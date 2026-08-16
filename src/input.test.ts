import { describe, expect, test } from "bun:test";

import { parseInput } from "./input";

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
