import { describe, expect, spyOn, test } from "bun:test";

import { createEditorState, getInputLines, getViewport, handleEditorKey, wrappedLineOffsets } from "./editor";

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

  test("Shift+D deletes and yanks the visual selection", () => {
    const copiedTexts: string[] = [];
    const which = spyOn(Bun, "which").mockImplementation((command) => command === "xclip" ? "/usr/bin/xclip" : null);
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdin: {
        write(text: string) {
          copiedTexts.push(text);
        },
        end() {},
      },
    })) as unknown as typeof Bun.spawn);
    const editor = createEditorState("hello world", "normal");
    editor.cursor = 0;
    const lineEditor = createEditorState("one\ntwo\nthree", "normal");
    lineEditor.cursor = 0;

    try {
      handleEditorKey(editor, { type: "char", char: "v" });
      handleEditorKey(editor, { type: "char", char: "e" });
      handleEditorKey(editor, { type: "char", char: "D" });

      handleEditorKey(lineEditor, { type: "char", char: "V" });
      handleEditorKey(lineEditor, { type: "char", char: "j" });
      handleEditorKey(lineEditor, { type: "char", char: "D" });
    } finally {
      spawn.mockRestore();
      which.mockRestore();
    }

    expect(editor.mode).toBe("normal");
    expect(editor.buffer).toBe(" world");
    expect(editor.cursor).toBe(0);
    expect(lineEditor.mode).toBe("normal");
    expect(lineEditor.buffer).toBe("three");
    expect(copiedTexts).toEqual(["hello", "one\ntwo\n"]);
  });

  test("visual emoji yanks and edits preserve complete graphemes", () => {
    const copiedTexts: string[] = [];
    const which = spyOn(Bun, "which").mockImplementation((command) => command === "xclip" ? "/usr/bin/xclip" : null);
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdin: {
        write(text: string) { copiedTexts.push(text); },
        end() {},
      },
    })) as unknown as typeof Bun.spawn);

    try {
      for (const emoji of ["😭", "❤️", "👍🏽", "👩‍💻", "🇨🇦"]) {
        for (const keys of ["vy", "vly", "vhy", "vey", "viwy", "vD", "vd", "vc"]) {
          const single = ["vy", "vD", "vd", "vc"].includes(keys);
          const editor = createEditorState(single ? `a${emoji}b` : `${emoji}${emoji}`, "normal");
          editor.cursor = single ? 1 : keys === "vhy" ? emoji.length : 0;
          for (const char of keys) handleEditorKey(editor, { type: "char", char });

          if (keys.endsWith("y") || keys.endsWith("D")) {
            const expected = single ? emoji : emoji + emoji;
            expect(copiedTexts.at(-1)).toBe(expected);
            // The actual clipboard receives UTF-8, where split surrogates are lost.
            expect(Buffer.from(copiedTexts.at(-1)!, "utf8").toString("utf8")).toBe(expected);
          }
          expect(editor.buffer).toBe(
            ["vD", "vd", "vc"].includes(keys) ? "ab" : single ? `a${emoji}b` : emoji + emoji,
          );
          expect(editor.mode).toBe(keys === "vc" ? "insert" : "normal");
        }
      }
    } finally {
      spawn.mockRestore();
      which.mockRestore();
    }
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

  test("insert-mode up/down preserve preferred column across short lines", () => {
    const editor = createEditorState("abcdef\nx\n123456789", "insert");
    editor.cursor = 5;

    handleEditorKey(editor, { type: "down" });
    expect(editor.cursor).toBe(8); // insert cursor may sit after the short line

    handleEditorKey(editor, { type: "down" });
    expect(editor.cursor).toBe(14);
    expect(editor.curswant).toBe(5);
  });

  test("normal-mode j/k preserve preferred column without landing past line end", () => {
    const editor = createEditorState("abcdef\nx\n123456789", "normal");
    editor.cursor = 5;

    handleEditorKey(editor, { type: "char", char: "j" });
    expect(editor.cursor).toBe(7); // on x, not after x

    handleEditorKey(editor, { type: "char", char: "j" });
    expect(editor.cursor).toBe(14);
  });

  test("normal-mode h/l do not treat newline delimiters as prompt characters", () => {
    const editor = createEditorState("ab\ncd", "normal");

    editor.cursor = 1; // b, last character before newline
    handleEditorKey(editor, { type: "char", char: "l" });
    expect(editor.cursor).toBe(1);
    expect(editor.buffer[editor.cursor]).toBe("b");

    editor.cursor = 3; // c, first character after newline
    handleEditorKey(editor, { type: "char", char: "h" });
    expect(editor.cursor).toBe(3);
    expect(editor.buffer[editor.cursor]).toBe("c");
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

  test("prompt cursor columns use terminal width for inline custom emoji", () => {
    const marker = "\ue000";
    const buffer = `look ${marker}`;
    const input = getInputLines(buffer, buffer.length, 20, 2, 0);

    expect(input.lines).toEqual([buffer]);
    expect(input.cursorLine).toBe(0);
    expect(input.cursorCol).toBe(7);
  });

  test("prompt wrapping keeps a two-column custom emoji atomic", () => {
    const marker = "\ue000";
    const buffer = `abcd${marker}x`;
    const afterEmoji = "abcd".length + marker.length;
    const input = getInputLines(buffer, afterEmoji, 5, 3, 0);

    expect(input.lines).toEqual(["abcd", `${marker}x`]);
    expect(input.cursorLine).toBe(1);
    expect(input.cursorCol).toBe(2);
    expect(wrappedLineOffsets(buffer, 5)).toEqual([0, 4]);
  });
});
