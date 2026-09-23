/**
 * Prompt-buffer helpers shared outside the editor.
 */

import type { AppState } from "./state";
import { replaceCustomEmojiTokens } from "./customemoji";
import { resetEditor } from "./editor";
import { sanitizePromptTextForInsertion } from "./prompttext";
import { commitInsertSession, pushUndo } from "./undo";

export function clearPrompt(state: AppState): void {
  state.reactionComposer = false;
  state.reactionDraft = null;
  resetEditor(state.editor, "", "insert");
  state.autocomplete = null;
}

/** Restore the suspended draft without sharing reaction-editor undo history. */
export function restoreReactionDraft(state: AppState): boolean {
  const draft = state.reactionDraft;
  if (!draft) return false;
  const mode = state.editor.mode;
  state.editor = draft.editor;
  state.editor.mode = mode;
  state.pendingImages = draft.pendingImages;
  // Navigation normally clears cross-channel reply/edit contexts. A suspended
  // target must obey the same rule instead of silently editing another chat.
  const channelId = state.channelList.activeChannelId ?? state.timeline.channelId;
  state.replyTarget = draft.replyTarget?.channelId === channelId ? draft.replyTarget : null;
  state.editTarget = draft.editTarget?.channelId === channelId ? draft.editTarget : null;
  state.reactionDraft = null;
  state.reactionComposer = false;
  state.reactionTarget = null;
  state.autocomplete = null;
  return true;
}

/** Append text to the draft as a triple-quote block on its own prompt line. */
export function appendPromptQuoteBlock(state: AppState, text: string): boolean {
  const safeText = sanitizePromptTextForInsertion(text);
  if (!safeText) return false;

  const editor = state.editor;
  const currentLastLine = editor.buffer.slice(editor.buffer.lastIndexOf("\n") + 1);
  const leadingNewline = currentLastLine.length > 0 ? "\n" : "";
  const quoteBlock = `"""\n${replaceCustomEmojiTokens(safeText)}\n"""\n`;

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
