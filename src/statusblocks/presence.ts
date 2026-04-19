/**
 * Presence status block — current Discord presence.
 */

import type { AppState, PresenceStatus } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth } from "../textwidth";

function presenceColor(status: PresenceStatus): string {
  switch (status) {
    case "online":
      return theme.success;
    case "idle":
      return theme.warning;
    case "dnd":
      return theme.error;
    case "offline":
    default:
      return `${theme.dim}${theme.muted}`;
  }
}

export function presenceBlock(state: AppState): StatusBlock | null {
  if (state.auth.status !== "authenticated" || !state.auth.user || !state.auth.presenceStatus) {
    return null;
  }

  const label = "  Status: ";
  const value = state.auth.presenceStatus;
  const width = termWidth(label) + termWidth(value);

  return {
    id: "presence",
    priority: 1,
    width,
    height: 1,
    rows: [
      `${theme.muted}${label}${presenceColor(value)}${value}${theme.reset}`,
    ],
  };
}
