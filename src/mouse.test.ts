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

describe("clicks in the chat column", () => {
  function chatState() {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.rows = 20;
    state.sidebar.open = false;
    state.historyLines = ["hello world", "日本 x", "see https://example.com now"];
    state.timeline.scrollOffset = 0;
    state.chatMouseLayout = { firstCol: 1, lastCol: 80, bodyTop: 3, bodyRows: 10, firstInputRow: 15, inputRows: 2, firstLine: 0 };
    return state;
  }
  const press = (col: number, row: number) => mouseEvent({ button: 0, action: "press", col, row });
  const drag = (col: number, row: number) => mouseEvent({ button: 0, action: "motion", col, row });
  const release = (col: number, row: number) => mouseEvent({ button: 0, action: "release", col, row });

  test("a click in the prompt focuses it", () => {
    const writes: string[] = [];
    expect(handleMouseEvent(press(10, 16), chatState(), (s) => writes.push(s))).toEqual({ type: "focus_prompt" });
    expect(writes.at(-1)).toContain("mouseshape;text");
  });

  test("a press in history lands on the clicked character, wide glyphs included", () => {
    const state = chatState();
    expect(handleMouseEvent(press(8, 3), state, () => {})).toEqual({ type: "history_press", row: 0, col: 6 });
    // "日本 x": columns 0-1 日, 2-3 本, 4 space, 5 x
    expect(handleMouseEvent(press(5, 4), state, () => {})).toEqual({ type: "history_press", row: 1, col: 1 });
  });

  test("press, drag and release select; press and release on one character is a click", () => {
    const state = chatState();
    handleMouseEvent(press(3, 3), state, () => {});
    expect(handleMouseEvent(drag(9, 4), state, () => {})).toEqual({ type: "history_drag", row: 1, col: 3 });
    expect(handleMouseEvent(release(9, 4), state, () => {})).toEqual({ type: "history_release", position: { row: 1, col: 3 } });
    expect(state.mouseHistoryPress).toBeNull();

    handleMouseEvent(press(10, 5), state, () => {});
    expect(handleMouseEvent(release(10, 5), state, () => {})).toEqual({ type: "history_click", row: 2, col: 8 });
  });

  test("past the end of a line a press selects but a release is no click", () => {
    const state = chatState();
    expect(handleMouseEvent(press(60, 3), state, () => {})).toEqual({ type: "history_press", row: 0, col: 10 });
    expect(handleMouseEvent(release(60, 3), state, () => {})).toEqual({ type: "history_release", position: { row: 0, col: 10 } });
  });

  test("the pointer is a hand over a link and an I-beam over other text", () => {
    const state = chatState();
    const writes: string[] = [];
    handleMouseEvent(mouseEvent({ col: 12, row: 5 }), state, (s) => writes.push(s));
    expect(writes.at(-1)).toContain("mouseshape;hand");
    handleMouseEvent(mouseEvent({ col: 3, row: 5 }), state, (s) => writes.push(s));
    expect(writes.at(-1)).toContain("mouseshape;text");
  });

  test("rows map to the lines drawn, mid-glide included", () => {
    const state = chatState();
    state.chatMouseLayout = { ...state.chatMouseLayout!, firstLine: 1 };
    expect(handleMouseEvent(press(3, 3), state, () => {})).toEqual({ type: "history_press", row: 1, col: 0 });
  });

  test("clicks below the history content or outside the chat column do nothing", () => {
    const state = chatState();
    expect(handleMouseEvent(press(8, 8), state, () => {})).toEqual({ type: "handled" });
    expect(handleMouseEvent(press(90, 16), state, () => {})).toEqual({ type: "handled" });
  });
});
