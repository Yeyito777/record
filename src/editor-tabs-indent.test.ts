import { describe, expect, test } from "bun:test";

import { createEditorState, getInputLines, handleEditorKey, type EditorMode, type EditorState } from "./editor";
import { sanitizePromptTextForInsertion } from "./prompttext";

function prompt(buffer = "", cursor = buffer.length, mode: EditorMode = "insert"): EditorState {
  const editor = createEditorState(buffer, mode);
  editor.cursor = cursor;
  return editor;
}

function chars(editor: EditorState, keys: string): void {
  for (const char of keys) handleEditorKey(editor, { type: "char", char });
}

describe("prompt soft tabs", () => {
  test("Tab inserts four spaces and clears the preferred column", () => {
    const editor = prompt();
    editor.curswant = 10;
    handleEditorKey(editor, { type: "tab" });
    expect(editor.buffer).toBe("    ");
    expect(editor.cursor).toBe(4);
    expect(editor.curswant).toBeNull();
    expect(getInputLines(editor.buffer, editor.cursor, 80, 5).cursorCol).toBe(4);
  });

  test("tabs insert mid-line and repeated Backspace removes one tab per press", () => {
    const editor = prompt("🙂tail", 2);
    handleEditorKey(editor, { type: "tab" });
    handleEditorKey(editor, { type: "tab" });
    expect(editor.buffer).toBe("🙂        tail");
    expect(editor.cursor).toBe(10);
    handleEditorKey(editor, { type: "backspace" });
    expect(editor.buffer).toBe("🙂    tail");
    expect(editor.cursor).toBe(6);
    handleEditorKey(editor, { type: "backspace" });
    expect(editor.buffer).toBe("🙂tail");
    expect(editor.cursor).toBe(2);
  });

  test("Delete removes one four-space tab at the cursor", () => {
    const editor = prompt("a    b", 1);
    handleEditorKey(editor, { type: "delete" });
    expect(editor.buffer).toBe("ab");
    expect(editor.cursor).toBe(1);
  });

  for (const buffer of ["a b", "a  b", "a   b", "a  \n  b"]) {
    test(`short space runs still delete one character: ${JSON.stringify(buffer)}`, () => {
      const editor = prompt(buffer, buffer.length - 1);
      handleEditorKey(editor, { type: "backspace" });
      expect(editor.buffer).toBe(buffer.slice(0, -2) + "b");
      expect(editor.cursor).toBe(buffer.length - 2);
    });
  }

  test("deletion does not split combining characters on spaces", () => {
    const editor = prompt("    ́x", 0);
    handleEditorKey(editor, { type: "delete" });
    expect(editor.buffer).toBe("   ́x");
    editor.cursor = 4;
    handleEditorKey(editor, { type: "backspace" });
    expect(editor.buffer).toBe("  x");
  });

  test("Tab in normal mode does not insert whitespace", () => {
    const editor = prompt("text", 0, "normal");
    handleEditorKey(editor, { type: "tab" });
    expect(editor.buffer).toBe("text");
  });

  test("tabs participate in insert-session undo and redo", () => {
    const editor = prompt("text", 0, "normal");
    chars(editor, "i");
    handleEditorKey(editor, { type: "tab" });
    handleEditorKey(editor, { type: "escape" });
    chars(editor, "u");
    expect(editor.buffer).toBe("text");
    handleEditorKey(editor, { type: "ctrl-r" });
    expect(editor.buffer).toBe("    text");
  });

  test("inserted terminal text expands hard tabs to soft tabs", () => {
    expect(sanitizePromptTextForInsertion("a\tb")).toBe("a    b");
  });
});

describe("prompt line shifts", () => {
  test("first > is pending; >> shifts only the current logical line", () => {
    const editor = prompt("one\ntwo\nthree", 5, "normal");
    editor.curswant = 8;
    chars(editor, ">");
    expect(editor.pendingKeys).toBe(">");
    expect(editor.buffer).toBe("one\ntwo\nthree");
    chars(editor, ">");
    expect(editor.buffer).toBe("one\n    two\nthree");
    expect(editor.cursor).toBe(8);
    expect(editor.pendingKeys).toBe("");
    expect(editor.curswant).toBeNull();
    chars(editor, "<<");
    expect(editor.buffer).toBe("one\ntwo\nthree");
    expect(editor.cursor).toBe(4);
  });

  test("a count shifts that many lines once, not multiple indentation levels", () => {
    const editor = prompt("a\nb\nc\nd", 0, "normal");
    chars(editor, "3>>");
    expect(editor.buffer).toBe("    a\n    b\n    c\nd");
    expect(editor.count).toBeNull();
    chars(editor, "9<<");
    expect(editor.buffer).toBe("a\nb\nc\nd");
  });

  test("<< removes up to four leading spaces without touching text", () => {
    const editor = prompt("  a\n      b\nc", 0, "normal");
    chars(editor, "3<<");
    expect(editor.buffer).toBe("a\n  b\nc");
    chars(editor, "u");
    expect(editor.buffer).toBe("  a\n      b\nc");
    handleEditorKey(editor, { type: "ctrl-r" });
    expect(editor.buffer).toBe("a\n  b\nc");
  });

  test("a no-op outdent does not create an undo entry", () => {
    const editor = prompt("abc", 2, "normal");
    chars(editor, "<<");
    expect(editor.buffer).toBe("abc");
    expect(editor.cursor).toBe(0);
    expect(editor.undo.undoStack).toHaveLength(0);
  });

  test("empty and trailing lines can be shifted", () => {
    const editor = prompt("", 0, "normal");
    chars(editor, ">>");
    expect(editor.buffer).toBe("    ");
    chars(editor, "<<");
    expect(editor.buffer).toBe("");
    editor.buffer = "a\n";
    editor.cursor = 2;
    chars(editor, ">>");
    expect(editor.buffer).toBe("a\n    ");
  });

  for (const mode of ["visual", "visual-line"] as const) {
    for (const reversed of [false, true]) {
      test(`${mode} ${reversed ? "backward" : "forward"} selection shifts whole touched lines`, () => {
        const editor = prompt("one\ntwo\nthree", reversed ? 1 : 5, "normal");
        editor.mode = mode;
        editor.visualAnchor = reversed ? 5 : 1;
        chars(editor, ">");
        expect(editor.pendingKeys).toBe(">");
        expect(editor.mode).toBe(mode);
        chars(editor, ">");
        expect(editor.buffer).toBe("    one\n    two\nthree");
        expect(editor.cursor).toBe(4);
        expect(editor.mode as EditorMode).toBe("normal");
        chars(editor, "u");
        expect(editor.buffer).toBe("one\ntwo\nthree");

        editor.buffer = "    one\n  two\nthree";
        editor.cursor = 11;
        editor.mode = mode;
        editor.visualAnchor = 4;
        chars(editor, "<<");
        expect(editor.buffer).toBe("one\ntwo\nthree");
        expect(editor.mode as EditorMode).toBe("normal");
      });
    }
  }

  test("visual-line shift never accidentally includes the following line", () => {
    const editor = prompt("one\ntwo\nthree", 5, "normal");
    editor.mode = "visual-line";
    editor.visualAnchor = 4;
    chars(editor, ">>");
    expect(editor.buffer).toBe("one\n    two\nthree");
  });

  for (const mode of ["normal", "visual", "visual-line"] as const) {
    test(`${mode} shift prefix can be cancelled with Escape or an invalid key`, () => {
      const editor = prompt("one", 0, "normal");
      editor.mode = mode;
      chars(editor, ">r");
      expect(editor.pendingKeys).toBe("");
      expect(editor.pendingReplace).toBe(false);
      expect(editor.buffer).toBe("one");
      chars(editor, "<");
      handleEditorKey(editor, { type: "escape" });
      expect(editor.pendingKeys).toBe("");
      expect(editor.mode).toBe("normal");
      expect(editor.buffer).toBe("one");
    });
  }

  test("insert mode types angle brackets instead of shifting", () => {
    const editor = prompt();
    chars(editor, ">><<");
    expect(editor.buffer).toBe(">><<");
  });
});
