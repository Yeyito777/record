import { afterEach, describe, expect, test } from "bun:test";

import type { AppState } from "./state";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, type DiscordChannel, type DiscordMessage, type DiscordMessagePatch } from "./discord";
import { handleGatewayChannelCreateOrUpdate, handleGatewayMessageCreate, handleGatewayMessageUpdate, moveSelectedGuildOrder, sendCurrentChannelMessage, toggleSelectedPrivateConversationPin } from "./session";
import { buildSidebarEntries, renderSidebar } from "./sidebar";
import { createInitialState } from "./state";
import { DemoDiscordServer } from "./demo/server";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const effects = { scheduleRender: () => {} };

function dm(id: string, name: string, lastMessageId: string | null): DiscordChannel {
  return { id, guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name, topic: null, position: 0, type: 1, nsfw: false, lastMessageId };
}

function message(id: string, channelId: string, authorId = "friend"): DiscordMessage {
  return {
    id, channelId, type: 0, content: "hi", mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], mentionUsers: [],
    timestamp: Date.UTC(2026, 0, 1), editedTimestamp: null,
    author: { id: authorId, username: authorId, displayName: authorId, bot: false },
    reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
  };
}

/** Twelve DMs, newest first: dm 112 (last message 1112) … dm 101 (1101). */
function dmState(): AppState {
  const state = createInitialState("token-1", "/tmp/record-config.json");
  state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
  state.sidebar.open = true;
  state.sidebar.guilds = [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }];
  state.sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
  state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID] = Array.from({ length: 12 }, (_, index) => {
    const n = 101 + index;
    return dm(String(n), `Friend ${n}`, String(1000 + n));
  }).reverse();
  return state;
}

function order(state: AppState): string[] {
  return buildSidebarEntries(state.sidebar, state.channelList.channels)
    .filter((entry) => entry.kind === "channel")
    .map((entry) => entry.id);
}

function selectedId(state: AppState): string | undefined {
  return buildSidebarEntries(state.sidebar, state.channelList.channels)[state.sidebar.selectedIndex]?.id;
}

describe("DM order follows recent activity", () => {
  test("a received message bumps an unpinned DM to the top, live", () => {
    const state = dmState();
    expect(order(state).slice(0, 3)).toEqual(["112", "111", "110"]);
    handleGatewayMessageCreate(state, effects, message("2000", "103"));
    expect(order(state).slice(0, 3)).toEqual(["103", "112", "111"]);
  });

  test("your own message bumps it, sent here or from another device", async () => {
    const state = dmState();
    // From another device: Discord echoes it as a MESSAGE_CREATE authored by you.
    handleGatewayMessageCreate(state, effects, message("2000", "104", "self"));
    expect(order(state)[0]).toBe("104");

    // From here: the send reply carries the new id.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "2100", channel_id: "105", type: 0, content: "yo", timestamp: "2026-01-01T13:00:00.000Z", edited_timestamp: null,
      author: { id: "self", username: "self", global_name: "Self" }, attachments: [], embeds: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    state.channelList.guildId = DIRECT_MESSAGES_GUILD_ID;
    state.channelList.channels = state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID]!.map((channel) => ({ ...channel }));
    state.channelList.activeChannelId = "105";
    state.timeline.channelId = "105";
    sendCurrentChannelMessage(state, "token-1", "yo", effects);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order(state).slice(0, 2)).toEqual(["105", "104"]);
  });

  test("edits never move a chat", () => {
    const state = dmState();
    const patch = { id: "1101", channelId: "101", content: "edited", editedTimestamp: Date.UTC(2026, 0, 2) } as DiscordMessagePatch;
    handleGatewayMessageUpdate(state, effects, patch);
    expect(order(state).at(-1)).toBe("101");
    // An old id arriving late never moves a chat down either.
    handleGatewayMessageCreate(state, effects, message("1000", "112"));
    expect(order(state)[0]).toBe("112");
  });

  test("a newly opened DM starts at the top", () => {
    const state = dmState();
    handleGatewayChannelCreateOrUpdate(state, effects, dm("3000", "New friend", null));
    expect(order(state)[0]).toBe("3000");
  });

  test("pinned DMs keep their manual order; e/E on an unpinned DM only explains", () => {
    const state = dmState();
    state.sidebar.selectedItem = { type: "channel", id: "101", guildId: DIRECT_MESSAGES_GUILD_ID };
    toggleSelectedPrivateConversationPin(state, effects);
    state.sidebar.selectedItem = { type: "channel", id: "102", guildId: DIRECT_MESSAGES_GUILD_ID };
    toggleSelectedPrivateConversationPin(state, effects);
    expect(order(state).slice(0, 3)).toEqual(["101", "102", "112"]);

    // A message to a pinned chat leaves the pinned order alone.
    handleGatewayMessageCreate(state, effects, message("2000", "102"));
    expect(order(state).slice(0, 3)).toEqual(["101", "102", "112"]);
    moveSelectedGuildOrder(state, effects, "up");
    expect(order(state).slice(0, 3)).toEqual(["102", "101", "112"]);

    state.sidebar.selectedItem = { type: "channel", id: "110", guildId: DIRECT_MESSAGES_GUILD_ID };
    const before = order(state);
    moveSelectedGuildOrder(state, effects, "up");
    expect(order(state)).toEqual(before);
    expect(state.notice.text).toBe("Unpinned chats follow recent activity; pin one with p to arrange it.");
  });

  test("a manual order saved for unpinned chats is ignored; pinned placements still apply", () => {
    const state = dmState();
    state.sidebar.channelPlacementsByGuildId[DIRECT_MESSAGES_GUILD_ID] = {
      "101": { pinned: false, sortOrder: -50 },
      "105": { pinned: true, sortOrder: 0 },
    };
    expect(order(state).slice(0, 3)).toEqual(["105", "112", "111"]);
    expect(order(state).at(-1)).toBe("101");
  });

  test("muted DMs still move by recency", () => {
    const state = dmState();
    state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID] = state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID]!
      .map((channel) => channel.id === "106" ? { ...channel, muted: true } : channel);
    handleGatewayMessageCreate(state, effects, message("2000", "106"));
    expect(order(state)[0]).toBe("106");
  });

  test("the selection stays on the same chat and the sidebar does not scroll under it", () => {
    const state = dmState();
    state.panelFocus = "chat";
    const rows = 10;
    state.sidebar.selectedItem = { type: "channel", id: "108", guildId: DIRECT_MESSAGES_GUILD_ID };
    renderSidebar(state.sidebar, [], rows);
    const scrollBefore = state.sidebar.scrollOffset;
    expect(selectedId(state)).toBe("108");

    // A chat below the selection jumps over it: the cursor follows its chat.
    handleGatewayMessageCreate(state, effects, message("2000", "102"));
    renderSidebar(state.sidebar, [], rows);
    expect(selectedId(state)).toBe("108");
    expect(state.sidebar.scrollOffset).toBe(scrollBefore);
    expect(state.panelFocus).toBe("chat");

    // The selected chat itself jumps to the top: still selected, and the
    // viewport only moves because the row would otherwise leave the screen.
    state.sidebar.selectedItem = { type: "channel", id: "101", guildId: DIRECT_MESSAGES_GUILD_ID };
    renderSidebar(state.sidebar, [], rows);
    handleGatewayMessageCreate(state, effects, message("2001", "101"));
    const rendered = renderSidebar(state.sidebar, [], rows).join("\n");
    expect(selectedId(state)).toBe("101");
    expect(rendered).toContain("Friend 101");
  });
});

describe("demo", () => {
  test("!demo dm writes in the least recent DM so it jumps to the top", () => {
    const server = new DemoDiscordServer({ latencyMs: 0, olderPageDelayMs: 0 });
    const oldestFirst = () => server.world.directMessages.slice()
      .sort((a, b) => (BigInt(a.last_message_id ?? a.id) < BigInt(b.last_message_id ?? b.id) ? -1 : 1))
      .map((channel) => channel.id);
    const oldest = oldestFirst()[0]!;
    expect(server.emitDirectMessage()).toBe(oldest);
    expect(oldestFirst().at(-1)).toBe(oldest);
  });
});
