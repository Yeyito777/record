import { describe, expect, test } from "bun:test";

import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME } from "./discord";
import {
  activateSelectedEntry,
  applySidebarFolderLayout,
  buildSidebarEntries,
  createSidebarState,
  jumpSidebarSelectionToEdge,
  jumpSidebarSelectionToVisibleEdge,
  jumpSidebarSelectionToVisibleMiddle,
  moveSidebarSelection,
  scrollSidebarSelection,
  scrollSidebarSelectionLine,
  moveSidebarSelectionToNextCategory,
  moveSidebarSelectionToNextAnyNotification,
  moveSidebarSelectionToNextDirectMessage,
  moveSidebarSelectionToNextGuild,
  moveSidebarSelectionToPrevAnyNotification,
  moveSidebarSelectionToPrevCategory,
  moveSidebarSelectionToPrevDirectMessage,
  moveSidebarSelectionToPrevGuild,
  moveSidebarSelectionOut,
  moveSelectedSidebarGuild,
  openSidebarCommandBar,
  openSidebarCreateFolderPrompt,
  openSidebarMoveItemsPrompt,
  openSidebarSearchBar,
  handleSidebarPromptKey,
  handleSidebarSearchBarKey,
  jumpToSidebarSearchMatch,
  renderSidebar,
  setSidebarCachedChannels,
  setSidebarGuilds,
  sidebarFolderLayout,
  toggleSidebarVisualSelection,
  unwrapSelectedSidebarFolder,
  SIDEBAR_WIDTH,
} from "./sidebar";
import { termWidth } from "./textwidth";

function stripAnsiForTest(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

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

  test("renders muted guild icon and suppresses its guild badge", () => {
    const sidebar = createSidebarState();
    sidebar.open = true;
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null, muted: true }]);

    const rows = renderSidebar(
      sidebar,
      [],
      4,
      false,
      null,
      0,
      new Set(),
      "⋯",
      new Map(),
      new Map([["guild-1", 7]]),
    ).map(stripAnsiForTest);

    expect(rows[2]).toContain("🔕");
    expect(rows[2]).not.toContain(" 7 ");
  });

  test("renders muted DM icon and suppresses its channel badge", () => {
    const sidebar = createSidebarState();
    sidebar.open = true;
    setSidebarGuilds(sidebar, [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }]);
    sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;

    const rows = renderSidebar(
      sidebar,
      [{ id: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Alice", topic: null, position: 0, type: 1, nsfw: false, muted: true }],
      5,
      false,
      null,
      0,
      new Set(),
      "⋯",
      new Map([["dm-1", 4]]),
      new Map([[DIRECT_MESSAGES_GUILD_ID, 4]]),
    ).map(stripAnsiForTest);

    expect(rows[3]).toContain("🔕");
    expect(rows[3]).not.toContain(" 4 ");
  });

  test("creating folders uses Exocortex placement semantics", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "One", icon: null },
      { id: "guild-2", name: "Two", icon: null },
      { id: "guild-3", name: "Three", icon: null },
    ]);

    openSidebarCreateFolderPrompt(sidebar, [], {});
    for (const char of "Empty") handleSidebarPromptKey(sidebar, { type: "char", char });
    handleSidebarPromptKey(sidebar, { type: "enter" });
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id).slice(0, 3)).toEqual([DIRECT_MESSAGES_GUILD_ID, sidebar.folders[0]?.id, "guild-1"]);

    sidebar.selectedItem = { type: "guild", id: "guild-2" };
    buildSidebarEntries(sidebar, []);
    toggleSidebarVisualSelection(sidebar, [], {});
    moveSidebarSelection(sidebar, [], 1);
    openSidebarCreateFolderPrompt(sidebar, [], {});
    for (const char of "Selected") handleSidebarPromptKey(sidebar, { type: "char", char });
    handleSidebarPromptKey(sidebar, { type: "enter" });

    const entries = buildSidebarEntries(sidebar, []);
    const emptyFolder = sidebar.folders.find((folder) => folder.name === "Empty")!;
    const selectedFolder = sidebar.folders.find((folder) => folder.name === "Selected")!;
    expect(entries.map((entry) => entry.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, emptyFolder.id, "guild-1", selectedFolder.id]);
    sidebar.currentFolderId = selectedFolder.id;
    sidebar.selectedItem = null;
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["..", "guild-2", "guild-3"]);
  });

  test("server folders are local, navigable, movable, and persisted", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "One", icon: null },
      { id: "guild-2", name: "Two", icon: null },
    ]);

    sidebar.selectedIndex = 1;
    buildSidebarEntries(sidebar, []);
    toggleSidebarVisualSelection(sidebar, [], {});
    moveSidebarSelection(sidebar, [], 1);
    openSidebarCreateFolderPrompt(sidebar, [], {});
    for (const char of "Work") handleSidebarPromptKey(sidebar, { type: "char", char });
    handleSidebarPromptKey(sidebar, { type: "enter" });

    const rootEntries = buildSidebarEntries(sidebar, []);
    expect(rootEntries.map((entry) => entry.kind)).toEqual(["guild", "folder"]);
    expect(rootEntries[1]?.label).toBe("Work");

    activateSelectedEntry(sidebar, []);
    const folderEntries = buildSidebarEntries(sidebar, []);
    expect(folderEntries.map((entry) => entry.kind)).toEqual(["up", "guild", "guild"]);
    expect(folderEntries.map((entry) => entry.id)).toEqual(["..", "guild-1", "guild-2"]);

    moveSidebarSelection(sidebar, [], 1);
    openSidebarMoveItemsPrompt(sidebar, [], {});
    expect(sidebar.prompt?.autocomplete?.matches.map((match) => match.name)).toContain("/");
    handleSidebarPromptKey(sidebar, { type: "char", char: "/" });
    handleSidebarPromptKey(sidebar, { type: "enter" });
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["..", "guild-2"]);

    const restored = createSidebarState();
    setSidebarGuilds(restored, sidebar.guilds);
    applySidebarFolderLayout(restored, sidebarFolderLayout(sidebar));
    expect(buildSidebarEntries(restored, []).map((entry) => entry.id).sort()).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-1", sidebar.folders[0]?.id].sort());
  });

  test("moving a folder into another folder keeps focus at the next visible row", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "One", icon: null },
      { id: "guild-2", name: "Two", icon: null },
      { id: "guild-3", name: "Three", icon: null },
    ]);
    applySidebarFolderLayout(sidebar, {
      folders: [
        { id: "folder-a", name: "A", parentId: null, pinned: false, sortOrder: 1 },
        { id: "folder-b", name: "B", parentId: null, pinned: false, sortOrder: 3 },
      ],
      guildPlacements: {
        "guild-1": { folderId: null, pinned: false, sortOrder: 0 },
        "guild-2": { folderId: null, pinned: false, sortOrder: 2 },
        "guild-3": { folderId: null, pinned: false, sortOrder: 4 },
      },
    });

    let entries = buildSidebarEntries(sidebar, []);
    expect(entries.map((entry) => entry.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-1", "folder-a", "guild-2", "folder-b", "guild-3"]);
    sidebar.selectedIndex = 2;
    sidebar.selectedItem = { type: "folder", id: "folder-a" };

    openSidebarMoveItemsPrompt(sidebar, [], {});
    for (const char of "B") handleSidebarPromptKey(sidebar, { type: "char", char });
    handleSidebarPromptKey(sidebar, { type: "enter" });

    entries = buildSidebarEntries(sidebar, []);
    expect(sidebar.folders.find((folder) => folder.id === "folder-a")?.parentId).toBe("folder-b");
    expect(entries.map((entry) => entry.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-1", "guild-2", "folder-b", "guild-3"]);
    expect(entries[sidebar.selectedIndex]?.id).toBe("guild-2");
  });

  test("moving items out preserves the source folder slot", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-before", name: "Before", icon: null },
      { id: "guild-child", name: "Child", icon: null },
      { id: "guild-after", name: "After", icon: null },
    ]);
    applySidebarFolderLayout(sidebar, {
      folders: [{ id: "folder-a", name: "A", parentId: null, pinned: false, sortOrder: 1 }],
      guildPlacements: {
        "guild-before": { folderId: null, pinned: false, sortOrder: 0 },
        "guild-child": { folderId: "folder-a", pinned: false, sortOrder: 0 },
        "guild-after": { folderId: null, pinned: false, sortOrder: 2 },
      },
    });

    sidebar.currentFolderId = "folder-a";
    sidebar.selectedItem = { type: "guild", id: "guild-child" };
    expect(moveSidebarSelectionOut(sidebar, [], {})).toBe(true);
    sidebar.currentFolderId = null;
    sidebar.selectedItem = null;
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-before", "guild-child", "folder-a", "guild-after"]);
  });

  test("moving from a nested folder to root inserts before the top-level source folder", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-root", name: "Root", icon: null },
      { id: "guild-child", name: "Child", icon: null },
      { id: "guild-after", name: "After", icon: null },
    ]);
    applySidebarFolderLayout(sidebar, {
      folders: [
        { id: "folder-a", name: "A", parentId: null, pinned: false, sortOrder: 1 },
        { id: "folder-b", name: "B", parentId: "folder-a", pinned: false, sortOrder: 0 },
      ],
      guildPlacements: {
        "guild-root": { folderId: null, pinned: false, sortOrder: 0 },
        "guild-child": { folderId: "folder-b", pinned: false, sortOrder: 0 },
        "guild-after": { folderId: null, pinned: false, sortOrder: 2 },
      },
    });

    sidebar.currentFolderId = "folder-b";
    sidebar.selectedItem = { type: "guild", id: "guild-child" };
    openSidebarMoveItemsPrompt(sidebar, [], {});
    handleSidebarPromptKey(sidebar, { type: "char", char: "/" });
    handleSidebarPromptKey(sidebar, { type: "enter" });

    sidebar.currentFolderId = null;
    sidebar.selectedItem = null;
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-root", "guild-child", "folder-a", "guild-after"]);
  });

  test("folder prompts edit by grapheme like Exocortex", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "One", icon: null },
    ]);

    openSidebarCreateFolderPrompt(sidebar, [], {});
    handleSidebarPromptKey(sidebar, { type: "char", char: "📁" });
    handleSidebarPromptKey(sidebar, { type: "char", char: "A" });
    handleSidebarPromptKey(sidebar, { type: "left" });
    handleSidebarPromptKey(sidebar, { type: "backspace" });
    expect(sidebar.prompt?.input).toBe("A");
    expect(sidebar.prompt?.cursorPos).toBe(0);
    handleSidebarPromptKey(sidebar, { type: "delete" });
    expect(sidebar.prompt?.input).toBe("");
  });

  test("Ctrl-C is reserved for global quit, not sidebar-local cancellation", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "One", icon: null },
    ]);

    openSidebarCreateFolderPrompt(sidebar, [], {});
    handleSidebarPromptKey(sidebar, { type: "ctrl-c" });
    expect(sidebar.prompt).not.toBeNull();

    openSidebarSearchBar(sidebar, [], "forward");
    handleSidebarSearchBarKey(sidebar, [], { type: "ctrl-c" });
    expect(sidebar.search?.barOpen).toBe(true);
  });

  test("unwrapping a folder keeps children in the deleted folder slot", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-before", name: "Before", icon: null },
      { id: "guild-child", name: "Child", icon: null },
      { id: "guild-after", name: "After", icon: null },
    ]);
    applySidebarFolderLayout(sidebar, {
      folders: [{ id: "folder-a", name: "A", parentId: null, pinned: false, sortOrder: 1 }],
      guildPlacements: {
        "guild-before": { folderId: null, pinned: false, sortOrder: 0 },
        "guild-child": { folderId: "folder-a", pinned: false, sortOrder: 0 },
        "guild-after": { folderId: null, pinned: false, sortOrder: 2 },
      },
    });

    sidebar.selectedItem = { type: "folder", id: "folder-a" };
    expect(unwrapSelectedSidebarFolder(sidebar, [], {})).toBe(true);
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-before", "guild-child", "guild-after"]);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("guild-child");
  });

  test("renders notification badges for guilds and channels", () => {
    const sidebar = createSidebarState();
    sidebar.open = true;
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const rows = renderSidebar(
      sidebar,
      [{ id: "1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }],
      5,
      false,
      null,
      0,
      new Set(),
      "⋯",
      new Map([["1", 7]]),
      new Map([["guild-1", 7]]),
    ).map(stripAnsiForTest);

    expect(rows[2]).toContain("7");
    expect(rows[3]).toContain("7");
  });

  test("renders voice channels with voice markers", () => {
    const sidebar = createSidebarState();
    sidebar.open = true;
    sidebar.voiceMembersByChannelId = {
      "voice-1": [
        { userId: "user-1", displayName: "Alice", localMuted: true },
        { userId: "me", displayName: "Me", self: true, muted: true },
      ],
    };
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const rows = renderSidebar(
      sidebar,
      [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Lounge", topic: null, position: 0, type: 2, nsfw: false }],
      7,
      false,
    ).map(stripAnsiForTest);

    expect(rows.join("\n")).toContain("🔊 Lounge");
    expect(rows.join("\n")).toContain("• Alice 🔕");
    expect(rows.join("\n")).toContain("• Me (you) 🔇");
    expect(moveSidebarSelection(sidebar, [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Lounge", topic: null, position: 0, type: 2, nsfw: false }], 1)).toBeUndefined();
    expect(buildSidebarEntries(sidebar, [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Lounge", topic: null, position: 0, type: 2, nsfw: false }])[sidebar.selectedIndex]?.kind).toBe("channel");
    moveSidebarSelection(sidebar, [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Lounge", topic: null, position: 0, type: 2, nsfw: false }], 1);
    const selectedMember = buildSidebarEntries(sidebar, [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Lounge", topic: null, position: 0, type: 2, nsfw: false }])[sidebar.selectedIndex];
    expect(selectedMember?.kind).toBe("voice-member");
    expect(selectedMember?.userId).toBe("user-1");
  });

  test("keeps muted and deafened voice member icons visible when names truncate", () => {
    const sidebar = createSidebarState();
    sidebar.open = true;
    sidebar.voiceMembersByChannelId = {
      "voice-1": [
        { userId: "user-1", displayName: "A very very very very long voice member name", muted: true, deafened: true },
      ],
    };
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const rows = renderSidebar(
      sidebar,
      [{ id: "voice-1", guildId: "guild-1", parentId: null, name: "Lounge", topic: null, position: 0, type: 2, nsfw: false }],
      6,
      false,
    ).map(stripAnsiForTest);
    const memberRow = rows.find((row) => row.includes("•"));

    expect(memberRow).toBeDefined();
    expect(memberRow).toContain("…");
    expect(memberRow).toContain("🔇");
    expect(memberRow).toContain("🔕");
    expect(memberRow!.indexOf("…")).toBeLessThan(memberRow!.indexOf("🔇"));
    expect(memberRow!.indexOf("🔇")).toBeLessThan(memberRow!.indexOf("🔕"));
    expect(termWidth(memberRow!)).toBe(SIDEBAR_WIDTH);
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

  test("shows a loading row under direct messages while their list is still fetching", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }]);
    sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
    sidebar.loading = true;

    const entries = buildSidebarEntries(sidebar, [], 0);

    expect(entries.map((entry) => entry.kind)).toEqual(["guild", "loading"]);
    expect(entries[1]?.guildId).toBe(DIRECT_MESSAGES_GUILD_ID);
    expect(entries[1]?.label).toContain("Loading");
  });

  test("hides inaccessible channels unless show-hidden is enabled", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    sidebar.expandedGuildId = "guild-1";

    const channels = [
      { id: "cat-hidden", guildId: "guild-1", parentId: null, name: "Hidden Category", topic: null, position: 0, type: 4, nsfw: false, hidden: true },
      { id: "hidden", guildId: "guild-1", parentId: "cat-hidden", name: "hidden", topic: null, position: 1, type: 0, nsfw: false, hidden: true },
      { id: "cat-visible", guildId: "guild-1", parentId: null, name: "Visible Category", topic: null, position: 2, type: 4, nsfw: false, hidden: true },
      { id: "visible", guildId: "guild-1", parentId: "cat-visible", name: "visible", topic: null, position: 3, type: 0, nsfw: false },
    ];

    expect(buildSidebarEntries(sidebar, channels).map((entry) => entry.id)).toEqual(["guild-1", "cat-visible", "visible"]);
    expect(buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), { showHiddenChannels: true }).map((entry) => entry.id)).toEqual([
      "guild-1",
      "cat-hidden",
      "hidden",
      "cat-visible",
      "visible",
    ]);
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
    expect(sidebar.focusedGuildId).toBe("guild-2");
    expect(sidebar.activeGuildId).toBe("guild-1");
    expect(buildSidebarEntries(sidebar, []).find((candidate) => candidate.id === "guild-2")?.active).toBe(true);
  });

  test("starts with no active or expanded guild by default", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "Guild One", icon: null },
    ]);

    expect(sidebar.activeGuildId).toBeNull();
    expect(sidebar.focusedGuildId).toBeNull();
    expect(sidebar.expandedGuildId).toBeNull();
  });

  test("moves selected guilds optimistically without crossing direct messages", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "Guild One", icon: null },
      { id: "guild-2", name: "Guild Two", icon: null },
      { id: "guild-3", name: "Guild Three", icon: null },
    ]);
    sidebar.selectedIndex = 2;

    const movedUp = moveSelectedSidebarGuild(sidebar, [], "up");
    expect(movedUp?.guild.id).toBe("guild-2");
    expect(sidebar.guilds.map((guild) => guild.id)).toEqual([
      DIRECT_MESSAGES_GUILD_ID,
      "guild-2",
      "guild-1",
      "guild-3",
    ]);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("guild-2");

    expect(moveSelectedSidebarGuild(sidebar, [], "up")).toBeNull();
    expect(sidebar.guilds.map((guild) => guild.id)).toEqual([
      DIRECT_MESSAGES_GUILD_ID,
      "guild-2",
      "guild-1",
      "guild-3",
    ]);
  });

  test("scroll bindings use vim cursor/window behavior in the servers menu", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, Array.from({ length: 20 }, (_unused, index) => ({
      id: `guild-${index}`,
      name: `Guild ${index}`,
      icon: null,
    })));
    sidebar.selectedIndex = 5;
    sidebar.scrollOffset = 5;

    scrollSidebarSelectionLine(sidebar, [], -1, 7);
    expect(sidebar.scrollOffset).toBe(6);
    expect(sidebar.selectedIndex).toBe(6);

    scrollSidebarSelectionLine(sidebar, [], 1, 7);
    expect(sidebar.scrollOffset).toBe(5);
    expect(sidebar.selectedIndex).toBe(6);

    scrollSidebarSelection(sidebar, [], -1, 5, 7, "page");
    expect(sidebar.scrollOffset).toBe(10);
    expect(sidebar.selectedIndex).toBe(10);

    sidebar.selectedIndex = 12;
    scrollSidebarSelection(sidebar, [], 1, 5, 7, "page");
    expect(sidebar.scrollOffset).toBe(5);
    expect(sidebar.selectedIndex).toBe(9);
  });

  test("Shift+H/M/L jump within the visible servers menu", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, Array.from({ length: 8 }, (_unused, index) => ({
      id: `guild-${index}`,
      name: `Guild ${index}`,
      icon: null,
    })));
    sidebar.selectedIndex = 4;
    sidebar.scrollOffset = 2;

    jumpSidebarSelectionToVisibleEdge(sidebar, [], 7, "top");
    expect(sidebar.selectedIndex).toBe(2);
    expect(sidebar.scrollOffset).toBe(2);

    jumpSidebarSelectionToVisibleEdge(sidebar, [], 7, "top");
    expect(sidebar.selectedIndex).toBe(0);
    expect(sidebar.scrollOffset).toBe(0);

    jumpSidebarSelectionToVisibleMiddle(sidebar, [], 7);
    expect(sidebar.selectedIndex).toBe(2);
    expect(sidebar.scrollOffset).toBe(0);

    jumpSidebarSelectionToVisibleEdge(sidebar, [], 7, "bottom");
    expect(sidebar.selectedIndex).toBe(4);
    expect(sidebar.scrollOffset).toBe(0);

    jumpSidebarSelectionToVisibleEdge(sidebar, [], 7, "bottom");
    expect(sidebar.selectedIndex).toBe(6);
    expect(sidebar.scrollOffset).toBe(2);
  });

  test("gg/G-style jumps move to the top and bottom of the servers menu", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, Array.from({ length: 20 }, (_unused, index) => ({
      id: `guild-${index}`,
      name: `Guild ${index}`,
      icon: null,
    })));
    sidebar.selectedIndex = 10;
    sidebar.scrollOffset = 8;

    jumpSidebarSelectionToEdge(sidebar, [], 7, "top");
    expect(sidebar.selectedIndex).toBe(0);
    expect(sidebar.scrollOffset).toBe(0);

    jumpSidebarSelectionToEdge(sidebar, [], 7, "bottom");
    expect(sidebar.selectedIndex).toBe(19);
    expect(sidebar.scrollOffset).toBe(15);
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

  test("jumps between notified guilds and visible channels globally", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: "guild-1", name: "Guild 1", icon: null },
      { id: "guild-2", name: "Guild 2", icon: null },
    ]);
    sidebar.expandedGuildId = "guild-1";
    const channels = [
      { id: "channel-1", guildId: "guild-1", parentId: null, name: "one", topic: null, position: 0, type: 0, nsfw: false },
      { id: "channel-2", guildId: "guild-1", parentId: null, name: "two", topic: null, position: 1, type: 0, nsfw: false },
    ];
    const channelNotifications = new Map([["channel-2", 1]]);
    const guildNotifications = new Map([["guild-2", 2]]);

    sidebar.selectedIndex = 0;
    moveSidebarSelectionToNextAnyNotification(sidebar, channels, channelNotifications, guildNotifications);
    expect(buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", channelNotifications, guildNotifications)[sidebar.selectedIndex]?.id).toBe("channel-2");

    moveSidebarSelectionToNextAnyNotification(sidebar, channels, channelNotifications, guildNotifications);
    expect(buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", channelNotifications, guildNotifications)[sidebar.selectedIndex]?.id).toBe("guild-2");

    moveSidebarSelectionToPrevAnyNotification(sidebar, channels, channelNotifications, guildNotifications);
    expect(buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", channelNotifications, guildNotifications)[sidebar.selectedIndex]?.id).toBe("channel-2");
  });

  test("jumps between direct messages with bracket motions", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }]);
    sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
    const channels = [
      { id: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Alpha", topic: null, position: 0, type: 1, nsfw: false },
      { id: "dm-2", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Beta", topic: null, position: 1, type: 1, nsfw: false },
      { id: "dm-3", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Gamma", topic: null, position: 2, type: 1, nsfw: false },
    ];
    sidebar.selectedIndex = 0;
    moveSidebarSelectionToNextDirectMessage(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("dm-1");

    moveSidebarSelectionToNextDirectMessage(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("dm-2");

    moveSidebarSelectionToNextDirectMessage(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("dm-3");

    moveSidebarSelectionToNextDirectMessage(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("dm-1");

    moveSidebarSelectionToPrevDirectMessage(sidebar, channels);
    expect(buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id).toBe("dm-3");
  });

  test("searches cached direct messages and channels across servers", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "Guild One", icon: null },
      { id: "guild-2", name: "Guild Two", icon: null },
    ]);
    sidebar.expandedGuildId = "guild-1";
    setSidebarCachedChannels(sidebar, DIRECT_MESSAGES_GUILD_ID, [
      { id: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Alice", topic: null, position: 0, type: 1, nsfw: false },
    ]);
    setSidebarCachedChannels(sidebar, "guild-2", [
      { id: "cat-2", guildId: "guild-2", parentId: null, name: "Topics", topic: null, position: 0, type: 4, nsfw: false },
      { id: "chan-2", guildId: "guild-2", parentId: "cat-2", name: "project-alpha", topic: null, position: 1, type: 0, nsfw: false },
    ]);

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "alpha") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });

    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["guild-2", "cat-2", "chan-2"]);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("chan-2");

    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });
    expect(sidebar.search?.query).toBe("alpha");
    expect(sidebar.search?.highlightsVisible).toBe(true);
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["guild-2", "cat-2", "chan-2"]);

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "alice") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("dm-1");
  });

  test("sidebar search matches folders and servers, not only channels", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-1", name: "Gamma Server", icon: null },
      { id: "guild-2", name: "Alpha Server", icon: null },
    ]);
    applySidebarFolderLayout(sidebar, {
      folders: [{ id: "folder-work", name: "Workspaces", parentId: null, pinned: false, sortOrder: 1 }],
      guildPlacements: {
        "guild-1": { folderId: "folder-work", pinned: false, sortOrder: 0 },
        "guild-2": { folderId: null, pinned: false, sortOrder: 2 },
      },
    });

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "workspace") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    let entries = buildSidebarEntries(sidebar, []);
    expect(entries.map((entry) => entry.id)).toEqual(["folder-work"]);
    expect(entries[sidebar.selectedIndex]?.kind).toBe("folder");

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "alpha server") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    entries = buildSidebarEntries(sidebar, []);
    expect(entries.map((entry) => entry.id)).toEqual(["guild-2"]);
    expect(entries[sidebar.selectedIndex]?.kind).toBe("guild");
  });

  test("opening a directly matched server from search shows unfiltered children", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Raw Mutton", icon: null }]);
    setSidebarCachedChannels(sidebar, "guild-1", [
      { id: "cat-1", guildId: "guild-1", parentId: null, name: "Text Channels", topic: null, position: 0, type: 4, nsfw: false },
      { id: "chan-1", guildId: "guild-1", parentId: "cat-1", name: "general", topic: null, position: 1, type: 0, nsfw: false },
      { id: "chan-2", guildId: "guild-1", parentId: "cat-1", name: "off-topic", topic: null, position: 2, type: 0, nsfw: false },
    ]);

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "raw mutton") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["guild-1"]);

    const opened = activateSelectedEntry(sidebar, []);
    expect(opened?.kind).toBe("guild");
    expect(sidebar.expandedGuildId).toBe("guild-1");
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["guild-1", "cat-1", "chan-1", "chan-2"]);
  });

  test(":noh reveals the focused server in its folder and keeps it open", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-root", name: "Root", icon: null },
      { id: "guild-work", name: "Work", icon: null },
    ]);
    applySidebarFolderLayout(sidebar, {
      folders: [{ id: "folder-work", name: "Workspaces", parentId: null, pinned: false, sortOrder: 1 }],
      guildPlacements: {
        "guild-root": { folderId: null, pinned: false, sortOrder: 0 },
        "guild-work": { folderId: "folder-work", pinned: false, sortOrder: 0 },
      },
    });
    setSidebarCachedChannels(sidebar, "guild-work", [
      { id: "work-general", guildId: "guild-work", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
    ]);
    sidebar.focusedGuildId = "guild-work";

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "no-results") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual([]);

    openSidebarCommandBar(sidebar, []);
    for (const ch of "noh") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });

    expect(sidebar.currentFolderId).toBe("folder-work");
    expect(sidebar.expandedGuildId).toBe("guild-work");
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["..", "guild-work", "work-general"]);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("guild-work");
  });

  test(":noh returns to root when no server has been focused", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      { id: "guild-root", name: "Root", icon: null },
    ]);
    applySidebarFolderLayout(sidebar, {
      folders: [{ id: "folder-work", name: "Workspaces", parentId: null, pinned: false, sortOrder: 1 }],
      guildPlacements: {
        "guild-root": { folderId: null, pinned: false, sortOrder: 0 },
      },
    });
    sidebar.currentFolderId = "folder-work";
    sidebar.expandedGuildId = "guild-root";
    sidebar.focusedGuildId = null;

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "root") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });
    openSidebarCommandBar(sidebar, []);
    for (const ch of "noh") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });

    expect(sidebar.currentFolderId).toBeNull();
    expect(sidebar.expandedGuildId).toBeNull();
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, "guild-root", "folder-work"]);
  });

  test("sidebar search supports n/N and :noh like conversation search", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: "guild-1", name: "Guild", icon: null }]);
    setSidebarCachedChannels(sidebar, "guild-1", [
      { id: "alpha-1", guildId: "guild-1", parentId: null, name: "alpha-one", topic: null, position: 0, type: 0, nsfw: false },
      { id: "alpha-2", guildId: "guild-1", parentId: null, name: "alpha-two", topic: null, position: 1, type: 0, nsfw: false },
    ]);

    openSidebarSearchBar(sidebar, [], "forward");
    for (const ch of "alpha") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });

    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("alpha-1");
    expect(jumpToSidebarSearchMatch(sidebar, [], "forward")).toBe(true);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("alpha-2");
    expect(jumpToSidebarSearchMatch(sidebar, [], "backward")).toBe(true);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("alpha-1");

    openSidebarSearchBar(sidebar, [], "forward");
    handleSidebarSearchBarKey(sidebar, [], { type: "escape" });
    expect(sidebar.search?.barOpen).toBe(false);

    openSidebarSearchBar(sidebar, [], "forward");
    handleSidebarSearchBarKey(sidebar, [], { type: "char", char: "z" });
    handleSidebarSearchBarKey(sidebar, [], { type: "escape" });
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("alpha-1");

    sidebar.search!.barOpen = true;
    sidebar.search!.barMode = "command";
    for (const ch of "noh") handleSidebarSearchBarKey(sidebar, [], { type: "char", char: ch });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });
    expect(sidebar.search?.highlightsVisible).toBe(false);
    expect(buildSidebarEntries(sidebar, []).map((entry) => entry.id)).toEqual(["guild-1"]);
    expect(jumpToSidebarSearchMatch(sidebar, [], "forward")).toBe(true);
    expect(sidebar.search?.highlightsVisible).toBe(true);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("alpha-1");
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
