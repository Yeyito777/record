import { summarizeDiscordMessageReplyPreview, type DiscordMessage } from "./discord";
import { createEditorState, resetEditor } from "./editor";
import { focusPrompt, type AppState } from "./state";

/** Temporarily borrow the prompt, preserving the complete draft and its undo. */
export function beginReactionComposer(state: AppState, message: DiscordMessage): void {
  if (!state.reactionComposer) {
    state.reactionDraft = {
      editor: state.editor,
      pendingImages: state.pendingImages,
      replyTarget: state.replyTarget,
      editTarget: state.editTarget,
    };
  }
  state.editor = createEditorState();
  resetEditor(state.editor, ":", "insert");
  state.pendingImages = [];
  state.replyTarget = null;
  state.editTarget = null;
  state.messageDeletePending = null;
  state.reactionComposer = true;
  state.reactionTarget = {
    messageId: message.id, channelId: message.channelId,
    authorDisplayName: message.author.displayName,
    summary: summarizeDiscordMessageReplyPreview(message).slice(0, 160),
  };
  focusPrompt(state);
}
