/**
 * Prompt editor layout helpers.
 */

import type { EditorViewport, InputLinesResult } from "./editor-types";
import { nextWidthClusterEnd, sliceByWidth, termWidth } from "./textwidth";

export const PROMPT_PREFIX_WIDTH = 4;
export const MAX_PROMPT_ROWS = 8;

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
    const [fitting] = sliceByWidth(line.slice(start), maxWidth);
    // A two-cell cluster cannot fit in a one-cell viewport. Consume it anyway
    // so layout always makes progress and keeps the cluster atomic.
    const end = fitting.length > 0
      ? start + fitting.length
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

export function wrappedLineOffsets(buffer: string, maxWidth: number): number[] {
  if (maxWidth < 1) maxWidth = 1;
  const offsets: number[] = [];
  const lines = buffer.split("\n");
  let pos = 0;

  for (const line of lines) {
    for (const chunk of wrapLine(line, maxWidth)) {
      offsets.push(pos + chunk.start);
    }
    pos += line.length + 1;
  }

  return offsets;
}

export function getInputLines(
  buffer: string,
  cursorPos: number,
  maxWidth: number,
  maxRows: number,
  prevScrollOffset = 0,
): InputLinesResult {
  if (maxWidth < 1) maxWidth = 1;
  const bufferLines = buffer.split("\n");
  const wrapped: string[] = [];
  const isNewLineArr: boolean[] = [];

  let cursorWrappedLine = 0;
  let cursorColInLine = 0;
  let bufOffset = 0;

  for (let li = 0; li < bufferLines.length; li++) {
    const line = bufferLines[li];

    const chunks = wrapLine(line, maxWidth);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex]!;
      const chunkStart = bufOffset + chunk.start;
      const chunkEnd = bufOffset + chunk.end;
      if (cursorPos >= chunkStart && cursorPos <= chunkEnd) {
        cursorWrappedLine = wrapped.length;
        const cursorInChunk = Math.max(0, Math.min(cursorPos - chunkStart, chunk.text.length));
        cursorColInLine = termWidth(chunk.text.slice(0, cursorInChunk));
      }
      wrapped.push(chunk.text);
      isNewLineArr.push(li > 0 && chunkIndex === 0);
    }

    bufOffset += line.length + 1;
  }

  if (wrapped.length === 0) {
    wrapped.push("");
    isNewLineArr.push(false);
  }

  if (cursorColInLine >= maxWidth) {
    cursorWrappedLine++;
    cursorColInLine = 0;
    if (cursorWrappedLine >= wrapped.length) {
      wrapped.splice(cursorWrappedLine, 0, "");
      isNewLineArr.splice(cursorWrappedLine, 0, false);
    }
  }

  if (wrapped.length <= maxRows) {
    return {
      lines: wrapped,
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
    isNewLine: isNewLineArr.slice(scrollStart, scrollStart + maxRows),
    cursorLine: cursorWrappedLine - scrollStart,
    cursorCol: cursorColInLine,
    scrollOffset: scrollStart,
  };
}
