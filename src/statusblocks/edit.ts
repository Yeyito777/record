/**
 * Edit status block — active message edit target for the next submit.
 */

import type { AppState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth, truncate } from "../textwidth";

const MAX_EDIT_SUMMARY_WIDTH = 40;

export function editBlock(state: AppState): StatusBlock | null {
  const target = state.editTarget;
  if (!target) return null;

  const label = "  Editing: ";
  const name = `${target.authorDisplayName}: `;
  const summary = truncate(target.summary, MAX_EDIT_SUMMARY_WIDTH);
  const nameColor = target.authorColor || theme.accent;

  return {
    id: "edit",
    priority: 4,
    width: termWidth(label) + termWidth(name) + termWidth(summary),
    height: 1,
    rows: [
      `${theme.muted}${label}${nameColor}${name}${theme.text}${summary}${theme.reset}`,
    ],
  };
}
