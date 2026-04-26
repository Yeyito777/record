/**
 * Prompt editor with Exocortex-style vim bindings.
 *
 * The public surface stays small in this file; pure helpers live in
 * editor-*.ts siblings so motions, text objects, layout math, and clipboard
 * behavior can stay independently readable and testable.
 */

import type { KeyEvent } from "./input";
import {
  commitInsertSession,
  createUndoState,
  markInsertEntry,
  pushUndo,
  redo as redoEdit,
  undo as undoEdit,
} from "./undo";
import { lineEndOf, lineStartOf, clampInsertCursor, clampNormalCursor } from "./editor-buffer";
import { copyToClipboard, pasteFromClipboard } from "./editor-clipboard";
import { lookupCommand, isPrefix } from "./editor-keymap";
import {
  getInputLines,
  getViewport,
  MAX_PROMPT_ROWS,
  PROMPT_PREFIX_WIDTH,
  wrappedLineOffsets,
} from "./editor-layout";
import {
  charLeft,
  charRight,
  findBackward,
  findForward,
  lineDown,
  lineUp,
  resolveMotion,
} from "./editor-motions";
import {
  changeLine,
  changeToEnd,
  deleteChar,
  deleteCharBefore,
  deleteLine,
  deleteRange,
  deleteToEnd,
  openLineAbove,
  openLineBelow,
  replaceChar,
  swapCase,
  swapCaseRange,
} from "./editor-operations";
import { getVisualRange } from "./editor-selection";
import { isTextObjectKey, resolveTextObject } from "./editor-textobjects";
import { getSymbol } from "./symbols";
import {
  keyString,
  resetPending,
  type BufferEdit,
  type CursorSpec,
  type EditorAction,
  type EditorMode,
  type EditorState,
  type EditorViewport,
  type FindDirection,
  type InputLinesResult,
  type PromptCommand,
} from "./editor-types";

export type {
  BufferEdit,
  CursorSpec,
  EditorAction,
  EditorMode,
  EditorState,
  EditorViewport,
  FindDirection,
  InputLinesResult,
  PromptCommand,
} from "./editor-types";
export { getInputLines, getViewport, MAX_PROMPT_ROWS, PROMPT_PREFIX_WIDTH, wrappedLineOffsets } from "./editor-layout";
export { getVisualRange } from "./editor-selection";

function insertText(editor: EditorState, text: string): void {
  if (!text) return;
  const pos = clampInsertCursor(editor.buffer, editor.cursor);
  editor.buffer = editor.buffer.slice(0, pos) + text + editor.buffer.slice(pos);
  editor.cursor = pos + text.length;
}

function insertNewline(editor: EditorState): void {
  insertText(editor, "\n");
}

function replaceWithPaste(editor: EditorState, text: string): void {
  const pos = editor.mode === "insert" ? clampInsertCursor(editor.buffer, editor.cursor) : editor.cursor;
  if (editor.mode !== "insert") {
    enterInsertMode(editor, pos);
  }
  insertText(editor, text);
}

function applyUndo(editor: EditorState): void {
  const snapshot = undoEdit(editor.undo, editor.buffer, editor.cursor);
  if (!snapshot) return;
  editor.buffer = snapshot.buffer;
  editor.cursor = clampNormalCursor(snapshot.buffer, snapshot.cursor);
  resetPending(editor);
}

function applyRedo(editor: EditorState): void {
  const snapshot = redoEdit(editor.undo, editor.buffer, editor.cursor);
  if (!snapshot) return;
  editor.buffer = snapshot.buffer;
  editor.cursor = clampNormalCursor(snapshot.buffer, snapshot.cursor);
  resetPending(editor);
}

function applyBufferEdit(
  editor: EditorState,
  edit: BufferEdit,
  mode: EditorMode | null = null,
  markInsert = false,
): void {
  if (markInsert) {
    markInsertEntry(editor.undo, editor.buffer, editor.cursor);
  } else {
    pushUndo(editor.undo, editor.buffer, editor.cursor);
  }

  editor.buffer = edit.buffer;
  editor.cursor = mode === "insert"
    ? clampInsertCursor(edit.buffer, edit.cursor)
    : clampNormalCursor(edit.buffer, edit.cursor);
  if (mode) editor.mode = mode;
  resetPending(editor);
}

function applyCountedLineEdit(
  editor: EditorState,
  count: number,
  fn: (buffer: string, pos: number) => BufferEdit,
  mode: EditorMode | null = null,
): void {
  let buffer = editor.buffer;
  let cursor = editor.cursor;

  for (let i = 0; i < count; i++) {
    if (buffer.length === 0) break;
    const result = fn(buffer, cursor);
    buffer = result.buffer;
    cursor = result.cursor;
  }

  applyBufferEdit(editor, { buffer, cursor }, mode, mode === "insert");
}

function applyPasteCommand(editor: EditorState, position: "after" | "before"): void {
  const text = pasteFromClipboard();
  if (!text) return;

  pushUndo(editor.undo, editor.buffer, editor.cursor);
  const insertAt = position === "after" ? editor.cursor + 1 : editor.cursor;
  const pos = Math.min(insertAt, editor.buffer.length);
  editor.buffer = editor.buffer.slice(0, pos) + text + editor.buffer.slice(pos);
  editor.cursor = clampNormalCursor(editor.buffer, pos + Math.max(0, text.length - 1));
  resetPending(editor);
}

function motionTarget(buffer: string, cursor: number, motionName: string, count: number): number {
  let target = cursor;
  for (let i = 0; i < count; i++) {
    target = resolveMotion(motionName, buffer, target);
  }
  return target;
}

function handleNormalLikeCursorKey(editor: EditorState, key: KeyEvent): boolean {
  switch (key.type) {
    case "left":
      editor.cursor = charLeft(editor.buffer, editor.cursor);
      return true;
    case "right":
      editor.cursor = charRight(editor.buffer, editor.cursor);
      return true;
    case "up":
      editor.cursor = lineUp(editor.buffer, editor.cursor);
      return true;
    case "down":
      editor.cursor = lineDown(editor.buffer, editor.cursor);
      return true;
    case "home":
      editor.cursor = lineStartOf(editor.buffer, editor.cursor);
      return true;
    case "end":
      editor.cursor = lineEndOf(editor.buffer, editor.cursor);
      return true;
    default:
      return false;
  }
}

function findTarget(buffer: string, cursor: number, direction: FindDirection, char: string): number {
  return direction === "f"
    ? findForward(buffer, cursor, char)
    : findBackward(buffer, cursor, char);
}

function applyFindMotion(editor: EditorState, direction: FindDirection, char: string, remember = true): void {
  if (remember) editor.lastFind = { char, direction };
  editor.pendingFind = null;
  editor.cursor = findTarget(editor.buffer, editor.cursor, direction, char);
}

function applyFindOperator(editor: EditorState, direction: FindDirection, char: string, remember = true): EditorAction {
  if (remember) editor.lastFind = { char, direction };
  editor.pendingFind = null;

  const target = findTarget(editor.buffer, editor.cursor, direction, char);
  if (target === editor.cursor) {
    resetPending(editor);
    return "handled";
  }

  return applyOperatorToRange(
    editor,
    editor.pendingOperator ?? "",
    Math.min(editor.cursor, target),
    Math.max(editor.cursor, target) + 1,
  );
}

function repeatFindDirection(editor: EditorState, key: ";" | ","): FindDirection | null {
  if (!editor.lastFind) return null;
  if (key === ";") return editor.lastFind.direction;
  return editor.lastFind.direction === "f" ? "F" : "f";
}

function exitVisualMode(editor: EditorState): void {
  editor.mode = "normal";
  resetPending(editor);
  editor.cursor = clampNormalCursor(editor.buffer, editor.cursor);
}

function applyOperatorToRange(editor: EditorState, operator: string, start: number, end: number): EditorAction {
  switch (operator) {
    case "delete":
      applyBufferEdit(editor, deleteRange(editor.buffer, start, end));
      return "handled";
    case "change":
      applyBufferEdit(editor, deleteRange(editor.buffer, start, end), "insert", true);
      return "handled";
    case "yank":
      copyToClipboard(editor.buffer.slice(start, end));
      resetPending(editor);
      return "handled";
    default:
      resetPending(editor);
      return "handled";
  }
}

function executeModeChange(editor: EditorState, mode: EditorMode, cursorSpec?: CursorSpec): void {
  editor.mode = mode;
  resetPending(editor);

  if (mode === "visual" || mode === "visual-line") {
    editor.visualAnchor = editor.cursor;
    return;
  }

  let cursor = editor.cursor;
  switch (cursorSpec) {
    case "after":
      cursor = Math.min(editor.cursor + 1, lineEndOf(editor.buffer, editor.cursor));
      break;
    case "bol":
      cursor = lineStartOf(editor.buffer, editor.cursor);
      break;
    case "eol":
      cursor = lineEndOf(editor.buffer, editor.cursor);
      break;
    default:
      break;
  }

  editor.cursor = clampInsertCursor(editor.buffer, cursor);
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
}

function executeStandalone(editor: EditorState, name: string, count: number): EditorAction {
  switch (name) {
    case "delete_char":
      applyBufferEdit(editor, deleteChar(editor.buffer, editor.cursor));
      return "handled";
    case "delete_char_before":
      applyBufferEdit(editor, deleteCharBefore(editor.buffer, editor.cursor));
      return "handled";
    case "delete_line":
      applyCountedLineEdit(editor, count, deleteLine);
      return "handled";
    case "change_line":
      applyBufferEdit(editor, changeLine(editor.buffer, editor.cursor), "insert", true);
      return "handled";
    case "delete_to_eol":
      applyBufferEdit(editor, deleteToEnd(editor.buffer, editor.cursor));
      return "handled";
    case "change_to_eol":
      applyBufferEdit(editor, changeToEnd(editor.buffer, editor.cursor), "insert", true);
      return "handled";
    case "open_below":
      applyBufferEdit(editor, openLineBelow(editor.buffer, editor.cursor), "insert", true);
      return "handled";
    case "open_above":
      applyBufferEdit(editor, openLineAbove(editor.buffer, editor.cursor), "insert", true);
      return "handled";
    case "yank_line": {
      const start = lineStartOf(editor.buffer, editor.cursor);
      const lineEnd = lineEndOf(editor.buffer, editor.cursor);
      const end = lineEnd < editor.buffer.length ? lineEnd + 1 : lineEnd;
      copyToClipboard(editor.buffer.slice(start, end));
      resetPending(editor);
      return "handled";
    }
    case "swap_case":
      applyBufferEdit(editor, swapCase(editor.buffer, editor.cursor, count));
      return "handled";
    case "paste_after":
      applyPasteCommand(editor, "after");
      return "handled";
    case "paste_before":
      applyPasteCommand(editor, "before");
      return "handled";
    case "undo":
      applyUndo(editor);
      return "handled";
    default:
      resetPending(editor);
      return "handled";
  }
}

function executeVisualCommand(editor: EditorState, command: PromptCommand): EditorAction {
  switch (command.type) {
    case "motion":
      editor.cursor = resolveMotion(command.name, editor.buffer, editor.cursor);
      return "handled";
    case "standalone": {
      const { start, endExclusive } = getVisualRange(editor.buffer, editor.visualAnchor, editor.cursor, editor.mode);

      switch (command.name) {
        case "visual_yank":
          copyToClipboard(editor.buffer.slice(start, endExclusive));
          exitVisualMode(editor);
          return "handled";
        case "visual_delete":
          exitVisualMode(editor);
          applyBufferEdit(editor, deleteRange(editor.buffer, start, endExclusive));
          return "handled";
        case "visual_change":
          applyBufferEdit(editor, deleteRange(editor.buffer, start, endExclusive), "insert", true);
          return "handled";
        case "visual_swap_case":
          exitVisualMode(editor);
          applyBufferEdit(editor, swapCaseRange(editor.buffer, start, endExclusive));
          return "handled";
        default:
          return "handled";
      }
    }
    default:
      return "handled";
  }
}

function handlePaste(editor: EditorState, text: string): EditorAction {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) return "handled";
  replaceWithPaste(editor, normalized);
  return "handled";
}

function handleInsertKey(editor: EditorState, key: KeyEvent): EditorAction {
  // Symbol keys (Ctrl+number row → F14-F24 from st). Only insert them from
  // prompt insert mode; in normal/visual/history contexts they stay inert.
  const sym = getSymbol(key);
  if (sym) {
    insertText(editor, sym);
    return "handled";
  }

  switch (key.type) {
    case "char":
      if (key.char) insertText(editor, key.char);
      return "handled";
    case "backspace": {
      const pos = clampInsertCursor(editor.buffer, editor.cursor);
      if (pos > 0) {
        editor.buffer = editor.buffer.slice(0, pos - 1) + editor.buffer.slice(pos);
        editor.cursor = pos - 1;
      }
      return "handled";
    }
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
      editor.cursor = lineStartOf(editor.buffer, editor.cursor);
      return "handled";
    case "end":
      editor.cursor = lineEndOf(editor.buffer, editor.cursor);
      return "handled";
    case "up":
      editor.cursor = lineUp(editor.buffer, editor.cursor);
      return "handled";
    case "down":
      editor.cursor = lineDown(editor.buffer, editor.cursor);
      return "handled";
    case "enter":
      return "submit";
    case "ctrl-l":
    case "shift-enter":
      insertNewline(editor);
      return "handled";
    case "escape":
      leaveInsertMode(editor);
      return "handled";
    default:
      return "handled";
  }
}

function handleVisualKey(editor: EditorState, key: KeyEvent): EditorAction {
  const ks = keyString(key);

  if (ks === "escape" || (ks === "v" && editor.mode === "visual") || (ks === "V" && editor.mode === "visual-line")) {
    exitVisualMode(editor);
    return "handled";
  }

  if (ks === "V" && editor.mode === "visual") {
    editor.mode = "visual-line";
    return "handled";
  }
  if (ks === "v" && editor.mode === "visual-line") {
    editor.mode = "visual";
    return "handled";
  }

  if (ks === null) {
    handleNormalLikeCursorKey(editor, key);
    return "handled";
  }

  if (editor.pendingFind) {
    if (key.type !== "char" || !key.char) {
      editor.pendingFind = null;
      return "handled";
    }
    applyFindMotion(editor, editor.pendingFind, key.char);
    return "handled";
  }

  if (ks === "f" || ks === "F") {
    editor.pendingFind = ks;
    return "handled";
  }

  if (ks === ";" || ks === ",") {
    const direction = repeatFindDirection(editor, ks);
    if (!direction || !editor.lastFind) return "handled";
    applyFindMotion(editor, direction, editor.lastFind.char, false);
    return "handled";
  }

  if (editor.pendingTextObjectModifier) {
    const modifier = editor.pendingTextObjectModifier;
    editor.pendingTextObjectModifier = null;
    if (isTextObjectKey(ks)) {
      const range = resolveTextObject(modifier, ks, editor.buffer, editor.cursor);
      if (range && range.start !== range.end) {
        editor.visualAnchor = range.start;
        editor.cursor = Math.max(range.start, range.end - 1);
      }
    }
    return "handled";
  }

  if (ks === "i" || ks === "a") {
    editor.pendingTextObjectModifier = ks;
    return "handled";
  }

  const fullKey = editor.pendingKeys + ks;
  const command = lookupCommand(editor.mode, fullKey);
  if (command) {
    editor.pendingKeys = "";
    return executeVisualCommand(editor, command);
  }

  if (isPrefix(editor.mode, fullKey)) {
    editor.pendingKeys = fullKey;
    return "handled";
  }

  resetPending(editor);
  return "handled";
}

function handleNormalKey(editor: EditorState, key: KeyEvent): EditorAction {
  if (key.type === "ctrl-r") {
    applyRedo(editor);
    return "handled";
  }

  if (key.type === "enter") {
    resetPending(editor);
    return "submit";
  }

  if (handleNormalLikeCursorKey(editor, key)) {
    return "handled";
  }

  if (key.type === "backspace") {
    applyBufferEdit(editor, deleteCharBefore(editor.buffer, editor.cursor));
    return "handled";
  }

  if (key.type === "delete") {
    applyBufferEdit(editor, deleteChar(editor.buffer, editor.cursor));
    return "handled";
  }

  if (key.type === "escape") {
    resetPending(editor);
    return "handled";
  }

  const ks = keyString(key);
  if (ks === null) return "handled";

  if (/^[1-9]$/.test(ks) || (ks === "0" && editor.count !== null)) {
    editor.count = (editor.count ?? 0) * 10 + Number.parseInt(ks, 10);
    return "handled";
  }

  if (ks === "r" && !editor.pendingOperator) {
    editor.pendingReplace = true;
    return "handled";
  }

  if (editor.pendingFind) {
    if (key.type !== "char" || !key.char) {
      editor.pendingFind = null;
      return "handled";
    }

    if (editor.pendingOperator) {
      return applyFindOperator(editor, editor.pendingFind, key.char);
    }

    applyFindMotion(editor, editor.pendingFind, key.char);
    return "handled";
  }

  if (editor.pendingReplace) {
    resetPending(editor);
    if (key.type === "char" && key.char) {
      applyBufferEdit(editor, replaceChar(editor.buffer, editor.cursor, key.char));
    }
    return "handled";
  }

  if (ks === "f" || ks === "F") {
    editor.pendingFind = ks;
    return "handled";
  }

  if (ks === ";" || ks === ",") {
    const direction = repeatFindDirection(editor, ks);
    if (!direction || !editor.lastFind) return "handled";
    if (editor.pendingOperator) {
      return applyFindOperator(editor, direction, editor.lastFind.char, false);
    }
    applyFindMotion(editor, direction, editor.lastFind.char, false);
    return "handled";
  }

  const fullKey = editor.pendingKeys + ks;

  if (editor.pendingOperator && ks === editor.pendingOperatorKey) {
    const doubled = lookupCommand(editor.mode, editor.pendingOperatorKey + ks);
    if (doubled) {
      const count = editor.count ?? 1;
      resetPending(editor);
      return executeStandalone(editor, doubled.type === "standalone" ? doubled.name : "", count);
    }
  }

  if (editor.pendingOperator && editor.pendingTextObjectModifier) {
    if (isTextObjectKey(ks)) {
      const operator = editor.pendingOperator;
      const range = resolveTextObject(editor.pendingTextObjectModifier, ks, editor.buffer, editor.cursor);
      resetPending(editor);
      if (range && range.start !== range.end) {
        return applyOperatorToRange(editor, operator ?? "", range.start, range.end);
      }
      return "handled";
    }
    resetPending(editor);
    return "handled";
  }

  if (editor.pendingOperator) {
    if (ks === "i" || ks === "a") {
      editor.pendingTextObjectModifier = ks;
      return "handled";
    }

    const motionCommand = lookupCommand(editor.mode, ks);
    if (motionCommand?.type === "motion") {
      const operator = editor.pendingOperator;
      const count = editor.count ?? 1;
      const target = motionTarget(editor.buffer, editor.cursor, motionCommand.name, count);
      const start = Math.min(editor.cursor, target);
      const end = Math.max(editor.cursor, target);
      resetPending(editor);
      if (start === end) return "handled";
      return applyOperatorToRange(editor, operator ?? "", start, end);
    }

    resetPending(editor);
    return "handled";
  }

  const command = lookupCommand(editor.mode, fullKey);
  if (command) {
    editor.pendingKeys = "";
    const count = editor.count ?? 1;

    switch (command.type) {
      case "motion":
        editor.cursor = clampNormalCursor(editor.buffer, motionTarget(editor.buffer, editor.cursor, command.name, count));
        resetPending(editor);
        return "handled";
      case "operator":
        editor.pendingOperator = command.name;
        editor.pendingOperatorKey = ks;
        editor.pendingKeys = "";
        editor.count = null;
        return "handled";
      case "mode_change":
        executeModeChange(editor, command.mode, command.cursor);
        return "handled";
      case "action":
        resetPending(editor);
        return command.action;
      case "standalone":
        return executeStandalone(editor, command.name, count);
      default:
        return "handled";
    }
  }

  if (isPrefix(editor.mode, fullKey)) {
    editor.pendingKeys = fullKey;
    return "handled";
  }

  resetPending(editor);
  return "handled";
}

export function createEditorState(initialBuffer = "", mode: EditorMode = "insert"): EditorState {
  const editor: EditorState = {
    buffer: initialBuffer,
    cursor: mode === "insert" ? initialBuffer.length : clampNormalCursor(initialBuffer, initialBuffer.length),
    scroll: 0,
    mode,
    pendingKeys: "",
    pendingOperator: null,
    pendingOperatorKey: null,
    pendingTextObjectModifier: null,
    count: null,
    visualAnchor: 0,
    pendingFind: null,
    lastFind: null,
    pendingReplace: false,
    undo: createUndoState(),
  };

  if (mode === "insert") {
    markInsertEntry(editor.undo, editor.buffer, editor.cursor);
  }

  return editor;
}

export function resetEditor(editor: EditorState, buffer = "", mode: EditorMode = "insert"): void {
  editor.buffer = buffer;
  editor.cursor = mode === "insert" ? buffer.length : clampNormalCursor(buffer, buffer.length);
  editor.scroll = 0;
  editor.mode = mode;
  editor.pendingKeys = "";
  editor.pendingOperator = null;
  editor.pendingOperatorKey = null;
  editor.pendingTextObjectModifier = null;
  editor.count = null;
  editor.visualAnchor = 0;
  editor.pendingFind = null;
  editor.lastFind = null;
  editor.pendingReplace = false;
  editor.undo = createUndoState();

  if (mode === "insert") {
    markInsertEntry(editor.undo, editor.buffer, editor.cursor);
  }
}

export function leaveInsertMode(editor: EditorState): void {
  if (editor.mode !== "insert") return;
  commitInsertSession(editor.undo, editor.buffer);
  editor.mode = "normal";
  resetPending(editor);

  let newCursor = editor.cursor;
  if (newCursor > 0 && editor.buffer[newCursor - 1] !== "\n") {
    newCursor--;
  }
  editor.cursor = clampNormalCursor(editor.buffer, newCursor);
}

export function enterInsertMode(editor: EditorState, cursor: number): void {
  editor.mode = "insert";
  resetPending(editor);
  editor.cursor = clampInsertCursor(editor.buffer, cursor);
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
}

export function handleEditorKey(editor: EditorState, key: KeyEvent): EditorAction {
  if (key.type === "ctrl-c") return "quit";
  if (key.type === "paste") return handlePaste(editor, key.text ?? "");

  if (editor.mode === "insert") {
    return handleInsertKey(editor, key);
  }

  if (editor.mode === "visual" || editor.mode === "visual-line") {
    return handleVisualKey(editor, key);
  }

  return handleNormalKey(editor, key);
}

export function displayCursor(editor: EditorState): number {
  return editor.mode === "insert"
    ? clampInsertCursor(editor.buffer, editor.cursor)
    : clampNormalCursor(editor.buffer, editor.cursor);
}
