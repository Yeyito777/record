/**
 * Prompt editor visual selection helpers.
 */

import type { EditorMode } from "./editor-types";
import { lineEndOf, lineStartOf } from "./editor-buffer";

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

  return { start, endExclusive: Math.min(end + 1, buffer.length) };
}
