import { describe, expect, test } from "bun:test";

import { createEditorState, handleEditorKey } from "./editor";
import { handleHistoryVimKey } from "./historycursor";
import { handleHistorySelectionQuoteKey } from "./historyselection";
import { createInitialState, focusHistory, type AppState } from "./state";

function setupSelection(
  text: string,
  mode: "visual" | "visual-line" = "visual",
  draft = "",
): AppState {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.editor = createEditorState("", "insert");
  for (const char of draft) {
    handleEditorKey(state.editor, { type: "char", char });
  }
  focusHistory(state);
  state.editor.mode = mode;
  state.historyLines = [text];
  state.historyWrapContinuation = [false];
  state.historyVisualAnchor = { row: 0, col: 0 };
  state.historyCursor = { row: 0, col: Math.max(0, text.length - 1) };
  return state;
}

describe("quoting a history selection into the prompt", () => {
  test("visual ; appends a triple-quote block and focuses its following line", () => {
    const state = setupSelection("alpha beta");
    state.editor.lastFind = { char: "a", direction: "f" };

    expect(handleHistorySelectionQuoteKey(state, { type: "char", char: ";" })).toBe(true);

    expect(state.editor.buffer).toBe(`"""\nalpha beta\n"""\n`);
    expect(state.editor.cursor).toBe(state.editor.buffer.length);
    expect(state.panelFocus).toBe("chat");
    expect(state.chatFocus).toBe("prompt");
    expect(state.editor.mode).toBe("insert");
  });

  test("appends after a pre-existing draft and keeps the quote as its own undo step", () => {
    const state = setupSelection("alpha beta", "visual", "Compare this");

    expect(handleHistorySelectionQuoteKey(state, { type: "char", char: ";" })).toBe(true);
    const quotedDraft = `Compare this\n"""\nalpha beta\n"""\n`;
    expect(state.editor.buffer).toBe(quotedDraft);

    for (const char of "explain") {
      expect(handleEditorKey(state.editor, { type: "char", char })).toBe("handled");
    }
    expect(handleEditorKey(state.editor, { type: "escape" })).toBe("handled");
    expect(handleEditorKey(state.editor, { type: "char", char: "u" })).toBe("handled");
    expect(state.editor.buffer).toBe(quotedDraft);
    expect(handleEditorKey(state.editor, { type: "char", char: "u" })).toBe("handled");
    expect(state.editor.buffer).toBe("Compare this");
  });

  test("does not add an extra newline when the draft already ends on an empty line", () => {
    const state = setupSelection("alpha beta", "visual", "Compare this\n");

    expect(handleHistorySelectionQuoteKey(state, { type: "char", char: ";" })).toBe(true);

    expect(state.editor.buffer).toBe(`Compare this\n"""\nalpha beta\n"""\n`);
  });

  test("visual-line selection reconstructs soft-wrapped text", () => {
    const state = setupSelection("alpha", "visual-line");
    state.historyLines = ["alpha", "beta"];
    state.historyWrapContinuation = [false, true];
    state.historyVisualAnchor = { row: 0, col: 0 };
    state.historyCursor = { row: 1, col: 0 };

    expect(handleHistorySelectionQuoteKey(state, { type: "char", char: ";" })).toBe(true);

    expect(state.editor.buffer).toBe(`"""\nalpha beta\n"""\n`);
  });

  test("preserves a selected emoji as a complete grapheme", () => {
    const state = setupSelection("😀");
    state.historyCursor = { row: 0, col: 0 };

    expect(handleHistorySelectionQuoteKey(state, { type: "char", char: ";" })).toBe(true);

    expect(state.editor.buffer).toBe(`"""\n😀\n"""\n`);
  });

  test("normal-mode ; remains history repeat-find", () => {
    const state = setupSelection("alpha");
    state.editor.mode = "normal";
    state.editor.lastFind = { char: "p", direction: "f" };
    state.historyCursor = { row: 0, col: 0 };

    expect(handleHistorySelectionQuoteKey(state, { type: "char", char: ";" })).toBe(false);
    expect(handleHistoryVimKey(state, { type: "char", char: ";" }, 1)).toBe(true);

    expect(state.historyCursor).toEqual({ row: 0, col: 2 });
    expect(state.editor.buffer).toBe("");
    expect(state.chatFocus).toBe("history");
  });
});
