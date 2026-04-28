/**
 * Prompt editor buffer-edit operations.
 */

import type { BufferEdit } from "./editor-types";
import { clampNormalCursor, lineEndOf, lineStartOf, nextGraphemeEnd, previousGraphemeStart } from "./editor-buffer";

export function deleteRange(buffer: string, start: number, end: number): BufferEdit {
  if (start > end) [start, end] = [end, start];
  const newBuffer = buffer.slice(0, start) + buffer.slice(end);
  return { buffer: newBuffer, cursor: Math.min(start, newBuffer.length) };
}

export function deleteLine(buffer: string, pos: number): BufferEdit {
  const ls = lineStartOf(buffer, pos);
  const le = lineEndOf(buffer, pos);
  let start = ls;
  let end = le;

  if (end < buffer.length) end++;
  else if (start > 0) start--;

  const newBuffer = buffer.slice(0, start) + buffer.slice(end);
  return { buffer: newBuffer, cursor: clampNormalCursor(newBuffer, start) };
}

export function changeLine(buffer: string, pos: number): BufferEdit {
  const ls = lineStartOf(buffer, pos);
  const le = lineEndOf(buffer, pos);
  return { buffer: buffer.slice(0, ls) + buffer.slice(le), cursor: ls };
}

export function deleteChar(buffer: string, pos: number): BufferEdit {
  if (pos >= buffer.length) return { buffer, cursor: pos };
  return deleteRange(buffer, pos, nextGraphemeEnd(buffer, pos));
}

export function deleteCharBefore(buffer: string, pos: number): BufferEdit {
  if (pos <= 0) return { buffer, cursor: 0 };
  return deleteRange(buffer, previousGraphemeStart(buffer, pos), pos);
}

export function deleteToEnd(buffer: string, pos: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  if (pos >= le) return { buffer, cursor: clampNormalCursor(buffer, Math.max(0, pos - 1)) };
  const edit = deleteRange(buffer, pos, le);
  edit.cursor = clampNormalCursor(edit.buffer, edit.cursor);
  return edit;
}

export function changeToEnd(buffer: string, pos: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  if (pos >= le) return { buffer, cursor: pos };
  return deleteRange(buffer, pos, le);
}

export function openLineBelow(buffer: string, pos: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  const newBuffer = buffer.slice(0, le) + "\n" + buffer.slice(le);
  return { buffer: newBuffer, cursor: le + 1 };
}

export function openLineAbove(buffer: string, pos: number): BufferEdit {
  const ls = lineStartOf(buffer, pos);
  const newBuffer = buffer.slice(0, ls) + "\n" + buffer.slice(ls);
  return { buffer: newBuffer, cursor: ls };
}

function toggleCase(text: string): string {
  let out = "";
  for (const ch of text) {
    out += ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  }
  return out;
}

export function swapCase(buffer: string, pos: number, count: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  const end = Math.min(pos + count, le);
  if (pos >= end) return { buffer, cursor: pos };
  const swapped = toggleCase(buffer.slice(pos, end));
  const newBuffer = buffer.slice(0, pos) + swapped + buffer.slice(end);
  return { buffer: newBuffer, cursor: clampNormalCursor(newBuffer, end) };
}

export function replaceChar(buffer: string, pos: number, ch: string): BufferEdit {
  if (pos >= buffer.length || buffer[pos] === "\n") return { buffer, cursor: pos };
  return { buffer: buffer.slice(0, pos) + ch + buffer.slice(nextGraphemeEnd(buffer, pos)), cursor: pos };
}

export function swapCaseRange(buffer: string, start: number, end: number): BufferEdit {
  if (start > end) [start, end] = [end, start];
  const swapped = toggleCase(buffer.slice(start, end));
  const newBuffer = buffer.slice(0, start) + swapped + buffer.slice(end);
  return { buffer: newBuffer, cursor: clampNormalCursor(newBuffer, start) };
}
