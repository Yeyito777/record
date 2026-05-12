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
  | "nav_open_text"
  | "nav_prev_server"
  | "nav_next_server"
  | "nav_prev_category"
  | "nav_next_category"
  | "nav_toggle_guild_mute"
  | "nav_move_guild_up"
  | "nav_move_guild_down"
  | "nav_top"
  | "nav_bottom"
  | "nav_visible_top"
  | "nav_visible_middle"
  | "nav_visible_bottom"
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
  "shift-enter": "nav_open_text",
  "up": "nav_up",
  "down": "nav_down",
};

const NAV_CHAR_BINDS: Record<string, Action> = {
  "char:j": "nav_down",
  "char:k": "nav_up",
  "char:i": "focus_prompt",
  "char:a": "focus_prompt",
  "char:o": "nav_open_text",
  "char:{": "nav_prev_server",
  "char:}": "nav_next_server",
  "char:[": "nav_prev_category",
  "char:]": "nav_next_category",
  "char:m": "nav_toggle_guild_mute",
  "char:e": "nav_move_guild_up",
  "char:E": "nav_move_guild_down",
  "char:H": "nav_visible_top",
  "char:M": "nav_visible_middle",
  "char:L": "nav_visible_bottom",
};

const NAV_SEQUENCE_BINDS: Record<string, Action> = {
  "gg": "nav_top",
  "G": "nav_bottom",
};

const NAV_SEQUENCE_PREFIXES = new Set(["g"]);

export interface NavigationActionResolution {
  action: Action | null;
  pendingKeys: string;
  handled: boolean;
}

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

export function resolveNavigationAction(key: KeyEvent, pendingKeys = ""): NavigationActionResolution {
  if (key.type === "char" && key.char) {
    const fullKey = pendingKeys + key.char;
    const sequenceAction = NAV_SEQUENCE_BINDS[fullKey];
    if (sequenceAction) {
      return { action: sequenceAction, pendingKeys: "", handled: true };
    }

    if (NAV_SEQUENCE_PREFIXES.has(fullKey)) {
      return { action: null, pendingKeys: fullKey, handled: true };
    }

    if (pendingKeys) {
      return { action: null, pendingKeys: "", handled: true };
    }
  } else if (pendingKeys) {
    return { action: null, pendingKeys: "", handled: true };
  }

  const action = resolveAction(key, "navigation");
  return { action, pendingKeys: "", handled: action !== null };
}
