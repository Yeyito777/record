import { describe, expect, test } from "bun:test";

import { expandMacros, getMacroArgs } from "./macros";

describe("macro expansion", () => {
  test("/kao expands to a generic kaomoji", () => {
    expect(expandMacros("/kao")).toBe("(・∀・)");
  });

  test("/kao emotion variants expand inline", () => {
    expect(expandMacros("/kao happy")).toBe("ヽ(・∀・)ﾉ");
    expect(expandMacros("/kao sad")).toBe("(╥﹏╥)");
    expect(expandMacros("/kao angry")).toBe("(╬ಠ益ಠ)");
    expect(expandMacros("/kao flustered")).toBe("(⁄ ⁄>⁄ ▽ ⁄<⁄ ⁄)");
    expect(expandMacros("/kao embarassed")).toBe("(⁄ ⁄•⁄ω⁄•⁄ ⁄)");
  });

  test("keeps the spelling alias without advertising it", () => {
    expect(expandMacros("/kao embarrassed")).toBe("(⁄ ⁄•⁄ω⁄•⁄ ⁄)");
    expect(getMacroArgs()["/kao"]?.map((arg) => arg.name)).not.toContain("embarrassed");
  });

  test("expands macros at word boundaries and preserves trailing words", () => {
    expect(expandMacros("hello /kao happy friend")).toBe("hello ヽ(・∀・)ﾉ friend");
    expect(expandMacros("hello\n/kao sad!")).toBe("hello\n(╥﹏╥)!");
    expect(expandMacros("not/kao happy")).toBe("not/kao happy");
  });

  test("unknown macro args fall back to the base macro and preserve the arg", () => {
    expect(expandMacros("/kao sleepy")).toBe("(・∀・) sleepy");
  });

  test("/kao exposes emotion completions", () => {
    expect(getMacroArgs()["/kao"]).toEqual([
      { name: "happy", desc: "ヽ(・∀・)ﾉ" },
      { name: "sad", desc: "(╥﹏╥)" },
      { name: "angry", desc: "(╬ಠ益ಠ)" },
      { name: "flustered", desc: "(⁄ ⁄>⁄ ▽ ⁄<⁄ ⁄)" },
      { name: "embarassed", desc: "(⁄ ⁄•⁄ω⁄•⁄ ⁄)" },
    ]);
  });
});
