/**
 * Notice status block — transient feedback for async actions.
 */

import { loadingLabel } from "../loading";
import type { AppState, Notice } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth } from "../textwidth";

function toneColor(tone: Notice["tone"]): string {
  switch (tone) {
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "error":
      return theme.error;
    case "muted":
    default:
      return theme.muted;
  }
}

export function noticeBlock(state: AppState): StatusBlock | null {
  if (state.notice.statusLine === false) return null;
  const text = state.notice.text.split("\n")[0]?.trim();
  if (!text) return null;

  const label = state.notice.loading ? loadingLabel(text, state.loadingFrameIndex) : text;
  const prefix = "  ";
  const width = termWidth(prefix) + termWidth(label);

  return {
    id: "notice",
    priority: 10,
    width,
    height: 1,
    rows: [
      `${toneColor(state.notice.tone)}${prefix}${label}${theme.reset}`,
    ],
  };
}
