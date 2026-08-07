import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadCachedDirectMessages, loadCachedGuildOrder, loadCachedSidebarChannelLayout, loadCachedSidebarFolders, saveCachedGuildChannels, saveCachedGuildOrder, saveCachedMemberList, saveCachedSidebarFolders } from "./datacache";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, type DiscordMessage } from "./discord";
import { whatsappChannelId, WHATSAPP_GUILD_ID, WHATSAPP_GUILD_NAME } from "./chatproviders";
import { guildNotificationCounts } from "./notifications";
import { activeCallMessageParticipantIds, adjustVoiceMemberVolume, bootstrapReadOnlyClient, canDeleteGuildChannel, clearReadOnlyClient, deleteMessage, editCurrentMessage, focusThreadChannel, handleGatewayChannelCreateOrUpdate, handleGatewayMessageCreate, handleGatewayThreadListSync, handleGuildMembersChunk, handleVoiceStateUpdate, loadChannelMessages, loadGuildChannels, loadGuildRolesInBackground, loadLatestChannelMessages, moveSelectedGuildOrder, newRemoteCallParticipantIds, persistPresenceStatusWithRetries, rememberPresentCallParticipants, removeSessionChannel, resolveRemoteCallParticipantIds, sendCurrentChannelMessage, shouldRetainTrackedCallParticipant, toggleSelectedGuildMute, toggleSelectedPrivateConversationPin, uploadCurrentChannelFile, voiceMemberModerationContext, voiceMemberVolume } from "./session";
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
  test("non-authoritative gateway refreshes and regular channel updates preserve cached thread rows", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    const parent = { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false, permissionOverwrites: [] };
    const thread = {
      id: "thread-1",
      guildId: "guild-1",
      parentId: "channel-1",
      name: "joined thread",
      topic: null,
      position: 0,
      type: 11,
      nsfw: false,
      thread: {
        ownerId: "self",
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
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [parent];
    state.sidebar.cachedChannelsByGuildId["guild-1"] = [parent, thread];

    handleGatewayThreadListSync(state, { scheduleRender: () => {} }, {
      guildId: "guild-1",
      parentChannelIds: null,
      threads: [],
      authoritative: false,
    });
    expect(state.channelList.channels.map((channel) => channel.id)).toContain("thread-1");

    handleGatewayChannelCreateOrUpdate(state, { scheduleRender: () => {} }, { ...parent, name: "renamed" });
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]?.map((channel) => channel.id)).toContain("thread-1");
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]?.find((channel) => channel.id === "thread-1")?.thread?.joined).toBe(true);
  });

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
    const whatsAppChannel = whatsappChannelId("person@s.whatsapp.net");
    state.notifications.byChannelId[whatsAppChannel] = 2;
    // Prefix detection must preserve this even if a concurrent provider event
    // has not populated channelGuildIds yet.

    clearReadOnlyClient(state);

    expect(state.panelFocus === "chat").toBe(true);
    expect(state.chatFocus === "prompt").toBe(true);
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID]);
    expect(state.channelList.channels).toEqual([]);
    expect(state.timeline.messages).toEqual([]);
    expect(state.memberList.members).toEqual([]);
    expect(state.sidebar.requestId).toBe(4);
    expect(state.channelList.requestId).toBe(8);
    expect(state.timeline.requestId).toBe(12);
    expect(state.memberList.requestId).toBe(14);
    expect(state.notifications.byChannelId[whatsAppChannel]).toBe(2);
    expect(state.notifications.channelGuildIds[whatsAppChannel]).toBe(WHATSAPP_GUILD_ID);
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
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID]);

    resolveDms(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
    await bootstrap;

    expect(state.sidebar.loading).toBe(false);
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID]);
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
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID, "guild-1", "guild-2", "guild-new"]);
    expect(state.sidebar.guilds.map((guild) => guild.name)).toEqual([DIRECT_MESSAGES_GUILD_NAME, WHATSAPP_GUILD_NAME, "One Fresh", "Two Fresh", "New"]);
  });

  test("bootstrap warms persisted member lists for voice participant name fallback", async () => {
    saveCachedMemberList("self", "guild-1", "voice-1", [
      { id: "user-1", username: "alice", displayName: "Alice", bot: false },
    ]);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/users/@me/guilds")) return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/gateway")) return new Response(JSON.stringify({ url: "wss://gateway.example" }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };

    await bootstrapReadOnlyClient(state, "token-1", { scheduleRender: () => {} });

    expect(state.memberList.cache.get("guild-1:voice-1")).toEqual([
      { id: "user-1", username: "alice", displayName: "Alice", bot: false },
    ]);
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
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID, "guild-2", "guild-1", "guild-3"]);
  });

  test("bootstrap preserves local folders when the guild cache is cold", async () => {
    saveCachedSidebarFolders("self", {
      folders: [{ id: "folder-1", name: "Friends", parentId: null, pinned: false, sortOrder: 1 }],
      guildPlacements: {
        "guild-1": { folderId: "folder-1", pinned: false, sortOrder: 0 },
        "guild-2": { folderId: null, pinned: false, sortOrder: 2 },
      },
    });

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

    expect(state.sidebar.folders.map((folder) => folder.name)).toEqual(["Friends"]);
    expect(state.sidebar.guildPlacements["guild-1"]?.folderId).toBe("folder-1");
    expect(loadCachedSidebarFolders("self")?.folders.map((folder) => folder.name)).toEqual(["Friends"]);
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
      if (url.includes("/channels/visible/threads/search") || url.includes("/channels/hidden/threads/search")) {
        return new Response(JSON.stringify({ threads: [], members: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
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

  test("opening a server focuses it without switching chat history", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/guilds/guild-2/channels")) {
        return new Response(JSON.stringify([
          { id: "channel-2", guild_id: "guild-2", parent_id: null, name: "other", topic: null, position: 0, type: 0, nsfw: false },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/channel-2/threads/search")) {
        return new Response(JSON.stringify({ threads: [], members: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.sidebar.guilds = [
      { id: "guild-1", name: "Guild One", icon: null },
      { id: "guild-2", name: "Guild Two", icon: null },
    ];
    state.sidebar.activeGuildId = "guild-1";
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0]!;
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [message("1", "still here", "channel-1")];

    await loadGuildChannels(state, "token-1", "guild-2", { scheduleRender: () => {} }, { openFirstChannel: false });

    expect(state.sidebar.focusedGuildId).toBe("guild-2");
    expect(state.sidebar.expandedGuildId).toBe("guild-2");
    expect(state.sidebar.activeGuildId).toBe("guild-1");
    expect(state.channelList.activeChannelId).toBe("channel-1");
    expect(state.channelList.activeChannel?.id).toBe("channel-1");
    expect(state.timeline.channelId).toBe("channel-1");
    expect(state.timeline.messages.map((entry) => entry.content)).toEqual(["still here"]);
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

  test("loading a channel acks the channel read-state frontier even when cache is stale", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/ack")) {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.guildId = DIRECT_MESSAGES_GUILD_ID;
    state.channelList.channels = [{
      id: "dm-1",
      guildId: DIRECT_MESSAGES_GUILD_ID,
      parentId: null,
      name: "Felipe Toro",
      topic: null,
      position: 0,
      type: 1,
      nsfw: false,
      lastMessageId: "50",
    }];
    state.messageCacheByChannelId["dm-1"] = {
      channelId: "dm-1",
      messages: [message("10", "cached", "dm-1")],
      hasOlder: false,
      updatedAt: Date.now(),
      latestFetchedAt: Date.now(),
    };

    await loadChannelMessages(state, "token-1", "dm-1", { scheduleRender: () => {} });

    expect(requestedUrls).toContain("https://discord.com/api/v9/channels/dm-1/messages/50/ack");
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

  test("loading latest channel messages clears newer pagination after an around jump", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/channel-1/messages?")) {
        return new Response(JSON.stringify([{
          id: "9",
          channel_id: "channel-1",
          guild_id: "guild-1",
          type: 0,
          content: "latest",
          timestamp: "2026-01-01T12:09:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          attachments: [],
          embeds: [],
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/ack")) {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.activeChannelId = "channel-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [message("1", "around target")];
    state.timeline.hasNewer = true;

    const loaded = await loadLatestChannelMessages(state, "token-1", "channel-1", { scheduleRender: () => {} });

    expect(loaded).toBe(true);
    expect(state.timeline.hasNewer).toBe(false);
    expect(state.timeline.loading).toBe(false);
    expect(state.timeline.messages.map((entry) => entry.content)).toEqual(["latest"]);
  });

  test("loading a channel hydrates missing reply previews with a direct message fetch", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/channel-1/messages?")) {
        return new Response(JSON.stringify([{
          id: "43",
          channel_id: "channel-1",
          guild_id: "guild-1",
          type: 0,
          content: "reply body",
          timestamp: "2026-01-01T12:43:00.000Z",
          edited_timestamp: null,
          author: { id: "user-1", username: "tester", global_name: "Tester" },
          message_reference: { message_id: "42", channel_id: "channel-1" },
          referenced_message: null,
          attachments: [],
          embeds: [],
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/channels/channel-1/messages/42")) {
        return new Response(JSON.stringify({
          id: "42",
          channel_id: "channel-1",
          guild_id: "guild-1",
          type: 0,
          content: "real original",
          timestamp: "2026-01-01T12:42:00.000Z",
          edited_timestamp: null,
          author: { id: "user-2", username: "alice", global_name: "Alice" },
          attachments: [],
          embeds: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    await waitForCondition(() => state.timeline.messages[0]?.reply?.summary === "real original");

    expect(state.timeline.messages[0]?.reply).toMatchObject({
      messageId: "42",
      authorId: "user-2",
      authorDisplayName: "Alice",
      summary: "real original",
    });
    expect(state.messageCacheByChannelId["channel-1"]?.messages[0]?.reply?.summary).toBe("real original");
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

  test("refreshing stale cached messages preserves manual timeline scroll", async () => {
    let resolveMessages: (response: Response) => void = () => {};
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/channel-1/messages?")) {
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
      messages: Array.from({ length: 60 }, (_unused, index) => message(String(index + 1), `cached ${index + 1}`)),
      hasOlder: true,
      updatedAt: 0,
      latestFetchedAt: 0,
    };

    await loadChannelMessages(state, "token-1", "channel-1", { scheduleRender: () => {} });
    expect(state.timeline.messages.at(-1)?.content).toBe("cached 60");

    state.timeline.scrollOffset = 12;
    state.timeline.maxScroll = 80;

    resolveMessages(new Response(JSON.stringify([{
      id: "61",
      channel_id: "channel-1",
      guild_id: "guild-1",
      type: 0,
      content: "from rest",
      timestamp: "2026-01-01T13:01:00.000Z",
      edited_timestamp: null,
      author: { id: "user-1", username: "tester", global_name: "Tester" },
      attachments: [],
      embeds: [],
    }]), { status: 200, headers: { "Content-Type": "application/json" } }));
    await flushTimers();

    expect(state.timeline.messages.at(-1)?.content).toBe("from rest");
    expect(state.timeline.scrollOffset).toBe(12);
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

  test("sending to an unjoined thread joins it before posting", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.includes("/thread-members/@me")) return new Response("", { status: 204 });
      if (url.endsWith("/channels/thread-1/messages") && method === "POST") {
        return new Response(JSON.stringify({
          id: "message-1",
          channel_id: "thread-1",
          guild_id: "guild-1",
          content: "hello thread",
          timestamp: "2026-08-01T12:00:00.000Z",
          edited_timestamp: null,
          author: { id: "self", username: "self", global_name: "Self" },
          attachments: [],
          embeds: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{
      id: "thread-1",
      guildId: "guild-1",
      parentId: "channel-1",
      name: "release talk",
      topic: null,
      position: 0,
      type: 11,
      nsfw: false,
      thread: {
        ownerId: "other",
        archived: false,
        locked: false,
        invitable: true,
        autoArchiveDuration: 1440,
        archiveTimestamp: null,
        createTimestamp: null,
        joined: false,
        messageCount: 0,
        memberCount: 1,
        totalMessageSent: 0,
      },
    }];
    state.channelList.activeChannelId = "thread-1";
    state.channelList.activeChannel = state.channelList.channels[0]!;
    state.timeline.channelId = "thread-1";

    sendCurrentChannelMessage(state, "token-1", "hello thread", { scheduleRender: () => {} });
    await waitForCondition(() => state.timeline.messages[0]?.localStatus === undefined);

    expect(requests).toEqual([
      { url: "https://discord.com/api/v9/channels/thread-1/thread-members/@me?location=Sidebar%20Overflow", method: "POST" },
      { url: "https://discord.com/api/v9/channels/thread-1/messages", method: "POST" },
    ]);
    expect(state.channelList.activeChannel?.thread?.joined).toBe(true);
    expect(state.timeline.messages[0]?.content).toBe("hello thread");
  });

  test("focuses a thread channel opened from a creation message even when it is not loaded", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/channels/thread-1")) {
        return new Response(JSON.stringify({
          id: "thread-1",
          guild_id: "guild-1",
          parent_id: "channel-1",
          owner_id: "self",
          name: "release talk",
          type: 11,
          thread_metadata: {
            archived: false,
            auto_archive_duration: 1440,
            archive_timestamp: "2026-08-01T12:00:00.000Z",
            locked: false,
          },
          message_count: 0,
          member_count: 1,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/thread-1/messages?limit=50")) {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.expandedGuildId = "guild-1";
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [
      { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
    ];
    state.sidebar.cachedChannelsByGuildId["guild-1"] = state.channelList.channels;
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0]!;
    state.timeline.channelId = "channel-1";

    expect(await focusThreadChannel(state, "token-1", "thread-1", { scheduleRender: () => {} }, "guild-1")).toBe(true);

    expect(state.timeline.channelId).toBe("thread-1");
    expect(state.channelList.activeChannelId).toBe("thread-1");
    expect(state.sidebar.selectedItem).toEqual({ type: "channel", id: "thread-1", guildId: "guild-1" });
    expect(state.timeline.emptyText).toContain("No messages in this thread yet");
    expect(requestedUrls.filter((url) => url.includes("/channels/thread-1"))).toEqual([
      "https://discord.com/api/v9/channels/thread-1",
      "https://discord.com/api/v9/channels/thread-1/messages?limit=50",
    ]);
  });

  test("sending images appends local attachments and clears pending images", () => {
    let requestedBody: BodyInit | null | undefined = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = init?.body;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
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
    const pendingNonce = state.timeline.messages[0]?.nonce;
    expect(pendingNonce).toMatch(/^\d+$/);
    expect(requestedBody).toBeInstanceOf(FormData);
    const payload = JSON.parse(String((requestedBody as unknown as FormData).get("payload_json")));
    expect(payload.nonce).toBe(pendingNonce);
  });

  test("uploading a local file appends a pending attachment message", async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "record-upload-session-test-"));
    const path = join(dir, "note.txt");
    writeFileSync(path, "hello upload");

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";

    uploadCurrentChannelFile(state, "token-1", path, { scheduleRender: () => {} });

    await waitForCondition(() => state.timeline.messages.length > 0);
    expect(state.timeline.messages[0]).toMatchObject({
      content: "",
      localStatus: "pending",
      attachments: [{ filename: "note.txt", contentType: "text/plain", size: "hello upload".length }],
    });
    expect(state.editor.buffer).toBe("");
    expect(state.notice).toMatchObject({ text: "Uploading note.txt…", loading: true, statusLine: true, chat: false });
  });

  test("uploading a missing local file shows a warning", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.channelList.activeChannelId = "channel-1";

    uploadCurrentChannelFile(state, "token-1", "/definitely/missing/file.txt", { scheduleRender: () => {} });

    expect(state.notice.tone).toBe("warning");
    expect(state.notice.text).toContain("Upload failed:");
    expect(state.notice.statusLine).toBe(true);
    expect(state.notice.chat).toBe(false);
  });

  test("uploading an oversized local file shows compressing feedback before upload", async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "record-upload-session-test-"));
    const path = join(dir, "huge.txt");
    writeFileSync(path, "a".repeat(8 * 1024 * 1024 + 1));

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";

    uploadCurrentChannelFile(state, "token-1", path, { scheduleRender: () => {} });

    expect(state.notice).toMatchObject({ text: "Compressing huge.txt…", loading: true, statusLine: true, chat: false });

    await waitForCondition(() => state.notice.text === "Uploading huge.txt.gz…");
    expect(state.notice).toMatchObject({ text: "Uploading huge.txt.gz…", loading: true, statusLine: true, chat: false });
  });

  test("failed uploads show the error in the status line", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 })) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "record-upload-session-test-"));
    const path = join(dir, "note.txt");
    writeFileSync(path, "hello upload");

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.timeline.channelId = "channel-1";

    uploadCurrentChannelFile(state, "token-1", path, { scheduleRender: () => {} });
    await waitForCondition(() => state.notice.tone === "warning");

    expect(state.notice).toMatchObject({
      text: "Upload failed: Discord denied access to that resource.",
      tone: "warning",
      statusLine: true,
      chat: false,
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
      expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID, "guild-1", "guild-2"]);

      saveCachedGuildOrder("self", ["guild-2", "guild-1"]);
      await waitForCondition(() => state.sidebar.guilds.map((guild) => guild.id).join(",") === `${DIRECT_MESSAGES_GUILD_ID},${WHATSAPP_GUILD_ID},guild-2,guild-1`);
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

  test("moving and pinning a DM is local-only and persists its account-scoped layout", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.open = true;
    state.sidebar.guilds = [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }];
    state.sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
    state.channelList.guildId = DIRECT_MESSAGES_GUILD_ID;
    state.channelList.channels = [
      { id: "dm-a", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Alice", topic: null, position: 0, type: 1, nsfw: false },
      { id: "dm-b", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Friends", topic: null, position: 1, type: 3, nsfw: false },
    ];
    state.sidebar.selectedIndex = 2;

    moveSelectedGuildOrder(state, { scheduleRender: () => {} }, "up");
    toggleSelectedPrivateConversationPin(state, { scheduleRender: () => {} });

    expect(state.sidebar.channelPlacementsByGuildId[DIRECT_MESSAGES_GUILD_ID]).toEqual({
      "dm-a": { pinned: false, sortOrder: 1 },
      "dm-b": { pinned: true, sortOrder: 0 },
    });
    expect(loadCachedSidebarChannelLayout("self")?.[DIRECT_MESSAGES_GUILD_ID]).toEqual({
      "dm-a": { pinned: false, sortOrder: 1 },
      "dm-b": { pinned: true, sortOrder: 0 },
    });
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

  test("muting a category updates its override and clears child notifications", () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.open = true;
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.expandedGuildId = "guild-1";
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [
      { id: "category-1", guildId: "guild-1", parentId: null, name: "News", topic: null, position: 0, type: 4, nsfw: false },
      { id: "channel-1", guildId: "guild-1", parentId: "category-1", name: "announcements", topic: null, position: 1, type: 0, nsfw: false },
    ];
    state.sidebar.cachedChannelsByGuildId["guild-1"] = state.channelList.channels;
    state.sidebar.selectedIndex = 1;
    state.notifications.byChannelId["channel-1"] = 3;
    state.notifications.channelGuildIds["channel-1"] = "guild-1";

    toggleSelectedGuildMute(state, { scheduleRender: () => {} });

    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]?.find((channel) => channel.id === "category-1")?.muted).toBe(true);
    expect(state.notifications.byChannelId["channel-1"]).toBeUndefined();
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
  });

  test("muting a guild channel updates its local mute state", () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.open = true;
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.expandedGuildId = "guild-1";
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [
      { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
    ];
    state.sidebar.cachedChannelsByGuildId["guild-1"] = state.channelList.channels;
    state.sidebar.selectedIndex = 1;

    toggleSelectedGuildMute(state, { scheduleRender: () => {} });

    expect(state.channelList.channels[0]?.muted).toBe(true);
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]?.[0]?.muted).toBe(true);
  });

  test("muting a DM updates channel state, clears notifications, and patches Discord settings", () => {
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.open = true;
    state.sidebar.guilds = [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }];
    state.sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
    state.sidebar.selectedIndex = 1;
    state.channelList.guildId = DIRECT_MESSAGES_GUILD_ID;
    state.channelList.channels = [{ id: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Alice", topic: null, position: 0, type: 1, nsfw: false }];
    state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID] = state.channelList.channels;
    state.notifications.byChannelId["dm-1"] = 2;
    state.notifications.channelGuildIds["dm-1"] = DIRECT_MESSAGES_GUILD_ID;

    toggleSelectedGuildMute(state, { scheduleRender: () => {} });

    expect(state.channelList.channels[0]?.muted).toBe(true);
    expect(state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID]?.[0]?.muted).toBe(true);
    expect(state.notifications.byChannelId["dm-1"]).toBeUndefined();
    expect(loadCachedDirectMessages("self")?.[0]?.muted).toBe(true);
    expect(requests[0]?.url).toBe("https://discord.com/api/v9/users/@me/guilds/%40me/settings");
    expect(requests[0]?.body).toEqual({
      channel_overrides: {
        "dm-1": {
          muted: true,
          mute_config: { end_time: null, selected_time_window: -1 },
        },
      },
    });
  });

  test("gateway DM messages badge Direct Messages before the DM list is open", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }];
    state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID] = [{
      id: "dm-1",
      guildId: DIRECT_MESSAGES_GUILD_ID,
      parentId: null,
      name: "Alice",
      topic: null,
      position: 0,
      type: 1,
      nsfw: false,
    }];
    state.channelList.guildId = null;
    state.channelList.channels = [];

    const dmMessage = message("2", "hello", "dm-1");
    delete dmMessage.guildId;
    handleGatewayMessageCreate(state, { scheduleRender: () => {} }, dmMessage);

    expect(state.notifications.byChannelId["dm-1"]).toBe(1);
    expect(state.notifications.channelGuildIds["dm-1"]).toBe(DIRECT_MESSAGES_GUILD_ID);
    expect(guildNotificationCounts(state.notifications, state.channelList.channels).get(DIRECT_MESSAGES_GUILD_ID)).toBe(1);
  });

  test("ignores delayed voice-session disconnects after the same user rejoins", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Voice", topic: null, position: 0, type: 2, nsfw: false }];
    const effects = { scheduleRender: () => {} };

    handleVoiceStateUpdate(state, effects, {
      userId: "self",
      channelId: "voice-1",
      guildId: "guild-1",
      sessionId: "current-session",
      displayName: "Self",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    expect(state.sidebar.voiceMembersByChannelId["voice-1"]?.map((member) => member.userId)).toEqual(["self"]);

    handleVoiceStateUpdate(state, effects, {
      userId: "self",
      channelId: null,
      guildId: null,
      sessionId: "older-session",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    expect(state.sidebar.voiceMembersByChannelId["voice-1"]?.map((member) => member.userId)).toEqual(["self"]);

    handleVoiceStateUpdate(state, effects, {
      userId: "self",
      channelId: null,
      guildId: "guild-1",
      sessionId: "current-session",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    expect(state.sidebar.voiceMembersByChannelId["voice-1"]).toBeUndefined();

    clearReadOnlyClient(state);
  });

  test("muting a selected voice sidebar member is local and displays the local-muted bell state", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.open = true;
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.expandedGuildId = "guild-1";
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Voice", topic: null, position: 0, type: 2, nsfw: false }];
    const effects = { renders: 0, scheduleRender: () => { effects.renders += 1; } };

    handleVoiceStateUpdate(state, effects, {
      userId: "friend",
      channelId: "voice-1",
      guildId: "guild-1",
      sessionId: "voice-session-friend",
      displayName: "Friend",
      selfMute: false,
      selfDeaf: false,
      selfStream: true,
      mute: false,
      deaf: false,
    });
    state.sidebar.selectedIndex = 2;
    effects.renders = 0;

    toggleSelectedGuildMute(state, effects);

    expect(state.sidebar.voiceMembersByChannelId["voice-1"]?.[0]).toMatchObject({ userId: "friend", localMuted: true, streaming: true });
    expect(state.notice.text).toBe("");
    expect(effects.renders).toBeGreaterThan(0);

    toggleSelectedGuildMute(state, effects);
    expect(state.sidebar.voiceMembersByChannelId["voice-1"]?.[0]?.localMuted).toBe(false);

    handleVoiceStateUpdate(state, effects, {
      userId: "friend",
      channelId: "voice-1",
      guildId: "guild-1",
      sessionId: "voice-session-friend",
      displayName: "Friend",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    expect(state.sidebar.voiceMembersByChannelId["voice-1"]?.[0]?.streaming).toBe(false);

    clearReadOnlyClient(state);
  });

  test("adjusts a remote voice member in 10 percent steps and clamps to Discord's 0-200 range", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    let renders = 0;
    const effects = { scheduleRender: () => { renders += 1; } };

    expect(voiceMemberVolume("volume-friend")).toBe(100);
    expect(adjustVoiceMemberVolume(state, effects, "volume-friend", -10)).toBe(90);
    expect(voiceMemberVolume("volume-friend")).toBe(90);
    expect(adjustVoiceMemberVolume(state, effects, "volume-friend", -1000)).toBe(0);
    expect(adjustVoiceMemberVolume(state, effects, "volume-friend", 1000)).toBe(200);
    expect(adjustVoiceMemberVolume(state, effects, "self", -10)).toBe(100);
    expect(renders).toBe(3);

    clearReadOnlyClient(state);
    expect(voiceMemberVolume("volume-friend")).toBe(100);
  });

  test("voice actions use channel permissions while kick and ban also use role hierarchy", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null, permissions: "29360134" }];
    state.guildRolesByGuildId["guild-1"] = [
      { id: "guild-1", name: "@everyone", color: 0, position: 0, permissions: "0" },
      { id: "target-role", name: "Member", color: 0, position: 1, permissions: "0" },
      { id: "mod-role", name: "Moderator", color: 0, position: 10, permissions: "29360134" },
      { id: "higher-role", name: "Admin", color: 0, position: 20, permissions: "0" },
    ];
    state.roleIdsByGuildId["guild-1"] = ["mod-role"];
    state.channelList.channels = [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Voice", topic: null, position: 0, type: 2, nsfw: false }];
    const effects = { scheduleRender: () => {} };

    handleVoiceStateUpdate(state, effects, {
      userId: "friend",
      channelId: "voice-1",
      guildId: "guild-1",
      sessionId: "voice-session-friend",
      roleIds: ["target-role"],
      selfMute: false,
      selfDeaf: false,
      mute: true,
      deaf: false,
    });

    expect(voiceMemberModerationContext(state, "guild-1", "voice-1", "friend")).toEqual({
      serverMuted: true,
      serverDeafened: false,
      canServerMute: true,
      canServerDeafen: true,
      canKickFromVc: true,
      canKickFromServer: true,
      canBanFromServer: true,
    });

    handleGuildMembersChunk(state, effects, "guild-1", [{
      id: "friend",
      username: "friend",
      displayName: "Friend",
      bot: false,
      roleIds: ["higher-role"],
    }]);
    expect(voiceMemberModerationContext(state, "guild-1", "voice-1", "friend")).toMatchObject({
      canServerMute: true,
      canServerDeafen: true,
      canKickFromVc: true,
      canKickFromServer: false,
      canBanFromServer: false,
    });

    state.channelList.channels[0] = { ...state.channelList.channels[0]!, type: 13 };
    expect(voiceMemberModerationContext(state, "guild-1", "voice-1", "friend")).toMatchObject({
      canServerMute: true,
      canServerDeafen: false,
      canKickFromVc: true,
    });

    const voicePermissionDeny = String((1 << 22) + (1 << 23) + (1 << 24));
    state.channelList.channels[0] = {
      ...state.channelList.channels[0]!,
      type: 2,
      permissionOverwrites: [{ id: "self", type: 1, allow: "0", deny: voicePermissionDeny }],
    };
    expect(voiceMemberModerationContext(state, "guild-1", "voice-1", "friend")).toMatchObject({
      canServerMute: false,
      canServerDeafen: false,
      canKickFromVc: false,
    });

    clearReadOnlyClient(state);
  });

  test("channel deletion requires the correct effective channel or thread permission", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.roleIdsByGuildId["guild-1"] = ["mod-role"];
    const viewChannel = 1n << 10n;
    const manageChannels = 1n << 4n;
    const manageThreads = 1n << 34n;
    state.guildRolesByGuildId["guild-1"] = [
      { id: "guild-1", name: "@everyone", color: 0, position: 0, permissions: "0" },
      { id: "mod-role", name: "Moderator", color: 0, position: 1, permissions: String(viewChannel | manageChannels | manageThreads) },
    ];
    state.channelList.channels = [
      { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
      {
        id: "thread-1",
        guildId: "guild-1",
        parentId: "channel-1",
        name: "discussion",
        topic: null,
        position: 0,
        type: 11,
        nsfw: false,
        thread: { ownerId: "other", archived: false, locked: false, invitable: null, autoArchiveDuration: 1440, archiveTimestamp: null, createTimestamp: null, joined: true, messageCount: 0, memberCount: 1, totalMessageSent: 0 },
      },
    ];

    expect(canDeleteGuildChannel(state, "guild-1", "channel-1")).toBe(true);
    expect(canDeleteGuildChannel(state, "guild-1", "thread-1")).toBe(true);

    state.channelList.channels[0] = {
      ...state.channelList.channels[0]!,
      permissionOverwrites: [{ id: "self", type: 1, allow: "0", deny: String(manageThreads) }],
    };
    expect(canDeleteGuildChannel(state, "guild-1", "channel-1")).toBe(true);
    expect(canDeleteGuildChannel(state, "guild-1", "thread-1")).toBe(false);

    state.guildRolesByGuildId["guild-1"]![1] = {
      ...state.guildRolesByGuildId["guild-1"]![1]!,
      permissions: String(viewChannel | manageThreads),
    };
    state.channelList.channels[0] = {
      ...state.channelList.channels[0]!,
      permissionOverwrites: [],
    };
    expect(canDeleteGuildChannel(state, "guild-1", "channel-1")).toBe(false);
    expect(canDeleteGuildChannel(state, "guild-1", "thread-1")).toBe(true);

    state.guildRolesByGuildId["guild-1"]![1] = {
      ...state.guildRolesByGuildId["guild-1"]![1]!,
      permissions: String(manageChannels | manageThreads),
    };
    expect(canDeleteGuildChannel(state, "guild-1", "channel-1")).toBe(false);
    expect(canDeleteGuildChannel(state, "guild-1", "thread-1")).toBe(false);
  });

  test("guild owners and administrators can delete channels without overwrite metadata", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null, ownerId: "self" }];
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];

    expect(canDeleteGuildChannel(state, "guild-1", "channel-1")).toBe(true);

    state.sidebar.guilds[0] = { id: "guild-1", name: "Guild", icon: null };
    state.roleIdsByGuildId["guild-1"] = ["admin-role"];
    state.guildRolesByGuildId["guild-1"] = [
      { id: "guild-1", name: "@everyone", color: 0, position: 0, permissions: "0" },
      { id: "admin-role", name: "Admin", color: 0, position: 1, permissions: String(1n << 3n) },
    ];
    expect(canDeleteGuildChannel(state, "guild-1", "channel-1")).toBe(true);
    expect(canDeleteGuildChannel(state, DIRECT_MESSAGES_GUILD_ID, "channel-1")).toBe(false);
  });

  test("removes a successfully deleted channel and its threads from live and cached session state", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    const channel = { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false };
    const thread = { id: "thread-1", guildId: "guild-1", parentId: channel.id, name: "discussion", topic: null, position: 0, type: 11, nsfw: false };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [channel, thread];
    state.channelList.activeChannelId = thread.id;
    state.channelList.activeChannel = thread;
    state.sidebar.cachedChannelsByGuildId["guild-1"] = [channel, thread];
    state.timeline.channelId = thread.id;
    state.messageCacheByChannelId[channel.id] = { channelId: channel.id, messages: [], hasOlder: false, updatedAt: 0, latestFetchedAt: null };
    state.messageCacheByChannelId[thread.id] = { channelId: thread.id, messages: [], hasOlder: false, updatedAt: 0, latestFetchedAt: null };
    state.notifications.byChannelId[channel.id] = 2;
    state.notifications.channelGuildIds[channel.id] = "guild-1";
    state.notifications.byChannelId[thread.id] = 1;
    state.notifications.channelGuildIds[thread.id] = "guild-1";

    removeSessionChannel(state, { scheduleRender: () => {} }, channel.id, "guild-1");

    expect(state.channelList.channels).toEqual([]);
    expect(state.channelList.activeChannelId).toBeNull();
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]).toEqual([]);
    expect(state.timeline.channelId).toBeNull();
    expect(state.messageCacheByChannelId[channel.id]).toBeUndefined();
    expect(state.messageCacheByChannelId[thread.id]).toBeUndefined();
    expect(state.notifications.byChannelId[channel.id]).toBeUndefined();
    expect(state.notifications.byChannelId[thread.id]).toBeUndefined();
    expect(state.notice.text).toBe("Channel or thread was deleted.");
    expect(state.notice.statusLine).toBe(false);
  });

  test("does not resurrect a deleted thread from late REST or gateway snapshots", async () => {
    let markSearchStarted!: () => void;
    const searchStarted = new Promise<void>((resolve) => { markSearchStarted = resolve; });
    let resolveSearchResponse!: (response: Response) => void;
    const searchResponse = new Promise<Response>((resolve) => { resolveSearchResponse = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/guilds/guild-1/channels")) {
        return new Response(JSON.stringify([
          { id: "channel-1", guild_id: "guild-1", parent_id: null, name: "general", position: 0, type: 0, permission_overwrites: [] },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/channel-1/threads/search?")) {
        markSearchStarted();
        return searchResponse;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.roleIdsByGuildId["guild-1"] = [];
    const parent = { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false, permissionOverwrites: [] };
    const thread = {
      id: "thread-1",
      guildId: "guild-1",
      parentId: parent.id,
      name: "discussion",
      topic: null,
      position: 0,
      type: 11,
      nsfw: false,
      thread: { ownerId: "self", archived: false, locked: false, invitable: null, autoArchiveDuration: 1440, archiveTimestamp: null, createTimestamp: null, joined: true, messageCount: 0, memberCount: 1, totalMessageSent: 0 },
    };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [parent, thread];
    state.sidebar.cachedChannelsByGuildId["guild-1"] = [parent, thread];

    const load = loadGuildChannels(state, "token-1", "guild-1", { scheduleRender: () => {} }, { openFirstChannel: false });
    await searchStarted;
    removeSessionChannel(state, { scheduleRender: () => {} }, thread.id, "guild-1");
    resolveSearchResponse(new Response(JSON.stringify({
      threads: [{
        id: thread.id,
        guild_id: "guild-1",
        parent_id: parent.id,
        name: thread.name,
        position: 0,
        type: 11,
        owner_id: "self",
        thread_metadata: { archived: false, locked: false, auto_archive_duration: 1440 },
      }],
      members: [{ id: thread.id, user_id: "self" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await load;

    expect(state.channelList.channels.map((channel) => channel.id)).toEqual([parent.id]);
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]?.map((channel) => channel.id)).toEqual([parent.id]);

    handleGatewayThreadListSync(state, { scheduleRender: () => {} }, {
      guildId: "guild-1",
      parentChannelIds: [parent.id],
      threads: [thread],
      authoritative: false,
    });
    handleGatewayChannelCreateOrUpdate(state, { scheduleRender: () => {} }, thread);

    expect(state.channelList.channels.map((channel) => channel.id)).toEqual([parent.id]);
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]?.map((channel) => channel.id)).toEqual([parent.id]);
  });

  test("removes a stale cached thread when opening it returns not found", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/channels/thread-1/messages?")) {
        return new Response(JSON.stringify({ message: "Unknown Channel", code: 10003 }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    const thread = { id: "thread-1", guildId: "guild-1", parentId: "channel-1", name: "deleted", topic: null, position: 0, type: 11, nsfw: false };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [thread];
    state.sidebar.cachedChannelsByGuildId["guild-1"] = [thread];

    await loadChannelMessages(state, "token-1", thread.id, { scheduleRender: () => {} });

    expect(state.channelList.channels).toEqual([]);
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]).toEqual([]);
    expect(state.timeline.channelId).toBeNull();
    expect(state.notice.text).toBe("Channel or thread was deleted.");
    expect(state.notice.statusLine).toBe(false);
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

  test("collects active call participants from call messages", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    const activeCall = {
      ...message("10", "", "dm-1"),
      guildId: DIRECT_MESSAGES_GUILD_ID,
      type: 3,
      call: { endedTimestamp: null, participantIds: ["self", "friend"] },
    };
    const endedCall = {
      ...message("9", "", "dm-1"),
      guildId: DIRECT_MESSAGES_GUILD_ID,
      type: 3,
      call: { endedTimestamp: Date.UTC(2026, 0, 1, 12, 0, 9), participantIds: ["self", "old-friend"] },
    };
    state.timeline.channelId = "dm-1";
    state.timeline.messages = [endedCall, activeCall];
    state.messageCacheByChannelId["dm-1"] = {
      channelId: "dm-1",
      messages: [activeCall],
      hasOlder: false,
      updatedAt: 0,
      latestFetchedAt: null,
    };

    expect(activeCallMessageParticipantIds(state, "dm-1")).toEqual(["self", "friend"]);
  });

  test("does not keep departed call participants alive from stale call messages", () => {
    expect(resolveRemoteCallParticipantIds(
      "self",
      ["self", "friend", "other"],
      ["friend", "other"],
      ["friend"],
    )).toEqual(["other"]);

    expect(resolveRemoteCallParticipantIds(
      "self",
      ["self", "friend", "other"],
      ["friend", "other", "newcomer"],
      [],
    )).toEqual(["friend", "other", "newcomer"]);

    expect(resolveRemoteCallParticipantIds(
      "self",
      [],
      [],
      [],
      ["self", "voice-state-user"],
    )).toEqual(["voice-state-user"]);
  });

  test("retains a call participant when the canonical voice state rejects a stale departure", () => {
    expect(shouldRetainTrackedCallParticipant("voice-1", null, true)).toBe(true);
    expect(shouldRetainTrackedCallParticipant("voice-1", "other-voice", true)).toBe(true);
    expect(shouldRetainTrackedCallParticipant("voice-1", null, false)).toBe(false);
    expect(shouldRetainTrackedCallParticipant("voice-1", "voice-1", true)).toBe(false);
  });

  test("restores participants confirmed present by fresh voice-state data", () => {
    const participants = new Set(["friend"]);
    const departed = new Set(["friend", "newcomer", "still-gone"]);

    rememberPresentCallParticipants("self", participants, departed, ["self", "friend", "newcomer"]);

    expect(Array.from(participants)).toEqual(["friend", "newcomer"]);
    expect(Array.from(departed)).toEqual(["still-gone"]);
    expect(resolveRemoteCallParticipantIds("self", [], Array.from(participants), Array.from(departed)))
      .toEqual(["friend", "newcomer"]);
  });

  test("hydrates generic voice sidebar members from requested guild member chunks", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "voice", topic: null, position: 0, type: 2, nsfw: false }];
    const effects = { renders: 0, scheduleRender: () => { effects.renders += 1; } };

    handleVoiceStateUpdate(state, effects, {
      userId: "123456789012345678",
      channelId: "voice-1",
      guildId: "guild-1",
      sessionId: "session-1",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });

    expect(state.sidebar.voiceMembersByChannelId["voice-1"]?.[0]?.displayName).toBe("Someone");

    handleGuildMembersChunk(state, effects, "guild-1", [
      { id: "123456789012345678", username: "alice", displayName: "Alice", bot: false, avatar: "avatar-1", roleIds: ["role-1"] },
    ]);

    expect(state.sidebar.voiceMembersByChannelId["voice-1"]?.[0]?.displayName).toBe("Alice");
    expect(state.memberList.cache.get("guild-1:voice-1")?.[0]).toMatchObject({ id: "123456789012345678", displayName: "Alice", avatar: "avatar-1" });
    expect(state.memberRoleIdsByGuildId["guild-1"]?.["123456789012345678"]).toEqual(["role-1"]);

    clearReadOnlyClient(state);
  });

  test("detects newly added remote call participants", () => {
    expect(newRemoteCallParticipantIds("self", ["self"], ["self", "friend"])).toEqual(["friend"]);
    expect(newRemoteCallParticipantIds("self", ["friend"], ["self", "friend", "other", "other"])).toEqual(["other"]);
    expect(newRemoteCallParticipantIds("self", ["friend", "other"], ["self", "friend", "other"])).toEqual([]);
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
