/**
 * Prompt-buffer helpers shared outside the editor.
 */

import type { AppState } from "./state";
import { resetEditor } from "./editor";
import { sanitizePromptTextForInsertion } from "./prompttext";
import { commitInsertSession, pushUndo } from "./undo";

export function clearPrompt(state: AppState): void {
  resetEditor(state.editor, "", "insert");
  state.autocomplete = null;
}

/** Append text to the draft as a triple-quote block on its own prompt line. */
export function appendPromptQuoteBlock(state: AppState, text: string): boolean {
  const safeText = sanitizePromptTextForInsertion(text);
  if (!safeText) return false;

  const editor = state.editor;
  const currentLastLine = editor.buffer.slice(editor.buffer.lastIndexOf("\n") + 1);
  const leadingNewline = currentLastLine.length > 0 ? "\n" : "";
  const quoteBlock = `"""\n${safeText}\n"""\n`;

  // Preserve any earlier insert session as its own undo step, then make the
  // appended quote independently undoable from the pre-existing draft.
  commitInsertSession(editor.undo, editor.buffer);
  pushUndo(editor.undo, editor.buffer, editor.cursor);
  editor.buffer += leadingNewline + quoteBlock;
  editor.cursor = editor.buffer.length;
  editor.curswant = null;
  state.autocomplete = null;
  return true;
}
