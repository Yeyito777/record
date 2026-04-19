/**
 * Account status block — who the user is logged in as.
 */

import type { AppState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth, truncate } from "../textwidth";

const MAX_VALUE_WIDTH = 40;

export function accountBlock(state: AppState): StatusBlock {
  const label = "  Logged In As: ";
  const nickname = state.auth.status === "authenticated" && state.auth.user
    ? (state.auth.user.globalName || state.auth.user.username)
    : "N/A";
  const color = state.auth.status === "authenticated" && state.auth.user ? theme.accent : theme.error;
  const displayValue = truncate(nickname, MAX_VALUE_WIDTH);
  const width = termWidth(label) + termWidth(displayValue);

  return {
    id: "account",
    priority: 1,
    width,
    height: 1,
    rows: [
      `${theme.muted}${label}${color}${displayValue}${theme.reset}`,
    ],
  };
}
