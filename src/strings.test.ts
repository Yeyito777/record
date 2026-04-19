import { describe, expect, test } from "bun:test";

import { padRight, termWidth, truncate } from "./strings";

describe("strings", () => {
  test("measures terminal width for fullwidth and emoji chars", () => {
    expect(termWidth("memes＆media")).toBe(12);
    expect(termWidth("【calm】")).toBe(8);
    expect(termWidth("the🦋chat")).toBe(9);
  });

  test("truncates by terminal columns instead of utf-16 length", () => {
    expect(truncate("【calm】", 7)).toBe("【calm…");
  });

  test("pads to an exact terminal width", () => {
    const padded = padRight("memes＆media", 14);
    expect(termWidth(padded)).toBe(14);
    expect(padded.endsWith("  ")).toBe(true);
  });
});
