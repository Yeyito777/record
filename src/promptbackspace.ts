import type { AppState } from "./state";

export type PromptBackspacePrefixAction = "image" | "reply" | "edit" | "reaction";

/** Like cancelling a reply, leave the draft and editor mode untouched. */
export function cancelPromptReaction(state: AppState): boolean {
  if (!state.reactionComposer) return false;
  state.reactionComposer = false;
  state.reactionTarget = null;
  state.autocomplete = null;
  return true;
}

/**
 * Handles prompt-level things that live before the text buffer.
 *
 * Backspace at cursor 0 first removes pasted images, matching the existing
 * image chip behavior. Only when there are no images does it cancel the active
 * reaction/reply/edit target shown in the prompt separator.
 */
export function handlePromptPrefixBackspace(state: AppState): PromptBackspacePrefixAction | null {
  if (state.editor.cursor !== 0) return null;

  if (state.pendingImages.length > 0) {
    state.pendingImages.pop();
    return "image";
  }

  if (cancelPromptReaction(state)) return "reaction";

  if (state.replyTarget) {
    state.replyTarget = null;
    return "reply";
  }

  if (state.editTarget) {
    state.editTarget = null;
    return "edit";
  }

  return null;
}
