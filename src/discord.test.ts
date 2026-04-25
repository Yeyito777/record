import { afterEach, describe, expect, test } from "bun:test";

import {
  DIRECT_MESSAGES_GUILD_ID,
  ackChannelMessage,
  fetchChannelMessages,
  applyDiscordMessagePatch,
  fetchDirectMessages,
  formatChannelName,
  isDirectMessageChannel,
  mapDiscordMessagePatch,
  sendChannelMessage,
  setGuildMuted,
} from "./discord";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discord helpers", () => {
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
            attachments: [{ id: "a-1", filename: "cat.png", content_type: "image/png", size: 123, url: "https://example.com/cat.png" }],
            embeds: [{}],
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
      authorDisplayName: "Alicia",
      timestamp: Date.parse("2026-01-01T11:59:00.000Z"),
      summary: "hello there · [attachments] cat.png · [embeds] 1",
    });
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
      authorId: null,
      authorDisplayName: null,
      timestamp: null,
      summary: "Deleted message",
    });
  });
});
