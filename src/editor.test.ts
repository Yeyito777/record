import { describe, expect, test } from "bun:test";

import { createEditorState, getInputLines, getViewport, handleEditorKey } from "./editor";

describe("editor", () => {
  test("escape leaves insert mode and moves cursor left", () => {
    const editor = createEditorState("secret", "insert");
    editor.cursor = editor.buffer.length;

    handleEditorKey(editor, { type: "escape" });

    expect(editor.mode).toBe("normal");
    expect(editor.cursor).toBe(editor.buffer.length - 1);
  });

  test("dd clears the buffer in normal mode", () => {
    const editor = createEditorState("secret", "normal");

    handleEditorKey(editor, { type: "char", char: "d" });
    handleEditorKey(editor, { type: "char", char: "d" });

    expect(editor.buffer).toBe("");
    expect(editor.cursor).toBe(0);
  });

  test("ciw changes the current word and enters insert mode", () => {
    const editor = createEditorState("hello world", "normal");
    editor.cursor = 1;

    handleEditorKey(editor, { type: "char", char: "c" });
    handleEditorKey(editor, { type: "char", char: "i" });
    handleEditorKey(editor, { type: "char", char: "w" });
    handleEditorKey(editor, { type: "char", char: "H" });

    expect(editor.mode).toBe("insert");
    expect(editor.buffer).toBe("H world");
    expect(editor.cursor).toBe(1);
  });

  test("visual delete removes the selected range", () => {
    const editor = createEditorState("hello world", "normal");
    editor.cursor = 0;

    handleEditorKey(editor, { type: "char", char: "v" });
    handleEditorKey(editor, { type: "char", char: "e" });
    handleEditorKey(editor, { type: "char", char: "d" });

    expect(editor.mode).toBe("normal");
    expect(editor.buffer).toBe(" world");
  });

  test("ctrl+l inserts a newline in insert mode", () => {
    const editor = createEditorState("hello", "insert");

    handleEditorKey(editor, { type: "ctrl-l" });
    handleEditorKey(editor, { type: "char", char: "x" });

    expect(editor.buffer).toBe("hello\nx");
  });

  test("gg and G return scroll actions in prompt normal mode", () => {
    const editor = createEditorState("hello", "normal");

    expect(handleEditorKey(editor, { type: "char", char: "g" })).toBe("handled");
    expect(handleEditorKey(editor, { type: "char", char: "g" })).toBe("scroll_top");
    expect(handleEditorKey(editor, { type: "char", char: "G" })).toBe("scroll_bottom");
  });

  test("viewport keeps the cursor visible at the end of long input", () => {
    const view = getViewport("abcdefghijkl", 12, 6, 0);

    expect(view.scroll).toBe(7);
    expect(view.cursorCol).toBe(5);
    expect(view.text).toBe("hijkl");
  });

  test("input lines hard-wrap and keep the cursor visible", () => {
    const input = getInputLines("hello world", 11, 5, 2, 0);

    expect(input.lines).toEqual([" worl", "d"]);
    expect(input.cursorLine).toBe(1);
    expect(input.cursorCol).toBe(1);
  });
});
