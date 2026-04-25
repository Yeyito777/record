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
    expect(parseInput("\x1b[121;5u")).toEqual([{ type: "ctrl-y" }]);
  });

  test("parses Shift+Enter from kitty CSI-u", () => {
    expect(parseInput("\x1b[13;2u")).toEqual([{ type: "shift-enter" }]);
  });
});
