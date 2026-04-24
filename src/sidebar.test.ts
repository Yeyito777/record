import { describe, expect, test } from "bun:test";

import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME } from "./discord";
import {
  activateSelectedEntry,
  buildSidebarEntries,
  createSidebarState,
  moveSidebarSelection,
  moveSidebarSelectionToNextCategory,
  moveSidebarSelectionToNextGuild,
  moveSidebarSelectionToPrevCategory,
  moveSidebarSelectionToPrevGuild,
  renderSidebar,
  setSidebarGuilds,
  SIDEBAR_WIDTH,
} from "./sidebar";
import { termWidth } from "./textwidth";

describe("sidebar state", () => {
  test("builds a collapsible guild/category/channel tree", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const entries = buildSidebarEntries(sidebar, [
      { id: "cat", guildId: "guild-1", parentId: null, name: "Category", topic: null, position: 0, type: 4, nsfw: false },
      { id: "1", guildId: "guild-1", parentId: "cat", name: "general", topic: null, position: 1, type: 0, nsfw: false },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["guild", "category", "channel"]);

    moveSidebarSelection(sidebar, [
      { id: "cat", guildId: "guild-1", parentId: null, name: "Category", topic: null, position: 0, type: 4, nsfw: false },
      { id: "1", guildId: "guild-1", parentId: "cat", name: "general", topic: null, position: 1, type: 0, nsfw: false },
    ], 1);
    const entry = activateSelectedEntry(sidebar, [
      { id: "cat", guildId: "guild-1", parentId: null, name: "Category", topic: null, position: 0, type: 4, nsfw: false },
      { id: "1", guildId: "guild-1", parentId: "cat", name: "general", topic: null, position: 1, type: 0, nsfw: false },
    ]);

    expect(entry?.kind).toBe("category");
    expect(sidebar.collapsedCategoryIds).toEqual(["cat"]);
  });

  test("marks channels with active typing", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const entries = buildSidebarEntries(sidebar, [
      { id: "1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
    ], 0, new Set(["1"]));

    expect(entries[1]?.label).toBe("general ⋯");

    const animatedEntries = buildSidebarEntries(sidebar, [
      { id: "1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
    ], 0, new Set(["1"]), "..");
    expect(animatedEntries[1]?.label).toBe("general ..");
  });

  test("shows a loading row directly under an opening guild", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";
    sidebar.loadingGuildId = "guild-1";

    const entries = buildSidebarEntries(sidebar, [], 0);

    expect(entries.map((entry) => entry.kind)).toEqual(["guild", "loading"]);
    expect(entries[1]?.label).toContain("Loading");

    moveSidebarSelection(sidebar, [], 1);
    expect(sidebar.selectedIndex).toBe(0);
  });

  test("expanding another guild does not change the active chat guild", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: "guild-1", name: "Guild One", icon: null },
      { id: "guild-2", name: "Guild Two", icon: null },
    ]);
    sidebar.activeGuildId = "guild-1";

    moveSidebarSelection(sidebar, [], 1);
    const entry = activateSelectedEntry(sidebar, []);

    expect(entry?.kind).toBe("guild");
    expect(sidebar.expandedGuildId).toBe("guild-2");
    expect(sidebar.activeGuildId).toBe("guild-1");
  });

  test("starts with no active or expanded guild by default", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "Guild One", icon: null },
    ]);

    expect(sidebar.activeGuildId).toBeNull();
    expect(sidebar.expandedGuildId).toBeNull();
  });

  test("jumps between guilds with brace motions", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: "guild-1", name: "Guild One", icon: null },
      { id: "guild-2", name: "Guild Two", icon: null },
      { id: "guild-3", name: "Guild Three", icon: null },
    ]);
    sidebar.expandedGuildId = "guild-2";
    sidebar.selectedIndex = 1;

    moveSidebarSelectionToNextGuild(sidebar, []);
    expect(sidebar.selectedIndex).toBe(2);

    moveSidebarSelectionToPrevGuild(sidebar, []);
    expect(sidebar.selectedIndex).toBe(1);

    moveSidebarSelectionToPrevGuild(sidebar, []);
    expect(sidebar.selectedIndex).toBe(0);
  });

  test("jumps between categories with bracket motions", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const channels = [
      { id: "cat-1", guildId: "guild-1", parentId: null, name: "Alpha", topic: null, position: 0, type: 4, nsfw: false },
      { id: "chan-1", guildId: "guild-1", parentId: "cat-1", name: "general", topic: null, position: 1, type: 0, nsfw: false },
      { id: "cat-2", guildId: "guild-1", parentId: null, name: "Beta", topic: null, position: 2, type: 4, nsfw: false },
      { id: "chan-2", guildId: "guild-1", parentId: "cat-2", name: "random", topic: null, position: 3, type: 0, nsfw: false },
    ];

    sidebar.selectedIndex = 0;
    moveSidebarSelectionToNextCategory(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("cat-1");

    moveSidebarSelectionToNextCategory(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("cat-2");

    moveSidebarSelectionToPrevCategory(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("cat-1");
  });

  test("renders wide channel names without overflowing the sidebar border", () => {
    const sidebar = createSidebarState();
    sidebar.open = true;
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const rows = renderSidebar(sidebar, [
      { id: "cat-1", guildId: "guild-1", parentId: null, name: "TOPICS▐", topic: null, position: 0, type: 4, nsfw: false },
      { id: "chan-1", guildId: "guild-1", parentId: "cat-1", name: "memes＆media", topic: null, position: 1, type: 0, nsfw: false },
      { id: "chan-2", guildId: "guild-1", parentId: "cat-1", name: "【the🦋chat】", topic: null, position: 2, type: 0, nsfw: false },
      { id: "chan-3", guildId: "guild-1", parentId: "cat-1", name: "catpostinge𓃠", topic: null, position: 3, type: 0, nsfw: false },
    ], 8);

    const visibleRows = rows.slice(2).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
    for (const row of visibleRows) {
      expect(termWidth(row)).toBe(SIDEBAR_WIDTH);
      expect(row.endsWith("│")).toBe(true);
    }
  });
});
