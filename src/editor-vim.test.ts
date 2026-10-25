import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isLinewiseClipboardText, setTextClipboardSystemForTest } from "./editor-clipboard";
import { createEditorState, getInputLines, handleEditorKey, type EditorMode, type EditorState } from "./editor";
import type { KeyEvent } from "./input";

/** An editor whose prompt wraps at `width` columns (null: logical lines only). */
function prompt(buffer: string, cursor: number, mode: EditorMode = "normal", width: number | null = 76): EditorState {
  const editor = createEditorState(buffer, mode);
  editor.cursor = cursor;
  editor.wrapWidth = width;
  return editor;
}

/** Type keys; `<esc>`, `<up>`, `<down>`, `<left>`, `<right>`, `<home>`, `<end>` are special. */
function keys(editor: EditorState, sequence: string): void {
  for (const token of sequence.match(/<[a-z]+>|./gsu) ?? []) {
    const key: KeyEvent = token.length > 1 && token.startsWith("<")
      ? { type: token.slice(1, -1) === "esc" ? "escape" : token.slice(1, -1) } as KeyEvent
      : { type: "char", char: token };
    handleEditorKey(editor, key);
  }
}

/** Run keys from a normal-mode cursor; return buffer and cursor. */
function vim(buffer: string, cursor: number, sequence: string): { buffer: string; cursor: number } {
  const editor = prompt(buffer, cursor);
  keys(editor, sequence);
  return { buffer: editor.buffer, cursor: editor.cursor };
}

describe("prompt j/k move by display rows", () => {
  // One logical line wrapped into three 10-column rows.
  const wrapped = "0123456789abcdefghijKLMNOPQRST";

  test("k and j step through a wrapped line's rows, keeping the column", () => {
    const editor = prompt(wrapped, 25, "normal", 10);
    keys(editor, "k");
    expect(editor.cursor).toBe(15);
    keys(editor, "k");
    expect(editor.cursor).toBe(5);
    keys(editor, "k");
    expect(editor.cursor).toBe(5);
    keys(editor, "jj");
    expect(editor.cursor).toBe(25);
    keys(editor, "2k");
    expect(editor.cursor).toBe(5);
  });

  test("k at the top visible row of a scrolled prompt scrolls up one row", () => {
    const buffer = "x".repeat(50); // five 10-column rows
    const editor = prompt(buffer, 45, "normal", 10);
    let view = getInputLines(buffer, editor.cursor, 10, 2);
    expect(view.scrollOffset).toBe(3);

    keys(editor, "k");
    view = getInputLines(buffer, editor.cursor, 10, 2, view.scrollOffset);
    expect(editor.cursor).toBe(35);
    expect(view.scrollOffset).toBe(3);
    expect(view.cursorLine).toBe(0);

    keys(editor, "k");
    view = getInputLines(buffer, editor.cursor, 10, 2, view.scrollOffset);
    expect(editor.cursor).toBe(25);
    expect(view.scrollOffset).toBe(2);
    expect(view.cursorLine).toBe(0);

    keys(editor, "jjj");
    view = getInputLines(buffer, editor.cursor, 10, 2, view.scrollOffset);
    expect(editor.cursor).toBe(45);
    expect(view.scrollOffset).toBe(3);
    expect(view.cursorLine).toBe(1);
  });

  test("insert-mode Up/Down also move by display rows", () => {
    const editor = prompt(wrapped, 23, "insert", 10);
    handleEditorKey(editor, { type: "up" });
    expect(editor.cursor).toBe(13);
    handleEditorKey(editor, { type: "down" });
    expect(editor.cursor).toBe(23);
  });

  test("visual j/k extend by display rows", () => {
    const editor = prompt(wrapped, 5, "normal", 10);
    keys(editor, "vj");
    expect(editor.cursor).toBe(15);
    expect(editor.visualAnchor).toBe(5);
  });

  test("display rows keep wide emoji atomic", () => {
    // Each emoji is two cells: five per 10-column row.
    const editor = prompt("😀".repeat(8), "😀".length * 6, "normal", 10);
    keys(editor, "k");
    expect(editor.cursor).toBe("😀".length);
  });

  test("an end-of-row column never lands on the boundary that draws on the next row", () => {
    const editor = prompt("0123456789abc", 13, "insert", 10);
    handleEditorKey(editor, { type: "end" });
    handleEditorKey(editor, { type: "up" });
    expect(editor.cursor).toBe(9);
    expect(getInputLines(editor.buffer, editor.cursor, 10, 5).cursorLine).toBe(0);
  });

  test("an insert cursor past a full-width line gets its own row and moves from there", () => {
    const buffer = "0123456789\nxyz";
    const view = getInputLines(buffer, 10, 10, 5);
    expect(view.lines).toEqual(["0123456789", "", "xyz"]);
    expect(view.lineStarts).toEqual([0, 10, 11]);
    expect([view.cursorLine, view.cursorCol]).toEqual([1, 0]);

    const up = prompt(buffer, 10, "insert", 10);
    handleEditorKey(up, { type: "up" });
    expect(up.cursor).toBe(0);

    const down = prompt(buffer, 10, "insert", 10);
    handleEditorKey(down, { type: "down" });
    expect(down.cursor).toBe(11);
  });

  test("without a known wrap width j/k move by logical lines", () => {
    const editor = prompt(wrapped + "\nab", 25, "normal", null);
    keys(editor, "j");
    expect(editor.cursor).toBe(wrapped.length + 2);
  });

  test("$ makes j/k stick to the end of each line", () => {
    expect(vim("abcdef\nab\nabcdefgh", 0, "$jj").cursor).toBe(17);
  });

  test("f{char} finds j/k instead of moving vertically", () => {
    expect(vim("ab\nxjk", 3, "fj").cursor).toBe(4);
    expect(vim("ab\nxjk", 3, "fk").cursor).toBe(5);
  });
});

describe("prompt normal-mode arrow keys act as Vim motions", () => {
  test("Right and End stop on the line's last character", () => {
    expect(vim("ab\ncd", 1, "<right>").cursor).toBe(1);
    expect(vim("ab\ncd", 0, "<end>").cursor).toBe(1);
  });

  test("Down clamps to the last character like j", () => {
    expect(vim("abcdef\nx\nz", 5, "<down>").cursor).toBe(7);
  });

  test("Up/Down after an operator are linewise like k/j", () => {
    expect(vim("a\nb\nc", 0, "d<down>").buffer).toBe("c");
  });

  test("Home resets a pending count instead of extending it", () => {
    expect(vim("abc\nxyz", 2, "2<home>j").cursor).toBe(4);
  });

  test("an arrow cancels a pending find instead of moving", () => {
    expect(vim("abc", 0, "f<right>").cursor).toBe(0);
  });
});

describe("prompt normal-mode operators match Vim", () => {
  const cases: Array<[string, string, number, string, string, number]> = [
    // name, buffer, cursor, keys, expected buffer, expected cursor
    ["de is inclusive", "foo bar baz", 0, "de", " bar baz", 0],
    ["dE is inclusive", "foo.x bar", 0, "dE", " bar", 0],
    ["de from a word's end", "foo bar", 2, "de", "fo", 1],
    ["df includes the target", "a,b,c", 0, "df,", "b,c", 0],
    ["dF excludes the cursor", "a,b,c", 4, "dF,", "a,bc", 3],
    ["dt stops before the target", "foo(bar) x", 0, "dt(", "(bar) x", 0],
    ["dt next to the target deletes one char", "foo(bar) x", 2, "dt(", "fo(bar) x", 2],
    ["dt without a match does nothing", "a,b,c", 0, "dtz", "a,b,c", 0],
    ["dT deletes back to just after the target", "a,bcd", 4, "dT,", "a,d", 2],
    ["cw changes to the word end", "foo bar", 0, "cwX<esc>", "X bar", 0],
    ["cw on a word's last char", "foo bar", 2, "cwX<esc>", "foX bar", 2],
    ["cw on blanks changes the blanks", "foo   bar", 3, "cwX<esc>", "fooXbar", 3],
    ["2cw", "foo bar baz", 0, "2cwX<esc>", "X baz", 0],
    ["cw stops at punctuation", "foo.bar", 0, "cwX<esc>", "X.bar", 0],
    ["dw on a line's last word keeps the line break", "foo bar\n  baz", 4, "dw", "foo \n  baz", 3],
    ["dw keeps the line break after trailing blanks", "foo   \n  bar", 0, "dw", "\n  bar", 0],
    ["2dw", "foo bar\nbaz qux", 0, "2dw", "\nbaz qux", 0],
    ["3dw crosses the line on an inner word", "foo bar\nbaz qux", 0, "3dw", "qux", 0],
    ["dw on an empty line deletes it", "abc\n\ndef", 4, "dw", "abc\ndef", 4],
    ["dw at the buffer end", "foo bar", 4, "dw", "foo ", 3],
    ["dl at a line's end", "ab\ncd", 1, "dl", "a\ncd", 0],
    ["dj deletes both lines", "a\n  b\nc\nd", 0, "dj", "c\nd", 0],
    ["dk deletes both lines", "a\nb\nc", 4, "dk", "a", 0],
    ["dj on the last line does nothing", "a\nb", 2, "dj", "a\nb", 2],
    ["5dj deletes what is there", "a\nb\nc", 0, "5dj", "", 0],
    ["cj changes whole lines", "a\nb\nc", 0, "cjX<esc>", "X\nc", 0],
    ["3dd", "a\nb\nc\nd", 0, "3dd", "d", 0],
    ["d3d", "a\nb\nc\nd", 0, "d3d", "d", 0],
    ["3dw", "a b c d", 0, "3dw", "d", 0],
    ["2d2w", "a b c d e", 0, "2d2w", "e", 0],
    ["2cc", "a\nb\nc", 0, "2ccX<esc>", "X\nc", 0],
    ["3x stops at the line end", "abc\ndef", 1, "3x", "a\ndef", 0],
    ["x at a line's end keeps the cursor on the line", "abc\nd", 2, "x", "ab\nd", 1],
    ["x on an empty line does nothing", "a\n\nb", 2, "x", "a\n\nb", 2],
    ["x deletes a whole emoji", "a😀b", 1, "x", "ab", 1],
    ["3X stops at the line start", "abcdef", 2, "3X", "cdef", 0],
    ["X at a line's start does nothing", "ab\ncd", 3, "X", "ab\ncd", 3],
    ["D on an empty line stays put", "a\n\nb", 2, "D", "a\n\nb", 2],
    ["2D", "abc\ndef\nghi", 1, "2D", "a\nghi", 0],
    ["2C", "abc\ndef\nghi", 1, "2CX<esc>", "aX\nghi", 1],
    ["3~", "abcdef", 0, "3~", "ABCdef", 3],
    ["fr finds r instead of starting a replace", "abrc", 0, "fr", "abrc", 2],
    ["f1 finds a digit instead of starting a count", "ab1c", 0, "f1", "ab1c", 2],
  ];

  for (const [name, buffer, cursor, sequence, expectedBuffer, expectedCursor] of cases) {
    test(name, () => {
      expect(vim(buffer, cursor, sequence)).toEqual({ buffer: expectedBuffer, cursor: expectedCursor });
    });
  }

  test("no-op edits do not create undo entries", () => {
    for (const sequence of ["x", "jX", "D", "j<<", "fz", "dtz"]) {
      const editor = prompt("a\n\nb", 2);
      keys(editor, sequence);
      expect(editor.undo.undoStack).toHaveLength(0);
    }
  });
});

describe("prompt normal-mode motions match Vim", () => {
  const cases: Array<[string, string, number, string, number]> = [
    ["$ rests on the last character", "ab\ncd", 0, "$", 1],
    ["^ goes to the first non-blank", "   abc", 5, "^", 3],
    ["w stops at an empty line", "abc\n\ndef", 0, "w", 4],
    ["W stops at an empty line", "abc\n\ndef", 0, "W", 4],
    ["b stops at an empty line", "abc\n\ndef", 5, "b", 4],
    ["B stops at an empty line", "abc\n\ndef", 5, "B", 4],
    ["e skips empty lines", "abc\n\ndef", 2, "e", 7],
    // In the app a bare t is the next-notification shortcut; the editor still
    // treats it as a motion, which is what a count or operator reaches.
    ["t stops before the target", "a,b,c", 0, "t,", 0],
    ["2t, skips the adjacent match", "a,b,c,d", 0, "2t,", 2],
    ["T stops after the target", "a,b,c", 4, "T,", 4],
    ["; after t skips the adjacent match", "a,b,c,d", 0, "t,;", 2],
    [", reverses a t, skipping the adjacent match", "a,b,c,d", 4, "t,,", 2],
    ["2f", "a,b,c", 0, "2f,", 3],
    ["f finds after an emoji", "😀x😀y", 0, "fy", "😀x😀".length],
    ["a failed find stays put", "abc", 1, "fz", 1],
  ];

  for (const [name, buffer, cursor, sequence, expectedCursor] of cases) {
    test(name, () => {
      expect(vim(buffer, cursor, sequence).cursor).toBe(expectedCursor);
    });
  }

  test("I inserts at the first non-blank", () => {
    expect(vim("    abc", 6, "IX<esc>").buffer).toBe("    Xabc");
  });

  test("a count does not leak past a find", () => {
    expect(vim("a,b,c\nx\ny", 0, "2f,j").cursor).toBe(6);
  });
});

describe("prompt visual mode matches Vim", () => {
  test("counts apply to visual motions", () => {
    expect(vim("abcdef", 0, "v3ld")).toEqual({ buffer: "ef", cursor: 0 });
  });

  test("o swaps the selection ends", () => {
    const editor = prompt("abcdef", 1);
    keys(editor, "vllo");
    expect(editor.cursor).toBe(1);
    expect(editor.visualAnchor).toBe(3);
  });

  test("selection ends include the whole emoji", () => {
    expect(vim("a😀b", 0, "vld").buffer).toBe("b");
  });

  test("text objects select whole trailing emoji", () => {
    const editor = prompt("(a😀)", 1);
    keys(editor, "vi(");
    expect(editor.cursor).toBe(2);
    keys(editor, "d");
    expect(editor.buffer).toBe("()");
  });

  test("t extends to just before the target", () => {
    expect(vim("foo(bar)", 0, "vt(d").buffer).toBe("(bar)");
  });

  test("; after t/T skips the adjacent match", () => {
    expect(vim("a,b,c,d", 0, "vt,").cursor).toBe(0);
    expect(vim("a,b,c,d", 0, "vt,;").cursor).toBe(2);
    expect(vim("a,b,c,d", 6, "vT,;").cursor).toBe(4);
  });

  test("charwise selection across lines", () => {
    expect(vim("abc\ndef", 1, "vjd")).toEqual({ buffer: "af", cursor: 1 });
  });
});

describe("prompt linewise yank and put", () => {
  let clipboard = "";

  beforeEach(() => {
    clipboard = "";
    setTextClipboardSystemForTest({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: (command) => command === "xsel" ? "/usr/bin/xsel" : null,
      copy: async (_command, text) => { clipboard = text; return 0; },
      // Like wl-paste --no-newline, drop one trailing newline.
      paste: () => ({ output: clipboard.replace(/\n$/, ""), exitCode: 0 }),
    });
  });

  afterEach(() => setTextClipboardSystemForTest(null));

  test("yy then p puts the line below", () => {
    expect(vim("abc\ndef", 1, "yyp")).toEqual({ buffer: "abc\nabc\ndef", cursor: 4 });
  });

  test("yy then P puts the line above", () => {
    expect(vim("abc\ndef", 5, "yyP")).toEqual({ buffer: "abc\ndef\ndef", cursor: 4 });
  });

  test("p after the last line", () => {
    expect(vim("abc\ndef", 5, "yyp")).toEqual({ buffer: "abc\ndef\ndef", cursor: 8 });
  });

  test("put lands on the first non-blank", () => {
    expect(vim("  abc\ndef", 3, "yyp")).toEqual({ buffer: "  abc\n  abc\ndef", cursor: 8 });
  });

  test("2yy and yj yank two lines", () => {
    expect(vim("a\nb\nc", 0, "2yyp")).toEqual({ buffer: "a\na\nb\nb\nc", cursor: 2 });
    expect(vim("a\nb\nc", 0, "yjp")).toEqual({ buffer: "a\na\nb\nb\nc", cursor: 2 });
  });

  test("a counted put repeats the lines", () => {
    expect(vim("a\nb", 0, "yy2p")).toEqual({ buffer: "a\na\na\nb", cursor: 2 });
  });

  test("visual-line yank puts lines", () => {
    expect(vim("a\nb", 2, "Vyp")).toEqual({ buffer: "a\nb\nb", cursor: 4 });
  });

  test("charwise yank still puts inline, with a count", () => {
    expect(vim("ab", 0, "yl3p")).toEqual({ buffer: "aaaab", cursor: 3 });
  });

  test("a put is one undo step", () => {
    const editor = prompt("abc\ndef", 1);
    keys(editor, "yyp");
    keys(editor, "u");
    expect(editor.buffer).toBe("abc\ndef");
  });

  test("a trailing newline stripped by the clipboard still counts as linewise", () => {
    const editor = prompt("abc", 0);
    keys(editor, "yy");
    expect(clipboard).toBe("abc\n");
    expect(isLinewiseClipboardText("abc\n")).toBe(true);
    expect(isLinewiseClipboardText("abc")).toBe(true);
    expect(isLinewiseClipboardText("ab")).toBe(false);
  });
});

describe("prompt Enter with a pending Vim command", () => {
  test("r<Enter> splits the line instead of submitting", () => {
    const editor = prompt("ab", 0);
    keys(editor, "r");
    expect(handleEditorKey(editor, { type: "enter" })).not.toBe("submit");
    expect([editor.buffer, editor.cursor]).toEqual(["\nb", 1]);
  });

  test("r<Enter> on an empty line does nothing", () => {
    const editor = prompt("a\n\nb", 2);
    keys(editor, "r");
    expect(handleEditorKey(editor, { type: "enter" })).not.toBe("submit");
    expect([editor.buffer, editor.cursor]).toEqual(["a\n\nb", 2]);
  });

  test("Enter cancels a pending find, operator, prefix or count", () => {
    for (const pending of ["f", "d", "di", "g", "2", ">"]) {
      const editor = prompt("ab ab", 0);
      keys(editor, pending);
      expect(handleEditorKey(editor, { type: "enter" })).not.toBe("submit");
      expect(editor.buffer).toBe("ab ab");
      keys(editor, "w");
      expect(editor.cursor).toBe(3);
    }
  });

  test("Enter with nothing pending still submits", () => {
    expect(handleEditorKey(prompt("ab", 0), { type: "enter" })).toBe("submit");
  });
});

describe("prompt non-character keys cancel a pending Vim command", () => {
  test("Tab cancels a pending find", () => {
    expect(vim("xx b yy b", 0, "f<tab>b").cursor).toBe(0);
  });

  test("Tab cancels a pending operator", () => {
    expect(vim("ab cd", 0, "d<tab>w")).toEqual({ buffer: "ab cd", cursor: 3 });
  });

  test("Tab cancels a pending find in visual mode", () => {
    expect(vim("ab xb", 0, "vf<tab>bd").buffer).toBe("b xb");
  });

  test("Backspace and Delete cancel a pending command instead of editing", () => {
    expect(vim("abc", 1, "d<backspace>")).toEqual({ buffer: "abc", cursor: 1 });
    expect(vim("abc", 1, "f<delete>")).toEqual({ buffer: "abc", cursor: 1 });
    expect(vim("abc", 1, "r<backspace>")).toEqual({ buffer: "abc", cursor: 1 });
  });
});

describe("prompt visual change", () => {
  test("V c leaves an empty line to type on, like cc", () => {
    expect(vim("a\nb\nc", 2, "VcX<esc>").buffer).toBe("a\nX\nc");
    expect(vim("a\nb\nc", 0, "VjcX<esc>").buffer).toBe("X\nc");
    expect(vim("a\nb", 2, "VcX<esc>").buffer).toBe("a\nX");
    expect(vim("a\n", 2, "VcX<esc>").buffer).toBe("a\nX");
  });
});

describe("prompt charwise put from the system clipboard", () => {
  afterEach(() => setTextClipboardSystemForTest(null));

  function putClipboard(output: string, buffer: string, cursor: number, sequence: string): string {
    setTextClipboardSystemForTest({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: (command) => command === "xsel" ? "/usr/bin/xsel" : null,
      copy: async () => 0,
      paste: () => ({ output, exitCode: 0 }),
    });
    const editor = prompt(buffer, cursor);
    keys(editor, sequence);
    return editor.buffer;
  }

  test("p cleans clipboard text like a bracketed paste", () => {
    expect(putClipboard("x\r\ny\tz\x1b[31mR", "ab", 0, "p")).toBe("ax\ny    zRb");
  });

  test("p on an empty line puts on that line", () => {
    expect(putClipboard("X", "a\n\nb", 2, "p")).toBe("a\nX\nb");
    expect(putClipboard("X", "a\n", 2, "p")).toBe("a\nX");
  });
});

describe("prompt insert-mode Home", () => {
  test("stays on the first line when the buffer starts with a newline", () => {
    const editor = prompt("\nabc", 0, "insert");
    handleEditorKey(editor, { type: "home" });
    expect(editor.cursor).toBe(0);
  });

  test("moves to the start of the cursor's line", () => {
    const editor = prompt("ab\ncd", 4, "insert");
    handleEditorKey(editor, { type: "home" });
    expect(editor.cursor).toBe(3);
  });
});

describe("prompt word motions treat non-ASCII letters as word characters", () => {
  test("dw and diw take the whole accented word", () => {
    expect(vim("canción x", 0, "dw").buffer).toBe("x");
    expect(vim("canción x", 1, "diw").buffer).toBe(" x");
  });

  test("w, b and e step over whole words with accents and combining marks", () => {
    expect(vim("über naïve x", 0, "w").cursor).toBe(5);
    expect(vim("über naïve x", 11, "b").cursor).toBe(5);
    expect(vim("cafés x", 0, "e").cursor).toBe(5);
    expect(vim("café x", 0, "dw").buffer).toBe("x");
    expect(vim("Привет мир", 0, "w").cursor).toBe(7);
  });

  test("punctuation still splits words", () => {
    expect(vim("año,mes", 0, "w").cursor).toBe(3);
  });
});

describe("prompt bracketed paste", () => {
  test("a paste mid-insert undoes after the typing that follows it", () => {
    const editor = prompt("", 0, "insert");
    keys(editor, "abc");
    handleEditorKey(editor, { type: "paste", text: "XYZ" });
    keys(editor, "d<esc>");
    expect(editor.buffer).toBe("abcXYZd");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      keys(editor, "u");
      seen.push(editor.buffer);
    }
    expect(seen).toEqual(["abcXYZ", "abc", ""]);
  });

  test("a paste from normal mode is its own undo step", () => {
    const editor = prompt("ab", 1);
    handleEditorKey(editor, { type: "paste", text: "X" });
    keys(editor, "y<esc>");
    expect(editor.buffer).toBe("aXyb");
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      keys(editor, "u");
      seen.push(editor.buffer);
    }
    expect(seen).toEqual(["aXb", "ab"]);
  });

  test("pasted text is cleaned of terminal controls and hard tabs", () => {
    const editor = prompt("", 0, "insert");
    handleEditorKey(editor, { type: "paste", text: "a\tb\x1b[31mc\x07\r\nd" });
    expect(editor.buffer).toBe("a    bc\nd");
  });
});
