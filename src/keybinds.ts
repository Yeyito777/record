/**
 * Keybind definitions.
 *
 * Trimmed-down version of the Exocortex TUI keybind layer.
 */

import type { KeyEvent } from "./input";

export type Action =
  | "quit"
  | "sidebar_toggle";

const BINDS: Partial<Record<KeyEvent["type"], Action>> = {
  "ctrl-c": "quit",
  "ctrl-m": "sidebar_toggle",
  "ctrl-s": "sidebar_toggle",
};

export function resolveAction(key: KeyEvent): Action | null {
  return BINDS[key.type] ?? null;
}
