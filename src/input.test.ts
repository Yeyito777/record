import { describe, expect, test } from "bun:test";

import { parseInput } from "./input";

describe("input parser", () => {
  test("parses Ctrl+S from raw control byte", () => {
    expect(parseInput(String.fromCharCode(19))).toEqual([{ type: "ctrl-s" }]);
  });

  test("parses Ctrl+M from kitty CSI-u", () => {
    expect(parseInput("\x1b[109;5u")).toEqual([{ type: "ctrl-m" }]);
  });
});
