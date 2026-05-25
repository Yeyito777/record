import type { AppState } from "./state";

export type PromptBackspacePrefixAction = "image" | "reply" | "edit";

/**
 * Handles prompt-level things that live before the text buffer.
 *
 * Backspace at cursor 0 first removes pasted images, matching the existing
 * image chip behavior. Only when there are no images does it cancel the active
 * reply/edit target shown in the prompt separator.
 */
export function handlePromptPrefixBackspace(state: AppState): PromptBackspacePrefixAction | null {
  if (state.editor.cursor !== 0) return null;

  if (state.pendingImages.length > 0) {
    state.pendingImages.pop();
    return "image";
  }

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
