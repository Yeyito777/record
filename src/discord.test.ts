import { afterEach, describe, expect, test } from "bun:test";

import {
  DIRECT_MESSAGES_GUILD_ID,
  acceptDiscordInvite,
  ackChannelMessage,
  fetchChannelMessagesAfter,
  fetchChannelMessages,
  fetchChannelMessagesAround,
  applyDiscordMessagePatch,
  fetchDirectMessages,
  fetchGuilds,
  fetchGuildChannels,
  fetchGuildRoles,
  formatChannelName,
  isDirectMessageChannel,
  isGuildVoiceChannel,
  mapDiscordMessagePatch,
  mapDiscordMessageReactionPatch,
  deleteChannelMessage,
  editChannelMessage,
  sendChannelMessage,
  setGuildMuted,
  ringDirectMessageCall,
  setCurrentUserSettingsProtoStatus,
  fetchCurrentUserPresenceStatus,
  discordInviteCodeFromUrl,
} from "./discord";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discord helpers", () => {
  test("extracts Discord invite codes from join links", () => {
    expect(discordInviteCodeFromUrl("https://discord.gg/jKqsESXTc")).toBe("jKqsESXTc");
    expect(discordInviteCodeFromUrl("https://discord.com/invite/jKqsESXTc?event=1")).toBe("jKqsESXTc");
    expect(discordInviteCodeFromUrl("https://canary.discord.com/invites/custom-code")).toBe("custom-code");
    expect(discordInviteCodeFromUrl("jKqsESXTc")).toBe("jKqsESXTc");
    expect(discordInviteCodeFromUrl("https://discord.com/channels/1/2")).toBeNull();
    expect(discordInviteCodeFromUrl("https://example.com/invite/jKqsESXTc")).toBeNull();
  });

  test("accepts a Discord invite through REST", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | undefined;
      contextProperties: string | undefined;
      body: unknown;
    }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers?.Authorization,
        contextProperties: headers?.["X-Context-Properties"],
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({
        code: "jKqsESXTc",
        guild: { id: "guild-1", name: "Example Server", icon: null },
        channel: { id: "channel-1", name: "general", type: 0 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const result = await acceptDiscordInvite("token", "https://discord.gg/jKqsESXTc", { sessionId: "gateway-session" });

    expect(requests).toEqual([{
      url: "https://discord.com/api/v9/invites/jKqsESXTc?with_counts=true&with_expiration=true",
      method: "GET",
      authorization: "token",
      contextProperties: undefined,
      body: {},
    }, {
      url: "https://discord.com/api/v9/invites/jKqsESXTc",
      method: "POST",
      authorization: "token",
      contextProperties: expect.any(String),
      body: { session_id: "gateway-session" },
    }]);
    expect(result).toEqual({
      code: "jKqsESXTc",
      guildId: "guild-1",
      guildName: "Example Server",
      channelId: "channel-1",
      channelName: "general",
    });
  });

  test("surfaces captcha invite join failures", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/invites/jKqsESXTc?with_counts=true&with_expiration=true")) {
        return new Response(JSON.stringify({ code: "jKqsESXTc" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/invites/jKqsESXTc") && init?.method === "POST") {
        return new Response(JSON.stringify({ captcha_key: ["captcha-required"], captcha_sitekey: "sitekey" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    await expect(acceptDiscordInvite("token", "https://discord.gg/jKqsESXTc"))
      .rejects.toThrow("Captcha required to join this server.");
  });

  test("deletes a channel message through Discord REST", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    await deleteChannelMessage("token", "channel-1", "message-1");

    expect(requests).toEqual([{
      url: "https://discord.com/api/v9/channels/channel-1/messages/message-1",
      method: "DELETE",
    }]);
  });

  test("persists presence status through Discord settings-proto", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "GET") {
        return new Response(JSON.stringify({ settings: "WgsKAgoEaWRsZRoCCAE=" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "PATCH") {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    await setCurrentUserSettingsProtoStatus("token", "dnd");

    expect(requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
    const patchBody = JSON.parse(requests[1]?.body ?? "{}");
    expect(typeof patchBody.settings).toBe("string");
    expect(patchBody.settings).not.toBe("WgsKAgoEaWRsZRoCCAE=");
  });

  test("fetches presence status from Discord settings-proto before legacy settings", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "GET") {
        return new Response(JSON.stringify({ settings: "Wg4KBQoDZG5kGgUo5gEYARoCCAE=" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    expect(await fetchCurrentUserPresenceStatus("token")).toBe("dnd");
    expect(requests).toHaveLength(1);
  });

  test("maps guild channel permission overwrite string types", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/guilds/guild-1/channels")) {
        return new Response(JSON.stringify([{
          id: "channel-1",
          guild_id: "guild-1",
          parent_id: null,
          name: "secret",
          position: 0,
          type: 0,
          permission_overwrites: [{ id: "guild-1", type: "0", allow: "0", deny: "1024" }],
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const channels = await fetchGuildChannels("token", "guild-1");

    expect(channels[0]?.permissionOverwrites).toEqual([{ id: "guild-1", type: 0, allow: "0", deny: "1024" }]);
  });

  test("formats direct messages without a hash prefix", () => {
    const dm = {
      id: "dm-1",
      guildId: DIRECT_MESSAGES_GUILD_ID,
      parentId: null,
      name: "Alice",
      topic: null,
      position: 0,
      type: 1,
      nsfw: false,
    };
    const guildChannel = {
      id: "chan-1",
      guildId: "guild-1",
      parentId: null,
      name: "general",
      topic: null,
      position: 0,
      type: 0,
      nsfw: false,
    };

    expect(isDirectMessageChannel(dm)).toBe(true);
    expect(formatChannelName(dm)).toBe("Alice");
    expect(formatChannelName(guildChannel)).toBe("#general");
  });

  test("maps guild voice channels for the sidebar", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/guilds/guild-1/channels")) {
        return new Response(JSON.stringify([{
          id: "voice-1",
          guild_id: "guild-1",
          parent_id: null,
          name: "Lounge",
          position: 0,
          type: 2,
        }, {
          id: "stage-1",
          guild_id: "guild-1",
          parent_id: null,
          name: "Stage",
          position: 1,
          type: 13,
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const channels = await fetchGuildChannels("token", "guild-1");

    expect(channels.map((channel) => channel.id)).toEqual(["voice-1", "stage-1"]);
    expect(channels.every(isGuildVoiceChannel)).toBe(true);
    expect(formatChannelName(channels[0] ?? null)).toBe("🔊 Lounge");
  });

  test("fetches guilds without reading Discord sidebar settings", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/users/@me/settings")) {
        throw new Error("guild order should be local-only");
      }
      return new Response(JSON.stringify([
        { id: "guild-1", name: "One", icon: null },
        { id: "guild-2", name: "Two", icon: null },
        { id: "guild-3", name: "Three", icon: null },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const guilds = await fetchGuilds("token");

    expect(requests.some((url) => url.endsWith("/users/@me/settings"))).toBe(false);
    expect(guilds.map((guild) => guild.id)).toEqual(["guild-1", "guild-2", "guild-3"]);
  });

  test("can apply an explicit local guild order to fetched guilds", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: "guild-1", name: "One", icon: null },
      { id: "guild-2", name: "Two", icon: null },
      { id: "guild-3", name: "Three", icon: null },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const guilds = await fetchGuilds("token", { guildOrder: ["guild-2", "guild-1"] });

    expect(guilds.map((guild) => guild.id)).toEqual(["guild-2", "guild-1", "guild-3"]);
  });

  test("sorts direct messages by most recent last_message_id", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "dm-old",
          parent_id: null,
          type: 1,
          recipients: [{ id: "user-1", username: "littlebabel", global_name: "littlebabel" }],
          last_message_id: "100",
        },
        {
          id: "dm-new",
          parent_id: null,
          type: 1,
          recipients: [{ id: "user-2", username: "sfbabel", global_name: "zosa" }],
          last_message_id: "200",
        },
        {
          id: "group-null",
          parent_id: null,
          type: 3,
          name: "old group",
          recipients: [{ id: "user-3", username: "groupmate", global_name: null }],
          last_message_id: null,
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const directMessages = await fetchDirectMessages("token");

    expect(directMessages.map((channel) => channel.name)).toEqual(["zosa", "littlebabel", "old group"]);
    expect(directMessages.map((channel) => channel.position)).toEqual([0, 1, 2]);
  });

  test("maps referenced messages into compact reply previews", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "reply body",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          message_reference: { message_id: "message-0", channel_id: "channel-1" },
          referenced_message: {
            id: "message-0",
            content: "hello\nthere",
            timestamp: "2026-01-01T11:59:00.000Z",
            author: { id: "user-2", username: "alice", global_name: "Alice" },
            member: { nick: "Alicia" },
            mention_roles: ["role-1"],
            attachments: [{ id: "a-1", filename: "cat.png", content_type: "image/png", size: 123, url: "https://example.com/cat.png" }],
            embeds: [{ provider: { name: "Example" }, title: "Cat story", url: "https://example.com/cat" }],
          },
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.reply).toEqual({
      messageId: "message-0",
      authorId: "user-2",
      authorDisplayName: "Alice",
      timestamp: Date.parse("2026-01-01T11:59:00.000Z"),
      summary: "hello there · 📎 cat.png • 123 B · ↳ Example: Cat story",
      mentionRoleIds: ["role-1"],
    });
  });

  test("maps forwarded message snapshots without treating them as deleted replies", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "blocktales", global_name: "Blocktales" },
          message_reference: { type: 1, message_id: "message-0", channel_id: "channel-0" },
          referenced_message: null,
          message_snapshots: [{
            message: {
              content: "janthony ella es dama con rama tio",
              mention_roles: ["role-1"],
              mentions: [{ id: "user-2", username: "janthony", global_name: "Janthony" }],
              attachments: [{ id: "a-1", filename: "note.txt", content_type: "text/plain", size: 16, url: "https://example.com/note.txt" }],
              embeds: [{ provider: { name: "Example" }, title: "Snapshot", url: "https://example.com/snapshot" }],
            },
          }],
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.reply).toBeNull();
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.forwarded).toEqual({
      content: "janthony ella es dama con rama tio",
      originMessageId: "message-0",
      originChannelId: "channel-0",
      originGuildId: null,
      mentionEveryone: false,
      mentionRoleIds: ["role-1"],
      mentionUsers: [{ id: "user-2", username: "janthony", displayName: "Janthony", bot: false, roleIds: undefined }],
      attachments: [{ id: "a-1", filename: "note.txt", contentType: "text/plain", size: 16, url: "https://example.com/note.txt", durationSecs: undefined, waveform: undefined }],
      stickerNames: [],
      embedsCount: 1,
      embeds: [{ type: null, title: "Snapshot", url: "https://example.com/snapshot", description: null, providerName: "Example", authorName: null }],
    });
  });

  test("fetches a chunk around a target message id", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify([
        {
          id: "message-2",
          channel_id: "channel-1",
          content: "newer",
          timestamp: "2026-01-01T12:02:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          attachments: [],
          embeds: [],
        },
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "target",
          timestamp: "2026-01-01T12:01:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessagesAround("token", "channel-1", "message-1", 25);

    expect(requests).toEqual(["https://discord.com/api/v9/channels/channel-1/messages?limit=25&around=message-1"]);
    expect(messages.map((message) => message.id)).toEqual(["message-1", "message-2"]);
  });

  test("fetches messages after a known message id", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify([
        {
          id: "message-3",
          channel_id: "channel-1",
          content: "newest",
          timestamp: "2026-01-01T12:03:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessagesAfter("token", "channel-1", 25, "message-2");

    expect(requests).toEqual(["https://discord.com/api/v9/channels/channel-1/messages?limit=25&after=message-2"]);
    expect(messages.map((message) => message.id)).toEqual(["message-3"]);
  });

  test("maps sticker-only messages and reply previews", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          sticker_items: [{ id: "sticker-1", name: "catjam", format_type: 1 }],
          attachments: [],
          embeds: [],
        },
        {
          id: "message-2",
          channel_id: "channel-1",
          content: "reply body",
          timestamp: "2026-01-01T12:01:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          message_reference: { message_id: "message-1", channel_id: "channel-1" },
          referenced_message: {
            id: "message-1",
            content: "",
            timestamp: "2026-01-01T12:00:00.000Z",
            author: { id: "user-2", username: "alice", global_name: "Alice" },
            sticker_items: [{ id: "sticker-1", name: "catjam", format_type: 1 }],
            attachments: [],
            embeds: [],
          },
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    const stickerMessage = messages.find((message) => message.id === "message-1");
    const replyMessage = messages.find((message) => message.id === "message-2");
    expect(stickerMessage?.stickerNames).toEqual(["catjam"]);
    expect(replyMessage?.reply?.summary).toBe("[sticker] catjam");
  });

  test("maps message reactions from REST payloads", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "reactable",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          attachments: [],
          embeds: [],
          reactions: [
            { count: 3, me: true, emoji: { id: null, name: "👍" } },
            { count: 1, me: false, emoji: { id: "emoji-1", name: "blobcat", animated: true } },
          ],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.reactions).toEqual([
      { count: 3, me: true, emoji: { id: null, name: "👍", animated: false } },
      { count: 1, me: false, emoji: { id: "emoji-1", name: "blobcat", animated: true } },
    ]);
  });

  test("applies gateway reaction add and remove patches", () => {
    const existing = {
      id: "message-1",
      channelId: "channel-1",
      type: 0,
      content: "old",
      mentionEveryone: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      timestamp: Date.parse("2026-01-01T12:00:00.000Z"),
      editedTimestamp: null,
      author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
      reply: null,
      call: null,
      attachments: [],
      stickerNames: [],
      embedsCount: 0,
      reactions: [{ count: 1, me: false, emoji: { id: null, name: "👍", animated: false } }],
    };

    const addPatch = mapDiscordMessageReactionPatch({
      message_id: "message-1",
      channel_id: "channel-1",
      user_id: "viewer",
      emoji: { id: null, name: "👍" },
    }, "add", "viewer");
    const added = applyDiscordMessagePatch(existing, addPatch!);

    expect(added.reactions).toEqual([{ count: 2, me: true, emoji: { id: null, name: "👍", animated: false } }]);

    const removePatch = mapDiscordMessageReactionPatch({
      message_id: "message-1",
      channel_id: "channel-1",
      user_id: "viewer",
      emoji: { id: null, name: "👍" },
    }, "remove", "viewer");

    expect(applyDiscordMessagePatch(added, removePatch!).reactions).toEqual([
      { count: 1, me: false, emoji: { id: null, name: "👍", animated: false } },
    ]);
  });

  test("maps Discord call payloads", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "call-1",
          channel_id: "channel-1",
          type: 3,
          content: "",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          call: {
            ended_timestamp: "2026-01-01T12:03:04.000Z",
            participants: ["user-1", "user-2"],
          },
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.type).toBe(3);
    expect(messages[0]?.call).toEqual({
      endedTimestamp: Date.parse("2026-01-01T12:03:04.000Z"),
      participantIds: ["user-1", "user-2"],
    });
  });

  test("maps gateway message member roles onto authors", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([{
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        content: "hello",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester", avatar: "avatar-1" },
        member: { roles: ["role-1", "role-2"] },
        attachments: [],
        embeds: [],
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.author.roleIds).toEqual(["role-1", "role-2"]);
    expect(messages[0]?.author.avatar).toBe("avatar-1");
  });

  test("uses real display names instead of server nicknames for message authors", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([{
        id: "message-1",
        channel_id: "channel-1",
        content: "hello",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        member: { nick: "Server Nick" },
        attachments: [],
        embeds: [],
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.author.displayName).toBe("Tester");
  });

  test("preserves mentioned user display names and role ids", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([{
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        content: "hello <@123>",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "111", username: "tester", global_name: "Tester" },
        mentions: [{ id: "123", username: "alice", global_name: "Alice", member: { roles: ["role-1"] } }],
        attachments: [],
        embeds: [],
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.mentionUserIds).toEqual(["123"]);
    expect(messages[0]?.mentionUsers).toEqual([
      { id: "123", username: "alice", displayName: "Alice", bot: false, roleIds: ["role-1"] },
    ]);
  });

  test("clears stale call payloads when Discord sends a type-3 update without call data", () => {
    const existing = {
      id: "call-1",
      channelId: "channel-1",
      type: 3,
      content: "",
      mentionEveryone: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      timestamp: Date.parse("2026-01-01T12:00:00.000Z"),
      editedTimestamp: null,
      author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
      reply: null,
      call: { endedTimestamp: null, participantIds: ["user-1", "user-2"] },
      attachments: [],
      stickerNames: [],
      embedsCount: 0,
    };

    const patch = mapDiscordMessagePatch({ id: "call-1", channel_id: "channel-1", type: 3 });

    expect(applyDiscordMessagePatch(existing, patch).call).toBeNull();
  });

  test("maps partial message updates without clobbering existing fields", () => {
    const existing = {
      id: "message-1",
      channelId: "channel-1",
      type: 0,
      content: "old",
      mentionEveryone: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      timestamp: Date.parse("2026-01-01T12:00:00.000Z"),
      editedTimestamp: null,
      author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
      reply: null,
      call: null,
      attachments: [],
      stickerNames: [],
      embedsCount: 0,
    };

    const patch = mapDiscordMessagePatch({
      id: "message-1",
      channel_id: "channel-1",
      content: "new",
      edited_timestamp: "2026-01-01T12:01:00.000Z",
    });

    expect(applyDiscordMessagePatch(existing, patch)).toEqual({
      ...existing,
      content: "new",
      editedTimestamp: Date.parse("2026-01-01T12:01:00.000Z"),
    });
  });

  test("maps guild role names", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: "guild-1", name: "@everyone", color: 0, position: 0, permissions: "1024" },
      { id: "role-1", name: "artist", color: 0x3366ff, position: 1, permissions: "0" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const roles = await fetchGuildRoles("token", "guild-1");

    expect(roles).toEqual([
      { id: "guild-1", name: "@everyone", color: 0, position: 0, permissions: "1024" },
      { id: "role-1", name: "artist", color: 0x3366ff, position: 1, permissions: "0" },
    ]);
  });

  test("posts message content to the active channel", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-1",
        channel_id: "channel-1",
        type: 0,
        content: "hello world",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const message = await sendChannelMessage("token", "channel-1", "hello world");

    expect(requestedUrl).toBe("https://discord.com/api/v9/channels/channel-1/messages");
    expect(JSON.parse(requestedBody)).toEqual({ content: "hello world", tts: false });
    expect(message.content).toBe("hello world");
  });

  test("patches message content when editing a message", async () => {
    let requestedUrl = "";
    let requestedMethod = "";
    let requestedBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedMethod = String(init?.method ?? "");
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-1",
        channel_id: "channel-1",
        type: 0,
        content: "edited message",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: "2026-01-01T12:01:00.000Z",
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const message = await editChannelMessage("token", "channel-1", "message-1", "edited message");

    expect(requestedUrl).toBe("https://discord.com/api/v9/channels/channel-1/messages/message-1");
    expect(requestedMethod).toBe("PATCH");
    expect(JSON.parse(requestedBody)).toEqual({ content: "edited message" });
    expect(message.content).toBe("edited message");
    expect(message.editedTimestamp).toBe(Date.parse("2026-01-01T12:01:00.000Z"));
  });

  test("posts reply metadata when sending a reply", async () => {
    let requestedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-2",
        channel_id: "channel-1",
        guild_id: "guild-1",
        type: 0,
        content: "hello reply",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await sendChannelMessage("token", "channel-1", "hello reply", {
      reply: { messageId: "message-1", channelId: "channel-1", guildId: "guild-1", mention: false },
    });

    expect(JSON.parse(requestedBody)).toEqual({
      content: "hello reply",
      tts: false,
      message_reference: {
        message_id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
      },
      allowed_mentions: {
        parse: ["users", "roles", "everyone"],
        replied_user: false,
      },
    });
  });

  test("uploads image attachments as multipart form data", async () => {
    let requestedBody: BodyInit | null | undefined = null;
    let requestedContentType: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = init?.body;
      requestedContentType = new Headers(init?.headers).get("Content-Type");
      return new Response(JSON.stringify({
        id: "message-2",
        channel_id: "channel-1",
        type: 0,
        content: "caption",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        attachments: [{ id: "attachment-1", filename: "image-1.png", content_type: "image/png", size: 4, url: "https://cdn.example/image-1.png" }],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const message = await sendChannelMessage("token", "channel-1", "caption", {
      uploads: [{ filename: "image-1.png", mediaType: "image/png", base64: Buffer.from("test").toString("base64") }],
    });

    expect(requestedBody).toBeInstanceOf(FormData);
    expect(requestedContentType).toBeNull();
    const form = requestedBody as unknown as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({
      content: "caption",
      tts: false,
      attachments: [{ id: "0", filename: "image-1.png" }],
    });
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
    expect(message.attachments[0]?.filename).toBe("image-1.png");
  });

  test("posts Discord voice-message metadata with the upload", async () => {
    let requestedBody: BodyInit | null | undefined = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = init?.body;
      return new Response(JSON.stringify({
        id: "message-voice",
        channel_id: "channel-1",
        type: 0,
        content: "",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        attachments: [{
          id: "attachment-1",
          filename: "voice-message.ogg",
          content_type: "audio/ogg",
          size: 4,
          url: "https://cdn.example/voice-message.ogg",
          duration_secs: 1.25,
          waveform: "AAAA",
        }],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const message = await sendChannelMessage("token", "channel-1", "", {
      flags: 8192,
      uploads: [{
        filename: "voice-message.ogg",
        mediaType: "audio/ogg",
        base64: Buffer.from("test").toString("base64"),
        durationSecs: 1.25,
        waveform: "AAAA",
      }],
    });

    const form = requestedBody as unknown as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({
      content: "",
      tts: false,
      flags: 8192,
      attachments: [{ id: "0", filename: "voice-message.ogg", duration_secs: 1.25, waveform: "AAAA" }],
    });
    expect(message.attachments[0]?.durationSecs).toBe(1.25);
    expect(message.attachments[0]?.waveform).toBe("AAAA");
  });

  test("omits guild_id when sending a direct-message reply", async () => {
    let requestedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-2",
        channel_id: "dm-1",
        type: 0,
        content: "hello dm reply",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await sendChannelMessage("token", "dm-1", "hello dm reply", {
      reply: { messageId: "message-1", channelId: "dm-1", guildId: null, mention: true },
    });

    expect(JSON.parse(requestedBody).message_reference).toEqual({
      message_id: "message-1",
      channel_id: "dm-1",
    });
  });

  test("rings direct-message call recipients", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    await ringDirectMessageCall("token", "dm-1", ["user-1", "user-2"]);

    expect(requestedUrl).toBe("https://discord.com/api/v9/channels/dm-1/call/ring");
    expect(JSON.parse(requestedBody)).toEqual({ recipients: ["user-1", "user-2"] });
  });

  test("mutes and unmutes guilds through user guild settings", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await setGuildMuted("token", "guild-1", true);
    await setGuildMuted("token", "guild-1", false);

    expect(requests[0]?.url).toBe("https://discord.com/api/v9/users/@me/guilds/settings");
    expect(requests[0]?.body).toEqual({
      guilds: {
        "guild-1": {
          muted: true,
          mute_config: { end_time: null, selected_time_window: -1 },
        },
      },
    });
    expect(requests[1]?.body).toEqual({ guilds: { "guild-1": { muted: false } } });
  });

  test("acknowledges read messages", async () => {
    let requestedUrl = "";
    let requestedBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body ?? "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await ackChannelMessage("token", "channel-1", "message-1");

    expect(requestedUrl).toBe("https://discord.com/api/v9/channels/channel-1/messages/message-1/ack");
    expect(JSON.parse(requestedBody)).toMatchObject({ token: null });
    expect(typeof JSON.parse(requestedBody).last_viewed).toBe("number");
  });

  test("marks missing referenced messages as deleted replies", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "reply body",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          message_reference: { message_id: "message-0", channel_id: "channel-1" },
          referenced_message: null,
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.reply).toEqual({
      messageId: "message-0",
      channelId: "channel-1",
      authorId: null,
      authorDisplayName: null,
      timestamp: null,
      summary: "Deleted message",
    });
  });

  test("renders channel pin system messages instead of deleted reply previews", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "pin-1",
          channel_id: "channel-1",
          type: 6,
          content: "",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          message_reference: { message_id: "message-0", channel_id: "channel-1" },
          referenced_message: null,
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.type).toBe(6);
    expect(messages[0]?.content).toBe("📌 Pinned a message to this channel.");
    expect(messages[0]?.reply).toBeNull();
  });

  test("hydrates missing reply previews from messages returned in the same page", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "message-2",
          channel_id: "channel-1",
          content: "reply body",
          timestamp: "2026-01-01T12:01:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          message_reference: { message_id: "message-1", channel_id: "channel-1" },
          referenced_message: null,
          attachments: [],
          embeds: [],
        },
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "original body",
          timestamp: "2026-01-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "user-2", username: "alice", global_name: "Alice" },
          attachments: [],
          embeds: [],
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[1]?.reply).toEqual({
      messageId: "message-1",
      authorId: "user-2",
      authorDisplayName: "Alice",
      timestamp: Date.parse("2026-01-01T12:00:00.000Z"),
      summary: "original body",
    });
  });
});
