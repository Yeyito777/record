/**
 * Minimal modal editor for the token field.
 *
 * Default mode is vim-like: insert + normal. The surface area is intentionally
 * tiny for now, but the structure is ready for richer motions/actions later.
 */

import type { KeyEvent } from "./input";
import { normalizeToken } from "./token";
import {
  commitInsertSession,
  createUndoState,
  markInsertEntry,
  pushUndo,
  undo as undoEdit,
  type UndoState,
} from "./undo";

export type EditorMode = "insert" | "normal";
export type EditorAction = "handled" | "submit" | "quit";

export interface EditorState {
  buffer: string;
  cursor: number;
  scroll: number;
  mode: EditorMode;
  pendingKeys: string;
  undo: UndoState;
}

export interface EditorViewport {
  text: string;
  cursorCol: number;
  scroll: number;
}

export function clampInsertCursor(buffer: string, cursor: number): number {
  return Math.max(0, Math.min(cursor, buffer.length));
}

export function clampNormalCursor(buffer: string, cursor: number): number {
  if (buffer.length === 0) return 0;
  return Math.max(0, Math.min(cursor, buffer.length - 1));
}

export function createEditorState(initialBuffer = "", mode: EditorMode = "insert"): EditorState {
  const buffer = initialBuffer;
  const state: EditorState = {
    buffer,
    cursor: mode === "insert" ? buffer.length : clampNormalCursor(buffer, buffer.length - 1),
    scroll: 0,
    mode,
    pendingKeys: "",
    undo: createUndoState(),
  };

  if (mode === "insert") {
    markInsertEntry(state.undo, state.buffer, state.cursor);
  }

  return state;
}

export function resetEditor(editor: EditorState, buffer = "", mode: EditorMode = "insert"): void {
  editor.buffer = buffer;
  editor.cursor = mode === "insert" ? buffer.length : clampNormalCursor(buffer, buffer.length - 1);
  editor.scroll = 0;
  editor.mode = mode;
  editor.pendingKeys = "";
  editor.undo = createUndoState();

  if (mode === "insert") {
    markInsertEntry(editor.undo, editor.buffer, editor.cursor);
  }
}

export function leaveInsertMode(editor: EditorState): void {
  if (editor.mode !== "insert") return;
  commitInsertSession(editor.undo, editor.buffer);
  editor.mode = "normal";
  editor.pendingKeys = "";
  editor.cursor = editor.buffer.length === 0
    ? 0
    : clampNormalCursor(editor.buffer, Math.max(0, editor.cursor - 1));
}

export function enterInsertMode(editor: EditorState, cursor: number): void {
  editor.mode = "insert";
  editor.pendingKeys = "";
  editor.cursor = clampInsertCursor(editor.buffer, cursor);
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
}

function insertText(editor: EditorState, text: string): void {
  if (!text) return;
  const pos = clampInsertCursor(editor.buffer, editor.cursor);
  editor.buffer = editor.buffer.slice(0, pos) + text + editor.buffer.slice(pos);
  editor.cursor = pos + text.length;
}

function replaceWithPaste(editor: EditorState, text: string): void {
  pushUndo(editor.undo, editor.buffer, editor.cursor);
  editor.buffer = text;
  editor.cursor = text.length;
  editor.scroll = 0;
  editor.pendingKeys = "";
  editor.mode = "insert";
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
}

function deleteCharAtCursor(editor: EditorState): void {
  if (editor.buffer.length === 0) return;
  pushUndo(editor.undo, editor.buffer, editor.cursor);
  const pos = clampNormalCursor(editor.buffer, editor.cursor);
  editor.buffer = editor.buffer.slice(0, pos) + editor.buffer.slice(pos + 1);
  editor.cursor = clampNormalCursor(editor.buffer, pos);
}

function deleteCharBeforeCursor(editor: EditorState): void {
  if (editor.buffer.length === 0) return;
  const pos = editor.mode === "insert"
    ? clampInsertCursor(editor.buffer, editor.cursor)
    : clampNormalCursor(editor.buffer, editor.cursor);
  if (pos <= 0) return;

  pushUndo(editor.undo, editor.buffer, editor.cursor);
  const deleteAt = pos - 1;
  editor.buffer = editor.buffer.slice(0, deleteAt) + editor.buffer.slice(deleteAt + 1);
  editor.cursor = editor.mode === "insert"
    ? clampInsertCursor(editor.buffer, deleteAt)
    : clampNormalCursor(editor.buffer, deleteAt);
}

function deleteToEnd(editor: EditorState): void {
  if (editor.buffer.length === 0) return;
  const pos = clampNormalCursor(editor.buffer, editor.cursor);
  pushUndo(editor.undo, editor.buffer, editor.cursor);
  editor.buffer = editor.buffer.slice(0, pos);
  editor.cursor = clampNormalCursor(editor.buffer, pos);
}

function deleteAll(editor: EditorState): void {
  if (!editor.buffer) return;
  pushUndo(editor.undo, editor.buffer, editor.cursor);
  editor.buffer = "";
  editor.cursor = 0;
  editor.scroll = 0;
}

function applyUndo(editor: EditorState): void {
  const snapshot = undoEdit(editor.undo, editor.buffer, editor.cursor);
  if (!snapshot) return;
  editor.buffer = snapshot.buffer;
  editor.cursor = clampNormalCursor(snapshot.buffer, snapshot.cursor);
  editor.pendingKeys = "";
}

function sanitizeSingleLinePaste(text: string): string {
  return text
    .replace(/\r\n/g, " ")
    .replace(/[\r\n\t]+/g, " ");
}

function handlePaste(editor: EditorState, text: string): EditorAction {
  const pasted = sanitizeSingleLinePaste(text);
  if (!pasted) return "handled";

  if (editor.mode === "normal") {
    replaceWithPaste(editor, pasted);
  } else {
    insertText(editor, pasted);
  }

  return "handled";
}

function handleInsertKey(editor: EditorState, key: KeyEvent): EditorAction {
  switch (key.type) {
    case "char":
      if (key.char) insertText(editor, key.char);
      return "handled";
    case "backspace":
      if (editor.cursor > 0) {
        const pos = clampInsertCursor(editor.buffer, editor.cursor);
        editor.buffer = editor.buffer.slice(0, pos - 1) + editor.buffer.slice(pos);
        editor.cursor = pos - 1;
      }
      return "handled";
    case "delete": {
      const pos = clampInsertCursor(editor.buffer, editor.cursor);
      if (pos < editor.buffer.length) {
        editor.buffer = editor.buffer.slice(0, pos) + editor.buffer.slice(pos + 1);
      }
      return "handled";
    }
    case "left":
      editor.cursor = clampInsertCursor(editor.buffer, editor.cursor - 1);
      return "handled";
    case "right":
      editor.cursor = clampInsertCursor(editor.buffer, editor.cursor + 1);
      return "handled";
    case "home":
      editor.cursor = 0;
      return "handled";
    case "end":
      editor.cursor = editor.buffer.length;
      return "handled";
    case "escape":
      leaveInsertMode(editor);
      return "handled";
    case "up":
    case "down":
    case "tab":
    case "backtab":
    case "unknown":
      return "handled";
    default:
      return "handled";
  }
}

function handleNormalKey(editor: EditorState, key: KeyEvent): EditorAction {
  if (editor.pendingKeys === "d") {
    editor.pendingKeys = "";
    if (key.type === "char" && key.char === "d") {
      deleteAll(editor);
      return "handled";
    }
  }

  switch (key.type) {
    case "left":
      editor.cursor = clampNormalCursor(editor.buffer, editor.cursor - 1);
      return "handled";
    case "right":
      editor.cursor = clampNormalCursor(editor.buffer, editor.cursor + 1);
      return "handled";
    case "home":
      editor.cursor = 0;
      return "handled";
    case "end":
      editor.cursor = clampNormalCursor(editor.buffer, editor.buffer.length - 1);
      return "handled";
    case "backspace":
      deleteCharBeforeCursor(editor);
      return "handled";
    case "delete":
      deleteCharAtCursor(editor);
      return "handled";
    case "escape":
      editor.pendingKeys = "";
      return "handled";
    case "up":
    case "down":
    case "tab":
    case "backtab":
    case "unknown":
      return "handled";
    case "char":
      break;
    default:
      return "handled";
  }

  const ch = key.char;
  if (!ch) return "handled";

  switch (ch) {
    case "q":
      return "quit";
    case "h":
      editor.cursor = clampNormalCursor(editor.buffer, editor.cursor - 1);
      return "handled";
    case "l":
      editor.cursor = clampNormalCursor(editor.buffer, editor.cursor + 1);
      return "handled";
    case "0":
      editor.cursor = 0;
      return "handled";
    case "$":
      editor.cursor = clampNormalCursor(editor.buffer, editor.buffer.length - 1);
      return "handled";
    case "i":
      enterInsertMode(editor, editor.cursor);
      return "handled";
    case "a":
      enterInsertMode(editor, editor.buffer.length === 0 ? 0 : editor.cursor + 1);
      return "handled";
    case "I":
      enterInsertMode(editor, 0);
      return "handled";
    case "A":
      enterInsertMode(editor, editor.buffer.length);
      return "handled";
    case "x":
      deleteCharAtCursor(editor);
      return "handled";
    case "X":
      deleteCharBeforeCursor(editor);
      return "handled";
    case "D":
      deleteToEnd(editor);
      return "handled";
    case "d":
      editor.pendingKeys = "d";
      return "handled";
    case "u":
      applyUndo(editor);
      return "handled";
    default:
      editor.pendingKeys = "";
      return "handled";
  }
}

export function handleEditorKey(editor: EditorState, key: KeyEvent): EditorAction {
  switch (key.type) {
    case "ctrl-c":
      return "quit";
    case "enter":
      editor.pendingKeys = "";
      return "submit";
    case "paste":
      return handlePaste(editor, key.text ?? "");
    default:
      break;
  }

  if (editor.mode === "insert") {
    return handleInsertKey(editor, key);
  }
  return handleNormalKey(editor, key);
}

export function displayCursor(editor: EditorState): number {
  return editor.mode === "insert"
    ? clampInsertCursor(editor.buffer, editor.cursor)
    : clampNormalCursor(editor.buffer, editor.cursor);
}

export function getViewport(buffer: string, cursor: number, width: number, previousScroll = 0): EditorViewport {
  const safeWidth = Math.max(1, width);
  let scroll = Math.max(0, previousScroll);

  if (cursor < scroll) {
    scroll = cursor;
  } else if (cursor >= scroll + safeWidth) {
    scroll = cursor - safeWidth + 1;
  }

  // Insert mode can place the cursor one cell past the last visible character,
  // so allow one extra scroll step beyond buffer.length - width when needed.
  const maxScroll = Math.max(0, Math.max(buffer.length - safeWidth, cursor - safeWidth + 1));
  scroll = Math.max(0, Math.min(scroll, maxScroll));

  return {
    text: buffer.slice(scroll, scroll + safeWidth),
    cursorCol: Math.max(0, cursor - scroll),
    scroll,
  };
}
