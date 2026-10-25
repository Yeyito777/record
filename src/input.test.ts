import { describe, expect, test } from "bun:test";

import { parseInput, PasteBuffer } from "./input";

describe("input parser", () => {
  test("parses scrolling ctrl bytes", () => {
    expect(parseInput(String.fromCharCode(2))).toEqual([{ type: "ctrl-b" }]);
    expect(parseInput(String.fromCharCode(4))).toEqual([{ type: "ctrl-d" }]);
    expect(parseInput(String.fromCharCode(5))).toEqual([{ type: "ctrl-e" }]);
    expect(parseInput(String.fromCharCode(6))).toEqual([{ type: "ctrl-f" }]);
    expect(parseInput(String.fromCharCode(21))).toEqual([{ type: "ctrl-u" }]);
    expect(parseInput(String.fromCharCode(25))).toEqual([{ type: "ctrl-y" }]);
  });

  test("parses Ctrl+S from raw control byte", () => {
    expect(parseInput(String.fromCharCode(19))).toEqual([{ type: "ctrl-s" }]);
  });

  test("parses Ctrl+J from raw control byte", () => {
    expect(parseInput(String.fromCharCode(10))).toEqual([{ type: "ctrl-j" }]);
  });

  test("parses Ctrl+L from raw control byte", () => {
    expect(parseInput(String.fromCharCode(12))).toEqual([{ type: "ctrl-l" }]);
  });

  test("parses Ctrl+N from raw control byte", () => {
    expect(parseInput(String.fromCharCode(14))).toEqual([{ type: "ctrl-n" }]);
  });

  test("parses Ctrl+Q from raw control byte", () => {
    expect(parseInput(String.fromCharCode(17))).toEqual([{ type: "ctrl-q" }]);
  });

  test("parses Ctrl+R from raw control byte", () => {
    expect(parseInput(String.fromCharCode(18))).toEqual([{ type: "ctrl-r" }]);
  });

  test("parses Ctrl+V from raw control byte", () => {
    expect(parseInput(String.fromCharCode(22))).toEqual([{ type: "ctrl-v" }]);
  });

  test("parses Ctrl+] from raw control byte", () => {
    expect(parseInput(String.fromCharCode(29))).toEqual([{ type: "ctrl-right-bracket" }]);
  });

  test("parses kitty CSI-u control sequences", () => {
    expect(parseInput("\x1b[98;5u")).toEqual([{ type: "ctrl-b" }]);
    expect(parseInput("\x1b[109;5u")).toEqual([{ type: "ctrl-m" }]);
    expect(parseInput("\x1b[59;5u")).toEqual([{ type: "ctrl-semicolon" }]);
    expect(parseInput("\x1b[91;5u")).toEqual([{ type: "ctrl-left-bracket" }]);
    expect(parseInput("\x1b[93;5u")).toEqual([{ type: "ctrl-right-bracket" }]);
    expect(parseInput("\x1b[113;5u")).toEqual([{ type: "ctrl-q" }]);
    expect(parseInput("\x1b[118;5u")).toEqual([{ type: "ctrl-v" }]);
    expect(parseInput("\x1b[121;5u")).toEqual([{ type: "ctrl-y" }]);
  });

  test("parses Shift+Enter from kitty CSI-u", () => {
    expect(parseInput("\x1b[13;2u")).toEqual([{ type: "shift-enter" }]);
  });

  test("parses kitty all-key printable presses and releases", () => {
    expect(parseInput("\x1b[97;1:1;97u")).toEqual([{ type: "char", char: "a", event: "press" }]);
    expect(parseInput("\x1b[32;1:3;32u")).toEqual([{ type: "char", char: " ", event: "release" }]);
  });

  test("parses SGR mouse presses, releases, motion, wheel, and modifiers", () => {
    expect(parseInput("\x1b[<0;7;4M\x1b[<0;7;4m")).toEqual([
      {
        type: "mouse",
        button: 0,
        col: 7,
        row: 4,
        action: "press",
        shift: false,
        meta: false,
        ctrl: false,
      },
      {
        type: "mouse",
        button: 0,
        col: 7,
        row: 4,
        action: "release",
        shift: false,
        meta: false,
        ctrl: false,
      },
    ]);
    expect(parseInput("\x1b[<35;9;5M")).toEqual([{
      type: "mouse",
      button: 3,
      col: 9,
      row: 5,
      action: "motion",
      shift: false,
      meta: false,
      ctrl: false,
    }]);
    expect(parseInput("\x1b[<64;3;6M\x1b[<65;3;6M")).toEqual([
      {
        type: "mouse",
        button: 64,
        col: 3,
        row: 6,
        action: "press",
        shift: false,
        meta: false,
        ctrl: false,
      },
      {
        type: "mouse",
        button: 65,
        col: 3,
        row: 6,
        action: "press",
        shift: false,
        meta: false,
        ctrl: false,
      },
    ]);
    expect(parseInput("\x1b[<28;2;3M")).toEqual([{
      type: "mouse",
      button: 0,
      col: 2,
      row: 3,
      action: "press",
      shift: true,
      meta: true,
      ctrl: true,
    }]);
  });

  test("parses st ctrl-number-row symbol function keys", () => {
    expect(parseInput("\x1b[1;2Q")).toEqual([{ type: "f14" }]);
    expect(parseInput("\x1b[1;2R")).toEqual([{ type: "f15" }]);
    expect(parseInput("\x1b[1;2S")).toEqual([{ type: "f16" }]);
    expect(parseInput("\x1b[21;2~")).toEqual([{ type: "f22" }]);
    expect(parseInput("\x1b[23;2~")).toEqual([{ type: "f23" }]);
    expect(parseInput("\x1b[24;2~")).toEqual([{ type: "f24" }]);
  });
});

describe("kitty functional keys", () => {
  test("modifier, lock and private-use function keys produce no text", () => {
    for (const seq of [
      "\x1b[57441;2u", // Left Shift press
      "\x1b[57441;1:3u", // Left Shift release
      "\x1b[57442;5u", // Left Control press
      "\x1b[57358u", // Caps Lock
      "\x1b[57376u", // F13
      "\x1b[57428u", // Media Play
    ]) {
      expect(parseInput(seq)).toEqual([]);
    }
  });

  test("keypad Enter submits like Enter", () => {
    expect(parseInput("\x1b[57414u")).toEqual([{ type: "enter", event: "press" }]);
    expect(parseInput("\x1b[57414;1:3u")).toEqual([{ type: "enter", event: "release" }]);
    expect(parseInput("\x1b[57414;2u")).toEqual([{ type: "shift-enter", event: "press" }]);
  });

  test("keypad keys without associated text map to their characters and motions", () => {
    expect(parseInput("\x1b[57400u")).toEqual([{ type: "char", char: "1", event: "press" }]);
    expect(parseInput("\x1b[57413u")).toEqual([{ type: "char", char: "+", event: "press" }]);
    expect(parseInput("\x1b[57417u")).toEqual([{ type: "left", event: "press" }]);
    expect(parseInput("\x1b[57426u")).toEqual([{ type: "delete", event: "press" }]);
  });

  test("keypad keys with associated text still use the text", () => {
    expect(parseInput("\x1b[57400;;49u")).toEqual([{ type: "char", char: "1", event: "press" }]);
  });
});

describe("kitty event types on legacy CSI keys", () => {
  test("repeat and release events for arrows, Home and End keep their key", () => {
    expect(parseInput("\x1b[1;1:2D")).toEqual([{ type: "left", event: "repeat" }]);
    expect(parseInput("\x1b[1;1:2A")).toEqual([{ type: "up", event: "repeat" }]);
    expect(parseInput("\x1b[1;1:3C")).toEqual([{ type: "right", event: "release" }]);
    expect(parseInput("\x1b[1;1:2H")).toEqual([{ type: "home", event: "repeat" }]);
    expect(parseInput("\x1b[1;1:2F")).toEqual([{ type: "end", event: "repeat" }]);
  });

  test("repeat events for ~ keys keep their key", () => {
    expect(parseInput("\x1b[3;1:2~")).toEqual([{ type: "delete", event: "repeat" }]);
    expect(parseInput("\x1b[15;2:2~")).toEqual([{ type: "f17", event: "repeat" }]);
    expect(parseInput("\x1b[1;2:1Q")).toEqual([{ type: "f14", event: "press" }]);
  });

  test("plain sequences are unchanged", () => {
    expect(parseInput("\x1b[D\x1b[3~\x1b[1;2Q\x1b[Z\x1b[1~\x1b[4~\x1b[24;2~")).toEqual([
      { type: "left" }, { type: "delete" }, { type: "f14" }, { type: "backtab" },
      { type: "home" }, { type: "end" }, { type: "f24" },
    ]);
  });

  test("modified arrows stay unmapped", () => {
    expect(parseInput("\x1b[1;5D")).toEqual([]);
    expect(parseInput("\x1b[3;5~")).toEqual([]);
  });
});

describe("raw text input", () => {
  test("an emoji or composed character arrives as one character", () => {
    expect(parseInput("a😭e\u0301👩‍💻🇨🇦")).toEqual([
      { type: "char", char: "a" },
      { type: "char", char: "😭" },
      { type: "char", char: "e\u0301" },
      { type: "char", char: "👩‍💻" },
      { type: "char", char: "🇨🇦" },
    ]);
  });

  test("a paste split inside a multibyte character survives", () => {
    const pasted = "\x1b[200~canción 日本語 🎤\x1b[201~";
    const bytes = Buffer.from(pasted);
    for (let split = 1; split < bytes.length; split++) {
      const buffer = new PasteBuffer(() => {});
      const out = [buffer.feed(bytes.subarray(0, split)), buffer.feed(bytes.subarray(split))];
      expect(out.filter((part) => part !== null).join("")).toBe(pasted);
    }
  });
});
