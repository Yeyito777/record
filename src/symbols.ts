/**
 * Symbol insertion for Ctrl+number-row keys.
 *
 * st remaps Ctrl+1–9,0,- to F14–F24 escape sequences in alt-screen mode.
 * This module maps those F-keys to Unicode symbol insertions for the prompt
 * in insert mode.
 *
 * Master list (shared with Exocortex TUI and qutebrowser):
 *   Ctrl+1 (F14) → ←  left arrow
 *   Ctrl+2 (F15) → •  bullet point
 *   Ctrl+3 (F16) → →  right arrow
 *   Ctrl+9 (F22) → ✗  x mark
 *   Ctrl+0 (F23) → ✓  checkmark
 *   Ctrl+- (F24) → —  em dash
 */

import type { KeyEvent } from "./input";

const SYMBOL_MAP: Partial<Record<KeyEvent["type"], string>> = {
  f14: "←",  // Ctrl+1: left arrow
  f15: "•",  // Ctrl+2: bullet point
  f16: "→",  // Ctrl+3: right arrow
  f22: "✗",  // Ctrl+9: x mark
  f23: "✓",  // Ctrl+0: checkmark
  f24: "—",  // Ctrl+-: em dash
};

/**
 * If the key is a symbol F-key, return the symbol to insert.
 * Returns null for unbound F-keys or non-F-key events.
 */
export function getSymbol(key: KeyEvent): string | null {
  return SYMBOL_MAP[key.type] ?? null;
}
