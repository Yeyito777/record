import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { getCommandArgs, tryCommand } from "./commands";
import { configDir, loadConfig } from "./config";
import { loadCachedSidebarFolders, saveCachedSidebarFolderExpansion, saveCachedSidebarFolders } from "./datacache";
import { buildDemoWorld, demoServerFolderLayout } from "./demo/data";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, type DiscordChannel } from "./discord";
import { invalidateFrame } from "./frame";
import type { InlineChatImageReady } from "./inlineimage";
import { render } from "./render";
import {
  activateSelectedEntry,
  applySidebarFolderLayout,
  buildSidebarEntries,
  createSidebarIconFrame,
  createSidebarState,
  enterSidebarFolder,
  handleSidebarPromptKey,
  handleSidebarSearchBarKey,
  leaveSidebarFolder,
  moveSelectedSidebarItem,
  moveSidebarSelection,
  moveSidebarSelectionOut,
  openSidebarCreateFolderPrompt,
  openSidebarMoveItemsPrompt,
  openSidebarRenameFolderPrompt,
  openSidebarSearchBar,
  renderSidebar,
  revealSidebarChannel,
  setSidebarCachedChannels,
  setSidebarFolderView,
  setSidebarGuilds,
  sidebarFolderLayout,
  sidebarHitTest,
  SIDEBAR_WIDTH,
  toggleSidebarVisualSelection,
  unwrapSelectedSidebarFolder,
  type SidebarFolderLayout,
  type SidebarPreferences,
  type SidebarState,
} from "./sidebar";
import { discordGuildIconSource, sidebarIconTerminalOwner, sidebarIcons } from "./sidebaricons";
import { SmoothScroller, markScrollIntent, setSmoothScroller } from "./smoothscroll";
import { applyTuiStartingState, type TuiStartingState } from "./startingstate";
import { persistSidebarFolderExpansion, persistSidebarFolders } from "./session";
import { createInitialState } from "./state";
import { disposeInlineTerminalImages } from "./terminalimage";
import { termWidth } from "./textwidth";
import { setTimelineMessages } from "./timeline";
import { VtScreen } from "./vtscreen.testutil";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** A rendered row's text without the right border. */
function plain(row: string | undefined): string {
  return stripAnsi(row ?? "").replace(/│$/, "").trimEnd();
}

function ids(sidebar: SidebarState, channels: DiscordChannel[] = []): string[] {
  return buildSidebarEntries(sidebar, channels).map((entry) => entry.id);
}

function selectedId(sidebar: SidebarState, channels: DiscordChannel[] = []): string | undefined {
  return buildSidebarEntries(sidebar, channels)[sidebar.selectedIndex]?.id;
}

/**
 * Root, Dev/ (One, Two, Tools/ (Deep)), Chill/ (Calm), After. Tools is nested
 * inside Dev, as in the owner's real layout.
 */
const LAYOUT: SidebarFolderLayout = {
  folders: [
    { id: "dev", name: "Dev", parentId: null, pinned: false, sortOrder: 1 },
    { id: "tools", name: "Tools", parentId: "dev", pinned: false, sortOrder: 2 },
    { id: "chill", name: "Chill", parentId: null, pinned: false, sortOrder: 2 },
  ],
  guildPlacements: {
    "g-root": { folderId: null, pinned: false, sortOrder: 0 },
    "g-one": { folderId: "dev", pinned: false, sortOrder: 0 },
    "g-two": { folderId: "dev", pinned: false, sortOrder: 1 },
    "g-deep": { folderId: "tools", pinned: false, sortOrder: 0 },
    "g-calm": { folderId: "chill", pinned: false, sortOrder: 0 },
    "g-after": { folderId: null, pinned: false, sortOrder: 3 },
  },
};

function treeSidebar(preferences: SidebarPreferences = {}, expanded: string[] = []): SidebarState {
  const sidebar = createSidebarState(preferences);
  sidebar.open = true;
  setSidebarGuilds(sidebar, [
    { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
    { id: "g-root", name: "Root", icon: null },
    { id: "g-one", name: "One", icon: null },
    { id: "g-two", name: "Two", icon: null },
    { id: "g-deep", name: "Deep", icon: null },
    { id: "g-calm", name: "Calm", icon: null },
    { id: "g-after", name: "After", icon: null },
  ]);
  applySidebarFolderLayout(sidebar, { ...LAYOUT, expandedFolderIds: expanded });
  return sidebar;
}

function select(sidebar: SidebarState, item: SidebarState["selectedItem"]): void {
  sidebar.selectedItem = item;
  buildSidebarEntries(sidebar, []);
}

function type(sidebar: SidebarState, text: string): void {
  for (const char of text) handleSidebarPromptKey(sidebar, { type: "char", char });
  handleSidebarPromptKey(sidebar, { type: "enter" });
}

describe("sidebar tree view", () => {
  test("is the default, with arrows hidden; navigate stays available", () => {
    const sidebar = createSidebarState();
    expect(sidebar.folderView).toBe("tree");
    expect(sidebar.arrows).toBe("hide");
    expect(createSidebarState({ folderView: "navigate", arrows: "show" })).toMatchObject({ folderView: "navigate", arrows: "show" });
  });

  test("folders expand in place, nested folders indent, and there is no '..' row", () => {
    const sidebar = treeSidebar();
    expect(ids(sidebar)).toEqual([DIRECT_MESSAGES_GUILD_ID, "g-root", "dev", "chill", "g-after"]);

    sidebar.expandedFolderIds.add("dev");
    sidebar.expandedFolderIds.add("tools");
    const entries = buildSidebarEntries(sidebar, []);
    expect(entries.map((entry) => [entry.id, entry.depth])).toEqual([
      [DIRECT_MESSAGES_GUILD_ID, 0],
      ["g-root", 0],
      ["dev", 0],
      ["g-one", 1],
      ["g-two", 1],
      ["tools", 1],
      ["g-deep", 2],
      ["chill", 0],
      ["g-after", 0],
    ]);
    expect(entries.some((entry) => entry.kind === "up")).toBe(false);

    // A nested folder stays hidden while the folder above it is collapsed.
    sidebar.expandedFolderIds.delete("dev");
    expect(ids(sidebar)).toEqual([DIRECT_MESSAGES_GUILD_ID, "g-root", "dev", "chill", "g-after"]);
  });

  test("servers inside folders keep their own expand/collapse of categories and channels", () => {
    const sidebar = treeSidebar({}, ["dev", "tools"]);
    const channels: DiscordChannel[] = [
      { id: "cat", guildId: "g-deep", parentId: null, name: "Text", topic: null, position: 0, type: 4, nsfw: false },
      { id: "loose", guildId: "g-deep", parentId: null, name: "loose", topic: null, position: 0, type: 0, nsfw: false },
      { id: "general", guildId: "g-deep", parentId: "cat", name: "general", topic: null, position: 1, type: 0, nsfw: false },
    ];
    setSidebarCachedChannels(sidebar, "g-deep", channels);
    select(sidebar, { type: "guild", id: "g-deep" });
    activateSelectedEntry(sidebar, []);
    expect(sidebar.expandedGuildId).toBe("g-deep");
    const entries = buildSidebarEntries(sidebar, []);
    const deep = entries.findIndex((entry) => entry.id === "g-deep");
    expect(entries.slice(deep, deep + 4).map((entry) => [entry.id, entry.depth])).toEqual([
      ["g-deep", 2],
      ["loose", 3],
      ["cat", 3],
      ["general", 4],
    ]);

    // Categories have no item; select the row by index.
    sidebar.selectedItem = null;
    sidebar.selectedIndex = deep + 2;
    activateSelectedEntry(sidebar, []);
    expect(sidebar.collapsedCategoryIds).toEqual(["cat"]);
    expect(ids(sidebar)).not.toContain("general");
    // The folders stay open while the server's own rows change.
    expect([...sidebar.expandedFolderIds].sort()).toEqual(["dev", "tools"]);
  });

  test("Enter and clicks toggle a folder in place", () => {
    const sidebar = treeSidebar();
    select(sidebar, { type: "folder", id: "dev" });
    activateSelectedEntry(sidebar, []);
    expect(sidebar.expandedFolderIds.has("dev")).toBe(true);
    expect(selectedId(sidebar)).toBe("dev");
    activateSelectedEntry(sidebar, []);
    expect(sidebar.expandedFolderIds.has("dev")).toBe(false);

    // A click on the folder row hits the same entry.
    sidebar.scrollOffset = 0;
    const hit = sidebarHitTest(sidebar, [], 3 + 2, 20);
    expect(hit?.entry.id).toBe("dev");
  });

  test("l expands then steps in; h and Backspace collapse the folder or the one listing the row", () => {
    const sidebar = treeSidebar();
    select(sidebar, { type: "folder", id: "dev" });
    enterSidebarFolder(sidebar, "dev");
    expect(sidebar.expandedFolderIds.has("dev")).toBe(true);
    expect(selectedId(sidebar)).toBe("dev");
    enterSidebarFolder(sidebar, "dev");
    expect(selectedId(sidebar)).toBe("g-one");

    moveSidebarSelection(sidebar, [], 2);
    expect(selectedId(sidebar)).toBe("tools");
    enterSidebarFolder(sidebar, "tools");
    enterSidebarFolder(sidebar, "tools");
    expect(selectedId(sidebar)).toBe("g-deep");

    // h on a row inside Tools collapses Tools and lands on it.
    leaveSidebarFolder(sidebar);
    expect(sidebar.expandedFolderIds.has("tools")).toBe(false);
    expect(selectedId(sidebar)).toBe("tools");
    // h on a collapsed folder collapses the folder listing it.
    leaveSidebarFolder(sidebar);
    expect(sidebar.expandedFolderIds.has("dev")).toBe(false);
    expect(selectedId(sidebar)).toBe("dev");
    // At the top level there is nothing to collapse.
    expect(leaveSidebarFolder(sidebar)).toBe(false);
  });

  test("the folder context follows the cursor", () => {
    const sidebar = treeSidebar({}, ["dev", "tools"]);
    select(sidebar, { type: "guild", id: "g-deep" });
    expect(sidebar.currentFolderId).toBe("tools");
    select(sidebar, { type: "folder", id: "tools" });
    expect(sidebar.currentFolderId).toBe("dev");
    select(sidebar, { type: "guild", id: "g-after" });
    expect(sidebar.currentFolderId).toBeNull();

    // A channel row belongs to the folder listing its server.
    setSidebarCachedChannels(sidebar, "g-two", [{ id: "c2", guildId: "g-two", parentId: null, name: "two", topic: null, position: 0, type: 0, nsfw: false }]);
    sidebar.expandedGuildId = "g-two";
    select(sidebar, { type: "channel", id: "c2", guildId: "g-two" });
    expect(sidebar.currentFolderId).toBe("dev");
  });

  test("f creates the folder in the folder that lists the selected row", () => {
    const sidebar = treeSidebar({}, ["dev", "tools"]);
    select(sidebar, { type: "guild", id: "g-deep" });
    openSidebarCreateFolderPrompt(sidebar, []);
    type(sidebar, "Inner");
    const inner = sidebar.folders.find((folder) => folder.name === "Inner")!;
    expect(inner.parentId).toBe("tools");
    expect(selectedId(sidebar)).toBe(inner.id);

    // A visual block inside Dev becomes a new folder inside Dev.
    select(sidebar, { type: "guild", id: "g-one" });
    toggleSidebarVisualSelection(sidebar, []);
    moveSidebarSelection(sidebar, [], 1);
    openSidebarCreateFolderPrompt(sidebar, []);
    expect(sidebar.prompt?.items).toEqual([{ type: "guild", id: "g-one" }, { type: "guild", id: "g-two" }]);
    type(sidebar, "Pair");
    const pair = sidebar.folders.find((folder) => folder.name === "Pair")!;
    expect(pair.parentId).toBe("dev");
    expect(sidebar.guildPlacements["g-one"]?.folderId).toBe(pair.id);
    expect(sidebar.guildPlacements["g-two"]?.folderId).toBe(pair.id);
  });

  test("< moves the selection out of the folder listing it and the cursor follows it", () => {
    const sidebar = treeSidebar({}, ["dev", "tools"]);
    select(sidebar, { type: "guild", id: "g-deep" });
    expect(moveSidebarSelectionOut(sidebar, [])).toBe(true);
    expect(sidebar.guildPlacements["g-deep"]?.folderId).toBe("dev");
    expect(ids(sidebar)).toEqual([DIRECT_MESSAGES_GUILD_ID, "g-root", "dev", "g-one", "g-two", "g-deep", "tools", "chill", "g-after"]);
    expect(selectedId(sidebar)).toBe("g-deep");
    expect(sidebar.currentFolderId).toBe("dev");

    expect(moveSidebarSelectionOut(sidebar, [])).toBe(true);
    expect(sidebar.guildPlacements["g-deep"]?.folderId).toBeNull();
    expect(ids(sidebar).slice(0, 4)).toEqual([DIRECT_MESSAGES_GUILD_ID, "g-root", "g-deep", "dev"]);
    // Nothing above the top level.
    expect(moveSidebarSelectionOut(sidebar, [])).toBe(false);
  });

  test("F moves to a folder relative to the cursor's folder and keeps the cursor on rows that stay visible", () => {
    const sidebar = treeSidebar({}, ["dev", "tools"]);
    select(sidebar, { type: "guild", id: "g-deep" });
    openSidebarMoveItemsPrompt(sidebar, []);
    expect(sidebar.prompt?.autocomplete?.matches.map((match) => match.name)).toContain("..");
    type(sidebar, "..");
    expect(sidebar.guildPlacements["g-deep"]?.folderId).toBe("dev");
    expect(selectedId(sidebar)).toBe("g-deep");

    // Into a collapsed folder: the row leaves the screen, the cursor stays in place.
    openSidebarMoveItemsPrompt(sidebar, []);
    type(sidebar, "Chill");
    expect(sidebar.guildPlacements["g-deep"]?.folderId).toBe("chill");
    expect(ids(sidebar)).not.toContain("g-deep");
    expect(selectedId(sidebar)).toBe("tools");
  });

  test("e/E reorder rows among their siblings inside a nested folder", () => {
    const sidebar = treeSidebar({}, ["dev"]);
    select(sidebar, { type: "guild", id: "g-two" });
    expect(moveSelectedSidebarItem(sidebar, [], "up")).toBe(true);
    expect(ids(sidebar).slice(2, 6)).toEqual(["dev", "g-two", "g-one", "tools"]);
    select(sidebar, { type: "folder", id: "tools" });
    expect(moveSelectedSidebarItem(sidebar, [], "down")).toBe(false);
    expect(moveSelectedSidebarItem(sidebar, [], "up")).toBe(true);
    expect(ids(sidebar).slice(2, 6)).toEqual(["dev", "g-two", "tools", "g-one"]);
  });

  test("a visual block over a folder and its rows acts on the folder only", () => {
    const sidebar = treeSidebar({}, ["dev", "tools"]);
    select(sidebar, { type: "folder", id: "tools" });
    toggleSidebarVisualSelection(sidebar, []);
    moveSidebarSelection(sidebar, [], 1);
    expect(selectedId(sidebar)).toBe("g-deep");
    openSidebarMoveItemsPrompt(sidebar, []);
    expect(sidebar.prompt?.items).toEqual([{ type: "folder", id: "tools" }]);
    type(sidebar, "/");
    expect(sidebar.folders.find((folder) => folder.id === "tools")?.parentId).toBeNull();
    expect(sidebar.guildPlacements["g-deep"]?.folderId).toBe("tools");
  });

  test("rename and unwrap act on the selected folder row", () => {
    const sidebar = treeSidebar({}, ["dev", "tools"]);
    select(sidebar, { type: "folder", id: "tools" });
    expect(openSidebarRenameFolderPrompt(sidebar, [])).toBe(true);
    type(sidebar, "Kit");
    expect(sidebar.folders.find((folder) => folder.id === "tools")?.name).toBe("Kit");

    expect(unwrapSelectedSidebarFolder(sidebar, [])).toBe(true);
    expect(sidebar.guildPlacements["g-deep"]?.folderId).toBe("dev");
    expect(sidebar.expandedFolderIds.has("tools")).toBe(false);
    expect(selectedId(sidebar)).toBe("g-deep");
  });

  test("opening a server's channel reveals the folders above it", () => {
    const sidebar = treeSidebar();
    const channels: DiscordChannel[] = [{ id: "c-deep", guildId: "g-deep", parentId: null, name: "deep", topic: null, position: 0, type: 0, nsfw: false }];
    expect(revealSidebarChannel(sidebar, channels, "g-deep", "c-deep")).toBe(true);
    expect([...sidebar.expandedFolderIds].sort()).toEqual(["dev", "tools"]);
    expect(selectedId(sidebar, channels)).toBe("c-deep");
  });

  test("search results stay flat; opening a found folder clears the filter and expands it where it lives", () => {
    const sidebar = treeSidebar();
    openSidebarSearchBar(sidebar, [], "forward");
    for (const char of "Tools") handleSidebarSearchBarKey(sidebar, [], { type: "char", char });
    handleSidebarSearchBarKey(sidebar, [], { type: "enter" });
    expect(ids(sidebar)).toEqual(["tools"]);
    activateSelectedEntry(sidebar, []);
    expect(sidebar.search?.highlightsVisible).toBe(false);
    expect([...sidebar.expandedFolderIds].sort()).toEqual(["dev", "tools"]);
    expect(selectedId(sidebar)).toBe("tools");
    expect(ids(sidebar)).toContain("g-deep");
  });

  test("switching views keeps the cursor; navigate's open folder opens in the tree", () => {
    const sidebar = treeSidebar({ folderView: "navigate" });
    select(sidebar, { type: "folder", id: "dev" });
    activateSelectedEntry(sidebar, []);
    expect(sidebar.currentFolderId).toBe("dev");
    expect(ids(sidebar)[0]).toBe("..");
    sidebar.selectedIndex = 0;
    sidebar.selectedItem = { type: "up" };

    setSidebarFolderView(sidebar, "tree");
    expect(sidebar.expandedFolderIds.has("dev")).toBe(true);
    expect(selectedId(sidebar)).toBe("dev");

    select(sidebar, { type: "guild", id: "g-two" });
    setSidebarFolderView(sidebar, "navigate");
    expect(sidebar.currentFolderId).toBe("dev");
    expect(ids(sidebar)).toEqual(["..", "g-one", "g-two", "tools"]);
    expect(selectedId(sidebar)).toBe("g-two");
  });

  test("a starting state saved in the navigate view opens its folder in the tree", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const sidebar = treeSidebar();
    state.sidebar = sidebar;
    const startingState: TuiStartingState = {
      version: 1,
      accountId: null,
      focusedChannel: null,
      sidebar: {
        open: true,
        currentFolderId: "tools",
        focusedGuildId: null,
        expandedGuildId: null,
        collapsedCategoryIds: [],
        selectedItem: { type: "up" },
        scrollOffset: 0,
      },
    };
    applyTuiStartingState(state, startingState);
    expect([...sidebar.expandedFolderIds].sort()).toEqual(["dev", "tools"]);
    expect(selectedId(sidebar)).toBe("tools");
  });
});

describe("sidebar folder persistence", () => {
  test("the expanded set rides along with the layout and drops folders that no longer exist", () => {
    const sidebar = treeSidebar({}, ["dev", "tools", "gone"]);
    expect([...sidebar.expandedFolderIds].sort()).toEqual(["dev", "tools"]);
    const layout = sidebarFolderLayout(sidebar);
    expect(layout.expandedFolderIds?.sort()).toEqual(["dev", "tools"]);

    const restored = treeSidebar();
    applySidebarFolderLayout(restored, layout);
    expect([...restored.expandedFolderIds].sort()).toEqual(["dev", "tools"]);

    sidebar.folders = sidebar.folders.filter((folder) => folder.id !== "tools");
    expect(sidebarFolderLayout(sidebar).expandedFolderIds).toEqual(["dev"]);
  });

  test("layouts saved before the tree view load unchanged, all folders collapsed", () => {
    const accountId = "acct-old";
    const dir = join(configDir(), "accounts", accountId);
    mkdirSync(dir, { recursive: true });
    const old = { version: 1, accountId, layout: { folders: LAYOUT.folders, guildPlacements: LAYOUT.guildPlacements }, savedAt: 1 };
    writeFileSync(join(dir, "server-folders.json"), JSON.stringify(old));

    const loaded = loadCachedSidebarFolders(accountId)!;
    expect(loaded.folders).toEqual(LAYOUT.folders);
    expect(loaded.guildPlacements).toEqual(LAYOUT.guildPlacements);
    expect(loaded.expandedFolderIds).toEqual([]);

    const sidebar = treeSidebar();
    applySidebarFolderLayout(sidebar, loaded);
    expect(sidebarFolderLayout(sidebar)).toEqual({ ...LAYOUT, expandedFolderIds: [] });
  });

  test("saving the expanded set rewrites only that field, and only over the folders the sidebar has loaded", () => {
    const accountId = "acct-expansion";
    const path = join(configDir(), "accounts", accountId, "server-folders.json");
    saveCachedSidebarFolders(accountId, { ...LAYOUT, expandedFolderIds: [] });
    // A field written by some other version survives.
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.layout.futureField = { keep: true };
    writeFileSync(path, JSON.stringify(raw));
    const folderIds = LAYOUT.folders.map((folder) => folder.id);

    saveCachedSidebarFolderExpansion(accountId, folderIds, ["tools", "dev", "unknown"]);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.layout.expandedFolderIds).toEqual(["tools", "dev"]);
    expect(saved.layout.futureField).toEqual({ keep: true });
    expect(saved.layout.folders).toEqual(raw.layout.folders);
    expect(saved.layout.guildPlacements).toEqual(raw.layout.guildPlacements);

    // A sidebar that has not loaded this account's folders never writes.
    saveCachedSidebarFolderExpansion(accountId, [], []);
    saveCachedSidebarFolderExpansion(accountId, ["dev"], []);
    expect(JSON.parse(readFileSync(path, "utf8")).layout.expandedFolderIds).toEqual(["tools", "dev"]);
    // No file, nothing to do.
    saveCachedSidebarFolderExpansion("acct-none", folderIds, ["dev"]);
    expect(loadCachedSidebarFolders("acct-none")).toBeNull();
  });

  test("expanding and collapsing saves the set for the signed-in account", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    state.auth.user = { id: "acct-session" } as unknown as typeof state.auth.user;
    // Before the account's folders are loaded nothing is written.
    persistSidebarFolderExpansion(state);
    expect(loadCachedSidebarFolders("acct-session")).toBeNull();

    state.sidebar = treeSidebar();
    persistSidebarFolders(state);
    select(state.sidebar, { type: "folder", id: "dev" });
    activateSelectedEntry(state.sidebar, []);
    persistSidebarFolderExpansion(state);
    expect(loadCachedSidebarFolders("acct-session")?.expandedFolderIds).toEqual(["dev"]);
    activateSelectedEntry(state.sidebar, []);
    persistSidebarFolderExpansion(state);
    expect(loadCachedSidebarFolders("acct-session")?.expandedFolderIds).toEqual([]);
    expect(loadCachedSidebarFolders("acct-session")?.folders).toEqual(LAYOUT.folders);
  });

  test("/folders and /arrows switch and persist, like /images", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    state.timeline.channelId = "channel-1";
    expect(tryCommand("/folders", state)).toEqual({ type: "handled" });
    expect(state.timeline.systemMessages.at(-1)?.text).toContain("Folders: tree");
    expect(tryCommand("/folders navigate", state)).toEqual({ type: "handled" });
    expect(state.sidebar.folderView).toBe("navigate");
    expect(loadConfig().sidebar).toEqual({ folders: "navigate" });
    expect(tryCommand("/folders sideways", state)).toEqual({ type: "handled" });
    expect(state.timeline.systemMessages.at(-1)?.text).toBe("Usage: /folders tree|navigate");
    expect(tryCommand("/folders tree", state)).toEqual({ type: "handled" });
    expect(state.sidebar.folderView).toBe("tree");

    expect(tryCommand("/arrows", state)).toEqual({ type: "handled" });
    expect(state.timeline.systemMessages.at(-1)?.text).toBe("Sidebar arrows: hide");
    expect(tryCommand("/arrows show", state)).toEqual({ type: "handled" });
    expect(state.sidebar.arrows).toBe("show");
    expect(loadConfig().sidebar).toEqual({ folders: "tree", arrows: "show" });
    expect(tryCommand("/arrows maybe", state)).toEqual({ type: "handled" });
    expect(state.timeline.systemMessages.at(-1)?.text).toBe("Usage: /arrows hide|show");
    expect(tryCommand("/arrows hide", state)).toEqual({ type: "handled" });
    expect(state.sidebar.arrows).toBe("hide");
    expect(state.notice).toMatchObject({ text: "", statusLine: false });
    expect(getCommandArgs(state)["/arrows"]?.map((arg) => arg.name)).toEqual(["show", "hide"]);
    expect(getCommandArgs(state)["/folders"]?.map((arg) => arg.name)).toEqual(["tree", "navigate"]);
  });

  test("the demo account has nested server folders covering every demo server", () => {
    const world = buildDemoWorld();
    const layout = demoServerFolderLayout(world);
    expect(Object.keys(layout.guildPlacements).sort()).toEqual(world.guilds.map((guild) => guild.id).sort());
    expect(layout.folders.find((folder) => folder.id === "demo-folder-archive")?.parentId).toBe("demo-folder-tools");
    expect(layout.folders.find((folder) => folder.id === "demo-folder-tools")?.parentId).toBe("demo-folder-dev");
  });
});

describe("sidebar arrows", () => {
  const threadInfo = {
    ownerId: "user-1", archived: false, locked: false, invitable: true, autoArchiveDuration: 1440,
    archiveTimestamp: null, createTimestamp: null, joined: true, messageCount: 1, memberCount: 1, totalMessageSent: 1,
  };
  const guildChannels: DiscordChannel[] = [
    { id: "loose", guildId: "g-deep", parentId: null, name: "loose", topic: null, position: 0, type: 0, nsfw: false },
    { id: "cat", guildId: "g-deep", parentId: null, name: "Text", topic: null, position: 1, type: 4, nsfw: false },
    { id: "general", guildId: "g-deep", parentId: "cat", name: "general", topic: null, position: 2, type: 0, nsfw: false },
    { id: "thread", guildId: "g-deep", parentId: "general", name: "talk", topic: null, position: 0, type: 11, nsfw: false, thread: threadInfo },
    { id: "forum", guildId: "g-deep", parentId: "cat", name: "help", topic: null, position: 3, type: 15, nsfw: false },
    { id: "voice", guildId: "g-deep", parentId: "cat", name: "Lounge", topic: null, position: 4, type: 2, nsfw: false },
  ];

  function deepOpen(arrows: "show" | "hide"): SidebarState {
    const sidebar = treeSidebar({ arrows }, ["dev", "tools"]);
    setSidebarCachedChannels(sidebar, "g-deep", guildChannels);
    sidebar.voiceMembersByChannelId = { voice: [{ userId: "u1", displayName: "Alice" }] };
    sidebar.expandedGuildId = "g-deep";
    select(sidebar, { type: "guild", id: "g-deep" });
    return sidebar;
  }

  test("hidden: no arrows or cursor marker; every row starts one column in and indents two per level", () => {
    const rows = renderSidebar(deepOpen("hide"), [], 24).map(plain);
    expect(rows.slice(2, 19)).toEqual([
      " Direct Messages",
      " Root",
      " 📂 Dev/",
      "   One",
      "   Two",
      "   📂 Tools/",
      "     Deep",
      "       # loose",
      "       Text",
      "         # general",
      "           ↳ talk",
      "         ▤ help",
      "         🔊 Lounge",
      "           • Alice",
      " 📁 Chill/ 1",
      " After",
    ].concat([""]));
    expect(rows.join("\n")).not.toMatch(/[▸▾]/);
  });

  test("shown: exactly the arrow layout, with folder nesting after the cursor column", () => {
    const rows = renderSidebar(deepOpen("show"), [], 24).map(plain);
    // A server's rows hang under its arrow, as today.
    expect(rows.slice(2, 18)).toEqual([
      "  ▸ Direct Messages",
      "  ▸ Root",
      "  📂 Dev/",
      "    ▸ One",
      "    ▸ Two",
      "    📂 Tools/",
      "▸     ▾ Deep",
      "      # loose",
      "      ▾ Text",
      "        # general",
      "          ↳ talk",
      "        ▤ help",
      "        🔊 Lounge",
      "          • Alice",
      "  📁 Chill/ 1",
      "  ▸ After",
    ]);
  });

  test("shown with nothing nested is today's look", () => {
    const sidebar = treeSidebar({ arrows: "show" });
    select(sidebar, { type: "guild", id: "g-root" });
    const rows = renderSidebar(sidebar, [], 10).map(plain);
    expect(rows.slice(2, 7)).toEqual(["  ▸ Direct Messages", "▸ ▸ Root", "  📁 Dev/ 3", "  📁 Chill/ 1", "  ▸ After"]);
  });

  test("closed folders carry the aggregate badge; open ones do not repeat it", () => {
    const sidebar = treeSidebar();
    const counts = new Map([["g-deep", 2], ["g-one", 1]]);
    let rows = renderSidebar(sidebar, [], 10, false, null, 0, new Set(), "⋯", new Map(), counts).map(plain);
    expect(rows[4]).toMatch(/^ 📁 Dev\/ 3\s+3$/);

    sidebar.expandedFolderIds.add("dev");
    rows = renderSidebar(sidebar, [], 12, false, null, 0, new Set(), "⋯", new Map(), counts).map(plain);
    expect(rows[4]).toBe(" 📂 Dev/");
    expect(rows[5]).toMatch(/^ {3}One\s+1$/);
    expect(rows[7]).toMatch(/^ {3}📁 Tools\/ 1\s+2$/);
  });

  test("loading and pinned-delimiter rows follow the same indent", () => {
    const sidebar = treeSidebar({}, ["dev"]);
    sidebar.expandedGuildId = "g-one";
    sidebar.loadingGuildId = "g-one";
    expect(renderSidebar(sidebar, [], 12).map(plain)).toContain("     ⠋ Loading…");

    const shown = treeSidebar({ arrows: "show" }, ["dev"]);
    shown.expandedGuildId = "g-one";
    shown.loadingGuildId = "g-one";
    expect(renderSidebar(shown, [], 12).map(plain)).toContain("    ⠋ Loading…");
  });

  test("every row is exactly the sidebar's width in both modes", () => {
    for (const arrows of ["show", "hide"] as const) {
      const rows = renderSidebar(deepOpen(arrows), [], 24);
      for (const row of rows) expect(termWidth(stripAnsi(row))).toBe(SIDEBAR_WIDTH);
    }
  });

  test("icons sit right after the indent: tiles and avatars under their parents in both modes", () => {
    const ready = { imageId: 0x73000009 } as unknown as InlineChatImageReady;
    // Icon sources need a snowflake id; Deep is "777" here.
    const frameFor = () => createSidebarIconFrame((iconSource) => iconSource.key === discordGuildIconSource({ id: "777", icon: "d" })!.key ? ready : null);
    const withIcons = (arrows: "show" | "hide") => {
      const sidebar = treeSidebar({ arrows });
      setSidebarGuilds(sidebar, sidebar.guilds.map((guild) => guild.id === "g-deep" ? { ...guild, id: "777", icon: "d" } : guild));
      applySidebarFolderLayout(sidebar, {
        ...LAYOUT,
        guildPlacements: { ...LAYOUT.guildPlacements, "777": LAYOUT.guildPlacements["g-deep"]! },
        expandedFolderIds: ["dev", "tools"],
      });
      setSidebarCachedChannels(sidebar, DIRECT_MESSAGES_GUILD_ID, [
        { id: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "alice", topic: null, position: 0, type: 1, nsfw: false, recipients: [{ id: "u1", username: "alice", displayName: "alice", bot: false }] },
      ]);
      sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
      select(sidebar, { type: "guild", id: "g-root" });
      const frame = frameFor();
      const rows = renderSidebar(sidebar, [], 16, false, null, 0, new Set(), "⋯", new Map(), new Map(), {}, frame).map(plain);
      return { rows, frame };
    };

    const hidden = withIcons("hide");
    expect(hidden.rows.slice(2, 12)).toEqual([
      " DM Direct Messages",
      "   Al alice",
      " Ro Root",
      " 📂 Dev/",
      "   On One",
      "   Tw Two",
      "   📂 Tools/",
      "        Deep",
      " 📁 Chill/ 1",
      " Af After",
    ]);
    expect(hidden.frame.placements.map(({ row, col }) => [row, col])).toEqual([[10, 6]]);

    const shown = withIcons("show");
    expect(shown.rows.slice(2, 12)).toEqual([
      "  ▾ DM Direct Messages",
      "    Al alice",
      "▸ ▸ Ro Root",
      "  📂 Dev/",
      "    ▸ On One",
      "    ▸ Tw Two",
      "    📂 Tools/",
      "      ▸    Deep",
      "  📁 Chill/ 1",
      "  ▸ Af After",
    ]);
    expect(shown.frame.placements.map(({ row, col }) => [row, col])).toEqual([[10, 9]]);
  });
});

describe("sidebar icons in the tree without arrows", () => {
  function capture(state: ReturnType<typeof createInitialState>): string {
    let output = "";
    const originalWrite = process.stdout.write;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      render(state);
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
    }
    return output;
  }

  test("nested icons stay in place while the message pane glides and move with the selection only by row", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");
    sidebarIcons.configure({ fetch: (async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch, cacheDir: null, onUpdate: () => {} });
    sidebarIcons.setEnabled(true);
    try {
      const state = createInitialState(null, "/tmp/record-config.json");
      state.rows = 24;
      state.cols = 80;
      state.sidebar.open = true;
      const guilds = Array.from({ length: 12 }, (_, index) => ({ id: `9${index}`, name: `Server ${index}`, icon: `h${index}` }));
      setSidebarGuilds(state.sidebar, guilds);
      applySidebarFolderLayout(state.sidebar, {
        folders: [
          { id: "f1", name: "Outer", parentId: null, pinned: false, sortOrder: 2 },
          { id: "f2", name: "Inner", parentId: "f1", pinned: false, sortOrder: 2 },
        ],
        guildPlacements: Object.fromEntries(guilds.map((guild, index) => [guild.id, {
          folderId: index < 2 ? null : index < 5 ? "f1" : index < 8 ? "f2" : null,
          pinned: false,
          sortOrder: index,
        }])),
        expandedFolderIds: ["f1", "f2"],
      });
      capture(state);
      await sidebarIcons.idle();

      let now = 1000;
      const smooth = new SmoothScroller(100, () => now, 30);
      setSmoothScroller(state, smooth);
      setTimelineMessages(state.timeline, "channel-1", Array.from({ length: 60 }, (_, i) => ({
        id: String(100 + i), channelId: "channel-1", type: 0, timestamp: Date.UTC(2026, 0, 1) + i * 60_000, editedTimestamp: null,
        content: `line ${i}`, mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [],
        author: { id: "u", username: "u", displayName: "U", bot: false }, reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
      })));
      invalidateFrame(state);
      const screen = new VtScreen(state.rows, state.cols);
      screen.write(capture(state));
      const icons = () => screen.placements().filter((placement) => placement.imageId >= 0x73000000);
      const atRest = icons();
      // Top level one column in, Outer's servers two further, Inner's four (0-based columns).
      expect([...new Set(atRest.map((placement) => placement.col))].sort()).toEqual([1, 3, 5]);

      markScrollIntent(state);
      state.timeline.scrollOffset -= 3;
      let scrolls = 0;
      for (let i = 0; i < 60; i++) {
        const out = capture(state);
        if (/\x1b\[\d+;\d+r\x1b\[\d+T/.test(out)) scrolls++;
        screen.write(out);
        expect(icons()).toEqual(atRest);
        if (!smooth.busy()) break;
        now += Math.max(1, smooth.nextWakeMs());
      }
      expect(scrolls).toBeGreaterThan(0);
      setSmoothScroller(state, null);

      // Without a cursor column, moving the selection leaves every icon in its cell.
      const cells = () => icons().map(({ row, col, imageId }) => ({ row, col, imageId }));
      const cellsAtRest = cells();
      state.panelFocus = "sidebar";
      moveSidebarSelection(state.sidebar, [], 3);
      screen.write(capture(state));
      expect(cells()).toEqual(cellsAtRest);
    } finally {
      sidebarIcons.setEnabled(false);
      disposeInlineTerminalImages(sidebarIconTerminalOwner, () => {});
    }
  });
});
