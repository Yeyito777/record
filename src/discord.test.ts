import { afterEach, describe, expect, test } from "bun:test";

import {
  DIRECT_MESSAGES_GUILD_ID,
  acceptDiscordInvite,
  banGuildMember,
  createChannelThread,
  createGuildInvite,
  createMessageThread,
  deleteChannel,
  ackChannelMessage,
  fetchChannelPinnedMessages,
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
  isForumChannel,
  isGuildVoiceChannel,
  isThreadChannel,
  joinThread,
  mapDiscordMessagePatch,
  mapDiscordMessageReactionPatch,
  deleteChannelMessage,
  editChannelMessage,
  sendChannelMessage,
  setDirectMessageChannelMuted,
  setGuildChannelMuted,
  setGuildMuted,
  ringDirectMessageCall,
  setCurrentUserSettingsProtoCustomStatus,
  setCurrentUserSettingsProtoStatus,
  fetchCurrentUserStatusSettings,
  fetchCurrentUserPresenceStatus,
  discordInviteCodeFromUrl,
  disconnectGuildMemberFromVoice,
  kickGuildMember,
  leaveGuild,
  setGuildMemberServerDeafen,
  setGuildMemberServerMute,
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

  test("sends Discord client metadata headers on REST requests", async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify([{ id: "guild-1", name: "One", icon: null }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await fetchGuilds("token");

    expect(headers["Authorization"]).toBe("token");
    expect(headers["User-Agent"]).toContain("discord/0.0.115");
    expect(headers["Origin"]).toBe("https://discord.com");
    expect(headers["Referer"]).toBe("https://discord.com/channels/@me");
    expect(headers["X-Super-Properties"]).toEqual(expect.any(String));
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

  test("deletes a channel or thread through Discord REST", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    await deleteChannel("token", "channel-1");

    expect(requests).toEqual([{
      url: "https://discord.com/api/v9/channels/channel-1",
      method: "DELETE",
    }]);
  });

  test("treats an already missing channel as successfully deleted", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      message: "Unknown Channel",
      code: 10003,
    }), { status: 404, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    await expect(deleteChannel("token", "stale-thread")).resolves.toBeUndefined();
  });

  test("creates a seven-day server invite through the first text channel", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/guilds/guild-1/channels")) {
        return new Response(JSON.stringify([
          { id: "category-1", guild_id: "guild-1", parent_id: null, name: "Chat", position: 0, type: 4 },
          { id: "voice-1", guild_id: "guild-1", parent_id: null, name: "Voice", position: 0, type: 2 },
          { id: "text-1", guild_id: "guild-1", parent_id: "category-1", name: "general", position: 1, type: 0 },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/channels/text-1/invites")) {
        return new Response(JSON.stringify({ code: "abc123" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    expect(await createGuildInvite("token", "guild-1")).toBe("https://discord.gg/abc123");
    expect(requests).toEqual([{
      url: "https://discord.com/api/v9/guilds/guild-1/channels",
      method: "GET",
      body: null,
    }, {
      url: "https://discord.com/api/v9/channels/text-1/invites",
      method: "POST",
      body: {
        flags: 0,
        max_age: 604800,
        max_uses: 0,
        temporary: false,
        validate: null,
      },
    }]);
  });

  test("creates an invite without refetching channels when they are cached", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ code: "cached123" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const url = await createGuildInvite("token", "guild-1", [{
      id: "text-1",
      guildId: "guild-1",
      parentId: null,
      name: "general",
      topic: null,
      position: 0,
      type: 0,
      nsfw: false,
    }]);

    expect(url).toBe("https://discord.gg/cached123");
    expect(requests).toEqual(["https://discord.com/api/v9/channels/text-1/invites"]);
  });

  test("leaves a guild through Discord REST", async () => {
    const requests: Array<{ url: string; method: string; body: BodyInit | null | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    await leaveGuild("token", "guild-1");

    expect(requests).toEqual([{
      url: "https://discord.com/api/v9/users/@me/guilds/guild-1",
      method: "DELETE",
      body: undefined,
    }]);
  });

  test("moderates guild voice members through Discord's member routes", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    await setGuildMemberServerMute("token", "guild-1", "user-1", true);
    await setGuildMemberServerDeafen("token", "guild-1", "user-1", false);
    await disconnectGuildMemberFromVoice("token", "guild-1", "user-1");
    await kickGuildMember("token", "guild-1", "user-1");
    await banGuildMember("token", "guild-1", "user-1");

    expect(requests).toEqual([
      { url: "https://discord.com/api/v9/guilds/guild-1/members/user-1", method: "PATCH", body: { mute: true } },
      { url: "https://discord.com/api/v9/guilds/guild-1/members/user-1", method: "PATCH", body: { deaf: false } },
      { url: "https://discord.com/api/v9/guilds/guild-1/members/user-1", method: "PATCH", body: { channel_id: null } },
      { url: "https://discord.com/api/v9/guilds/guild-1/members/user-1", method: "DELETE", body: null },
      { url: "https://discord.com/api/v9/guilds/guild-1/bans/user-1", method: "PUT", body: { delete_message_seconds: 0 } },
    ]);
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

  test("fetches and updates a multi-word custom status while preserving its emoji", async () => {
    const requests: Array<{ method: string; body: string }> = [];
    // idle presence + "old quote" + a Unicode moon emoji + an expiration.
    let currentSettings = "WigKBgoEaWRsZRIaCglvbGQgcXVvdGUaBPCfjJkhFc1bBwAAAAAaAggB";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "GET") {
        return new Response(JSON.stringify({ settings: currentSettings }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "PATCH") {
        currentSettings = JSON.parse(String(init.body)).settings;
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    expect(await fetchCurrentUserStatusSettings("token")).toEqual({
      presenceStatus: "idle",
      customStatus: { text: "old quote", emojiId: null, emojiName: "🌙" },
    });

    await setCurrentUserSettingsProtoCustomStatus("token", "I am but a prince fighting the dark");

    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(await fetchCurrentUserStatusSettings("token")).toEqual({
      presenceStatus: "idle",
      customStatus: { text: "I am but a prince fighting the dark", emojiId: null, emojiName: "🌙" },
    });
  });

  test("clears the custom status through Discord settings-proto", async () => {
    // idle presence + "old quote" + a Unicode moon emoji + an expiration.
    let currentSettings = "WigKBgoEaWRsZRIaCglvbGQgcXVvdGUaBPCfjJkhFc1bBwAAAAAaAggB";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "GET") {
        return new Response(JSON.stringify({ settings: currentSettings }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "PATCH") {
        currentSettings = JSON.parse(String(init.body)).settings;
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    await setCurrentUserSettingsProtoCustomStatus("token", null);

    expect(await fetchCurrentUserStatusSettings("token")).toEqual({
      presenceStatus: "idle",
      customStatus: null,
    });
  });

  test("preserves the show-current-game preference when setting a quote", async () => {
    let currentSettings = "WgwKBgoEaWRsZRoCCAA="; // idle presence + showCurrentGame=false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "GET") {
        return new Response(JSON.stringify({ settings: currentSettings }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "PATCH") {
        currentSettings = JSON.parse(String(init.body)).settings;
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    await setCurrentUserSettingsProtoCustomStatus("show-game-token", "new");

    expect(currentSettings).toBe("WhMSBQoDbmV3CgYKBGlkbGUaAggA");
  });

  test("serializes presence and quote changes so they cannot clobber each other", async () => {
    const methods: string[] = [];
    let currentSettings = "WgsKAgoEaWRsZRoCCAE=";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(init?.method ?? "GET");
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "GET") {
        return new Response(JSON.stringify({ settings: currentSettings }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/users/@me/settings-proto/1") && init?.method === "PATCH") {
        currentSettings = JSON.parse(String(init.body)).settings;
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    await Promise.all([
      setCurrentUserSettingsProtoStatus("concurrent-token", "dnd"),
      setCurrentUserSettingsProtoCustomStatus("concurrent-token", "new quote"),
    ]);

    expect(methods).toEqual(["GET", "PATCH", "GET", "PATCH"]);
    expect(await fetchCurrentUserStatusSettings("concurrent-token")).toEqual({
      presenceStatus: "dnd",
      customStatus: { text: "new quote", emojiId: null, emojiName: null },
    });
  });

  test("does not patch presence when current settings cannot be read", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ message: "temporary failure" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(setCurrentUserSettingsProtoStatus("failed-read-token", "dnd")).rejects.toThrow();

    expect(methods).toEqual(["GET"]);
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
      if (url.includes("/channels/channel-1/threads/search")) {
        return new Response(JSON.stringify({ threads: [], members: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
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

  test("fetches active guild threads with membership and metadata", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/guilds/guild-1/channels")) {
        return new Response(JSON.stringify([
          { id: "text-1", guild_id: "guild-1", parent_id: null, name: "general", position: 0, type: 0, permission_overwrites: [] },
          { id: "forum-1", guild_id: "guild-1", parent_id: null, name: "support", position: 1, type: 15, permission_overwrites: [] },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/text-1/threads/search?")) {
        return new Response(JSON.stringify({
          threads: [{
            id: "thread-1",
            guild_id: "guild-1",
            parent_id: "text-1",
            owner_id: "user-1",
            name: "release discussion",
            type: 11,
            last_message_id: "300",
            message_count: 4,
            member_count: 2,
            total_message_sent: 6,
            thread_metadata: {
              archived: false,
              auto_archive_duration: 1440,
              archive_timestamp: "2026-07-31T12:00:00.000Z",
              create_timestamp: "2026-07-30T12:00:00.000Z",
              locked: false,
              invitable: true,
            },
          }, {
            id: "thread-without-member",
            guild_id: "guild-1",
            parent_id: "text-1",
            owner_id: "user-2",
            name: "discovered thread",
            type: 11,
            message_count: 1,
            member_count: 2,
            thread_metadata: {
              archived: false,
              auto_archive_duration: 1440,
              archive_timestamp: "2026-07-31T13:00:00.000Z",
              locked: false,
            },
          }],
          members: [{ id: "thread-1", user_id: "viewer", muted: true }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/forum-1/threads/search?")) {
        return new Response(JSON.stringify({ threads: [], members: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const channels = await fetchGuildChannels("token", "guild-1", { includeThreads: true });
    const thread = channels.find((channel) => channel.id === "thread-1") ?? null;

    expect(requests.sort()).toEqual([
      "https://discord.com/api/v9/guilds/guild-1/channels",
      "https://discord.com/api/v9/channels/text-1/threads/search?archived=false&sort_by=last_message_time&sort_order=desc&limit=25",
      "https://discord.com/api/v9/channels/forum-1/threads/search?archived=false&sort_by=last_message_time&sort_order=desc&limit=25",
    ].sort());
    expect(isForumChannel(channels.find((channel) => channel.id === "forum-1") ?? null)).toBe(true);
    expect(isThreadChannel(thread)).toBe(true);
    expect(formatChannelName(thread)).toBe("🧵 release discussion");
    expect(thread).toMatchObject({
      parentId: "text-1",
      lastMessageId: "300",
      muted: true,
      thread: {
        ownerId: "user-1",
        archived: false,
        locked: false,
        invitable: true,
        autoArchiveDuration: 1440,
        joined: true,
        messageCount: 4,
        memberCount: 2,
        totalMessageSent: 6,
      },
    });
    expect(channels.find((channel) => channel.id === "thread-without-member")?.thread?.joined).toBeNull();
  });

  test("retains known active threads only when their parent search fails", async () => {
    let failThreadSearch = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/guilds/guild-1/channels")) {
        return new Response(JSON.stringify([
          { id: "text-1", guild_id: "guild-1", parent_id: null, name: "general", position: 0, type: 0, permission_overwrites: [] },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/text-1/threads/search?")) {
        if (failThreadSearch) {
          return new Response(JSON.stringify({ message: "temporary failure" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ threads: [], members: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const knownThread = {
      id: "thread-1",
      guildId: "guild-1",
      parentId: "text-1",
      name: "known thread",
      topic: null,
      position: 0,
      type: 11,
      nsfw: false,
      thread: {
        ownerId: "viewer",
        archived: false,
        locked: false,
        invitable: true,
        autoArchiveDuration: 1440,
        archiveTimestamp: Date.now(),
        createTimestamp: Date.now(),
        joined: true,
        messageCount: 1,
        memberCount: 1,
        totalMessageSent: 1,
      },
    };

    const retained = await fetchGuildChannels("token", "guild-1", { includeThreads: true, fallbackThreads: [knownThread] });
    failThreadSearch = false;
    const removed = await fetchGuildChannels("token", "guild-1", { includeThreads: true, fallbackThreads: [knownThread] });

    expect(retained.map((channel) => channel.id)).toContain("thread-1");
    expect(retained.find((channel) => channel.id === "thread-1")?.thread?.joined).toBe(true);
    expect(removed.map((channel) => channel.id)).not.toContain("thread-1");
  });

  test("creates a public thread anchored to a channel message", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({
        id: "thread-1",
        guild_id: "guild-1",
        parent_id: "channel-1",
        owner_id: "viewer",
        name: "release discussion",
        type: 11,
        message_count: 0,
        member_count: 1,
        thread_metadata: {
          archived: false,
          auto_archive_duration: 1440,
          archive_timestamp: "2026-08-01T00:00:00.000Z",
          locked: false,
        },
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const thread = await createMessageThread("token", "channel-1", "message-1", "release discussion");

    expect(requests[0]).toEqual({
      url: "https://discord.com/api/v9/channels/channel-1/messages/message-1/threads",
      method: "POST",
      body: {
        name: "release discussion",
        auto_archive_duration: 1440,
        rate_limit_per_user: 0,
      },
    });
    expect(thread).toMatchObject({
      id: "thread-1",
      guildId: "guild-1",
      parentId: "channel-1",
      type: 11,
      thread: { joined: true },
    });
  });

  test("creates a standalone public thread in a text channel", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({
        id: "thread-1",
        guild_id: "guild-1",
        parent_id: "channel-1",
        owner_id: "viewer",
        name: "release discussion",
        type: 11,
        message_count: 0,
        member_count: 1,
        thread_metadata: {
          archived: false,
          auto_archive_duration: 1440,
          archive_timestamp: "2026-08-01T00:00:00.000Z",
          locked: false,
        },
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const thread = await createChannelThread("token", "channel-1", "release discussion");

    expect(requests[0]).toEqual({
      url: "https://discord.com/api/v9/channels/channel-1/threads",
      method: "POST",
      body: {
        name: "release discussion",
        auto_archive_duration: 1440,
        rate_limit_per_user: 0,
        type: 11,
      },
    });
    expect(thread).toMatchObject({
      id: "thread-1",
      guildId: "guild-1",
      parentId: "channel-1",
      type: 11,
      thread: { joined: true },
    });
  });

  test("joins a thread through the user-account thread member route", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;

    await joinThread("token", "thread-1");

    expect(requests).toEqual([{
      url: "https://discord.com/api/v9/channels/thread-1/thread-members/@me?location=Sidebar%20Overflow",
      method: "POST",
    }]);
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

  test("fetches every page of channel pins and returns them in message chronology", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const secondPage = url.includes("before=");
      const item = secondPage
        ? {
          pinned_at: "2026-01-01T10:00:00.000Z",
          message: {
            id: "1",
            channel_id: "channel-1",
            content: "older pin",
            timestamp: "2025-12-01T12:00:00.000Z",
            edited_timestamp: null,
            author: { id: "user-1", username: "tester", global_name: "Tester" },
            attachments: [],
            embeds: [],
          },
        }
        : {
          pinned_at: "2026-02-01T10:00:00.000Z",
          message: {
            id: "3",
            channel_id: "channel-1",
            content: "newer pin",
            timestamp: "2026-01-01T12:00:00.000Z",
            edited_timestamp: null,
            author: { id: "user-1", username: "tester", global_name: "Tester" },
            attachments: [],
            embeds: [],
          },
        };
      return new Response(JSON.stringify({ items: [item], has_more: !secondPage }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelPinnedMessages("token", "channel-1");

    expect(requests).toEqual([
      "https://discord.com/api/v9/channels/channel-1/messages/pins?limit=50",
      "https://discord.com/api/v9/channels/channel-1/messages/pins?limit=50&before=2026-02-01T10%3A00%3A00.000Z",
    ]);
    expect(messages.map((message) => message.id)).toEqual(["1", "3"]);
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

  test("retries call and other system-message replies without a native reference", async () => {
    const requestedBodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      if (requestedBodies.length === 1) {
        return new Response(JSON.stringify({
          message: "Invalid Form Body",
          code: 50035,
          errors: {
            message_reference: {
              _errors: [{
                code: "MESSAGE_REFERENCE_TYPE_INVALID",
                message: "Cannot reply to a system message",
              }],
            },
          },
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        id: "message-2",
        channel_id: "dm-1",
        nonce: "123456789",
        type: 0,
        content: "oh man I didn't see call mb",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "user-1", username: "tester", global_name: "Tester" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const message = await sendChannelMessage("token", "dm-1", "oh man I didn't see call mb", {
      nonce: "123456789",
      reply: { messageId: "call-message-1", channelId: "dm-1", guildId: null, mention: false },
    });

    expect(requestedBodies).toEqual([{
      content: "oh man I didn't see call mb",
      tts: false,
      nonce: "123456789",
      message_reference: {
        message_id: "call-message-1",
        channel_id: "dm-1",
      },
      allowed_mentions: {
        parse: ["users", "roles", "everyone"],
        replied_user: false,
      },
    }, {
      content: "oh man I didn't see call mb",
      tts: false,
      nonce: "123456789",
    }]);
    expect(message).toMatchObject({
      id: "message-2",
      channelId: "dm-1",
      content: "oh man I didn't see call mb",
      nonce: "123456789",
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
        nonce: 123456789,
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
      nonce: "123456789",
      uploads: [{ filename: "image-1.png", mediaType: "image/png", base64: Buffer.from("test").toString("base64") }],
    });

    expect(requestedBody).toBeInstanceOf(FormData);
    expect(requestedContentType).toBeNull();
    const form = requestedBody as unknown as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({
      content: "caption",
      tts: false,
      nonce: "123456789",
      attachments: [{ id: "0", filename: "image-1.png" }],
    });
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
    expect(message.nonce).toBe("123456789");
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

  test("mutes and unmutes guild channels and categories through channel overrides", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await setGuildChannelMuted("token", "guild-1", "category-1", true);
    await setGuildChannelMuted("token", "guild-1", "channel-1", false);

    expect(requests[0]?.url).toBe("https://discord.com/api/v9/users/@me/guilds/settings");
    expect(requests[0]?.body).toEqual({
      guilds: {
        "guild-1": {
          channel_overrides: {
            "category-1": {
              muted: true,
              mute_config: { end_time: null, selected_time_window: -1 },
            },
          },
        },
      },
    });
    expect(requests[1]?.body).toEqual({
      guilds: {
        "guild-1": {
          channel_overrides: { "channel-1": { muted: false } },
        },
      },
    });
  });

  test("mutes and unmutes DMs through @me user guild settings", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await setDirectMessageChannelMuted("token", "dm-1", true);
    await setDirectMessageChannelMuted("token", "dm-1", false);

    expect(requests[0]?.url).toBe("https://discord.com/api/v9/users/@me/guilds/%40me/settings");
    expect(requests[0]?.body).toEqual({
      channel_overrides: {
        "dm-1": {
          muted: true,
          mute_config: { end_time: null, selected_time_window: -1 },
        },
      },
    });
    expect(requests[1]?.body).toEqual({ channel_overrides: { "dm-1": { muted: false } } });
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

  test("falls back to bulk read-state ack when per-message ack fails", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (url.endsWith("/channels/channel-1/messages/message-1/ack")) {
        return new Response(JSON.stringify({ message: "Unknown Message" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await ackChannelMessage("token", "channel-1", "message-1");

    expect(requests.map((request) => request.url)).toEqual([
      "https://discord.com/api/v9/channels/channel-1/messages/message-1/ack",
      "https://discord.com/api/v9/read-states/ack-bulk",
    ]);
    expect(requests[1]?.body).toEqual({
      read_states: [{ channel_id: "channel-1", message_id: "message-1", read_state_type: 0 }],
    });
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

  test("renders thread creation as an authored message linked to the thread channel", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([{
        id: "thread-created-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        type: 18,
        content: "test-thread",
        timestamp: "2026-08-01T01:32:00.000Z",
        edited_timestamp: null,
        author: { id: "self", username: "yeyito", global_name: "Yeyito" },
        message_reference: { channel_id: "thread-1", guild_id: "guild-1" },
        referenced_message: null,
        attachments: [],
        embeds: [],
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "channel-1", 50);

    expect(messages[0]?.type).toBe(18);
    expect(messages[0]?.content).toBe("🧵 Started a thread: test-thread");
    expect(messages[0]?.reply).toBeNull();
    expect(messages[0]?.threadId).toBe("thread-1");
  });

  test("renders a message-anchored thread starter through the authored reply UI", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([{
        id: "starter-1",
        channel_id: "thread-1",
        guild_id: "guild-1",
        type: 21,
        content: "",
        timestamp: "2026-08-01T01:09:00.000Z",
        edited_timestamp: null,
        author: { id: "self", username: "yeyito", global_name: "Yeyito" },
        message_reference: { message_id: "message-1", channel_id: "channel-1", guild_id: "guild-1" },
        referenced_message: {
          id: "message-1",
          content: "Mira los mensajes del whatsapp",
          timestamp: "2026-08-01T01:08:00.000Z",
          author: { id: "other", username: "janthony", global_name: "Janthony" },
          attachments: [],
          embeds: [],
        },
        attachments: [],
        embeds: [],
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const messages = await fetchChannelMessages("token", "thread-1", 50);

    expect(messages[0]?.type).toBe(21);
    expect(messages[0]?.content).toBe("🧵 Started this thread.");
    expect(messages[0]?.reply).toEqual({
      messageId: "message-1",
      authorId: "other",
      authorDisplayName: "Janthony",
      timestamp: Date.parse("2026-08-01T01:08:00.000Z"),
      summary: "Mira los mensajes del whatsapp",
    });
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
