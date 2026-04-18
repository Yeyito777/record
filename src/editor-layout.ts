/**
 * Prompt editor layout helpers.
 */

import type { EditorViewport, InputLinesResult } from "./editor-types";

export const PROMPT_PREFIX_WIDTH = 4;
export const MAX_PROMPT_ROWS = 8;

export function getViewport(buffer: string, cursor: number, width: number, previousScroll = 0): EditorViewport {
  const safeWidth = Math.max(1, width);
  let scroll = Math.max(0, previousScroll);

  if (cursor < scroll) {
    scroll = cursor;
  } else if (cursor >= scroll + safeWidth) {
    scroll = cursor - safeWidth + 1;
  }

  const maxScroll = Math.max(0, Math.max(buffer.length - safeWidth, cursor - safeWidth + 1));
  scroll = Math.max(0, Math.min(scroll, maxScroll));

  return {
    text: buffer.slice(scroll, scroll + safeWidth),
    cursorCol: Math.max(0, cursor - scroll),
    scroll,
  };
}

export function wrappedLineOffsets(buffer: string, maxWidth: number): number[] {
  if (maxWidth < 1) maxWidth = 1;
  const offsets: number[] = [];
  const lines = buffer.split("\n");
  let pos = 0;

  for (const line of lines) {
    if (line.length <= maxWidth) {
      offsets.push(pos);
    } else {
      for (let i = 0; i < line.length; i += maxWidth) {
        offsets.push(pos + i);
      }
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

    if (line.length <= maxWidth) {
      if (cursorPos >= bufOffset && cursorPos <= bufOffset + line.length) {
        cursorWrappedLine = wrapped.length;
        cursorColInLine = cursorPos - bufOffset;
      }
      wrapped.push(line);
      isNewLineArr.push(li > 0);
    } else {
      for (let i = 0; i < line.length; i += maxWidth) {
        const chunk = line.slice(i, i + maxWidth);
        const chunkStart = bufOffset + i;
        const chunkEnd = chunkStart + chunk.length;
        if (cursorPos >= chunkStart && cursorPos <= chunkEnd) {
          cursorWrappedLine = wrapped.length;
          cursorColInLine = cursorPos - chunkStart;
        }
        wrapped.push(chunk);
        isNewLineArr.push(li > 0 && i === 0);
      }
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
