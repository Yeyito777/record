import { describe, expect, test } from "bun:test";

import { graphemeBoundaryAtOrAfter, nextGraphemeEnd, previousGraphemeStart } from "./editor-buffer";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Grapheme starts of the whole buffer, the reference the windowed helpers must match. */
function starts(buffer: string): number[] {
  return [...segmenter.segment(buffer)].map((segment) => segment.index);
}

describe("grapheme helpers segment only around the cursor", () => {
  const pieces = ["a", "b", " ", "\n", "\r\n", "é", "😭", "❤️", "👍🏽", "👩‍💻", "🇨🇦", "🇺🇸", "🇫", "한", "각", "日本", "1️⃣", "x‍"];

  test("match whole-buffer segmentation at every offset", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      let buffer = "";
      const length = 1 + Math.floor(random() * 30);
      for (let i = 0; i < length; i++) buffer += pieces[Math.floor(random() * pieces.length)];
      const boundaries = [...starts(buffer), buffer.length];
      for (let pos = 0; pos <= buffer.length; pos++) {
        const next = boundaries.find((boundary) => boundary > pos) ?? buffer.length;
        const previous = [...boundaries].reverse().find((boundary) => boundary < pos) ?? 0;
        const atOrAfter = boundaries.find((boundary) => boundary >= pos) ?? buffer.length;
        expect([buffer, pos, nextGraphemeEnd(buffer, pos)]).toEqual([buffer, pos, next]);
        expect([buffer, pos, previousGraphemeStart(buffer, pos)]).toEqual([buffer, pos, previous]);
        expect([buffer, pos, graphemeBoundaryAtOrAfter(buffer, pos)]).toEqual([buffer, pos, atOrAfter]);
      }
    }
  });

  test("stay fast at the end of a long prompt", () => {
    const buffer = "the quick brown fox jumps over the lazy dog ".repeat(5000);
    const started = performance.now();
    for (let i = 0; i < 200; i++) previousGraphemeStart(buffer, buffer.length - 3);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
