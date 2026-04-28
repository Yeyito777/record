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

  test("backspace and delete remove whole emoji graphemes", () => {
    const editor = createEditorState("a😭b", "insert");
    editor.cursor = "a😭".length;

    handleEditorKey(editor, { type: "backspace" });

    expect(editor.buffer).toBe("ab");
    expect(editor.cursor).toBe(1);

    editor.buffer = "a❤️b";
    editor.cursor = 1;
    handleEditorKey(editor, { type: "delete" });

    expect(editor.buffer).toBe("ab");
    expect(editor.cursor).toBe(1);
  });

  test("cursor movement treats emoji as one character", () => {
    const editor = createEditorState("a😭b", "insert");
    editor.cursor = editor.buffer.length;

    handleEditorKey(editor, { type: "left" });
    expect(editor.cursor).toBe("a😭".length);

    handleEditorKey(editor, { type: "left" });
    expect(editor.cursor).toBe(1);

    handleEditorKey(editor, { type: "right" });
    expect(editor.cursor).toBe("a😭".length);
  });

  test("escape leaves normal cursor on emoji start", () => {
    const editor = createEditorState("😭", "insert");
    editor.cursor = editor.buffer.length;

    handleEditorKey(editor, { type: "escape" });

    expect(editor.mode).toBe("normal");
    expect(editor.cursor).toBe(0);
  });

  test("append after an emoji places insert cursor after the whole grapheme", () => {
    const editor = createEditorState("😭", "normal");
    editor.cursor = 0;

    handleEditorKey(editor, { type: "char", char: "a" });
    handleEditorKey(editor, { type: "char", char: "x" });

    expect(editor.mode).toBe("insert");
    expect(editor.buffer).toBe("😭x");
    expect(editor.cursor).toBe("😭x".length);
  });

  test("append after a variation-selector emoji places insert cursor after the whole grapheme", () => {
    const editor = createEditorState("❤️", "normal");
    editor.cursor = 0;

    handleEditorKey(editor, { type: "char", char: "a" });
    handleEditorKey(editor, { type: "char", char: "x" });

    expect(editor.buffer).toBe("❤️x");
    expect(editor.cursor).toBe("❤️x".length);
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

  test("enter submits from insert mode", () => {
    const editor = createEditorState("/theme whale", "insert");

    expect(handleEditorKey(editor, { type: "enter" })).toBe("submit");
  });

  test("ctrl+l inserts a newline in insert mode", () => {
    const editor = createEditorState("hello", "insert");

    handleEditorKey(editor, { type: "ctrl-l" });
    handleEditorKey(editor, { type: "char", char: "x" });

    expect(editor.buffer).toBe("hello\nx");
  });

  test("symbol function keys insert only in insert mode", () => {
    const editor = createEditorState("ab", "insert");
    editor.cursor = 1;

    handleEditorKey(editor, { type: "f14" });
    handleEditorKey(editor, { type: "f15" });
    handleEditorKey(editor, { type: "f16" });
    handleEditorKey(editor, { type: "f22" });
    handleEditorKey(editor, { type: "f23" });
    handleEditorKey(editor, { type: "f24" });

    expect(editor.buffer).toBe("a←•→✗✓—b");

    editor.mode = "normal";
    const before = editor.buffer;
    handleEditorKey(editor, { type: "f14" });
    expect(editor.buffer).toBe(before);
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
