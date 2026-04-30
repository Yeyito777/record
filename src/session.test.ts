import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadCachedGuildOrder, saveCachedGuildChannels, saveCachedGuildOrder } from "./datacache";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, type DiscordMessage } from "./discord";
import { bootstrapReadOnlyClient, clearReadOnlyClient, deleteMessage, editCurrentMessage, loadChannelMessages, loadGuildChannels, loadGuildRolesInBackground, moveSelectedGuildOrder, persistPresenceStatusWithRetries, sendCurrentChannelMessage, toggleSelectedGuildMute } from "./session";
import { createInitialState, focusSidebar } from "./state";

const originalFetch = globalThis.fetch;
const originalXdg = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-session-test-"));
});

function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("condition timed out"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function message(id: string, content: string, channelId = "channel-1"): DiscordMessage {
  return {
    id,
    channelId,
    guildId: "guild-1",
    type: 0,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    mentionUsers: [],
    timestamp: Date.UTC(2026, 0, 1, 12, Number(id) || 0, 0),
    editedTimestamp: null,
    author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
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

  test("bootstrap shows direct messages before DM channel data has loaded", async () => {
    let resolveDms: (response: Response) => void = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) {
        return await new Promise<Response>((resolve) => {
          resolveDms = resolve;
        });
      }
      if (url.includes("/users/@me/guilds")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://gateway.example" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };

    const bootstrap = bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });
    await flushTimers();

    expect(state.sidebar.loading).toBe(true);
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID]);

    resolveDms(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
    await bootstrap;

    expect(state.sidebar.loading).toBe(false);
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID]);
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

    await bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(state.sidebar.expandedGuildId).toBe("guild-1");
    expect(state.channelList.guildId).toBe("guild-1");
    expect(state.channelList.channels.map((channel) => channel.id)).toEqual(["channel-1"]);
    expect(state.channelList.activeChannelId).toBe("channel-1");
  });

  test("bootstrap appends new guilds without touching Discord sidebar settings", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/users/@me/settings")) {
        throw new Error("guild order should be local-only");
      }
      if (url.includes("/users/@me/guilds")) {
        return new Response(JSON.stringify([
          { id: "guild-1", name: "One Fresh", icon: "icon-1" },
          { id: "guild-new", name: "New", icon: null },
          { id: "guild-2", name: "Two Fresh", icon: "icon-2" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://gateway.example" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "bootstrap-unordered", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [
      { id: "guild-1", name: "One Cached", icon: null },
      { id: "guild-2", name: "Two Cached", icon: null },
    ];

    await bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });

    expect(requests.some((url) => url.endsWith("/users/@me/settings"))).toBe(false);
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-1", "guild-2", "guild-new"]);
    expect(state.sidebar.guilds.map((guild) => guild.name)).toEqual([DIRECT_MESSAGES_GUILD_NAME, "One Fresh", "Two Fresh", "New"]);
  });

  test("bootstrap applies the local account-scoped guild order", async () => {
    saveCachedGuildOrder("self", ["guild-2", "guild-1"]);
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/users/@me/guilds")) {
        return new Response(JSON.stringify([
          { id: "guild-1", name: "One", icon: null },
          { id: "guild-2", name: "Two", icon: null },
          { id: "guild-3", name: "Three", icon: null },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://gateway.example" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };

    await bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });

    expect(requests.some((url) => url.endsWith("/users/@me/settings"))).toBe(false);
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-2", "guild-1", "guild-3"]);
  });

  test("cached channels fetch missing current-user roles before immediate visibility filtering", async () => {
    const viewChannel = String(1 << 10);

    saveCachedGuildChannels("self", "guild-1", [
      {
        id: "visible",
        guildId: "guild-1",
        parentId: null,
        name: "visible",
        topic: null,
        position: 0,
        type: 0,
        nsfw: false,
        permissionOverwrites: [],
      },
      {
        id: "hidden",
        guildId: "guild-1",
        parentId: null,
        name: "hidden",
        topic: null,
        position: 1,
        type: 0,
        nsfw: false,
        permissionOverwrites: [{ id: "guild-1", type: 0, allow: "0", deny: viewChannel }],
      },
    ]);

    let memberFetches = 0;
    let resolveChannels: (response: Response) => void = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/users/@me/guilds/guild-1/member")) {
        memberFetches += 1;
        return new Response(JSON.stringify({ roles: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/guilds/guild-1/channels")) {
        return await new Promise<Response>((resolve) => {
          resolveChannels = resolve;
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.savedToken = "token-1";
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.guildRolesByGuildId["guild-1"] = [{ id: "guild-1", color: 0, position: 0, permissions: viewChannel }];

    const load = loadGuildChannels(state, "token-1", "guild-1", { scheduleRender: () => {} });
    await flushTimers();

    expect(memberFetches).toBe(1);
    expect(state.memberRoleIdsByGuildId["guild-1"]?.self).toEqual([]);
    expect(state.channelList.channels.find((channel) => channel.id === "hidden")?.hidden).toBe(true);
    expect(state.channelList.channels.find((channel) => channel.id === "visible")?.hidden).toBe(false);

    resolveChannels(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
    await load;
  });

  test("refetches cached guild roles that lack names", async () => {
    let roleFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/guilds/guild-1/roles")) {
        roleFetches += 1;
        return new Response(JSON.stringify([
          { id: "guild-1", name: "@everyone", color: 0, position: 0, permissions: "1024" },
          { id: "role-1", name: "Block Tales", color: 0x3366ff, position: 1, permissions: "0" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.guildRolesByGuildId["guild-1"] = [{ id: "role-1", color: 0x3366ff, position: 1, permissions: "0" }];

    loadGuildRolesInBackground(state, "token-1", "guild-1", { scheduleRender: () => {} });
    await flushTimers();

    expect(roleFetches).toBe(1);
    expect(state.guildRolesByGuildId["guild-1"]?.find((role) => role.id === "role-1")?.name).toBe("Block Tales");
  });

  test("loading a channel renders fresh cached messages without REST", async () => {
    let messageFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/channel-1/messages?")) {
        messageFetches += 1;
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/guilds/guild-1/roles")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.messageCacheByChannelId["channel-1"] = {
      channelId: "channel-1",
      messages: [message("1", "cached")],
      hasOlder: false,
      updatedAt: Date.now(),
      latestFetchedAt: Date.now(),
    };

    await loadChannelMessages(state, "token-1", "channel-1", { scheduleRender: () => {} });

    expect(messageFetches).toBe(0);
    expect(state.timeline.loading).toBe(false);
    expect(state.timeline.messages.map((entry) => entry.content)).toEqual(["cached"]);
  });

  test("loading a channel without cache fetches once and stores the result", async () => {
    let messageFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/channel-1/messages?")) {
        messageFetches += 1;
        return new Response(JSON.stringify([{
          id: "2",
          channel_id: "channel-1",
          guild_id: "guild-1",
          type: 0,
          content: "from rest",
          timestamp: "2026-01-01T12:02:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          attachments: [],
          embeds: [],
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/guilds/guild-1/roles")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/ack")) {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];

    await loadChannelMessages(state, "token-1", "channel-1", { scheduleRender: () => {} });

    expect(messageFetches).toBe(1);
    expect(state.timeline.loading).toBe(false);
    expect(state.timeline.messages.map((entry) => entry.content)).toEqual(["from rest"]);
    expect(state.messageCacheByChannelId["channel-1"]?.messages.map((entry) => entry.content)).toEqual(["from rest"]);
  });

  test("loading a channel with only gateway messages keeps them visible while REST loads", async () => {
    let messageFetches = 0;
    let resolveMessages: (response: Response) => void = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/channel-1/messages?")) {
        messageFetches += 1;
        return await new Promise<Response>((resolve) => {
          resolveMessages = resolve;
        });
      }
      if (url.includes("/guilds/guild-1/roles")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/ack")) {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.messageCacheByChannelId["channel-1"] = {
      channelId: "channel-1",
      messages: [message("3", "from gateway")],
      hasOlder: true,
      updatedAt: Date.now(),
      latestFetchedAt: null,
    };

    await loadChannelMessages(state, "token-1", "channel-1", { scheduleRender: () => {} });

    expect(messageFetches).toBe(1);
    expect(state.timeline.loading).toBe(true);
    expect(state.timeline.messages.map((entry) => entry.content)).toEqual(["from gateway"]);

    resolveMessages(new Response(JSON.stringify([{
      id: "2",
      channel_id: "channel-1",
      guild_id: "guild-1",
      type: 0,
      content: "from rest",
      timestamp: "2026-01-01T12:02:00.000Z",
      edited_timestamp: null,
      author: { id: "user-1", username: "tester", global_name: "Tester" },
      attachments: [],
      embeds: [],
    }]), { status: 200, headers: { "Content-Type": "application/json" } }));
    await flushTimers();

    expect(state.timeline.loading).toBe(false);
    expect(state.timeline.messages.map((entry) => entry.content)).toEqual(["from rest", "from gateway"]);
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

  test("syncs server order from the account-scoped file when another client changes it", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/users/@me/guilds")) {
        return new Response(JSON.stringify([
          { id: "guild-1", name: "One", icon: null },
          { id: "guild-2", name: "Two", icon: null },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://gateway.example" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };

    await bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });
    try {
      expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-1", "guild-2"]);

      saveCachedGuildOrder("self", ["guild-2", "guild-1"]);
      await waitForCondition(() => state.sidebar.guilds.map((guild) => guild.id).join(",") === `${DIRECT_MESSAGES_GUILD_ID},guild-2,guild-1`);
    } finally {
      clearReadOnlyClient(state);
    }
  });

  test("moving a server order is local-only and persists the account-scoped order", () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("server ordering should not call Discord");
    }) as unknown as typeof fetch;
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.open = true;
    state.sidebar.guilds = [
      { id: "guild-1", name: "One", icon: null },
      { id: "guild-2", name: "Two", icon: null },
    ];
    state.sidebar.selectedIndex = 1;

    moveSelectedGuildOrder(state, { scheduleRender: () => {} }, "up");

    expect(fetchCalls).toBe(0);
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual(["guild-2", "guild-1"]);
    expect(loadCachedGuildOrder("self")).toEqual(["guild-2", "guild-1"]);
    expect(state.notice.text).toBe("");
  });

  test("muting a server updates sidebar state without notice feedback", () => {
    saveCachedGuildOrder("self", ["guild-2", "guild-1"]);
    globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.open = true;
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.selectedIndex = 0;
    state.notice = { text: "old feedback", tone: "muted", loading: false, statusLine: true, chat: true };

    toggleSelectedGuildMute(state, { scheduleRender: () => {} });

    expect(state.sidebar.guilds[0]?.muted).toBe(true);
    expect(state.notice.text).toBe("");
    expect(loadCachedGuildOrder("self")).toEqual(["guild-2", "guild-1"]);
  });

  test("editing a message patches it optimistically and clears edit state", async () => {
    let requestedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        type: 0,
        content: "edited",
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: "2026-01-01T12:01:00.000Z",
        author: { id: "self", username: "self", global_name: "Self" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [message("message-1", "original")];
    state.messageCacheByChannelId["channel-1"] = { channelId: "channel-1", messages: [message("message-1", "original")], hasOlder: false, updatedAt: 0, latestFetchedAt: null };
    state.editTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      authorDisplayName: "Self",
      authorColor: "",
      summary: "original",
      originalContent: "original",
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    };
    state.editor.buffer = "edited";

    editCurrentMessage(state, "token-1", "edited", { scheduleRender: () => {} });

    expect(state.editTarget).toBeNull();
    expect(state.editor.buffer).toBe("");
    expect(state.timeline.messages[0]?.content).toBe("edited");
    expect(typeof state.timeline.messages[0]?.editedTimestamp).toBe("number");

    await flushTimers();

    expect(JSON.parse(requestedBody)).toEqual({ content: "edited" });
    expect(state.timeline.messages[0]?.content).toBe("edited");
    expect(state.timeline.messages[0]?.editedTimestamp).toBe(Date.parse("2026-01-01T12:01:00.000Z"));
  });

  test("failed edits restore the prompt, edit state, and original message", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 })) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [message("message-1", "original")];
    state.editTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      authorDisplayName: "Self",
      authorColor: "",
      summary: "original",
      originalContent: "original",
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    };

    editCurrentMessage(state, "token-1", "edited", { scheduleRender: () => {} });
    await flushTimers();

    expect(state.editTarget?.messageId).toBe("message-1");
    expect(state.editor.buffer).toBe("edited");
    expect(state.timeline.messages[0]?.content).toBe("original");
    expect(state.notice.text).toContain("Edit failed");
  });

  test("deleting a message removes it optimistically", async () => {
    let requested = false;
    globalThis.fetch = (async () => {
      requested = true;
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";
    const first = message("1", "first");
    const second = message("2", "second");
    state.timeline.messages = [first, second];
    state.messageCacheByChannelId["channel-1"] = { channelId: "channel-1", messages: [first, second], hasOlder: false, updatedAt: 0, latestFetchedAt: null };

    deleteMessage(state, "token-1", first, { scheduleRender: () => {} });

    expect(state.timeline.messages.map((entry) => entry.id)).toEqual(["2"]);
    expect(state.messageCacheByChannelId["channel-1"]?.messages.map((entry) => entry.id)).toEqual(["2"]);

    await flushTimers();

    expect(requested).toBe(true);
    expect(state.timeline.messages.map((entry) => entry.id)).toEqual(["2"]);
  });

  test("failed deletes restore the optimistically removed message", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 })) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";
    const first = message("1", "first");
    const second = message("2", "second");
    state.timeline.messages = [first, second];
    state.messageCacheByChannelId["channel-1"] = { channelId: "channel-1", messages: [first, second], hasOlder: false, updatedAt: 0, latestFetchedAt: null };

    deleteMessage(state, "token-1", first, { scheduleRender: () => {} });
    expect(state.timeline.messages.map((entry) => entry.id)).toEqual(["2"]);

    await flushTimers();

    expect(state.timeline.messages.map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(state.messageCacheByChannelId["channel-1"]?.messages.map((entry) => entry.id)).toEqual(["1", "2"]);
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

  test("presence status persistence retries transient failures", async () => {
    const attempts: string[] = [];

    const persisted = await persistPresenceStatusWithRetries("token-1", "idle", async (_token, status) => {
      attempts.push(status);
      if (attempts.length < 3) throw new Error("Discord rate-limited the request.");
    }, { retries: 3, delayMs: 0 });

    expect(persisted).toBe(true);
    expect(attempts).toEqual(["idle", "idle", "idle"]);
  });

  test("presence status persistence gives up after configured retries", async () => {
    let attempts = 0;

    const persisted = await persistPresenceStatusWithRetries("token-1", "online", async () => {
      attempts += 1;
      throw new Error("Discord rate-limited the request.");
    }, { retries: 3, delayMs: 0 });

    expect(persisted).toBe(false);
    expect(attempts).toBe(4);
  });

  test("presence status persistence stops retrying stale status changes", async () => {
    let attempts = 0;
    let currentStatus = "idle";

    const persisted = await persistPresenceStatusWithRetries("token-1", "idle", async () => {
      attempts += 1;
      currentStatus = "online";
      throw new Error("Discord rate-limited the request.");
    }, { retries: 3, delayMs: 0, shouldContinue: () => currentStatus === "idle" });

    expect(persisted).toBe(false);
    expect(attempts).toBe(1);
  });
});
