/**
 * Keybind definitions.
 *
 * Trimmed-down version of the Exocortex TUI keybind layer.
 */

import type { KeyEvent } from "./input";

export type Action =
  | "quit"
  | "sidebar_toggle"
  | "focus_cycle"
  | "focus_prompt"
  | "focus_history"
  | "nav_up"
  | "nav_down"
  | "nav_select";

const GLOBAL_BINDS: Partial<Record<KeyEvent["type"], Action>> = {
  "ctrl-c": "quit",
  "ctrl-j": "focus_cycle",
  "ctrl-k": "focus_cycle",
  "ctrl-m": "sidebar_toggle",
  "ctrl-n": "focus_history",
  "ctrl-s": "sidebar_toggle",
};

const NAV_BINDS: Partial<Record<KeyEvent["type"], Action>> = {
  "enter": "nav_select",
  "up": "nav_up",
  "down": "nav_down",
};

const NAV_CHAR_BINDS: Record<string, Action> = {
  "char:j": "nav_down",
  "char:k": "nav_up",
  "char:i": "focus_prompt",
  "char:a": "focus_prompt",
};

export type KeyContext = "prompt" | "navigation";

export function resolveAction(key: KeyEvent, context: KeyContext = "prompt"): Action | null {
  const globalAction = GLOBAL_BINDS[key.type];
  if (globalAction) return globalAction;

  if (context !== "navigation") return null;

  if (key.type === "char" && key.char) {
    const charAction = NAV_CHAR_BINDS[`char:${key.char}`];
    if (charAction) return charAction;
  }

  return NAV_BINDS[key.type] ?? null;
}
