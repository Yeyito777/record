/**
 * Prompt editor layout helpers.
 */

import type { EditorViewport, InputLinesResult } from "./editor-types";
import { nextWidthClusterEnd, sliceByWidth, sliceByWidthFrom, termWidth } from "./textwidth";

export const PROMPT_PREFIX_WIDTH = 4;
export const MAX_PROMPT_ROWS = 10;

/**
 * Rows the prompt may grow to, given the rows left for history and prompt:
 * up to MAX_PROMPT_ROWS, but never more than half of them, so a long draft on
 * a short terminal still leaves the conversation visible (like Exocortex).
 */
export function promptRowLimit(availableRows: number): number {
  return Math.max(1, Math.min(MAX_PROMPT_ROWS, Math.floor(availableRows / 2)));
}

interface WrappedChunk {
  text: string;
  start: number;
  end: number;
}

/** Split one logical line without dividing terminal-width clusters. */
function wrapLine(line: string, maxWidth: number): WrappedChunk[] {
  if (!line) return [{ text: "", start: 0, end: 0 }];

  const chunks: WrappedChunk[] = [];
  let start = 0;
  while (start < line.length) {
    const [fittingEnd] = sliceByWidthFrom(line, start, maxWidth);
    // A two-cell cluster cannot fit in a one-cell viewport. Consume it anyway
    // so layout always makes progress and keeps the cluster atomic.
    const end = fittingEnd > start
      ? fittingEnd
      : nextWidthClusterEnd(line, start);
    chunks.push({ text: line.slice(start, end), start, end });
    start = end;
  }
  return chunks;
}

export function getViewport(buffer: string, cursor: number, width: number, previousScroll = 0): EditorViewport {
  const safeWidth = Math.max(1, width);
  const safeCursor = Math.max(0, Math.min(cursor, buffer.length));
  let scroll = Math.max(0, Math.min(previousScroll, buffer.length));

  if (safeCursor < scroll) {
    scroll = safeCursor;
  }

  while (scroll < safeCursor && termWidth(buffer.slice(scroll, safeCursor)) >= safeWidth) {
    scroll = nextWidthClusterEnd(buffer, scroll);
  }

  const [text] = sliceByWidth(buffer.slice(scroll), safeWidth);

  return {
    text,
    cursorCol: termWidth(buffer.slice(scroll, safeCursor)),
    scroll,
  };
}

/** One hard-wrapped prompt row: buffer offsets [start, end), excluding "\n". */
export interface PromptRow {
  start: number;
  end: number;
}

/**
 * Hard-wrap the buffer into terminal-width display rows (vim-style, no word
 * boundaries) without splitting width clusters. Every logical line, including
 * an empty one, yields at least one row. Rendering and j/k share this model.
 */
export function promptDisplayRows(buffer: string, maxWidth: number): PromptRow[] {
  if (maxWidth < 1) maxWidth = 1;
  const rows: PromptRow[] = [];
  let lineStart = 0;

  for (const line of buffer.split("\n")) {
    for (const chunk of wrapLine(line, maxWidth)) {
      rows.push({ start: lineStart + chunk.start, end: lineStart + chunk.end });
    }
    lineStart += line.length + 1;
  }

  return rows;
}

/**
 * Row and display column of a buffer offset. A wrapped row's end offset is
 * also its continuation row's start; the continuation row wins. An insert
 * cursor just past a full-width line reports a column of `maxWidth`.
 */
export function promptCursorCell(buffer: string, rows: PromptRow[], pos: number): { row: number; col: number } {
  let row = 0;
  for (let i = 0; i < rows.length && rows[i]!.start <= pos; i++) {
    if (pos <= rows[i]!.end) row = i;
  }
  const rowStart = rows[row]!.start;
  return { row, col: termWidth(buffer.slice(rowStart, Math.max(rowStart, pos))) };
}

export function wrappedLineOffsets(buffer: string, maxWidth: number): number[] {
  return promptDisplayRows(buffer, maxWidth).map((row) => row.start);
}

export function getInputLines(
  buffer: string,
  cursorPos: number,
  maxWidth: number,
  maxRows: number,
  prevScrollOffset = 0,
): InputLinesResult {
  if (maxWidth < 1) maxWidth = 1;
  const rows = promptDisplayRows(buffer, maxWidth);
  const wrapped = rows.map((row) => buffer.slice(row.start, row.end));
  const lineStarts = rows.map((row) => row.start);
  const isNewLineArr = rows.map((row) => row.start > 0 && buffer[row.start - 1] === "\n");
  let { row: cursorWrappedLine, col: cursorColInLine } = promptCursorCell(buffer, rows, cursorPos);

  // Cursor at the right edge of a full-width line gets its own empty
  // continuation row, so it never overlaps the next line's first character.
  if (cursorColInLine >= maxWidth) {
    cursorWrappedLine++;
    cursorColInLine = 0;
    wrapped.splice(cursorWrappedLine, 0, "");
    lineStarts.splice(cursorWrappedLine, 0, cursorPos);
    isNewLineArr.splice(cursorWrappedLine, 0, false);
  }

  if (wrapped.length <= maxRows) {
    return {
      lines: wrapped,
      lineStarts,
      isNewLine: isNewLineArr,
      cursorLine: cursorWrappedLine,
      cursorCol: cursorColInLine,
      scrollOffset: 0,
    };
  }

  let scrollStart = Math.max(0, Math.min(prevScrollOffset, wrapped.length - maxRows));
  if (cursorWrappedLine < scrollStart) {
    scrollStart = cursorWrappedLine;
  } else if (cursorWrappedLine >= scrollStart + maxRows) {
    scrollStart = cursorWrappedLine - maxRows + 1;
  }

  return {
    lines: wrapped.slice(scrollStart, scrollStart + maxRows),
    lineStarts: lineStarts.slice(scrollStart, scrollStart + maxRows),
    isNewLine: isNewLineArr.slice(scrollStart, scrollStart + maxRows),
    cursorLine: cursorWrappedLine - scrollStart,
    cursorCol: cursorColInLine,
    scrollOffset: scrollStart,
  };
}
