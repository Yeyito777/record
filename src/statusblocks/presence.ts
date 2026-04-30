/**
 * Presence status block — current Discord presence.
 */

import type { AppState, PresenceStatus } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth } from "../textwidth";

function presenceColor(status: PresenceStatus | null): string {
  switch (status) {
    case "online":
      return theme.success;
    case "idle":
      return theme.warning;
    case "dnd":
      return theme.error;
    case "invisible":
      return `${theme.dim}${theme.muted}`;
    default:
      return theme.error;
  }
}

function presenceLabel(status: PresenceStatus | null): string {
  switch (status) {
    case "dnd":
      return "Do Not Disturb";
    case "invisible":
      return "Invisible";
    case "online":
    case "idle":
      return status;
    default:
      return "N/A";
  }
}

export function presenceBlock(state: AppState): StatusBlock {
  const label = "  Status: ";
  const status = state.auth.status === "authenticated" && state.auth.user ? state.auth.presenceStatus : null;
  const value = presenceLabel(status);
  const width = termWidth(label) + termWidth(value);

  return {
    id: "presence",
    priority: 1,
    width,
    height: 1,
    rows: [
      `${theme.muted}${label}${presenceColor(status)}${value}${theme.reset}`,
    ],
  };
}
