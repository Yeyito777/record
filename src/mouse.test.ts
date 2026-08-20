import { describe, expect, test } from "bun:test";

import { handleMouseEvent } from "./mouse";
import { setSidebarGuilds, SIDEBAR_WIDTH } from "./sidebar";
import { createInitialState } from "./state";

function mouseState(guildCount = 4) {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.rows = 7;
  state.sidebar.open = true;
  setSidebarGuilds(state.sidebar, Array.from({ length: guildCount }, (_unused, index) => ({
    id: `guild-${index}`,
    name: `Guild ${index}`,
    icon: null,
  })));
  return state;
}

function mouseEvent(overrides: Partial<Parameters<typeof handleMouseEvent>[0]> = {}): Parameters<typeof handleMouseEvent>[0] {
  return {
    type: "mouse",
    button: 3,
    col: 5,
    row: 3,
    action: "motion",
    shift: false,
    meta: false,
    ctrl: false,
    ...overrides,
  };
}

describe("mouse routing", () => {
  test("focus and keyboard selection follow a hovered sidebar row", () => {
    const state = mouseState();
    const cursorWrites: string[] = [];

    expect(handleMouseEvent(
      mouseEvent({ row: 4 }),
      state,
      (sequence) => cursorWrites.push(sequence),
    )).toEqual({ type: "handled" });

    expect(state.panelFocus).toBe("sidebar");
    expect(state.sidebar.selectedIndex).toBe(1);
    expect(state.sidebar.selectedItem).toEqual({ type: "guild", id: "guild-1" });
    expect(state.mouseCursor).toBe("hand");
    expect(cursorWrites).toHaveLength(1);
  });

  test("left click focuses the exact row and requests normal sidebar activation", () => {
    const state = mouseState();

    const result = handleMouseEvent(
      mouseEvent({ button: 0, row: 5, action: "press" }),
      state,
      () => {},
    );

    expect(result).toEqual({ type: "activate_sidebar" });
    expect(state.sidebar.selectedItem).toEqual({ type: "guild", id: "guild-2" });
  });

  test("header and separator chrome are not clickable", () => {
    const state = mouseState();

    expect(handleMouseEvent(
      mouseEvent({ button: 0, row: 1, action: "press" }),
      state,
      () => {},
    )).toEqual({ type: "handled" });
    expect(state.sidebar.selectedIndex).toBe(0);
    expect(state.sidebar.selectedItem).toBeNull();
    expect(state.mouseCursor).toBe("pointer");
  });

  test("wheel scrolls the sidebar viewport one row in either direction", () => {
    const state = mouseState(10);
    state.sidebar.selectedIndex = 2;
    state.sidebar.selectedItem = null;

    handleMouseEvent(mouseEvent({ button: 65, action: "press" }), state, () => {});
    expect(state.sidebar.scrollOffset).toBe(1);

    handleMouseEvent(mouseEvent({ button: 64, action: "press" }), state, () => {});
    expect(state.sidebar.scrollOffset).toBe(0);
  });

  test("wheel requests a three-line chat-history scroll outside the sidebar", () => {
    const state = mouseState();
    const chatCol = SIDEBAR_WIDTH + 1;

    expect(handleMouseEvent(
      mouseEvent({ button: 64, col: chatCol, action: "press" }),
      state,
      () => {},
    )).toEqual({ type: "scroll_chat", delta: -3 });

    expect(handleMouseEvent(
      mouseEvent({ button: 65, col: chatCol, action: "press" }),
      state,
      () => {},
    )).toEqual({ type: "scroll_chat", delta: 3 });
  });

  test("wheel releases do not scroll chat history", () => {
    const state = mouseState();

    expect(handleMouseEvent(
      mouseEvent({ button: 64, col: SIDEBAR_WIDTH + 1, action: "release" }),
      state,
      () => {},
    )).toEqual({ type: "handled" });
  });

  test("moving out of the sidebar returns panel focus to chat", () => {
    const state = mouseState();
    state.panelFocus = "sidebar";

    handleMouseEvent(mouseEvent({ col: SIDEBAR_WIDTH + 1 }), state, () => {});

    expect(state.panelFocus as "chat" | "sidebar").toBe("chat");
    expect(state.mouseCursor).toBe("pointer");
  });
});
