import { describe, expect, test } from "bun:test";

import {
  getViewportByWidth,
  nextWidthClusterEnd,
  sliceByWidthFrom,
  hardBreak,
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

  test("treats nonspacing marks from display names as zero width", () => {
    expect(termWidth("ੈ")).toBe(0);
    expect(termWidth("ღ jättebög ੈ✩‧₊˚")).toBe(15);
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
    expect(termWidth("\x1b[31m🦋\x1b[0m hi")).toBe(5);
  });

  test("preserves active ANSI color across hard-wrapped segments", () => {
    const red = "\x1b[31m";
    const reset = "\x1b[0m";
    const wrapped: string[] = [];
    const tail = hardBreak(`${red}abcdefghijkl${reset}`, 5, wrapped);

    expect([...wrapped, tail].map((part) => part.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(["abcde", "fghij", "kl"]);
    expect(wrapped[0]).toBe(`${red}abcde${reset}`);
    expect(wrapped[1]).toBe(`${red}fghij${reset}`);
    expect(tail).toBe(`${red}kl${reset}`);
  });

  test("a character wider than the line gets a line of its own, styled or not, never split", () => {
    // Fails fast instead of filling memory if hardBreak stops making progress.
    class Lines extends Array<string> {
      override push(...items: string[]): number {
        if (this.length + items.length > 50) throw new Error("hardBreak made no progress");
        return super.push(...items);
      }
    }
    const muted = "\x1b[90m";
    const text = "\x1b[97m";
    for (const word of [`${muted}📎${text}`, `${muted}📎📎x${text}`, "📎😀", "a📎"]) {
      const wrapped = new Lines();
      const tail = hardBreak(word, 1, wrapped);
      const visible = [...wrapped, tail].map((part) => part.replace(/\x1b\[[0-9;]*m/g, "")).filter(Boolean);
      expect(visible.join("")).toBe(word.replace(/\x1b\[[0-9;]*m/g, ""));
      // Whole characters only: no lone surrogate halves.
      for (const part of visible) expect(part).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });

  test("builds a width-aware viewport that keeps the cursor visible", () => {
    const viewport = getViewportByWidth("ab🦋cd", "ab🦋cd".length, 4);
    expect(viewport.visibleText).toBe("🦋cd");
    expect(viewport.cursorCol).toBe(4);
  });

  test("sliceByWidthFrom's ASCII fast path matches cluster-by-cluster wrapping", () => {
    const text = "ab😀e\u0301 #\ufe0f\u20e3 x\u200dy 🇨🇦\ue000 end";
    for (let width = 1; width <= 6; width++) {
      for (let start = 0; start < text.length; start = nextWidthClusterEnd(text, start)) {
        let end = start;
        let used = 0;
        while (end < text.length) {
          const next = nextWidthClusterEnd(text, end);
          const clusterWidth = termWidth(text.slice(end, next));
          if (used + clusterWidth > width) break;
          used += clusterWidth;
          end = next;
        }
        expect(sliceByWidthFrom(text, start, width)).toEqual([end, used]);
      }
    }
  });
});

describe("glibc wcwidth parity (what st uses)", () => {
  test("newer wide and zero-width code points", () => {
    // Emoji and symbols from Unicode 13-17, trigrams, enclosed ideographs.
    for (const glyph of ["🩷", "🩵", "🫨", "🛜", "🪭", "🫟", "☰", "⚊", "🈀", "🈐", "🉠", "ꥠ", "𖿠", "𛀀", "𝌀"]) {
      expect(termWidth(glyph)).toBe(2);
    }
    expect(termWidth("\u303F")).toBe(1); // ideographic half fill space
    expect(termWidth("\u00AD")).toBe(1); // soft hyphen
    // Hangul conjoining vowels/finals and fillers, format controls.
    for (const glyph of ["\u1160", "\u11FF", "\uD7B0", "\u3164", "\uFFA0", "\u061C", "\u180E", "\u206A", "\u{1BCA0}", "\u{1D173}"]) {
      expect(termWidth(glyph)).toBe(0);
    }
    expect(termWidth("\u1100\u1161\u11A8")).toBe(2); // conjoining jamo syllable
  });

  test("custom emoji markers keep their two-cell slot", () => {
    expect(termWidth("\uE000")).toBe(2);
  });
});
