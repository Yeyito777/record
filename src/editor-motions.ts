/**
 * Prompt editor motions.
 */

import { lineEndOf, lineStartOf, nextGraphemeEnd, previousGraphemeStart } from "./editor-buffer";
import { isBufferSpace, isPunct, isWordChar } from "./editor-chars";

function normalLineEnd(buffer: string, pos: number): number {
  const start = lineStartOf(buffer, pos);
  const end = lineEndOf(buffer, pos);
  return end > start ? previousGraphemeStart(buffer, end) : end;
}

export function charLeft(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  if (buffer[pos - 1] === "\n") return pos;
  return previousGraphemeStart(buffer, pos);
}

export function charRight(buffer: string, pos: number): number {
  if (pos >= buffer.length) return buffer.length;
  const next = nextGraphemeEnd(buffer, pos);
  return next > normalLineEnd(buffer, pos) ? pos : next;
}

export function wordForward(buffer: string, pos: number): number {
  const len = buffer.length;
  if (pos >= len) return pos;
  let i = pos;

  if (isWordChar(buffer[i])) {
    while (i < len && isWordChar(buffer[i])) i++;
  } else if (isPunct(buffer[i])) {
    while (i < len && isPunct(buffer[i])) i++;
  } else {
    i++;
  }

  while (i < len && isBufferSpace(buffer[i])) i++;
  return i;
}

export function wordBackward(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;

  while (i > 0 && isBufferSpace(buffer[i])) i--;

  if (isWordChar(buffer[i])) {
    while (i > 0 && isWordChar(buffer[i - 1])) i--;
  } else if (isPunct(buffer[i])) {
    while (i > 0 && isPunct(buffer[i - 1])) i--;
  }

  return Math.max(0, i);
}

export function wordEnd(buffer: string, pos: number): number {
  const len = buffer.length;
  if (len === 0) return 0;
  if (pos >= len - 1) return Math.max(0, len - 1);
  let i = pos + 1;

  while (i < len && isBufferSpace(buffer[i])) i++;

  if (i < len && isWordChar(buffer[i])) {
    while (i < len - 1 && isWordChar(buffer[i + 1])) i++;
  } else if (i < len && isPunct(buffer[i])) {
    while (i < len - 1 && isPunct(buffer[i + 1])) i++;
  }

  return i;
}

export function wordForwardBig(buffer: string, pos: number): number {
  const len = buffer.length;
  let i = pos;

  while (i < len && !isBufferSpace(buffer[i])) i++;
  while (i < len && isBufferSpace(buffer[i])) i++;
  return i;
}

export function wordBackwardBig(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;

  while (i > 0 && isBufferSpace(buffer[i])) i--;
  while (i > 0 && !isBufferSpace(buffer[i - 1])) i--;
  return Math.max(0, i);
}

export function wordEndBig(buffer: string, pos: number): number {
  const len = buffer.length;
  if (len === 0) return 0;
  if (pos >= len - 1) return Math.max(0, len - 1);
  let i = pos + 1;

  while (i < len && isBufferSpace(buffer[i])) i++;
  while (i < len - 1 && !isBufferSpace(buffer[i + 1])) i++;
  return i;
}

export function lineDown(buffer: string, pos: number): number {
  const ls = lineStartOf(buffer, pos);
  const col = pos - ls;
  const le = lineEndOf(buffer, pos);
  if (le >= buffer.length) return pos;
  const nextLs = le + 1;
  const nextLe = lineEndOf(buffer, nextLs);
  return nextLs + Math.min(col, nextLe - nextLs);
}

export function lineUp(buffer: string, pos: number): number {
  const ls = lineStartOf(buffer, pos);
  if (ls === 0) return pos;
  const col = pos - ls;
  const prevLe = ls - 1;
  const prevLs = lineStartOf(buffer, prevLe);
  return prevLs + Math.min(col, prevLe - prevLs);
}

export function bufferStart(): number {
  return 0;
}

export function bufferEnd(buffer: string): number {
  return buffer.length;
}

export function findForward(buffer: string, pos: number, char: string): number {
  const le = lineEndOf(buffer, pos);
  for (let i = pos + 1; i <= le; i++) {
    if (buffer[i] === char) return i;
  }
  return pos;
}

export function findBackward(buffer: string, pos: number, char: string): number {
  const ls = lineStartOf(buffer, pos);
  for (let i = pos - 1; i >= ls; i--) {
    if (buffer[i] === char) return i;
  }
  return pos;
}

export function resolveMotion(name: string, buffer: string, pos: number): number {
  switch (name) {
    case "char_left": return charLeft(buffer, pos);
    case "char_right": return charRight(buffer, pos);
    case "word_forward": return wordForward(buffer, pos);
    case "word_backward": return wordBackward(buffer, pos);
    case "word_end": return wordEnd(buffer, pos);
    case "word_forward_big": return wordForwardBig(buffer, pos);
    case "word_backward_big": return wordBackwardBig(buffer, pos);
    case "word_end_big": return wordEndBig(buffer, pos);
    case "line_start": return lineStartOf(buffer, pos);
    case "line_end": return lineEndOf(buffer, pos);
    case "line_down": return lineDown(buffer, pos);
    case "line_up": return lineUp(buffer, pos);
    case "buffer_start": return bufferStart();
    case "buffer_end": return bufferEnd(buffer);
    default: return pos;
  }
}
