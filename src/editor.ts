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
import { lineEndOf, lineStartOf, clampInsertCursor, clampNormalCursor, nextGraphemeEnd, previousGraphemeStart } from "./editor-buffer";
import { isBufferSpace, isPunct, isWordChar } from "./editor-chars";
import { copyToClipboard, isLinewiseClipboardText, pasteFromClipboard } from "./editor-clipboard";
import { lookupCommand, isPrefix } from "./editor-keymap";
import { promptCursorCell, promptDisplayRows } from "./editor-layout";
import {
  findCharCount,
  firstNonBlank,
  resolveMotion,
  reverseFindKind,
  wordEnd,
  wordEndBig,
} from "./editor-motions";
import {
  changeLines,
  changeToEnd,
  deleteChars,
  deleteCharsBefore,
  deleteLines,
  deleteRange,
  deleteToEnd,
  lineSpan,
  linewiseText,
  openLineAbove,
  openLineBelow,
  putLines,
  replaceChar,
  shiftLines,
  swapCase,
  swapCaseRange,
} from "./editor-operations";
import { getVisualRange } from "./editor-selection";
import { PROMPT_TAB, promptDeleteEnd, promptDeleteStart } from "./editor-tabs";
import { isTextObjectKey, resolveTextObject } from "./editor-textobjects";
import { sanitizePromptTextForInsertion } from "./prompttext";
import { getSymbol } from "./symbols";
import { termWidth } from "./textwidth";
import {
  hasPending,
  keyString,
  resetPending,
  type BufferEdit,
  type CursorSpec,
  type EditorAction,
  type EditorMode,
  type EditorState,
  type EditorViewport,
  type FindDirection,
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
export {
  getInputLines,
  getViewport,
  MAX_PROMPT_ROWS,
  PROMPT_PREFIX_WIDTH,
  promptDisplayRows,
  wrappedLineOffsets,
} from "./editor-layout";
export { getVisualRange } from "./editor-selection";

function resetCurswant(editor: EditorState): void {
  editor.curswant = null;
}

/** Arrow/Home/End keys act as their Vim motions outside insert mode. */
const ARROW_MOTIONS: Partial<Record<KeyEvent["type"], string>> = {
  left: "h",
  right: "l",
  up: "k",
  down: "j",
  home: "0",
  end: "$",
};

function offsetForVCol(line: string, desiredCol: number): number {
  let offset = 0;
  let col = 0;

  while (offset < line.length) {
    const end = nextGraphemeEnd(line, offset);
    const cluster = line.slice(offset, end);
    const width = termWidth(cluster);
    if (col + width > desiredCol) return offset;
    if (col + width === desiredCol) return end;
    col += width;
    offset = end;
  }

  return line.length;
}

/**
 * Move by display rows (Vim gj/gk) using the renderer's wrap width, so a
 * wrapped line's continuation rows are reachable and the prompt scrolls one
 * row at a time. Without a known width every logical line is one row. The
 * preferred column (curswant) is a display column within the row; Infinity
 * sticks to the end of each row (after $/End).
 */
function moveVerticalWithCurswant(
  editor: EditorState,
  direction: -1 | 1,
  count = 1,
  normalMode = false,
): boolean {
  const buffer = editor.buffer;
  const maxWidth = Math.max(1, editor.wrapWidth ?? Number.MAX_SAFE_INTEGER);
  const rows = promptDisplayRows(buffer, maxWidth);
  const cell = promptCursorCell(buffer, rows, editor.cursor);
  // An insert cursor just past a full-width line is drawn at column 0 of its
  // own row below it, so moving up first lands on the line's own last row.
  const onPhantomRow = cell.col >= maxWidth;
  const desiredCol = editor.curswant ?? (onPhantomRow ? 0 : cell.col);
  const upFromPhantomRow = onPhantomRow && direction < 0;
  const steps = Math.max(1, count) - (upFromPhantomRow ? 1 : 0);
  const target = Math.max(0, Math.min(rows.length - 1, cell.row + direction * steps));

  editor.curswant = desiredCol;
  if (target === cell.row && !upFromPhantomRow) return false;

  const row = rows[target]!;
  let pos = row.start + offsetForVCol(buffer.slice(row.start, row.end), desiredCol);
  // A wrapped row's end offset is drawn at the start of its continuation row,
  // and normal mode never rests past a line's last character.
  const continues = target + 1 < rows.length && rows[target + 1]!.start === row.end;
  if (pos >= row.end && row.end > row.start && (continues || normalMode)) {
    pos = previousGraphemeStart(buffer, row.end);
  }
  editor.cursor = pos;
  return true;
}

function isVerticalMotion(name: string): boolean {
  return name === "line_down" || name === "line_up";
}

function directionForVerticalMotion(name: string): -1 | 1 {
  return name === "line_up" ? -1 : 1;
}

function insertText(editor: EditorState, text: string): void {
  if (!text) return;
  const pos = clampInsertCursor(editor.buffer, editor.cursor);
  editor.buffer = editor.buffer.slice(0, pos) + text + editor.buffer.slice(pos);
  editor.cursor = pos + text.length;
  resetCurswant(editor);
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
  resetCurswant(editor);
  resetPending(editor);
}

function applyRedo(editor: EditorState): void {
  const snapshot = redoEdit(editor.undo, editor.buffer, editor.cursor);
  if (!snapshot) return;
  editor.buffer = snapshot.buffer;
  editor.cursor = clampNormalCursor(snapshot.buffer, snapshot.cursor);
  resetCurswant(editor);
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
  resetCurswant(editor);
  resetPending(editor);
}

/** Apply an edit, or just move the cursor when nothing changed (no empty undo step). */
function applyEditIfChanged(editor: EditorState, edit: BufferEdit): void {
  if (edit.buffer !== editor.buffer) {
    applyBufferEdit(editor, edit);
    return;
  }
  editor.cursor = clampNormalCursor(editor.buffer, edit.cursor);
  resetCurswant(editor);
  resetPending(editor);
}

/**
 * p/P — put `count` copies of the clipboard; as whole lines below/above the
 * cursor's line when it still holds our last linewise yank (yy, yj, Vy).
 */
function applyPasteCommand(editor: EditorState, position: "after" | "before", count: number): void {
  const text = pasteFromClipboard();
  if (!text) {
    resetPending(editor);
    return;
  }

  pushUndo(editor.undo, editor.buffer, editor.cursor);
  const buffer = editor.buffer;
  if (isLinewiseClipboardText(text)) {
    const lines = text.endsWith("\n") ? text : text + "\n";
    const edit = putLines(buffer, editor.cursor, lines.repeat(count), position === "after");
    editor.buffer = edit.buffer;
    editor.cursor = edit.cursor;
  } else {
    // Cursor offsets are UTF-16 indices; step over the whole grapheme before
    // putting text, rather than splitting an emoji or its modifiers in half.
    // On an empty line there is no character to put after.
    const insertAt = position === "after" && buffer[editor.cursor] !== "\n"
      ? nextGraphemeEnd(buffer, editor.cursor)
      : editor.cursor;
    const pos = Math.min(insertAt, buffer.length);
    const pasted = text.repeat(count);
    editor.buffer = buffer.slice(0, pos) + pasted + buffer.slice(pos);
    // Cursor on the last pasted character.
    editor.cursor = clampNormalCursor(editor.buffer, previousGraphemeStart(editor.buffer, pos + pasted.length));
  }
  resetCurswant(editor);
  resetPending(editor);
}

function motionTarget(buffer: string, cursor: number, motionName: string, count: number): number {
  let target = cursor;
  for (let i = 0; i < count; i++) {
    target = resolveMotion(motionName, buffer, target);
  }
  return target;
}

/** Outside insert mode, arrows are h/j/k/l/0/$ unless a find/replace awaits its character. */
function arrowKeyAsMotion(editor: EditorState, key: KeyEvent): KeyEvent {
  const motion = ARROW_MOTIONS[key.type];
  if (!motion || editor.pendingFind || editor.pendingReplace) return key;
  if (motion === "0") editor.count = null; // otherwise 0 extends a count
  return { type: "char", char: motion };
}

function isShiftPrefix(editor: EditorState): boolean {
  return editor.pendingKeys === "<" || editor.pendingKeys === ">";
}

/**
 * Resolve a find (f/F/t/T, or a ;/, repeat) `count` times. Only a new find
 * (not a repeat) is stored for ; and ,.
 */
function resolveFind(
  editor: EditorState,
  kind: FindDirection,
  char: string,
  repeat: boolean,
  count: number,
): number | null {
  if (!repeat) editor.lastFind = { char, direction: kind };
  return findCharCount(editor.buffer, editor.cursor, char, kind, count, repeat);
}

function applyFindMotion(editor: EditorState, kind: FindDirection, char: string, repeat: boolean): void {
  const target = resolveFind(editor, kind, char, repeat, editor.count ?? 1);
  resetPending(editor);
  if (target === null) return;
  editor.cursor = target;
  resetCurswant(editor);
}

/** A find after an operator: f/t include the target; F/T exclude the cursor's character. */
function applyFindOperator(editor: EditorState, kind: FindDirection, char: string, repeat: boolean): EditorAction {
  const operator = editor.pendingOperator ?? "";
  const cursor = editor.cursor;
  const target = resolveFind(editor, kind, char, repeat, operatorMotionCount(editor));
  resetPending(editor);
  if (target === null) return "handled";

  const forward = kind === "f" || kind === "t";
  const start = forward ? cursor : target;
  const end = forward ? nextGraphemeEnd(editor.buffer, target) : cursor;
  if (start >= end) return "handled";
  return applyOperatorToRange(editor, operator, start, end);
}

/** ;/, — the last find's kind, reversed for `,`. */
function repeatFindKind(editor: EditorState, key: ";" | ","): FindDirection | null {
  if (!editor.lastFind) return null;
  return key === ";" ? editor.lastFind.direction : reverseFindKind(editor.lastFind.direction);
}

/** A count before an operator multiplies the motion's (3dw, 2d3w, 3dd). */
function operatorMotionCount(editor: EditorState): number {
  return (editor.operatorCount ?? 1) * (editor.count ?? 1);
}

/** Character class for Vim's word motions: 0 blank, 1 punctuation, 2 word. */
function wordClass(ch: string | undefined, big: boolean): number {
  if (ch === undefined || isBufferSpace(ch)) return 0;
  if (big) return 2;
  return isWordChar(ch) ? 2 : isPunct(ch) ? 1 : 0;
}

/**
 * cw/cW on a non-blank — Vim changes to the end of the word, like ce/cE,
 * except the cursor's own word counts even when already on its last character.
 */
function changeWordEnd(buffer: string, cursor: number, count: number, big: boolean): number {
  const toWordEnd = big ? wordEndBig : wordEnd;
  const cls = wordClass(buffer[cursor], big);
  let end = wordClass(buffer[cursor + 1], big) === cls ? toWordEnd(buffer, cursor) : cursor;
  for (let i = 1; i < count; i++) end = toWordEnd(buffer, end);
  return end;
}

function applyOperatorMotion(editor: EditorState, operator: string, motionName: string, count: number): EditorAction {
  const buffer = editor.buffer;
  const cursor = editor.cursor;

  // j/k are linewise: operate on whole lines (dj, yk, 2cj).
  if (isVerticalMotion(motionName)) {
    const span = lineSpan(buffer, cursor, motionName === "line_down" ? count : -count);
    if (span.first === lineStartOf(buffer, cursor) && span.last === lineEndOf(buffer, cursor)) return "handled";
    return applyOperatorToLines(editor, operator, span.first, span.last);
  }

  const isWordForward = motionName === "word_forward" || motionName === "word_forward_big";
  if (operator === "change" && isWordForward && cursor < buffer.length && !isBufferSpace(buffer[cursor]!)) {
    const end = changeWordEnd(buffer, cursor, count, motionName === "word_forward_big");
    return applyOperatorToRange(editor, operator, cursor, nextGraphemeEnd(buffer, end));
  }

  // dl may reach the end of the line, unlike the normal-mode l motion.
  if (motionName === "char_right") {
    const le = lineEndOf(buffer, cursor);
    let target = cursor;
    for (let i = 0; i < count && target < le; i++) target = nextGraphemeEnd(buffer, target);
    return target === cursor ? "handled" : applyOperatorToRange(editor, operator, cursor, target);
  }

  let from = cursor;
  let target = cursor;
  for (let i = 0; i < count; i++) {
    from = target;
    target = resolveMotion(motionName, buffer, target);
  }
  if (target === cursor) return "handled";

  // An operated w/W whose last word ends its line stops at that line's end
  // rather than eating the line break (dw on a line's last word).
  if (isWordForward && buffer.slice(from, target).includes("\n")) {
    const le = lineEndOf(buffer, from);
    if (le > from) target = le;
  }

  const start = Math.min(cursor, target);
  let end = Math.max(cursor, target);
  // e/E are inclusive: the word's last character is part of the range.
  if (motionName === "word_end" || motionName === "word_end_big") end = nextGraphemeEnd(buffer, end);
  return applyOperatorToRange(editor, operator, start, end);
}

/** Apply an operator to whole lines [first line start, last line end]. */
function applyOperatorToLines(editor: EditorState, operator: string, first: number, last: number): EditorAction {
  switch (operator) {
    case "delete":
      applyBufferEdit(editor, deleteLines(editor.buffer, first, last));
      return "handled";
    case "change":
      applyBufferEdit(editor, changeLines(editor.buffer, first, last), "insert", true);
      return "handled";
    case "yank":
      copyToClipboard(linewiseText(editor.buffer, first, last), true);
      resetPending(editor);
      return "handled";
    default:
      resetPending(editor);
      return "handled";
  }
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
      cursor = Math.min(nextGraphemeEnd(editor.buffer, editor.cursor), lineEndOf(editor.buffer, editor.cursor));
      break;
    case "bol":
      cursor = firstNonBlank(editor.buffer, editor.cursor);
      break;
    case "eol":
      cursor = lineEndOf(editor.buffer, editor.cursor);
      break;
    default:
      break;
  }

  editor.cursor = clampInsertCursor(editor.buffer, cursor);
  resetCurswant(editor);
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
}

function executeStandalone(editor: EditorState, name: string, count: number): EditorAction {
  const { buffer, cursor } = editor;
  switch (name) {
    case "delete_char":
      applyEditIfChanged(editor, deleteChars(buffer, cursor, count));
      return "handled";
    case "delete_char_before":
      applyEditIfChanged(editor, deleteCharsBefore(buffer, cursor, count));
      return "handled";
    case "delete_line": {
      const span = lineSpan(buffer, cursor, count - 1);
      applyEditIfChanged(editor, deleteLines(buffer, span.first, span.last));
      return "handled";
    }
    case "change_line": {
      const span = lineSpan(buffer, cursor, count - 1);
      applyBufferEdit(editor, changeLines(buffer, span.first, span.last), "insert", true);
      return "handled";
    }
    case "delete_to_eol":
      applyEditIfChanged(editor, deleteToEnd(buffer, cursor, count));
      return "handled";
    case "change_to_eol":
      applyBufferEdit(editor, changeToEnd(buffer, cursor, count), "insert", true);
      return "handled";
    case "open_below":
      applyBufferEdit(editor, openLineBelow(buffer, cursor), "insert", true);
      return "handled";
    case "open_above":
      applyBufferEdit(editor, openLineAbove(buffer, cursor), "insert", true);
      return "handled";
    case "yank_line": {
      const span = lineSpan(buffer, cursor, count - 1);
      copyToClipboard(linewiseText(buffer, span.first, span.last), true);
      resetPending(editor);
      return "handled";
    }
    case "shift_right":
    case "shift_left": {
      // A count shifts that many lines once, not that many levels.
      const last = lineSpan(buffer, cursor, count - 1).last;
      applyEditIfChanged(editor, shiftLines(buffer, cursor, last, name === "shift_right" ? 1 : -1));
      return "handled";
    }
    case "swap_case":
      applyEditIfChanged(editor, swapCase(buffer, cursor, count));
      return "handled";
    case "paste_after":
      applyPasteCommand(editor, "after", count);
      return "handled";
    case "paste_before":
      applyPasteCommand(editor, "before", count);
      return "handled";
    case "undo":
      applyUndo(editor);
      return "handled";
    default:
      resetPending(editor);
      return "handled";
  }
}

function executeMotion(editor: EditorState, name: string, count: number, normalMode: boolean): void {
  if (isVerticalMotion(name)) {
    moveVerticalWithCurswant(editor, directionForVerticalMotion(name), count, true);
  } else {
    const target = motionTarget(editor.buffer, editor.cursor, name, count);
    editor.cursor = normalMode ? clampNormalCursor(editor.buffer, target) : target;
    resetCurswant(editor);
    // $ keeps later j/k at the end of each line.
    if (name === "line_end") editor.curswant = Number.POSITIVE_INFINITY;
  }
  resetPending(editor);
}

function executeVisualCommand(editor: EditorState, command: PromptCommand): EditorAction {
  switch (command.type) {
    case "motion":
      executeMotion(editor, command.name, editor.count ?? 1, false);
      return "handled";
    case "standalone": {
      const name = command.name;
      const anchor = editor.visualAnchor;
      const cursor = editor.cursor;
      resetPending(editor);

      if (name === "visual_swap_ends") {
        editor.visualAnchor = cursor;
        editor.cursor = anchor;
        resetCurswant(editor);
        return "handled";
      }

      if (name === "visual_shift_right" || name === "visual_shift_left") {
        const edit = shiftLines(editor.buffer, anchor, cursor, name === "visual_shift_right" ? 1 : -1);
        exitVisualMode(editor);
        applyEditIfChanged(editor, edit);
        return "handled";
      }

      const { start, endExclusive } = getVisualRange(editor.buffer, anchor, cursor, editor.mode);
      const linewise = editor.mode === "visual-line";
      const text = editor.buffer.slice(start, endExclusive);
      // A linewise register is always "\n"-terminated, even for the last line.
      const yankText = linewise && !text.endsWith("\n") ? text + "\n" : text;

      switch (name) {
        case "visual_yank":
          copyToClipboard(yankText, linewise);
          exitVisualMode(editor);
          return "handled";
        case "visual_delete":
          exitVisualMode(editor);
          applyBufferEdit(editor, deleteRange(editor.buffer, start, endExclusive));
          return "handled";
        case "visual_delete_yank":
          copyToClipboard(yankText, linewise);
          exitVisualMode(editor);
          applyBufferEdit(editor, deleteRange(editor.buffer, start, endExclusive));
          return "handled";
        case "visual_change": {
          // Like cc, V c keeps the trailing newline: an empty line remains.
          const end = linewise && endExclusive > start && editor.buffer[endExclusive - 1] === "\n"
            ? endExclusive - 1
            : endExclusive;
          applyBufferEdit(editor, deleteRange(editor.buffer, start, end), "insert", true);
          return "handled";
        }
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

/**
 * Bracketed paste: cleaned like any prompt text, then its own undo step.
 * Typing before a mid-insert paste is one step, the paste the next, and
 * typing after it starts a new insert session.
 */
function handlePaste(editor: EditorState, text: string): EditorAction {
  const cleaned = sanitizePromptTextForInsertion(text);
  if (!cleaned) return "handled";
  commitInsertSession(editor.undo, editor.buffer);
  pushUndo(editor.undo, editor.buffer, editor.cursor);
  replaceWithPaste(editor, cleaned);
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
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
      if (key.char) insertText(editor, sanitizePromptTextForInsertion(key.char));
      return "handled";
    case "tab":
      insertText(editor, PROMPT_TAB);
      return "handled";
    case "backspace": {
      const pos = clampInsertCursor(editor.buffer, editor.cursor);
      if (pos > 0) {
        const start = promptDeleteStart(editor.buffer, pos);
        editor.buffer = editor.buffer.slice(0, start) + editor.buffer.slice(pos);
        editor.cursor = start;
      }
      resetCurswant(editor);
      return "handled";
    }
    case "delete": {
      const pos = clampInsertCursor(editor.buffer, editor.cursor);
      if (pos < editor.buffer.length) {
        editor.buffer = editor.buffer.slice(0, pos) + editor.buffer.slice(promptDeleteEnd(editor.buffer, pos));
      }
      resetCurswant(editor);
      return "handled";
    }
    case "left":
      editor.cursor = previousGraphemeStart(editor.buffer, clampInsertCursor(editor.buffer, editor.cursor));
      resetCurswant(editor);
      return "handled";
    case "right":
      editor.cursor = nextGraphemeEnd(editor.buffer, clampInsertCursor(editor.buffer, editor.cursor));
      resetCurswant(editor);
      return "handled";
    case "home":
      editor.cursor = lineStartOf(editor.buffer, editor.cursor);
      resetCurswant(editor);
      return "handled";
    case "end":
      editor.cursor = lineEndOf(editor.buffer, editor.cursor);
      // Like Vim's <End>: later vertical moves stick to the end of each row.
      editor.curswant = Number.POSITIVE_INFINITY;
      return "handled";
    case "up":
      moveVerticalWithCurswant(editor, -1);
      return "handled";
    case "down":
      moveVerticalWithCurswant(editor, 1);
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

/** Digits 1-9 start a count; 0 only continues one (alone it is the line_start motion). */
function isCountKey(editor: EditorState, ks: string): boolean {
  return /^[1-9]$/.test(ks) || (ks === "0" && editor.count !== null);
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
    resetPending(editor);
    return "handled";
  }

  // A shift prefix requires the same second key, not a new find/count.
  if (isShiftPrefix(editor) && ks !== editor.pendingKeys) {
    resetPending(editor);
    return "handled";
  }

  if (editor.pendingFind) {
    if (key.type !== "char" || !key.char) {
      resetPending(editor);
      return "handled";
    }
    applyFindMotion(editor, editor.pendingFind, key.char, false);
    return "handled";
  }

  if (ks === "f" || ks === "F" || ks === "t" || ks === "T") {
    editor.pendingFind = ks;
    return "handled";
  }

  if (ks === ";" || ks === ",") {
    const kind = repeatFindKind(editor, ks);
    if (!kind || !editor.lastFind) {
      resetPending(editor);
      return "handled";
    }
    applyFindMotion(editor, kind, editor.lastFind.char, true);
    return "handled";
  }

  if (editor.pendingTextObjectModifier) {
    const modifier = editor.pendingTextObjectModifier;
    editor.pendingTextObjectModifier = null;
    if (isTextObjectKey(ks)) {
      const range = resolveTextObject(modifier, ks, editor.buffer, editor.cursor);
      if (range && range.start !== range.end) {
        editor.visualAnchor = range.start;
        editor.cursor = previousGraphemeStart(editor.buffer, range.end);
      }
    }
    return "handled";
  }

  if (isCountKey(editor, ks)) {
    editor.count = (editor.count ?? 0) * 10 + Number.parseInt(ks, 10);
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

  // Enter submits only when no command is half-typed: r<Enter> splits the
  // line like Vim, and any other pending command is cancelled.
  if (key.type === "enter") {
    const pending = hasPending(editor);
    const replace = editor.pendingReplace;
    resetPending(editor);
    if (replace) {
      const edit = replaceChar(editor.buffer, editor.cursor, "\n");
      if (edit.buffer !== editor.buffer) applyBufferEdit(editor, { buffer: edit.buffer, cursor: editor.cursor + 1 });
    }
    return pending ? "handled" : "submit";
  }

  // Other non-character keys cancel a half-typed command (d<BS> must not
  // leave d waiting, or delete a character).
  if (key.type !== "char" && hasPending(editor)) {
    resetPending(editor);
    return "handled";
  }

  if (key.type === "backspace") {
    if (editor.cursor > 0) {
      applyBufferEdit(editor, deleteRange(editor.buffer, previousGraphemeStart(editor.buffer, editor.cursor), editor.cursor));
    } else {
      resetPending(editor);
    }
    return "handled";
  }

  if (key.type === "delete") {
    if (editor.cursor < editor.buffer.length) {
      applyBufferEdit(editor, deleteRange(editor.buffer, editor.cursor, nextGraphemeEnd(editor.buffer, editor.cursor)));
    } else {
      resetPending(editor);
    }
    return "handled";
  }

  if (key.type === "escape") {
    resetPending(editor);
    return "handled";
  }

  const ks = keyString(key);
  if (ks === null) {
    resetPending(editor);
    return "handled";
  }

  // A shift prefix requires the same second key, not a new find/replace/count.
  if (isShiftPrefix(editor) && ks !== editor.pendingKeys) {
    resetPending(editor);
    return "handled";
  }

  if (editor.pendingFind) {
    if (key.type !== "char" || !key.char) {
      resetPending(editor);
      return "handled";
    }
    if (editor.pendingOperator) {
      return applyFindOperator(editor, editor.pendingFind, key.char, false);
    }
    applyFindMotion(editor, editor.pendingFind, key.char, false);
    return "handled";
  }

  if (editor.pendingReplace) {
    resetPending(editor);
    if (key.type === "char" && key.char) {
      applyEditIfChanged(editor, replaceChar(editor.buffer, editor.cursor, key.char));
    }
    return "handled";
  }

  if (isCountKey(editor, ks)) {
    editor.count = (editor.count ?? 0) * 10 + Number.parseInt(ks, 10);
    return "handled";
  }

  if (ks === "r" && !editor.pendingOperator) {
    editor.pendingReplace = true;
    return "handled";
  }

  if (ks === "f" || ks === "F" || ks === "t" || ks === "T") {
    editor.pendingFind = ks;
    return "handled";
  }

  if (ks === ";" || ks === ",") {
    const kind = repeatFindKind(editor, ks);
    if (!kind || !editor.lastFind) {
      resetPending(editor);
      return "handled";
    }
    if (editor.pendingOperator) {
      return applyFindOperator(editor, kind, editor.lastFind.char, true);
    }
    applyFindMotion(editor, kind, editor.lastFind.char, true);
    return "handled";
  }

  const fullKey = editor.pendingKeys + ks;

  if (editor.pendingOperator && ks === editor.pendingOperatorKey) {
    const doubled = lookupCommand(editor.mode, editor.pendingOperatorKey + ks);
    if (doubled) {
      const count = operatorMotionCount(editor);
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
      const count = operatorMotionCount(editor);
      resetPending(editor);
      return applyOperatorMotion(editor, operator, motionCommand.name, count);
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
        executeMotion(editor, command.name, count, true);
        return "handled";
      case "operator":
        editor.pendingOperator = command.name;
        editor.pendingOperatorKey = ks;
        editor.pendingKeys = "";
        editor.operatorCount = editor.count;
        editor.count = null;
        return "handled";
      case "mode_change":
        executeModeChange(editor, command.mode, command.cursor);
        return "handled";
      case "action":
        resetPending(editor);
        return command.action;
      case "standalone":
        resetPending(editor);
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
    curswant: null,
    scroll: 0,
    wrapWidth: null,
    mode,
    pendingKeys: "",
    pendingOperator: null,
    pendingOperatorKey: null,
    pendingTextObjectModifier: null,
    count: null,
    operatorCount: null,
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
  editor.curswant = null;
  editor.scroll = 0;
  editor.mode = mode;
  editor.pendingKeys = "";
  editor.pendingOperator = null;
  editor.pendingOperatorKey = null;
  editor.pendingTextObjectModifier = null;
  editor.count = null;
  editor.operatorCount = null;
  editor.visualAnchor = 0;
  editor.pendingFind = null;
  editor.lastFind = null;
  editor.pendingReplace = false;
  editor.undo = createUndoState();

  if (mode === "insert") {
    markInsertEntry(editor.undo, editor.buffer, editor.cursor);
  }
}

/**
 * Replace the prompt with `text` in insert mode, cursor at its end, keeping the
 * replaced draft one undo step away (Exocortex edit-confirm): `u` brings the
 * draft back, then the typing before it.
 */
export function replaceEditorText(editor: EditorState, text: string): void {
  if (editor.mode === "insert") commitInsertSession(editor.undo, editor.buffer);
  if (editor.buffer !== text) pushUndo(editor.undo, editor.buffer, editor.cursor);
  editor.buffer = text;
  editor.cursor = text.length;
  editor.curswant = null;
  editor.scroll = 0;
  editor.mode = "insert";
  resetPending(editor);
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
}

export function leaveInsertMode(editor: EditorState): void {
  if (editor.mode !== "insert") return;
  commitInsertSession(editor.undo, editor.buffer);
  editor.mode = "normal";
  resetPending(editor);

  let newCursor = editor.cursor;
  if (newCursor > 0 && editor.buffer[newCursor - 1] !== "\n") {
    newCursor = previousGraphemeStart(editor.buffer, newCursor);
  }
  editor.cursor = clampNormalCursor(editor.buffer, newCursor);
  resetCurswant(editor);
}

export function enterInsertMode(editor: EditorState, cursor: number): void {
  editor.mode = "insert";
  resetPending(editor);
  editor.cursor = clampInsertCursor(editor.buffer, cursor);
  resetCurswant(editor);
  markInsertEntry(editor.undo, editor.buffer, editor.cursor);
}

export function handleEditorKey(editor: EditorState, key: KeyEvent): EditorAction {
  if (key.type === "ctrl-c") return "quit";
  if (key.type === "paste") return handlePaste(editor, key.text ?? "");

  if (editor.mode === "insert") {
    return handleInsertKey(editor, key);
  }

  const motionKey = arrowKeyAsMotion(editor, key);
  if (editor.mode === "visual" || editor.mode === "visual-line") {
    return handleVisualKey(editor, motionKey);
  }

  return handleNormalKey(editor, motionKey);
}

export function displayCursor(editor: EditorState): number {
  return editor.mode === "insert"
    ? clampInsertCursor(editor.buffer, editor.cursor)
    : clampNormalCursor(editor.buffer, editor.cursor);
}
