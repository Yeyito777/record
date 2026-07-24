/** Pull a visual chat-history selection back into the message draft. */

import { resetPending } from "./editor-types";
import { getHistoryVisualSelection } from "./historycursor";
import type { KeyEvent } from "./input";
import { appendPromptQuoteBlock } from "./promptstate";
import { focusPrompt, type AppState } from "./state";

function isHistoryVisualSelection(state: AppState): boolean {
  return state.panelFocus === "chat"
    && state.chatFocus === "history"
    && (state.editor.mode === "visual" || state.editor.mode === "visual-line");
}

/**
 * In history visual/visual-line mode, `;` appends the selected text to the end
 * of the current draft inside a triple-quote block and focuses the empty line
 * after it, matching Exocortex's quote-selection workflow.
 */
export function handleHistorySelectionQuoteKey(state: AppState, key: KeyEvent): boolean {
  if (key.type !== "char" || key.char !== ";" || !isHistoryVisualSelection(state)) {
    return false;
  }

  appendPromptQuoteBlock(state, getHistoryVisualSelection(state));
  state.editor.mode = "normal";
  resetPending(state.editor);
  focusPrompt(state);
  return true;
}
