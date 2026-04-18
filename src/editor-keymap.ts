/**
 * Prompt editor vim keymap.
 */

import type { KeymapEntry, PromptCommand, EditorMode } from "./editor-types";

const KEYMAP: KeymapEntry[] = [
  { mode: "normal", key: "h", command: { type: "motion", name: "char_left" } },
  { mode: "normal", key: "l", command: { type: "motion", name: "char_right" } },
  { mode: "normal", key: "j", command: { type: "motion", name: "line_down" } },
  { mode: "normal", key: "k", command: { type: "motion", name: "line_up" } },
  { mode: "normal", key: "w", command: { type: "motion", name: "word_forward" } },
  { mode: "normal", key: "b", command: { type: "motion", name: "word_backward" } },
  { mode: "normal", key: "e", command: { type: "motion", name: "word_end" } },
  { mode: "normal", key: "W", command: { type: "motion", name: "word_forward_big" } },
  { mode: "normal", key: "B", command: { type: "motion", name: "word_backward_big" } },
  { mode: "normal", key: "E", command: { type: "motion", name: "word_end_big" } },
  { mode: "normal", key: "0", command: { type: "motion", name: "line_start" } },
  { mode: "normal", key: "$", command: { type: "motion", name: "line_end" } },
  { mode: "normal", key: "gg", command: { type: "action", action: "scroll_top" } },
  { mode: "normal", key: "G", command: { type: "action", action: "scroll_bottom" } },
  { mode: "normal", key: "i", command: { type: "mode_change", mode: "insert", cursor: "before" } },
  { mode: "normal", key: "a", command: { type: "mode_change", mode: "insert", cursor: "after" } },
  { mode: "normal", key: "I", command: { type: "mode_change", mode: "insert", cursor: "bol" } },
  { mode: "normal", key: "A", command: { type: "mode_change", mode: "insert", cursor: "eol" } },
  { mode: "normal", key: "d", command: { type: "operator", name: "delete" } },
  { mode: "normal", key: "c", command: { type: "operator", name: "change" } },
  { mode: "normal", key: "y", command: { type: "operator", name: "yank" } },
  { mode: "normal", key: "dd", command: { type: "standalone", name: "delete_line" } },
  { mode: "normal", key: "cc", command: { type: "standalone", name: "change_line" } },
  { mode: "normal", key: "yy", command: { type: "standalone", name: "yank_line" } },
  { mode: "normal", key: "u", command: { type: "standalone", name: "undo" } },
  { mode: "normal", key: "x", command: { type: "standalone", name: "delete_char" } },
  { mode: "normal", key: "X", command: { type: "standalone", name: "delete_char_before" } },
  { mode: "normal", key: "D", command: { type: "standalone", name: "delete_to_eol" } },
  { mode: "normal", key: "C", command: { type: "standalone", name: "change_to_eol" } },
  { mode: "normal", key: "o", command: { type: "standalone", name: "open_below" } },
  { mode: "normal", key: "O", command: { type: "standalone", name: "open_above" } },
  { mode: "normal", key: "p", command: { type: "standalone", name: "paste_after" } },
  { mode: "normal", key: "P", command: { type: "standalone", name: "paste_before" } },
  { mode: "normal", key: "~", command: { type: "standalone", name: "swap_case" } },
  { mode: "normal", key: "v", command: { type: "mode_change", mode: "visual" } },
  { mode: "normal", key: "V", command: { type: "mode_change", mode: "visual-line" } },
  { mode: "visual", key: "h", command: { type: "motion", name: "char_left" } },
  { mode: "visual", key: "l", command: { type: "motion", name: "char_right" } },
  { mode: "visual", key: "j", command: { type: "motion", name: "line_down" } },
  { mode: "visual", key: "k", command: { type: "motion", name: "line_up" } },
  { mode: "visual", key: "w", command: { type: "motion", name: "word_forward" } },
  { mode: "visual", key: "b", command: { type: "motion", name: "word_backward" } },
  { mode: "visual", key: "e", command: { type: "motion", name: "word_end" } },
  { mode: "visual", key: "W", command: { type: "motion", name: "word_forward_big" } },
  { mode: "visual", key: "B", command: { type: "motion", name: "word_backward_big" } },
  { mode: "visual", key: "E", command: { type: "motion", name: "word_end_big" } },
  { mode: "visual", key: "0", command: { type: "motion", name: "line_start" } },
  { mode: "visual", key: "$", command: { type: "motion", name: "line_end" } },
  { mode: "visual", key: "gg", command: { type: "motion", name: "buffer_start" } },
  { mode: "visual", key: "G", command: { type: "motion", name: "buffer_end" } },
  { mode: "visual", key: "d", command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual", key: "x", command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual", key: "c", command: { type: "standalone", name: "visual_change" } },
  { mode: "visual", key: "y", command: { type: "standalone", name: "visual_yank" } },
  { mode: "visual", key: "~", command: { type: "standalone", name: "visual_swap_case" } },
  { mode: "visual-line", key: "j", command: { type: "motion", name: "line_down" } },
  { mode: "visual-line", key: "k", command: { type: "motion", name: "line_up" } },
  { mode: "visual-line", key: "gg", command: { type: "motion", name: "buffer_start" } },
  { mode: "visual-line", key: "G", command: { type: "motion", name: "buffer_end" } },
  { mode: "visual-line", key: "d", command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual-line", key: "x", command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual-line", key: "c", command: { type: "standalone", name: "visual_change" } },
  { mode: "visual-line", key: "y", command: { type: "standalone", name: "visual_yank" } },
  { mode: "visual-line", key: "~", command: { type: "standalone", name: "visual_swap_case" } },
];

const KEY_PREFIXES = new Set<string>();
for (const entry of KEYMAP) {
  for (let i = 1; i < entry.key.length; i++) {
    KEY_PREFIXES.add(`${entry.mode}:${entry.key.slice(0, i)}`);
  }
}

export function lookupCommand(mode: EditorMode, key: string): PromptCommand | null {
  return KEYMAP.find((entry) => entry.mode === mode && entry.key === key)?.command ?? null;
}

export function isPrefix(mode: EditorMode, key: string): boolean {
  if (lookupCommand(mode, key)) return false;
  return KEY_PREFIXES.has(`${mode}:${key}`);
}
