/**
 * Prompt-buffer helpers shared outside the editor.
 */

import type { AppState } from "./state";
import { resetEditor } from "./editor";

export function clearPrompt(state: AppState): void {
  resetEditor(state.editor, "", "insert");
  state.autocomplete = null;
}
