/**
 * Prompt editor motions.
 */

import { lineEndOf, lineStartOf, nextGraphemeEnd, previousGraphemeStart } from "./editor-buffer";
import { isBufferSpace, isPunct, isWordChar } from "./editor-chars";
import type { FindDirection } from "./editor-types";

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

/** True when `pos` is on an empty line, where Vim's w/W/b/B stop. */
function isEmptyLineAt(buffer: string, pos: number): boolean {
  return (pos === 0 || buffer[pos - 1] === "\n") && (pos === buffer.length || buffer[pos] === "\n");
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

  while (i < len && isBufferSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i++;
  return i;
}

export function wordBackward(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;

  while (i > 0 && isBufferSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i--;

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
  while (i < len && isBufferSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i++;
  return i;
}

export function wordBackwardBig(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;

  while (i > 0 && isBufferSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i--;
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

/** ^ — the first non-blank character of the current line. */
export function firstNonBlank(buffer: string, pos: number): number {
  const end = lineEndOf(buffer, pos);
  let i = lineStartOf(buffer, pos);
  while (i < end && (buffer[i] === " " || buffer[i] === "\t")) i++;
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

/** The opposite-direction find, for `,`. */
export function reverseFindKind(kind: FindDirection): FindDirection {
  return ({ f: "F", F: "f", t: "T", T: "t" } as const)[kind];
}

/**
 * f/F/t/T{char} — the next/previous `char` on the current line, or just
 * before/after it for t/T. Returns null when there is no match. A repeat
 * (; and ,) skips a t/T match right next to the cursor, so it can't get stuck.
 */
export function findChar(buffer: string, pos: number, char: string, kind: FindDirection, repeat = false): number | null {
  const till = kind === "t" || kind === "T";
  if (kind === "f" || kind === "t") {
    const end = lineEndOf(buffer, pos);
    let i = nextGraphemeEnd(buffer, pos);
    if (till && repeat && i < end) i = nextGraphemeEnd(buffer, i);
    for (; i < end; i = nextGraphemeEnd(buffer, i)) {
      if (buffer.startsWith(char, i)) return till ? previousGraphemeStart(buffer, i) : i;
    }
    return null;
  }

  const start = lineStartOf(buffer, pos);
  let i = pos;
  if (till && repeat && i > start) i = previousGraphemeStart(buffer, i);
  while (i > start) {
    i = previousGraphemeStart(buffer, i);
    if (buffer.startsWith(char, i)) return till ? nextGraphemeEnd(buffer, i) : i;
  }
  return null;
}

/** findChar repeated `count` times (2fx, 3;); null unless every repetition matches. */
export function findCharCount(
  buffer: string,
  pos: number,
  char: string,
  kind: FindDirection,
  count: number,
  repeat = false,
): number | null {
  let target: number | null = pos;
  for (let i = 0; i < count && target !== null; i++) {
    target = findChar(buffer, target, char, kind, repeat || i > 0);
  }
  return target;
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
    case "first_non_blank": return firstNonBlank(buffer, pos);
    case "line_end": return lineEndOf(buffer, pos);
    case "line_down": return lineDown(buffer, pos);
    case "line_up": return lineUp(buffer, pos);
    case "buffer_start": return bufferStart();
    case "buffer_end": return bufferEnd(buffer);
    default: return pos;
  }
}
