import { describe, expect, test } from "bun:test";

import {
  buildLineAnchorIndex,
  getHistoryVisualSelection,
  handleHistoryVimKey,
  placeHistoryCursorAtVisibleBottom,
  remapRenderedRow,
  scrollHistoryViewportSticky,
  scrollHistoryWithCursor,
} from "./historycursor";
import { createInitialState } from "./state";

describe("history cursor", () => {
  test("places the cursor at the visible bottom of the current viewport", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = ["one", "two", "three", "four"];
    state.timeline.scrollOffset = 1;

    placeHistoryCursorAtVisibleBottom(state, 2);

    expect(state.historyCursor).toEqual({ row: 2, col: 0 });
  });

  test("remaps rows by stable line anchors across history mutations", () => {
    const oldAnchors = ["msg:2:header", "msg:2:content:0:0", "msg:3:header"];
    const newAnchors = [
      "timeline:loading-older",
      "msg:1:header",
      "msg:1:content:0:0",
      "msg:2:header",
      "msg:2:content:0:0",
      "msg:3:header",
    ];

    const index = buildLineAnchorIndex(newAnchors);

    expect(remapRenderedRow(0, oldAnchors, index)).toBe(3);
    expect(remapRenderedRow(1, oldAnchors, index)).toBe(4);
    expect(remapRenderedRow(2, oldAnchors, index)).toBe(5);
  });

  test("line scrolling keeps the history cursor sticky until it would leave the viewport", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = Array.from({ length: 10 }, (_unused, index) => `line ${index}`);
    state.timeline.scrollOffset = 5;
    state.historyCursor = { row: 5, col: 0 };

    scrollHistoryViewportSticky(state, -1, 3);

    expect(state.timeline.scrollOffset).toBe(6);
    expect(state.historyCursor.row).toBe(6);

    scrollHistoryViewportSticky(state, 1, 3);

    expect(state.timeline.scrollOffset).toBe(5);
    expect(state.historyCursor.row).toBe(6);
  });

  test("page scrolling moves the cursor even when the viewport is already at an edge", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = Array.from({ length: 20 }, (_unused, index) => `line ${index}`);
    state.timeline.scrollOffset = 0;
    state.historyCursor = { row: 3, col: 0 };

    scrollHistoryWithCursor(state, 1, 5, 5);

    expect(state.timeline.scrollOffset).toBe(0);
    expect(state.historyCursor.row).toBe(0);

    state.timeline.scrollOffset = 15;
    state.historyCursor = { row: 16, col: 0 };
    scrollHistoryWithCursor(state, -1, 5, 5);

    expect(state.timeline.scrollOffset).toBe(15);
    expect(state.historyCursor.row).toBe(19);
  });

  test("supports quote text objects in history visual mode", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = ["The \"quick brown\" fox"];
    state.historyWrapContinuation = [false];
    state.historyCursor = { row: 0, col: 7 };

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 3)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "i" }, 3)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "\"" }, 3)).toBe(true);

    expect(state.editor.mode).toBe("visual");
    expect(getHistoryVisualSelection(state)).toBe("quick brown");
  });

  test("lowercase message text object selects only message text", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = [
      "Alice 12:00",
      "  hello there",
      "",
      "Bob 12:01",
      "  later",
    ];
    state.historyWrapContinuation = [false, false, false, false, false];
    state.historyLineAnchors = [
      "msg:message-1:header",
      "msg:message-1:content:0",
      "msg:message-1:gap",
      "msg:message-2:header",
      "msg:message-2:content:0",
    ];
    state.historyMessageBounds = [
      { messageId: "message-1", start: 0, end: 3, contentStart: 1, contentEnd: 2 },
      { messageId: "message-2", start: 3, end: 5, contentStart: 4, contentEnd: 5 },
    ];
    state.historyCursor = { row: 1, col: 2 };

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "i" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "m" }, 5)).toBe(true);

    expect(state.editor.mode).toBe("visual");
    expect(getHistoryVisualSelection(state)).toBe("hello there");
  });

  test("uppercase message text object selects the full rendered message", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = [
      "Alice 12:00",
      "  hello there",
      "",
      "Bob 12:01",
      "  later",
    ];
    state.historyWrapContinuation = [false, false, false, false, false];
    state.historyLineAnchors = [
      "msg:message-1:header",
      "msg:message-1:content:0",
      "msg:message-1:gap",
      "msg:message-2:header",
      "msg:message-2:content:0",
    ];
    state.historyMessageBounds = [
      { messageId: "message-1", start: 0, end: 3, contentStart: 1, contentEnd: 2 },
      { messageId: "message-2", start: 3, end: 5, contentStart: 4, contentEnd: 5 },
    ];
    state.historyCursor = { row: 1, col: 2 };

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "i" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "M" }, 5)).toBe(true);

    expect(state.editor.mode).toBe("visual");
    expect(getHistoryVisualSelection(state)).toBe("Alice 12:00\nhello there\n");
  });

  test("supports vim motions and visual selection in history", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = [
      "Alpha beta",
      "Gamma delta",
      "Epsilon zeta",
    ];
    state.historyWrapContinuation = [false, false, false];
    state.historyMessageBounds = [
      { messageId: "message-1", start: 0, end: 1, contentStart: 0, contentEnd: 1 },
      { messageId: "message-2", start: 1, end: 2, contentStart: 1, contentEnd: 2 },
      { messageId: "message-3", start: 2, end: 3, contentStart: 2, contentEnd: 3 },
    ];

    expect(handleHistoryVimKey(state, { type: "char", char: "j" }, 3)).toBe(true);
    expect(state.historyCursor.row).toBe(1);

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 3)).toBe(true);
    expect(state.editor.mode).toBe("visual");
    expect(state.historyVisualAnchor).toEqual({ row: 1, col: 0 });

    expect(handleHistoryVimKey(state, { type: "char", char: "w" }, 3)).toBe(true);
    expect(state.historyCursor.col).toBeGreaterThan(0);
    expect(getHistoryVisualSelection(state)).toBe("Gamma d");

    expect(handleHistoryVimKey(state, { type: "char", char: "V" }, 3)).toBe(true);
    expect(state.editor.mode).toBe("visual-line");
    expect(getHistoryVisualSelection(state)).toBe("Gamma delta");

    expect(handleHistoryVimKey(state, { type: "char", char: "}" }, 3)).toBe(true);
    expect(state.historyCursor.row).toBe(2);
  });
});
