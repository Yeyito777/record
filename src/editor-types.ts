/**
 * Prompt editor core types.
 */

import type { KeyEvent } from "./input";
import type { UndoState } from "./undo";

export type EditorMode = "insert" | "normal" | "visual" | "visual-line";
export type EditorAction = "handled" | "submit" | "quit" | "scroll_top" | "scroll_bottom";
/** f/F find a character; t/T stop just before/after it. */
export type FindDirection = "f" | "F" | "t" | "T";
export type CursorSpec = "before" | "after" | "bol" | "eol";

export interface EditorState {
  buffer: string;
  cursor: number;
  /** Preferred visual column for repeated vertical movement (Vim curswant). */
  curswant: number | null;
  scroll: number;
  /**
   * Prompt wrap width in terminal cells, recorded by the renderer so j/k and
   * Up/Down move by the same display rows that are drawn. Null moves by
   * logical lines (no layout known yet).
   */
  wrapWidth: number | null;
  mode: EditorMode;
  pendingKeys: string;
  pendingOperator: string | null;
  pendingOperatorKey: string | null;
  pendingTextObjectModifier: "i" | "a" | null;
  count: number | null;
  /** Count typed before a pending operator (the 2 in "2d3w"); multiplies the motion count. */
  operatorCount: number | null;
  visualAnchor: number;
  pendingFind: FindDirection | null;
  lastFind: { char: string; direction: FindDirection } | null;
  pendingReplace: boolean;
  undo: UndoState;
}

export interface EditorViewport {
  text: string;
  cursorCol: number;
  scroll: number;
}

export interface InputLinesResult {
  lines: string[];
  /** Buffer offset where each visible line starts. */
  lineStarts: number[];
  isNewLine: boolean[];
  cursorLine: number;
  cursorCol: number;
  scrollOffset: number;
}

export interface BufferEdit {
  buffer: string;
  cursor: number;
}

export interface Range {
  start: number;
  end: number;
}

export type PromptCommand =
  | { type: "motion"; name: string }
  | { type: "operator"; name: string }
  | { type: "mode_change"; mode: EditorMode; cursor?: CursorSpec }
  | { type: "action"; action: "scroll_top" | "scroll_bottom" }
  | { type: "standalone"; name: string };

export interface KeymapEntry {
  mode: EditorMode;
  key: string;
  command: PromptCommand;
}

export function keyString(key: KeyEvent): string | null {
  if (key.type === "char" && key.char) return key.char;
  if (key.type === "escape") return "escape";
  if (key.type === "enter") return "enter";
  return null;
}

/** Whether a command is half-typed (operator, prefix, count, find or replace). */
export function hasPending(editor: EditorState): boolean {
  return !!(editor.pendingOperator || editor.pendingTextObjectModifier || editor.pendingKeys
    || editor.count !== null || editor.pendingFind || editor.pendingReplace);
}

export function resetPending(editor: EditorState): void {
  editor.pendingOperator = null;
  editor.pendingOperatorKey = null;
  editor.pendingTextObjectModifier = null;
  editor.pendingKeys = "";
  editor.count = null;
  editor.operatorCount = null;
  editor.pendingFind = null;
  editor.pendingReplace = false;
}
