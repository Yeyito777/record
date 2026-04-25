/**
 * Keybind definitions.
 *
 * Trimmed-down version of the Exocortex TUI keybind layer.
 */

import type { KeyEvent } from "./input";

export type Action =
  | "cancel_action"
  | "quit"
  | "sidebar_toggle"
  | "focus_cycle_next"
  | "focus_cycle_prev"
  | "focus_prompt"
  | "focus_history"
  | "member_list_toggle"
  | "sidebar_next"
  | "sidebar_prev"
  | "scroll_line_up"
  | "scroll_line_down"
  | "scroll_half_up"
  | "scroll_half_down"
  | "scroll_page_up"
  | "scroll_page_down"
  | "nav_up"
  | "nav_down"
  | "nav_select"
  | "nav_prev_server"
  | "nav_next_server"
  | "nav_prev_category"
  | "nav_next_category"
  | "nav_toggle_guild_mute"
  | "notification_prev"
  | "notification_next"
  | "paste_image"
  | "reply_toggle";

const GLOBAL_BINDS: Partial<Record<KeyEvent["type"], Action>> = {
  "ctrl-b": "scroll_page_up",
  "ctrl-c": "quit",
  "ctrl-d": "scroll_half_down",
  "ctrl-e": "scroll_line_down",
  "ctrl-f": "scroll_page_down",
  "ctrl-j": "focus_cycle_next",
  "ctrl-k": "focus_cycle_prev",
  "ctrl-m": "sidebar_toggle",
  "ctrl-n": "focus_history",
  "ctrl-q": "cancel_action",
  "ctrl-r": "reply_toggle",
  "ctrl-s": "sidebar_toggle",
  "ctrl-semicolon": "member_list_toggle",
  "ctrl-left-bracket": "notification_prev",
  "ctrl-right-bracket": "notification_next",
  "ctrl-u": "scroll_half_up",
  "ctrl-v": "paste_image",
  "ctrl-y": "scroll_line_up",
};

const GLOBAL_CHAR_BINDS: Record<string, Action> = {
  "char:J": "sidebar_next",
  "char:K": "sidebar_prev",
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
  "char:{": "nav_prev_server",
  "char:}": "nav_next_server",
  "char:[": "nav_prev_category",
  "char:]": "nav_next_category",
  "char:m": "nav_toggle_guild_mute",
};

export type KeyContext = "prompt" | "navigation";

export function resolveAction(key: KeyEvent, context: KeyContext = "prompt"): Action | null {
  if (key.type === "char" && key.char) {
    if (context === "navigation") {
      const navCharAction = NAV_CHAR_BINDS[`char:${key.char}`];
      if (navCharAction) return navCharAction;
    }

    const globalCharAction = GLOBAL_CHAR_BINDS[`char:${key.char}`];
    if (globalCharAction) return globalCharAction;
  }

  const globalAction = GLOBAL_BINDS[key.type];
  if (globalAction) return globalAction;

  return context === "navigation" ? NAV_BINDS[key.type] ?? null : null;
}
