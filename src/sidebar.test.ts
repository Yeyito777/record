import { describe, expect, test } from "bun:test";

import { activateSelectedEntry, buildSidebarEntries, createSidebarState, moveSidebarSelection, setSidebarGuilds } from "./sidebar";

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
});
