import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { setSidebarGuilds } from "./sidebar";
import { createInitialState } from "./state";
import {
  applyTuiStartingState,
  availableStartingChannel,
  captureTuiStartingState,
  loadTuiStartingState,
  saveTuiStartingState,
  tuiStartingStatePath,
  type TuiStartingState,
} from "./startingstate";

const previousXdg = process.env.XDG_CONFIG_HOME;
let testRoot = "";

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "record-starting-state-test-"));
  process.env.XDG_CONFIG_HOME = testRoot;
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

function startingState(overrides: Partial<TuiStartingState> = {}): TuiStartingState {
  return {
    version: 1,
    accountId: "account-1",
    focusedChannel: { guildId: "guild-1", channelId: "channel-1" },
    sidebar: { open: false },
    ...overrides,
  };
}

describe("TUI starting state", () => {
  test("captures the focused channel and an open sidebar cursor", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    state.auth.user = { id: "account-1", username: "me", globalName: "Me", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = { id: "channel-1", guildId: "guild-1", parentId: "category-1", name: "general", topic: null, position: 1, type: 0, nsfw: false };
    state.timeline.channelId = "channel-1";
    state.sidebar.open = true;
    state.sidebar.currentFolderId = "work";
    state.sidebar.focusedGuildId = "guild-2";
    state.sidebar.expandedGuildId = "guild-2";
    state.sidebar.collapsedCategoryIds = ["category-2"];
    state.sidebar.selectedItem = { type: "channel", id: "channel-2", guildId: "guild-2" };
    state.sidebar.scrollOffset = 7;

    expect(captureTuiStartingState(state)).toEqual({
      version: 1,
      accountId: "account-1",
      focusedChannel: { guildId: "guild-1", channelId: "channel-1" },
      sidebar: {
        open: true,
        currentFolderId: "work",
        focusedGuildId: "guild-2",
        expandedGuildId: "guild-2",
        collapsedCategoryIds: ["category-2"],
        selectedItem: { type: "channel", id: "channel-2", guildId: "guild-2" },
        scrollOffset: 7,
      },
    });
  });

  test("does not persist stale sidebar cursor details while the sidebar is closed", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.sidebar.open = false;
    state.sidebar.currentFolderId = "work";
    state.sidebar.selectedItem = { type: "folder", id: "nested" };
    state.sidebar.scrollOffset = 12;

    expect(captureTuiStartingState(state)).toEqual({
      version: 1,
      accountId: null,
      focusedChannel: null,
      sidebar: { open: false },
    });
    expect(captureTuiStartingState(state, "pending-account").accountId).toBe("pending-account");
  });

  test("seeds the saved sidebar state and preserves its cursor as lists arrive", () => {
    const saved = startingState({
      sidebar: {
        open: true,
        currentFolderId: "work",
        focusedGuildId: "guild-2",
        expandedGuildId: "guild-2",
        collapsedCategoryIds: ["category-2"],
        selectedItem: { type: "guild", id: "guild-2" },
        scrollOffset: 4,
      },
    });
    const state = createInitialState("token", "/tmp/record-config.json");
    state.sidebar.folders = [{ id: "work", name: "Work", parentId: null, pinned: false, sortOrder: 0 }];

    applyTuiStartingState(state, saved);
    setSidebarGuilds(state.sidebar, [
      { id: "guild-1", name: "One", icon: null },
      { id: "guild-2", name: "Two", icon: null },
    ]);

    expect(state.channelList.guildId).toBe("guild-1");
    expect(state.channelList.activeChannelId).toBe("channel-1");
    expect(state.timeline.channelId).toBe("channel-1");
    expect(state.sidebar.open).toBe(true);
    expect(state.sidebar.currentFolderId).toBe("work");
    expect(state.sidebar.focusedGuildId).toBe("guild-2");
    expect(state.sidebar.expandedGuildId).toBe("guild-2");
    expect(state.sidebar.collapsedCategoryIds).toEqual(["category-2"]);
    expect(state.sidebar.selectedItem).toEqual({ type: "guild", id: "guild-2" });
    expect(state.sidebar.scrollOffset).toBe(4);
  });

  test("only returns a channel for the authenticated account and an available guild", () => {
    const saved = startingState();
    const guilds = [{ id: "guild-1" }];

    expect(availableStartingChannel(saved, "account-1", guilds)).toEqual({ guildId: "guild-1", channelId: "channel-1" });
    expect(availableStartingChannel(saved, "another-account", guilds)).toBeNull();
    expect(availableStartingChannel(saved, "account-1", [{ id: "guild-2" }])).toBeNull();
  });

  test("atomically replaces the previous close's state", () => {
    const first = startingState({ focusedChannel: { guildId: "guild-1", channelId: "first" } });
    const second = startingState({ focusedChannel: { guildId: "guild-1", channelId: "second" } });

    saveTuiStartingState(first);
    const firstInode = statSync(tuiStartingStatePath()).ino;
    saveTuiStartingState(second);
    const secondInode = statSync(tuiStartingStatePath()).ino;

    if (process.platform !== "win32") expect(secondInode).not.toBe(firstInode);
    expect(loadTuiStartingState()).toEqual(second);
    expect(JSON.parse(readFileSync(tuiStartingStatePath(), "utf8"))).toEqual(second);
    expect(readdirSync(dirname(tuiStartingStatePath())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("ignores malformed or partially written state", () => {
    saveTuiStartingState(startingState());
    writeFileSync(tuiStartingStatePath(), '{"version":1,"accountId":');
    expect(loadTuiStartingState()).toBeNull();

    writeFileSync(tuiStartingStatePath(), JSON.stringify({
      version: 1,
      accountId: "account-1",
      focusedChannel: { guildId: "guild-1", channelId: "channel-1" },
      sidebar: {
        open: true,
        currentFolderId: null,
        focusedGuildId: null,
        expandedGuildId: null,
        collapsedCategoryIds: [],
        selectedItem: null,
        scrollOffset: -1,
      },
    }));
    expect(loadTuiStartingState()).toBeNull();

    expect(basename(tuiStartingStatePath())).toBe("tui-state.json");
  });
});
