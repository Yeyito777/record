/**
 * Main body panel content.
 *
 * Keeps render.ts focused on layout composition.
 */

import type { AppState } from "./state";
import { truncate } from "./strings";
import { theme, toneColor } from "./theme";

function noticeLines(state: AppState, width: number): string[] {
  if (!state.notice.text) return [];
  return state.notice.text
    .split("\n")
    .map((line) => `${toneColor(state.notice.tone)}${truncate(line, width)}${theme.reset}`);
}

export function renderBodyLines(state: AppState, width: number): string[] {
  return noticeLines(state, width);
}
