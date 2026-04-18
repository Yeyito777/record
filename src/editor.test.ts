import { describe, expect, test } from "bun:test";

import { createEditorState, getViewport, handleEditorKey } from "./editor";

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

  test("viewport keeps the cursor visible at the end of long input", () => {
    const view = getViewport("abcdefghijkl", 12, 6, 0);

    expect(view.scroll).toBe(7);
    expect(view.cursorCol).toBe(5);
    expect(view.text).toBe("hijkl");
  });
});
