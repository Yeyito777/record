import { describe, expect, test } from "bun:test";
import { getVisualRange } from "./editor-selection";

describe("prompt visual selection", () => {
  for (const grapheme of ["😭", "❤️", "👍🏽", "👩‍💻", "🇨🇦", "e\u0301"]) {
    test(`includes the whole ${grapheme} grapheme at either endpoint`, () => {
      const buffer = `a${grapheme}b`;
      for (let offset = 1; offset < 1 + grapheme.length; offset++) {
        expect(getVisualRange(buffer, offset, offset, "visual")).toEqual({
          start: 1, endExclusive: 1 + grapheme.length,
        });
        expect(getVisualRange(buffer, 0, offset, "visual")).toEqual({
          start: 0, endExclusive: 1 + grapheme.length,
        });
        expect(getVisualRange(buffer, offset, 0, "visual")).toEqual({
          start: 0, endExclusive: 1 + grapheme.length,
        });
        expect(getVisualRange(buffer, buffer.length - 1, offset, "visual")).toEqual({
          start: 1, endExclusive: buffer.length,
        });
      }
    });
  }

  test("preserves empty, end-of-buffer, newline and linewise selections", () => {
    expect(getVisualRange("", 0, 0, "visual")).toEqual({ start: 0, endExclusive: 0 });
    expect(getVisualRange("😭", 2, 2, "visual")).toEqual({ start: 2, endExclusive: 2 });
    expect(getVisualRange("😭", 0, 2, "visual")).toEqual({ start: 0, endExclusive: 2 });
    expect(getVisualRange("a\nb", 1, 1, "visual")).toEqual({ start: 1, endExclusive: 2 });
    expect(getVisualRange("😭\n❤️\nx", 1, 3, "visual-line")).toEqual({
      start: 0, endExclusive: 6,
    });
  });
});
