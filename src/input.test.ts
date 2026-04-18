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

  test("parses Ctrl+R from raw control byte", () => {
    expect(parseInput(String.fromCharCode(18))).toEqual([{ type: "ctrl-r" }]);
  });

  test("parses kitty CSI-u control sequences", () => {
    expect(parseInput("\x1b[98;5u")).toEqual([{ type: "ctrl-b" }]);
    expect(parseInput("\x1b[109;5u")).toEqual([{ type: "ctrl-m" }]);
    expect(parseInput("\x1b[121;5u")).toEqual([{ type: "ctrl-y" }]);
  });

  test("parses Shift+Enter from kitty CSI-u", () => {
    expect(parseInput("\x1b[13;2u")).toEqual([{ type: "shift-enter" }]);
  });
});
