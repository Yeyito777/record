/**
 * Link hint status block: where a masked embed link (`[label](url)`, drawn
 * as its label) goes, while the mouse is over it or the history cursor on it.
 */

import { embedMaskedLinkAtHistoryCursor } from "../historyopenable";
import type { AppState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth, truncate } from "../textwidth";

const MAX_URL_WIDTH = 80;

export function linkHintBlock(state: AppState): StatusBlock | null {
  const historyCursor = state.panelFocus === "chat" && state.chatFocus === "history";
  const url = state.historyLinkHover ?? (historyCursor ? embedMaskedLinkAtHistoryCursor(state) : null);
  if (!url) return null;
  const label = `  ↗ ${truncate(url.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""), MAX_URL_WIDTH)}`;
  return {
    id: "link-hint",
    priority: 9,
    width: termWidth(label),
    height: 1,
    rows: [`${theme.muted}${label}${theme.reset}`],
  };
}
