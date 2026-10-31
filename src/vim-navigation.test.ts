import { describe, expect, test } from "bun:test";

import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME } from "./discord";
import { enterHistoryShiftJkUp, handleHistoryVimKey, shiftJkRows } from "./historycursor";
import { parseInput } from "./input";
import { resolveAction, resolveNavigationAction, shiftJkRoute, type ShiftJkFocus } from "./keybinds";
import {
  applySidebarFolderLayout,
  buildSidebarEntries,
  createSidebarState,
  handleSidebarPromptKey,
  moveSelectedPrivateConversation,
  moveSelectedSidebarItem,
  openSidebarMoveItemsPrompt,
  setSidebarCachedChannels,
  setSidebarGuilds,
  toggleSelectedPrivateConversationPinned,
  toggleSidebarVisualSelection,
  moveSidebarSelection,
  type SidebarFolderLayout,
  type SidebarState,
} from "./sidebar";
import { createInitialState, type AppState } from "./state";

const ROWS = 40;
const STEP = shiftJkRows(ROWS);

function historyState(lineCount: number, viewStart: number, cursorRow: number): AppState {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.chatFocus = "history";
  state.historyLines = Array.from({ length: lineCount }, (_unused, index) => `line ${index} text`);
  state.historyWrapContinuation = Array.from({ length: lineCount }, () => false);
  state.timeline.scrollOffset = viewStart;
  state.historyCursor = { row: cursorRow, col: 0 };
  return state;
}

function press(state: AppState, char: string, rows = ROWS): boolean {
  return handleHistoryVimKey(state, { type: "char", char }, rows);
}

describe("history Shift+J/K", () => {
  test("an eighth of a page: a quarter of Ctrl+U/Ctrl+D's half page, at least one row", () => {
    expect(shiftJkRows(40)).toBe(5);
    expect(shiftJkRows(41)).toBe(5);
    expect(shiftJkRows(24)).toBe(3);
    expect(shiftJkRows(8)).toBe(1);
    expect(shiftJkRows(3)).toBe(1);
    expect(shiftJkRows(0)).toBe(1);
  });

  test("move the cursor inside the view without scrolling it", () => {
    const state = historyState(200, 50, 70);
    expect(press(state, "K")).toBe(true);
    expect(state.historyCursor.row).toBe(70 - STEP);
    expect(state.timeline.scrollOffset).toBe(50);
    expect(press(state, "J")).toBe(true);
    expect(press(state, "J")).toBe(true);
    expect(state.historyCursor.row).toBe(70 + STEP);
    expect(state.timeline.scrollOffset).toBe(50);
  });

  test("past the top or bottom edge the view scrolls just enough to follow, like k/j", () => {
    const state = historyState(200, 50, 52);
    press(state, "K");
    expect(state.historyCursor.row).toBe(52 - STEP);
    expect(state.timeline.scrollOffset).toBe(52 - STEP);

    const bottom = historyState(200, 50, 50 + ROWS - 2);
    press(bottom, "J");
    expect(bottom.historyCursor.row).toBe(50 + ROWS - 2 + STEP);
    expect(bottom.timeline.scrollOffset).toBe(bottom.historyCursor.row - ROWS + 1);
  });

  test("stop at the first and last rows", () => {
    const state = historyState(200, 0, 2);
    press(state, "K");
    expect(state.historyCursor.row).toBe(0);
    const end = historyState(200, 160, 198);
    press(end, "J");
    expect(end.historyCursor.row).toBe(199);
  });

  test("keep the wanted column like j/k", () => {
    const state = historyState(200, 50, 70);
    state.historyLines[70 - STEP] = "x";
    state.historyCursor = { row: 70, col: 6 };
    press(state, "K");
    expect(state.historyCursor).toEqual({ row: 70 - STEP, col: 0 });
    press(state, "J");
    expect(state.historyCursor).toEqual({ row: 70, col: 6 });
  });

  test("extend a visual selection", () => {
    const state = historyState(200, 50, 70);
    press(state, "V");
    press(state, "K");
    expect(state.editor.mode).toBe("visual-line");
    expect(state.historyVisualAnchor.row).toBe(70);
    expect(state.historyCursor.row).toBe(70 - STEP);
  });

  test("fK still finds a K", () => {
    const state = historyState(3, 0, 0);
    state.historyLines = ["abc K def", "two", "three"];
    press(state, "f");
    press(state, "K");
    expect(state.historyCursor).toEqual({ row: 0, col: 4 });
  });

  test("from the prompt, Shift+K enters with the cursor one Shift+K up from the visible bottom", () => {
    const state = historyState(200, 100, 0);
    enterHistoryShiftJkUp(state, ROWS);
    expect(state.historyCursor.row).toBe(100 + ROWS - 1 - STEP);
    expect(state.timeline.scrollOffset).toBe(100);

    // Following the bottom: the view is pinned past the end.
    const pinned = historyState(200, Number.MAX_SAFE_INTEGER, 0);
    enterHistoryShiftJkUp(pinned, ROWS);
    expect(pinned.historyCursor.row).toBe(199 - STEP);
    expect(pinned.timeline.scrollOffset).toBe(200 - ROWS);

    const empty = historyState(0, 0, 0);
    enterHistoryShiftJkUp(empty, ROWS);
    expect(empty.historyCursor).toEqual({ row: 0, col: 0 });
  });
});

describe("Shift+J/K routing", () => {
  const prompt: ShiftJkFocus = { panelFocus: "chat", chatFocus: "prompt", insertMode: false, promptPending: false };

  test("from the prompt in normal mode Shift+K enters the history and Shift+J does nothing", () => {
    expect(shiftJkRoute("sidebar_prev", prompt)).toBe("enter_history");
    expect(shiftJkRoute("sidebar_next", prompt)).toBe("ignore");
  });

  test("typed characters while inserting or finishing a prompt find", () => {
    expect(shiftJkRoute("sidebar_prev", { ...prompt, insertMode: true })).toBe("pass");
    expect(shiftJkRoute("sidebar_next", { ...prompt, promptPending: true })).toBe("pass");
  });

  test("the history keeps them for its cursor; the sidebar and member list move the sidebar selection", () => {
    expect(shiftJkRoute("sidebar_prev", { ...prompt, chatFocus: "history" })).toBe("pass");
    expect(shiftJkRoute("sidebar_next", { ...prompt, chatFocus: "history" })).toBe("pass");
    expect(shiftJkRoute("sidebar_next", { ...prompt, panelFocus: "sidebar" })).toBe("sidebar");
    expect(shiftJkRoute("sidebar_prev", { ...prompt, panelFocus: "memberlist" })).toBe("sidebar");
  });
});

describe("history h/l across a wrapped line", () => {
  function wrapped(): AppState {
    const state = historyState(4, 0, 0);
    state.historyLines = ["  first row of a", "  long line", "  next line", "  last"];
    state.historyWrapContinuation = [false, true, false, false];
    return state;
  }

  test("l at a row's end goes on to the row it wraps onto; h goes back", () => {
    const state = wrapped();
    state.historyCursor = { row: 0, col: 15 };
    press(state, "l");
    expect(state.historyCursor).toEqual({ row: 1, col: 2 });
    press(state, "h");
    expect(state.historyCursor).toEqual({ row: 0, col: 15 });
  });

  test("real line starts and ends still stop", () => {
    const state = wrapped();
    state.historyCursor = { row: 1, col: 10 };
    press(state, "l");
    expect(state.historyCursor).toEqual({ row: 1, col: 10 });
    state.historyCursor = { row: 2, col: 2 };
    press(state, "h");
    expect(state.historyCursor).toEqual({ row: 2, col: 2 });
    state.historyCursor = { row: 0, col: 2 };
    press(state, "h");
    expect(state.historyCursor).toEqual({ row: 0, col: 2 });
  });

  test("the arrow keys do the same", () => {
    const state = wrapped();
    state.historyCursor = { row: 0, col: 15 };
    handleHistoryVimKey(state, { type: "right" }, ROWS);
    expect(state.historyCursor).toEqual({ row: 1, col: 2 });
    handleHistoryVimKey(state, { type: "left" }, ROWS);
    expect(state.historyCursor).toEqual({ row: 0, col: 15 });
  });
});

describe("Ctrl+Shift+E", () => {
  test("decodes from CSI u (st, kitty) and resolves to move-to-top in the sidebar; Ctrl+E still scrolls", () => {
    expect(parseInput("\x1b[101;6u")).toEqual([{ type: "ctrl-shift-e" }]);
    expect(parseInput("\x1b[101;6:1u")).toMatchObject([{ type: "ctrl-shift-e" }]);
    expect(resolveNavigationAction({ type: "ctrl-shift-e" }).action).toBe("nav_move_to_top");
    expect(resolveAction({ type: "ctrl-e" }, "navigation")).toBe("scroll_line_down");
    expect(resolveAction({ type: "ctrl-shift-e" }, "prompt")).toBeNull();
  });
});

/** Root, Dev/ (One, Two, Tools/ (Deep)), Chill/ (Calm), After. */
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

function treeSidebar(expanded: string[]): SidebarState {
  const sidebar = createSidebarState();
  sidebar.open = true;
  setSidebarGuilds(sidebar, [
    { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
    ...["root", "one", "two", "deep", "calm", "after"].map((name) => ({ id: `g-${name}`, name, icon: null })),
  ]);
  applySidebarFolderLayout(sidebar, { ...LAYOUT, expandedFolderIds: expanded });
  return sidebar;
}

function ids(sidebar: SidebarState): string[] {
  return buildSidebarEntries(sidebar, []).map((entry) => entry.id);
}

function selectedId(sidebar: SidebarState): string | undefined {
  return buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id;
}

function select(sidebar: SidebarState, item: SidebarState["selectedItem"]): void {
  sidebar.selectedItem = item;
  buildSidebarEntries(sidebar, []);
}

function moveTo(sidebar: SidebarState, destination: string): void {
  expect(openSidebarMoveItemsPrompt(sidebar, [])).toBe(true);
  for (const char of destination) handleSidebarPromptKey(sidebar, { type: "char", char });
  handleSidebarPromptKey(sidebar, { type: "enter" });
}

describe("sidebar move to top", () => {
  test("moves a server, folder or visual block to the top of its siblings", () => {
    const sidebar = treeSidebar(["dev"]);
    select(sidebar, { type: "folder", id: "tools" });
    expect(moveSelectedSidebarItem(sidebar, [], "top")).toBe(true);
    expect(ids(sidebar).slice(2, 6)).toEqual(["dev", "tools", "g-one", "g-two"]);
    expect(selectedId(sidebar)).toBe("tools");
    expect(moveSelectedSidebarItem(sidebar, [], "top")).toBe(false);

    select(sidebar, { type: "folder", id: "chill" });
    toggleSidebarVisualSelection(sidebar, []);
    moveSidebarSelection(sidebar, [], 1);
    expect(moveSelectedSidebarItem(sidebar, [], "top")).toBe(true);
    expect(ids(sidebar).slice(1, 4)).toEqual(["chill", "g-after", "g-root"]);
  });

  test("moves a pinned chat to the top of the pinned ones; unpinned chats do not move", () => {
    const sidebar = createSidebarState();
    setSidebarGuilds(sidebar, [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }]);
    sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
    setSidebarCachedChannels(sidebar, DIRECT_MESSAGES_GUILD_ID, ["a", "b", "c", "d"].map((id, position) => ({
      id, guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: id, topic: null, position, type: 1, nsfw: false,
      lastMessageId: String(1000 - position),
    })));
    const order = () => buildSidebarEntries(sidebar, []).filter((entry) => entry.kind === "channel").map((entry) => entry.id);
    for (const id of ["a", "b", "c"]) {
      sidebar.selectedItem = { type: "channel", id, guildId: DIRECT_MESSAGES_GUILD_ID };
      toggleSelectedPrivateConversationPinned(sidebar, []);
    }
    expect(order()).toEqual(["a", "b", "c", "d"]);

    sidebar.selectedItem = { type: "channel", id: "c", guildId: DIRECT_MESSAGES_GUILD_ID };
    expect(moveSelectedPrivateConversation(sidebar, [], "top")).toBe(DIRECT_MESSAGES_GUILD_ID);
    expect(order()).toEqual(["c", "a", "b", "d"]);
    expect(buildSidebarEntries(sidebar, [])[sidebar.selectedIndex]?.id).toBe("c");
    expect(moveSelectedPrivateConversation(sidebar, [], "top")).toBeNull();

    sidebar.selectedItem = { type: "channel", id: "d", guildId: DIRECT_MESSAGES_GUILD_ID };
    expect(moveSelectedPrivateConversation(sidebar, [], "top")).toBeNull();
    expect(order()).toEqual(["c", "a", "b", "d"]);
  });
});

describe("sidebar cursor after rows leave", () => {
  test("takes the row that was below, in the same folder", () => {
    const sidebar = treeSidebar(["dev"]);
    select(sidebar, { type: "guild", id: "g-one" });
    moveTo(sidebar, "Chill");
    expect(ids(sidebar)).not.toContain("g-one");
    expect(selectedId(sidebar)).toBe("g-two");
  });

  test("the last row of a folder level takes the row above, not the next level's", () => {
    const sidebar = treeSidebar(["dev", "tools"]);
    // Dev lists One, Two, Tools; Tools lists Deep.
    select(sidebar, { type: "guild", id: "g-deep" });
    moveTo(sidebar, "Chill");
    expect(selectedId(sidebar)).toBe("tools");

    select(sidebar, { type: "guild", id: "g-two" });
    moveTo(sidebar, "Chill");
    expect(selectedId(sidebar)).toBe("tools");
  });

  test("a moved folder's open rows are not candidates", () => {
    const sidebar = treeSidebar(["dev", "tools"]);
    select(sidebar, { type: "folder", id: "tools" });
    moveTo(sidebar, "Chill");
    expect(ids(sidebar)).not.toContain("g-deep");
    expect(selectedId(sidebar)).toBe("g-two");
  });

  test("navigate view: the row below takes the slot, the row above when it was the last", () => {
    const sidebar = treeSidebar([]);
    sidebar.folderView = "navigate";
    select(sidebar, { type: "guild", id: "g-root" });
    moveTo(sidebar, "Chill");
    expect(selectedId(sidebar)).toBe("dev");

    select(sidebar, { type: "guild", id: "g-after" });
    moveTo(sidebar, "Chill");
    expect(selectedId(sidebar)).toBe("chill");
  });
});
