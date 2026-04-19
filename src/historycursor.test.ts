import { describe, expect, test } from "bun:test";

import {
  buildLineAnchorIndex,
  getHistoryVisualSelection,
  handleHistoryVimKey,
  placeHistoryCursorAtVisibleBottom,
  remapRenderedRow,
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
      { start: 0, end: 1, contentStart: 0, contentEnd: 1 },
      { start: 1, end: 2, contentStart: 1, contentEnd: 2 },
      { start: 2, end: 3, contentStart: 2, contentEnd: 3 },
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
