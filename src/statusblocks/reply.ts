/**
 * Reply status block — active reply target for the next message.
 */

import type { AppState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth, truncate } from "../textwidth";

const MAX_REPLY_SUMMARY_WIDTH = 40;

export function replyBlock(state: AppState): StatusBlock | null {
  const target = state.replyTarget;
  if (!target) return null;

  const ping = target.mention ? "PING " : "";
  const label = "  Replying: ";
  const name = `${target.authorDisplayName}: `;
  const summary = truncate(target.summary, MAX_REPLY_SUMMARY_WIDTH);
  const nameColor = target.authorColor || theme.accent;

  return {
    id: "reply",
    priority: 3,
    width: termWidth(label) + termWidth(ping) + termWidth(name) + termWidth(summary),
    height: 1,
    rows: [
      `${theme.muted}${label}${target.mention ? `${theme.accent}${ping}` : ""}${nameColor}${name}${theme.text}${summary}${theme.reset}`,
    ],
  };
}
