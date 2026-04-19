import { describe, expect, test } from "bun:test";

import {
  getViewportByWidth,
  padRight,
  termWidth,
  truncate,
  visibleLength,
} from "./textwidth";

describe("textwidth", () => {
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

  test("measures ANSI-wrapped text by visible width", () => {
    expect(visibleLength("\x1b[31m🦋\x1b[0m hi")).toBe(5);
  });

  test("builds a width-aware viewport that keeps the cursor visible", () => {
    const viewport = getViewportByWidth("ab🦋cd", "ab🦋cd".length, 4);
    expect(viewport.visibleText).toBe("🦋cd");
    expect(viewport.cursorCol).toBe(4);
  });
});
