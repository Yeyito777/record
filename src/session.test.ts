import { afterEach, describe, expect, test } from "bun:test";

import { DIRECT_MESSAGES_GUILD_ID } from "./discord";
import { clearReadOnlyClient, sendCurrentChannelMessage } from "./session";
import { createInitialState, focusSidebar } from "./state";

const originalFetch = globalThis.fetch;

function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("session", () => {
  test("clearing the read-only client drops loaded UI state and invalidates pending requests", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    focusSidebar(state);
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.requestId = 3;
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{
      id: "channel-1",
      guildId: "guild-1",
      parentId: null,
      name: "general",
      topic: null,
      position: 0,
      type: 0,
      nsfw: false,
    }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.requestId = 7;
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [{
      id: "message-1",
      channelId: "channel-1",
      type: 0,
      content: "hello",
      mentionEveryone: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      editedTimestamp: null,
      author: { id: "user-1", username: "user", displayName: "User", bot: false },
      reply: null,
      call: null,
      attachments: [],
      stickerNames: [],
      embedsCount: 0,
    }];
    state.timeline.requestId = 11;
    state.memberList.open = true;
    state.memberList.guildId = "guild-1";
    state.memberList.channelId = "channel-1";
    state.memberList.members = [{ id: "user-1", username: "user", displayName: "User", bot: false }];
    state.memberList.requestId = 13;

    clearReadOnlyClient(state);

    expect(state.panelFocus === "chat").toBe(true);
    expect(state.chatFocus === "prompt").toBe(true);
    expect(state.sidebar.guilds).toEqual([]);
    expect(state.channelList.channels).toEqual([]);
    expect(state.timeline.messages).toEqual([]);
    expect(state.memberList.members).toEqual([]);
    expect(state.sidebar.requestId).toBe(4);
    expect(state.channelList.requestId).toBe(8);
    expect(state.timeline.requestId).toBe(12);
    expect(state.memberList.requestId).toBe(14);
  });

  test("bootstrap revalidation preserves a channel list opened while REST is in flight", async () => {
    let resolveDms: (response: Response) => void = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) {
        return await new Promise<Response>((resolve) => {
          resolveDms = resolve;
        });
      }
      if (url.includes("/users/@me/guilds")) {
        return new Response(JSON.stringify([{ id: "guild-1", name: "Guild", icon: null }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://gateway.example" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    const { bootstrapReadOnlyClient } = await import("./session");
    const bootstrap = bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });
    await flushTimers();

    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.expandedGuildId = "guild-1";
    state.sidebar.activeGuildId = "guild-1";
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0]!;

    resolveDms(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
    await bootstrap;

    expect(state.sidebar.expandedGuildId).toBe("guild-1");
    expect(state.channelList.guildId).toBe("guild-1");
    expect(state.channelList.channels.map((channel) => channel.id)).toEqual(["channel-1"]);
    expect(state.channelList.activeChannelId).toBe("channel-1");
  });

  test("bootstrap revalidation preserves the currently expanded channel list", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/users/@me/guilds")) {
        return new Response(JSON.stringify([{ id: "guild-1", name: "Guild", icon: null }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://gateway.example" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.expandedGuildId = "guild-1";
    state.sidebar.activeGuildId = "guild-1";
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0]!;

    const { bootstrapReadOnlyClient } = await import("./session");
    await bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(state.sidebar.expandedGuildId).toBe("guild-1");
    expect(state.channelList.guildId).toBe("guild-1");
    expect(state.channelList.channels.map((channel) => channel.id)).toEqual(["channel-1"]);
    expect(state.channelList.activeChannelId).toBe("channel-1");
  });

  test("sending a message immediately appends a pending local message", () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";
    state.timeline.scrollOffset = 0;
    state.timeline.maxScroll = 10;

    sendCurrentChannelMessage(state, "token-1", "hello", { scheduleRender: () => {} });

    expect(state.editor.buffer).toBe("");
    expect(state.timeline.scrollOffset).toBe(Number.MAX_SAFE_INTEGER);
    expect(state.timeline.messages).toHaveLength(1);
    expect(state.timeline.messages[0]).toMatchObject({ content: "hello", localStatus: "pending" });
  });

  test("sending images appends local attachments and clears pending images", () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";
    state.pendingImages = [{ mediaType: "image/png", base64: Buffer.from("test").toString("base64"), sizeBytes: 4, filename: "image-1.png" }];

    sendCurrentChannelMessage(state, "token-1", "caption", { scheduleRender: () => {} });

    expect(state.pendingImages).toEqual([]);
    expect(state.timeline.messages[0]).toMatchObject({
      content: "caption",
      localStatus: "pending",
      attachments: [{ filename: "image-1.png", contentType: "image/png", size: 4 }],
    });
  });

  test("sending a reply includes a local reply preview and clears reply state", () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-2",
      authorDisplayName: "Other",
      authorColor: "",
      summary: "original message",
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      mention: true,
    };

    sendCurrentChannelMessage(state, "token-1", "hello", { scheduleRender: () => {} });

    expect(state.replyTarget).toBeNull();
    expect(state.timeline.messages[0]?.reply).toEqual({
      messageId: "message-1",
      authorId: "user-2",
      authorDisplayName: "Other",
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      summary: "original message",
    });
  });

  test("defensively omits the direct-message pseudo-guild from reply sends", async () => {
    let requestedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-2",
        channel_id: "dm-1",
        type: 0,
        content: "hello",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "self", username: "self", global_name: "Self" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = DIRECT_MESSAGES_GUILD_ID;
    state.channelList.channels = [{ id: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Paramount", topic: null, position: 0, type: 1, nsfw: false }];
    state.channelList.activeChannelId = "dm-1";
    state.timeline.channelId = "dm-1";
    state.replyTarget = {
      messageId: "message-1",
      channelId: "dm-1",
      guildId: DIRECT_MESSAGES_GUILD_ID,
      authorId: "user-2",
      authorDisplayName: "Paramount",
      authorColor: "",
      summary: "original dm",
      timestamp: null,
      mention: true,
    };

    sendCurrentChannelMessage(state, "token-1", "hello", { scheduleRender: () => {} });
    await flushTimers();

    expect(JSON.parse(requestedBody).message_reference).toEqual({
      message_id: "message-1",
      channel_id: "dm-1",
    });
  });

  test("failed sends restore the prompt and leave a failure in history", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 })) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";

    sendCurrentChannelMessage(state, "token-1", "hello", { scheduleRender: () => {} });
    await flushTimers();

    expect(state.editor.buffer).toBe("hello");
    expect(state.timeline.messages[0]).toMatchObject({ content: "hello", localStatus: "failed" });
    expect(state.timeline.messages[0]?.localError).toBe("Discord denied access to that resource.");
  });
});
