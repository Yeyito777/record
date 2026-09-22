/**
 * Prompt editor visual selection helpers.
 */

import type { EditorMode } from "./editor-types";
import { lineEndOf, lineStartOf, nextGraphemeEnd, previousGraphemeStart } from "./editor-buffer";

export function getVisualRange(
  buffer: string,
  visualAnchor: number,
  cursor: number,
  mode: EditorMode,
): { start: number; endExclusive: number } {
  let start = Math.min(visualAnchor, cursor);
  let end = Math.max(visualAnchor, cursor);

  if (mode === "visual-line") {
    start = lineStartOf(buffer, start);
    end = lineEndOf(buffer, end);
    if (end < buffer.length) end++;
    return { start, endExclusive: end };
  }

  // Visual selections are inclusive of whole graphemes, not UTF-16 units.
  // Word/text-object motions can leave an endpoint inside a grapheme, so
  // expand both ends before slicing for yanks, edits, and highlighting.
  if (start < buffer.length) start = previousGraphemeStart(buffer, start + 1);
  return { start, endExclusive: nextGraphemeEnd(buffer, end) };
}
