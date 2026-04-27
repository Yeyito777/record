/**
 * Chat history cursor, motions, and visual selection.
 *
 * Adapted from Exocortex TUI's history navigation behavior for record.
 */

import { copyToClipboard } from "./editor-clipboard";
import { isBufferSpace, isWORDChar, isWordChar } from "./editor-chars";
import { isTextObjectKey, resolveTextObject } from "./editor-textobjects";
import type { KeyEvent } from "./input";
import type { AppState } from "./state";
import type { TimelineMessageBound } from "./timeline";
import {
  ensureCursorRowVisibleInViewport,
  scrollByAmountWithCursorInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
} from "./vimscroll";

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^;]*;[^\x1b]*\x1b\\/g;

export interface HistoryCursor {
  row: number;
  col: number;
}

export function createHistoryCursor(): HistoryCursor {
  return { row: 0, col: 0 };
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function contentBounds(plain: string): { start: number; end: number } {
  let start = 0;
  while (start < plain.length && plain[start] === " ") start++;
  let end = plain.length - 1;
  while (end > start && plain[end] === " ") end--;
  if (start >= plain.length) {
    const pos = Math.max(0, plain.length);
    return { start: pos, end: pos };
  }
  return { start, end };
}

export function clampHistoryCol(col: number, lines: string[], row: number): number {
  const plain = stripAnsi(lines[row] ?? "");
  if (plain.length === 0) return 0;
  const { start, end } = contentBounds(plain);
  return Math.max(start, Math.min(col, end));
}

export function clampHistoryCursor(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (lines.length === 0) return { row: 0, col: 0 };
  const row = Math.max(0, Math.min(cursor.row, lines.length - 1));
  return { row, col: clampHistoryCol(cursor.col, lines, row) };
}

export function logicalLineRange(row: number, wrapContinuation: boolean[]): { first: number; last: number } {
  let first = row;
  while (first > 0 && wrapContinuation[first]) first--;
  let last = row;
  while (last < wrapContinuation.length - 1 && wrapContinuation[last + 1]) last++;
  return { first, last };
}

export function buildLineAnchorIndex(anchors: string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let row = 0; row < anchors.length; row++) {
    index.set(anchors[row], row);
  }
  return index;
}

export function remapRenderedRow(oldRow: number, oldAnchors: string[], newAnchorIndex: Map<string, number>): number {
  if (oldAnchors.length === 0) return 0;
  const clamped = Math.max(0, Math.min(oldRow, oldAnchors.length - 1));
  const exact = newAnchorIndex.get(oldAnchors[clamped]);
  if (exact !== undefined) return exact;

  for (let row = clamped + 1; row < oldAnchors.length; row++) {
    const mapped = newAnchorIndex.get(oldAnchors[row]);
    if (mapped !== undefined) return mapped;
  }
  for (let row = clamped - 1; row >= 0; row--) {
    const mapped = newAnchorIndex.get(oldAnchors[row]);
    if (mapped !== undefined) return mapped;
  }
  return 0;
}

export function placeHistoryCursorAtVisibleBottom(state: AppState, visibleRows: number): void {
  const lines = state.historyLines;
  if (lines.length === 0) {
    state.historyCursor = createHistoryCursor();
    return;
  }

  const row = Math.max(0, Math.min(state.timeline.scrollOffset + Math.max(0, visibleRows - 1), lines.length - 1));
  state.historyCursor = { row, col: clampHistoryCol(0, lines, row) };
}

export function ensureHistoryCursorVisible(state: AppState, visibleRows: number): void {
  const lines = state.historyLines;
  if (lines.length === 0) return;

  const cursor = clampHistoryCursor(state.historyCursor, lines);
  state.historyCursor = cursor;

  const next = ensureCursorRowVisibleInViewport({
    totalLines: lines.length,
    viewportHeight: visibleRows,
    viewStart: state.timeline.scrollOffset,
    cursorRow: cursor.row,
  });
  state.timeline.scrollOffset = next.viewStart;
}

export function shiftHistorySelection(state: AppState, deltaRows: number): void {
  if (deltaRows === 0) return;
  state.historyCursor = {
    ...state.historyCursor,
    row: Math.max(0, state.historyCursor.row + deltaRows),
  };
  state.historyVisualAnchor = {
    ...state.historyVisualAnchor,
    row: Math.max(0, state.historyVisualAnchor.row + deltaRows),
  };
}

export function scrollHistoryWithCursor(state: AppState, dir: number, amount: number, visibleRows: number): void {
  const lines = state.historyLines;
  if (lines.length === 0) return;

  const next = scrollByAmountWithCursorInViewport({
    totalLines: lines.length,
    viewportHeight: visibleRows,
    viewStart: state.timeline.scrollOffset,
    cursorRow: state.historyCursor.row,
  }, dir, amount);

  state.historyCursor = clampHistoryCursor({ row: next.cursorRow, col: state.historyCursor.col }, lines);
  state.timeline.scrollOffset = next.viewStart;
}

export function scrollHistoryPageWithCursor(state: AppState, dir: number, amount: number, visibleRows: number): void {
  const lines = state.historyLines;
  if (lines.length === 0) return;

  const next = scrollPageWithCursorInViewport({
    totalLines: lines.length,
    viewportHeight: visibleRows,
    viewStart: state.timeline.scrollOffset,
    cursorRow: state.historyCursor.row,
  }, dir, amount);

  state.historyCursor = clampHistoryCursor({ row: next.cursorRow, col: state.historyCursor.col }, lines);
  state.timeline.scrollOffset = next.viewStart;
}

export function scrollHistoryViewportSticky(state: AppState, dir: number, visibleRows: number): void {
  const lines = state.historyLines;
  if (lines.length === 0) return;

  const next = scrollLineWithStickyCursorInViewport({
    totalLines: lines.length,
    viewportHeight: visibleRows,
    viewStart: state.timeline.scrollOffset,
    cursorRow: state.historyCursor.row,
  }, dir);

  state.historyCursor = clampHistoryCursor({ row: next.cursorRow, col: state.historyCursor.col }, lines);
  state.timeline.scrollOffset = next.viewStart;
}

function charLeft(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { start } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: Math.max(start, cursor.col - 1) };
}

function charRight(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { end } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: Math.min(end, cursor.col + 1) };
}

function lineUp(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row <= 0) return cursor;
  const row = cursor.row - 1;
  return { row, col: clampHistoryCol(cursor.col, lines, row) };
}

function lineDown(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row >= lines.length - 1) return cursor;
  const row = cursor.row + 1;
  return { row, col: clampHistoryCol(cursor.col, lines, row) };
}

function lineStart(cursor: HistoryCursor, lines: string[], wrapContinuation?: boolean[]): HistoryCursor {
  const row = wrapContinuation ? logicalLineRange(cursor.row, wrapContinuation).first : cursor.row;
  return { row, col: contentBounds(stripAnsi(lines[row] ?? "")).start };
}

function lineEnd(cursor: HistoryCursor, lines: string[], wrapContinuation?: boolean[]): HistoryCursor {
  const row = wrapContinuation ? logicalLineRange(cursor.row, wrapContinuation).last : cursor.row;
  return { row, col: contentBounds(stripAnsi(lines[row] ?? "")).end };
}

function bufferStart(lines: string[]): HistoryCursor {
  return { row: 0, col: clampHistoryCol(0, lines, 0) };
}

function bufferEnd(lines: string[]): HistoryCursor {
  const row = Math.max(0, lines.length - 1);
  return { row, col: clampHistoryCol(0, lines, row) };
}

function wordForward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos <= end) {
    if (isWordChar(plain[pos] ?? "")) {
      while (pos <= end && isWordChar(plain[pos] ?? "")) pos++;
    } else if (!isBufferSpace(plain[pos] ?? "")) {
      while (pos <= end && !isWordChar(plain[pos] ?? "") && !isBufferSpace(plain[pos] ?? "")) pos++;
    }
    while (pos <= end && isBufferSpace(plain[pos] ?? "")) pos++;
  }

  if (pos > end) {
    for (let row = cursor.row + 1; row < lines.length; row++) {
      const bounds = contentBounds(stripAnsi(lines[row] ?? ""));
      if (bounds.end >= bounds.start) return { row, col: bounds.start };
    }
    return { row: cursor.row, col: end };
  }

  return { row: cursor.row, col: pos };
}

function wordBackward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { start } = contentBounds(plain);
  let pos = cursor.col;

  if (pos > start) {
    pos--;
    while (pos > start && isBufferSpace(plain[pos] ?? "")) pos--;
    if (isWordChar(plain[pos] ?? "")) {
      while (pos > start && isWordChar(plain[pos - 1] ?? "")) pos--;
    } else if (!isBufferSpace(plain[pos] ?? "")) {
      while (pos > start && !isWordChar(plain[pos - 1] ?? "") && !isBufferSpace(plain[pos - 1] ?? "")) pos--;
    }
    return { row: cursor.row, col: pos };
  }

  for (let row = cursor.row - 1; row >= 0; row--) {
    const bounds = contentBounds(stripAnsi(lines[row] ?? ""));
    if (bounds.end >= bounds.start) return { row, col: bounds.end };
  }
  return cursor;
}

function wordEnd(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos < end) {
    pos++;
    while (pos <= end && isBufferSpace(plain[pos] ?? "")) pos++;
    if (pos <= end) {
      if (isWordChar(plain[pos] ?? "")) {
        while (pos < end && isWordChar(plain[pos + 1] ?? "")) pos++;
      } else {
        while (pos < end && !isWordChar(plain[pos + 1] ?? "") && !isBufferSpace(plain[pos + 1] ?? "")) pos++;
      }
      return { row: cursor.row, col: pos };
    }
  }

  for (let row = cursor.row + 1; row < lines.length; row++) {
    const next = stripAnsi(lines[row] ?? "");
    const bounds = contentBounds(next);
    if (bounds.end >= bounds.start) {
      let col = bounds.start;
      if (isWordChar(next[col] ?? "")) {
        while (col < bounds.end && isWordChar(next[col + 1] ?? "")) col++;
      } else {
        while (col < bounds.end && !isWordChar(next[col + 1] ?? "") && !isBufferSpace(next[col + 1] ?? "")) col++;
      }
      return { row, col };
    }
  }

  return { row: cursor.row, col: end };
}

function wordForwardBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  while (pos <= end && isWORDChar(plain[pos] ?? "")) pos++;
  while (pos <= end && isBufferSpace(plain[pos] ?? "")) pos++;

  if (pos > end) {
    for (let row = cursor.row + 1; row < lines.length; row++) {
      const bounds = contentBounds(stripAnsi(lines[row] ?? ""));
      if (bounds.end >= bounds.start) return { row, col: bounds.start };
    }
    return { row: cursor.row, col: end };
  }

  return { row: cursor.row, col: pos };
}

function wordBackwardBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { start } = contentBounds(plain);
  let pos = cursor.col;

  if (pos > start) {
    pos--;
    while (pos > start && isBufferSpace(plain[pos] ?? "")) pos--;
    while (pos > start && isWORDChar(plain[pos - 1] ?? "")) pos--;
    return { row: cursor.row, col: pos };
  }

  for (let row = cursor.row - 1; row >= 0; row--) {
    const bounds = contentBounds(stripAnsi(lines[row] ?? ""));
    if (bounds.end >= bounds.start) return { row, col: bounds.end };
  }
  return cursor;
}

function wordEndBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos < end) {
    pos++;
    while (pos <= end && isBufferSpace(plain[pos] ?? "")) pos++;
    while (pos < end && isWORDChar(plain[pos + 1] ?? "")) pos++;
    if (pos <= end) return { row: cursor.row, col: pos };
  }

  for (let row = cursor.row + 1; row < lines.length; row++) {
    const next = stripAnsi(lines[row] ?? "");
    const bounds = contentBounds(next);
    if (bounds.end >= bounds.start) {
      let col = bounds.start;
      while (col < bounds.end && isWORDChar(next[col + 1] ?? "")) col++;
      return { row, col };
    }
  }

  return { row: cursor.row, col: end };
}

function findForward(cursor: HistoryCursor, lines: string[], char: string): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { end } = contentBounds(plain);
  for (let i = cursor.col + 1; i <= end; i++) {
    if (plain[i] === char) return { row: cursor.row, col: i };
  }
  return cursor;
}

function findBackward(cursor: HistoryCursor, lines: string[], char: string): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { start } = contentBounds(plain);
  for (let i = cursor.col - 1; i >= start; i--) {
    if (plain[i] === char) return { row: cursor.row, col: i };
  }
  return cursor;
}

function previousMessage(cursor: HistoryCursor, bounds: TimelineMessageBound[]): HistoryCursor {
  let target = -1;
  for (let i = bounds.length - 1; i >= 0; i--) {
    if (bounds[i].contentStart < cursor.row) {
      target = i;
      break;
    }
  }
  return target >= 0 ? { row: bounds[target].contentStart, col: 0 } : cursor;
}

function nextMessage(cursor: HistoryCursor, bounds: TimelineMessageBound[], lines: string[]): HistoryCursor {
  let target = -1;
  for (let i = 0; i < bounds.length; i++) {
    if (bounds[i].contentStart > cursor.row) {
      target = i;
      break;
    }
  }
  if (target >= 0) {
    return { row: bounds[target].contentStart, col: 0 };
  }

  const last = bounds[bounds.length - 1];
  if (last && cursor.row >= last.contentStart && cursor.row < last.contentEnd) {
    return bufferEnd(lines);
  }
  return cursor;
}

function resetHistoryPending(state: AppState): void {
  state.editor.pendingKeys = "";
  state.editor.pendingOperator = null;
  state.editor.pendingOperatorKey = null;
  state.editor.pendingTextObjectModifier = null;
  state.editor.count = null;
  state.editor.pendingFind = null;
  state.editor.pendingReplace = false;
}

function isVisualMode(state: AppState): boolean {
  return state.editor.mode === "visual" || state.editor.mode === "visual-line";
}

function normalizeSelection(anchor: HistoryCursor, cursor: HistoryCursor): { start: HistoryCursor; end: HistoryCursor } {
  const forward = anchor.row < cursor.row || (anchor.row === cursor.row && anchor.col <= cursor.col);
  return { start: forward ? anchor : cursor, end: forward ? cursor : anchor };
}

export function getHistoryVisualSelection(state: AppState): string {
  const { start, end } = normalizeSelection(state.historyVisualAnchor, state.historyCursor);
  const lines = state.historyLines;

  if (state.editor.mode === "visual-line") {
    const first = logicalLineRange(start.row, state.historyWrapContinuation).first;
    const last = logicalLineRange(end.row, state.historyWrapContinuation).last;
    const parts: string[] = [];
    for (let row = first; row <= last; row++) {
      parts.push(stripAnsi(lines[row] ?? "").trimEnd());
    }
    return parts.join("\n");
  }

  if (start.row === end.row) {
    return stripAnsi(lines[start.row] ?? "").slice(start.col, end.col + 1);
  }

  const parts: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    const plain = stripAnsi(lines[row] ?? "");
    const bounds = contentBounds(plain);
    const sliceStart = row === start.row ? start.col : bounds.start;
    const sliceEnd = row === end.row ? end.col + 1 : bounds.end + 1;
    const text = plain.slice(sliceStart, sliceEnd);
    if (row === start.row || !state.historyWrapContinuation[row]) {
      parts.push(text);
    } else if (text) {
      parts[parts.length - 1] += ` ${text}`;
    }
  }

  return parts.join("\n");
}

function copyHistorySelection(state: AppState): void {
  const text = getHistoryVisualSelection(state);
  if (text) copyToClipboard(text);
}

type HistoryRange = { start: HistoryCursor; end: HistoryCursor };
type FlatHistoryPosition = { row: number; col: number };

function flattenHistoryLines(state: AppState): { text: string; positions: FlatHistoryPosition[]; cursorIndex: number } {
  let text = "";
  const positions: FlatHistoryPosition[] = [];
  let cursorIndex = 0;

  for (let row = 0; row < state.historyLines.length; row++) {
    const plain = stripAnsi(state.historyLines[row] ?? "");
    for (let col = 0; col < plain.length; col++) {
      if (row === state.historyCursor.row && col === state.historyCursor.col) {
        cursorIndex = text.length;
      }
      text += plain[col];
      positions.push({ row, col });
    }
    if (row === state.historyCursor.row && state.historyCursor.col >= plain.length) {
      cursorIndex = Math.max(0, text.length - 1);
    }
    if (row < state.historyLines.length - 1) {
      const endCol = Math.max(0, plain.length - 1);
      text += "\n";
      positions.push({ row, col: endCol });
    }
  }

  return { text, positions, cursorIndex };
}

function rangeFromFlatIndexes(positions: FlatHistoryPosition[], start: number, endExclusive: number): HistoryRange | null {
  if (positions.length === 0 || start >= endExclusive) return null;
  const startPos = positions[Math.max(0, Math.min(start, positions.length - 1))];
  let endIndex = Math.max(start, Math.min(endExclusive - 1, positions.length - 1));
  while (endIndex > start && positions[endIndex].row !== positions[endIndex - 1].row && positions[endIndex].col === 0) {
    endIndex--;
  }
  const endPos = positions[endIndex];
  return { start: startPos, end: endPos };
}

function findMessageBoundsAtCursor(state: AppState): TimelineMessageBound | null {
  const row = state.historyCursor.row;
  return state.historyMessageBounds.find((bounds) => row >= bounds.start && row < bounds.end) ?? null;
}

function rowsToHistoryRange(state: AppState, startRow: number, endRowExclusive: number, trimBlankEdges: boolean): HistoryRange | null {
  const lines = state.historyLines;
  let start = startRow;
  let end = endRowExclusive;

  if (trimBlankEdges) {
    while (start < end && stripAnsi(lines[start] ?? "").trim() === "") start++;
    while (end > start && stripAnsi(lines[end - 1] ?? "").trim() === "") end--;
  }

  if (start >= end) return null;
  const startBounds = contentBounds(stripAnsi(lines[start] ?? ""));
  const endBounds = contentBounds(stripAnsi(lines[end - 1] ?? ""));
  return {
    start: { row: start, col: startBounds.start },
    end: { row: end - 1, col: endBounds.end },
  };
}

function resolveMessageTextRange(state: AppState): HistoryRange | null {
  const bounds = findMessageBoundsAtCursor(state);
  if (!bounds) return null;

  const contentRows = state.historyLineAnchors
    .map((anchor, row) => ({ anchor, row }))
    .filter(({ anchor, row }) => row >= bounds.start
      && row < bounds.end
      && anchor.startsWith(`msg:${bounds.messageId}:content:`))
    .map(({ row }) => row);

  if (contentRows.length > 0) {
    return rowsToHistoryRange(state, contentRows[0], contentRows[contentRows.length - 1] + 1, true);
  }

  return rowsToHistoryRange(state, bounds.contentStart, bounds.contentEnd, true);
}

function resolveFullMessageRange(state: AppState): HistoryRange | null {
  const bounds = findMessageBoundsAtCursor(state);
  if (!bounds) return null;
  return rowsToHistoryRange(state, bounds.start, bounds.end, false);
}

function resolveHistoryTextObject(state: AppState, modifier: "i" | "a", key: string): HistoryRange | null {
  if (key === "m") return resolveMessageTextRange(state);
  if (key === "M") return resolveFullMessageRange(state);
  if (!isTextObjectKey(key)) return null;

  const flat = flattenHistoryLines(state);
  const range = resolveTextObject(modifier, key, flat.text, flat.cursorIndex);
  if (!range) return null;
  return rangeFromFlatIndexes(flat.positions, range.start, range.end);
}

function selectHistoryTextObject(state: AppState, modifier: "i" | "a", key: string, visibleRows: number): boolean {
  const range = resolveHistoryTextObject(state, modifier, key);
  resetHistoryPending(state);
  if (!range) return true;

  state.historyVisualAnchor = range.start;
  state.historyCursor = range.end;
  if (state.editor.mode !== "visual-line") state.editor.mode = "visual";
  ensureHistoryCursorVisible(state, visibleRows);
  return true;
}

function historyRangeToText(state: AppState, range: HistoryRange): string {
  const previousAnchor = state.historyVisualAnchor;
  const previousCursor = state.historyCursor;
  const previousMode = state.editor.mode;
  state.historyVisualAnchor = range.start;
  state.historyCursor = range.end;
  state.editor.mode = "visual";
  const text = getHistoryVisualSelection(state);
  state.historyVisualAnchor = previousAnchor;
  state.historyCursor = previousCursor;
  state.editor.mode = previousMode;
  return text;
}

function yankHistoryTextObject(state: AppState, modifier: "i" | "a", key: string): boolean {
  const range = resolveHistoryTextObject(state, modifier, key);
  resetHistoryPending(state);
  if (!range) return true;

  const text = historyRangeToText(state, range);
  if (text) copyToClipboard(text);
  return true;
}

function applyMotion(name: string, state: AppState): boolean {
  const lines = state.historyLines;
  const wrapContinuation = state.historyWrapContinuation;
  const bounds = state.historyMessageBounds;
  const cursor = state.historyCursor;

  switch (name) {
    case "char_left":
      state.historyCursor = charLeft(cursor, lines);
      return true;
    case "char_right":
      state.historyCursor = charRight(cursor, lines);
      return true;
    case "line_up":
      state.historyCursor = lineUp(cursor, lines);
      return true;
    case "line_down":
      state.historyCursor = lineDown(cursor, lines);
      return true;
    case "word_forward":
      state.historyCursor = wordForward(cursor, lines);
      return true;
    case "word_backward":
      state.historyCursor = wordBackward(cursor, lines);
      return true;
    case "word_end":
      state.historyCursor = wordEnd(cursor, lines);
      return true;
    case "word_forward_big":
      state.historyCursor = wordForwardBig(cursor, lines);
      return true;
    case "word_backward_big":
      state.historyCursor = wordBackwardBig(cursor, lines);
      return true;
    case "word_end_big":
      state.historyCursor = wordEndBig(cursor, lines);
      return true;
    case "line_start":
      state.historyCursor = lineStart(cursor, lines, wrapContinuation);
      return true;
    case "line_end":
      state.historyCursor = lineEnd(cursor, lines, wrapContinuation);
      return true;
    case "buffer_start":
      state.historyCursor = bufferStart(lines);
      return true;
    case "buffer_end":
      state.historyCursor = bufferEnd(lines);
      return true;
    case "prev_message":
      if (bounds.length > 0) state.historyCursor = previousMessage(cursor, bounds);
      return true;
    case "next_message":
      if (bounds.length > 0) state.historyCursor = nextMessage(cursor, bounds, lines);
      return true;
    default:
      return false;
  }
}

const HISTORY_KEYMAP: Record<string, string> = {
  h: "char_left",
  l: "char_right",
  j: "line_down",
  k: "line_up",
  w: "word_forward",
  b: "word_backward",
  e: "word_end",
  W: "word_forward_big",
  B: "word_backward_big",
  E: "word_end_big",
  "0": "line_start",
  $: "line_end",
  gg: "buffer_start",
  G: "buffer_end",
  "{": "prev_message",
  "}": "next_message",
};

export function handleHistoryVimKey(state: AppState, key: KeyEvent, visibleRows: number): boolean {
  const lines = state.historyLines;
  if (lines.length === 0) {
    if (key.type === "escape" && isVisualMode(state)) {
      state.editor.mode = "normal";
      return true;
    }
    return false;
  }

  if (state.editor.pendingFind) {
    if (key.type !== "char" || !key.char) {
      state.editor.pendingFind = null;
      return true;
    }
    const direction = state.editor.pendingFind;
    state.editor.lastFind = { char: key.char, direction };
    state.editor.pendingFind = null;
    state.historyCursor = direction === "f"
      ? findForward(state.historyCursor, lines, key.char)
      : findBackward(state.historyCursor, lines, key.char);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }

  if (key.type === "char" && (key.char === "f" || key.char === "F")) {
    state.editor.pendingFind = key.char;
    return true;
  }

  if (key.type === "char" && (key.char === ";" || key.char === ",")) {
    const lastFind = state.editor.lastFind;
    if (!lastFind) return true;
    const direction = key.char === ";"
      ? lastFind.direction
      : (lastFind.direction === "f" ? "F" : "f");
    state.historyCursor = direction === "f"
      ? findForward(state.historyCursor, lines, lastFind.char)
      : findBackward(state.historyCursor, lines, lastFind.char);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }

  if (key.type === "left") {
    state.historyCursor = charLeft(state.historyCursor, lines);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }
  if (key.type === "right") {
    state.historyCursor = charRight(state.historyCursor, lines);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }
  if (key.type === "up") {
    state.historyCursor = lineUp(state.historyCursor, lines);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }
  if (key.type === "down") {
    state.historyCursor = lineDown(state.historyCursor, lines);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }
  if (key.type === "home") {
    state.historyCursor = lineStart(state.historyCursor, lines, state.historyWrapContinuation);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }
  if (key.type === "end") {
    state.historyCursor = lineEnd(state.historyCursor, lines, state.historyWrapContinuation);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }

  if (key.type === "escape") {
    if (isVisualMode(state)) {
      state.editor.mode = "normal";
      resetHistoryPending(state);
      return true;
    }
    resetHistoryPending(state);
    return true;
  }

  if (key.type !== "char" || !key.char) {
    return false;
  }

  if (isVisualMode(state)) {
    if (state.editor.pendingTextObjectModifier) {
      return selectHistoryTextObject(state, state.editor.pendingTextObjectModifier, key.char, visibleRows);
    }

    if (key.char === "i" || key.char === "a") {
      state.editor.pendingTextObjectModifier = key.char;
      return true;
    }

    if ((key.char === "v" && state.editor.mode === "visual") || (key.char === "V" && state.editor.mode === "visual-line")) {
      state.editor.mode = "normal";
      resetHistoryPending(state);
      return true;
    }
    if (key.char === "V" && state.editor.mode === "visual") {
      state.editor.mode = "visual-line";
      return true;
    }
    if (key.char === "v" && state.editor.mode === "visual-line") {
      state.editor.mode = "visual";
      return true;
    }
    if (key.char === "y") {
      copyHistorySelection(state);
      state.editor.mode = "normal";
      resetHistoryPending(state);
      return true;
    }
  } else {
    if (state.editor.pendingOperator === "yank") {
      if (state.editor.pendingTextObjectModifier) {
        return yankHistoryTextObject(state, state.editor.pendingTextObjectModifier, key.char);
      }
      if (key.char === "i" || key.char === "a") {
        state.editor.pendingTextObjectModifier = key.char;
        return true;
      }
      if (key.char === "y") {
        const plain = stripAnsi(lines[state.historyCursor.row] ?? "").trimEnd();
        if (plain) copyToClipboard(plain);
        resetHistoryPending(state);
        return true;
      }
      resetHistoryPending(state);
      return true;
    }

    if (key.char === "v") {
      state.editor.mode = "visual";
      state.historyVisualAnchor = { ...state.historyCursor };
      resetHistoryPending(state);
      return true;
    }
    if (key.char === "V") {
      state.editor.mode = "visual-line";
      state.historyVisualAnchor = { ...state.historyCursor };
      resetHistoryPending(state);
      return true;
    }
    if (key.char === "y") {
      state.editor.pendingOperator = "yank";
      state.editor.pendingOperatorKey = "y";
      state.editor.pendingKeys = "y";
      return true;
    }
  }

  const pending = state.editor.pendingKeys + key.char;
  if (HISTORY_KEYMAP[pending]) {
    applyMotion(HISTORY_KEYMAP[pending], state);
    resetHistoryPending(state);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }

  const isPrefix = pending === "g" || pending === "y";
  if (isPrefix) {
    state.editor.pendingKeys = pending;
    return true;
  }

  resetHistoryPending(state);
  const single = key.char;
  if (HISTORY_KEYMAP[single]) {
    applyMotion(HISTORY_KEYMAP[single], state);
    ensureHistoryCursorVisible(state, visibleRows);
    return true;
  }

  return false;
}
