/**
 * Prompt editor text objects.
 */

import type { Range } from "./editor-types";
import { lineEndOf, lineStartOf } from "./editor-buffer";
import { isBufferSpace, isWORDChar, isWordChar } from "./editor-chars";

function innerWord(buffer: string, cursor: number): Range | null {
  if (buffer.length === 0) return null;
  const pos = Math.min(cursor, buffer.length - 1);
  const ch = buffer[pos];
  let start: number;
  let end: number;

  if (isWordChar(ch)) {
    start = pos;
    while (start > 0 && isWordChar(buffer[start - 1])) start--;
    end = pos;
    while (end < buffer.length - 1 && isWordChar(buffer[end + 1])) end++;
    return { start, end: end + 1 };
  }

  if (isBufferSpace(ch)) {
    start = pos;
    while (start > 0 && isBufferSpace(buffer[start - 1])) start--;
    end = pos;
    while (end < buffer.length - 1 && isBufferSpace(buffer[end + 1])) end++;
    return { start, end: end + 1 };
  }

  start = pos;
  while (start > 0 && !isWordChar(buffer[start - 1]) && !isBufferSpace(buffer[start - 1]) && buffer[start - 1] !== "\n") start--;
  end = pos;
  while (end < buffer.length - 1 && !isWordChar(buffer[end + 1]) && !isBufferSpace(buffer[end + 1]) && buffer[end + 1] !== "\n") end++;
  return { start, end: end + 1 };
}

function aWord(buffer: string, cursor: number): Range | null {
  const inner = innerWord(buffer, cursor);
  if (!inner) return null;
  let { start, end } = inner;

  if (end < buffer.length && isBufferSpace(buffer[end])) {
    while (end < buffer.length && isBufferSpace(buffer[end])) end++;
    return { start, end };
  }

  if (start > 0 && isBufferSpace(buffer[start - 1])) {
    while (start > 0 && isBufferSpace(buffer[start - 1])) start--;
  }

  return { start, end };
}

function innerWORD(buffer: string, cursor: number): Range | null {
  if (buffer.length === 0) return null;
  const pos = Math.min(cursor, buffer.length - 1);

  if (!isWORDChar(buffer[pos])) {
    let start = pos;
    while (start > 0 && !isWORDChar(buffer[start - 1])) start--;
    let end = pos;
    while (end < buffer.length - 1 && !isWORDChar(buffer[end + 1])) end++;
    return { start, end: end + 1 };
  }

  let start = pos;
  while (start > 0 && isWORDChar(buffer[start - 1])) start--;
  let end = pos;
  while (end < buffer.length - 1 && isWORDChar(buffer[end + 1])) end++;
  return { start, end: end + 1 };
}

function aWORD(buffer: string, cursor: number): Range | null {
  const inner = innerWORD(buffer, cursor);
  if (!inner) return null;
  let { start, end } = inner;

  if (end < buffer.length && isBufferSpace(buffer[end])) {
    while (end < buffer.length && isBufferSpace(buffer[end])) end++;
    return { start, end };
  }

  if (start > 0 && isBufferSpace(buffer[start - 1])) {
    while (start > 0 && isBufferSpace(buffer[start - 1])) start--;
  }

  return { start, end };
}

function findQuotePair(buffer: string, cursor: number, quote: string): { open: number; close: number } | null {
  const ls = lineStartOf(buffer, cursor);
  const le = lineEndOf(buffer, cursor);
  const positions: number[] = [];

  for (let i = ls; i < le; i++) {
    if (buffer[i] === quote && (i === ls || buffer[i - 1] !== "\\")) {
      positions.push(i);
    }
  }

  if (positions.length < 2) return null;

  for (let i = 0; i < positions.length - 1; i += 2) {
    const open = positions[i];
    const close = positions[i + 1];
    if (cursor >= open && cursor <= close) return { open, close };
  }

  for (let i = 0; i < positions.length - 1; i += 2) {
    const open = positions[i];
    const close = positions[i + 1];
    if (open > cursor) return { open, close };
  }

  return null;
}

function innerQuote(buffer: string, cursor: number, quote: string): Range | null {
  const pair = findQuotePair(buffer, cursor, quote);
  return pair ? { start: pair.open + 1, end: pair.close } : null;
}

function aQuote(buffer: string, cursor: number, quote: string): Range | null {
  const pair = findQuotePair(buffer, cursor, quote);
  return pair ? { start: pair.open, end: pair.close + 1 } : null;
}

function findMatchingClose(buffer: string, openPos: number, open: string, close: string): number | null {
  let depth = 0;
  for (let i = openPos + 1; i < buffer.length; i++) {
    if (buffer[i] === open) depth++;
    if (buffer[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

function findMatchingOpen(buffer: string, closePos: number, open: string, close: string): number | null {
  let depth = 0;
  for (let i = closePos - 1; i >= 0; i--) {
    if (buffer[i] === close) depth++;
    if (buffer[i] === open) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

function findMatchingPair(buffer: string, cursor: number, open: string, close: string): { openPos: number; closePos: number } | null {
  if (buffer[cursor] === open) {
    const closePos = findMatchingClose(buffer, cursor, open, close);
    if (closePos !== null) return { openPos: cursor, closePos };
  }

  if (buffer[cursor] === close) {
    const openPos = findMatchingOpen(buffer, cursor, open, close);
    if (openPos !== null) return { openPos, closePos: cursor };
  }

  let depth = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    if (buffer[i] === close) depth++;
    if (buffer[i] === open) {
      if (depth === 0) {
        const closePos = findMatchingClose(buffer, i, open, close);
        if (closePos !== null && closePos >= cursor) return { openPos: i, closePos };
      } else {
        depth--;
      }
    }
  }

  const le = lineEndOf(buffer, cursor);
  for (let i = cursor + 1; i < le; i++) {
    if (buffer[i] === open) {
      const closePos = findMatchingClose(buffer, i, open, close);
      if (closePos !== null) return { openPos: i, closePos };
    }
  }

  return null;
}

function innerPair(buffer: string, cursor: number, open: string, close: string): Range | null {
  const pair = findMatchingPair(buffer, cursor, open, close);
  return pair ? { start: pair.openPos + 1, end: pair.closePos } : null;
}

function aPair(buffer: string, cursor: number, open: string, close: string): Range | null {
  const pair = findMatchingPair(buffer, cursor, open, close);
  return pair ? { start: pair.openPos, end: pair.closePos + 1 } : null;
}

export function resolveTextObject(modifier: "i" | "a", key: string, buffer: string, cursor: number): Range | null {
  switch (key) {
    case "w": return modifier === "i" ? innerWord(buffer, cursor) : aWord(buffer, cursor);
    case "W": return modifier === "i" ? innerWORD(buffer, cursor) : aWORD(buffer, cursor);
    case '"': return modifier === "i" ? innerQuote(buffer, cursor, '"') : aQuote(buffer, cursor, '"');
    case "'": return modifier === "i" ? innerQuote(buffer, cursor, "'") : aQuote(buffer, cursor, "'");
    case "`": return modifier === "i" ? innerQuote(buffer, cursor, "`") : aQuote(buffer, cursor, "`");
    case "(":
    case ")":
    case "b":
      return modifier === "i" ? innerPair(buffer, cursor, "(", ")") : aPair(buffer, cursor, "(", ")");
    case "{":
    case "}":
    case "B":
      return modifier === "i" ? innerPair(buffer, cursor, "{", "}") : aPair(buffer, cursor, "{", "}");
    case "[":
    case "]":
      return modifier === "i" ? innerPair(buffer, cursor, "[", "]") : aPair(buffer, cursor, "[", "]");
    case "<":
    case ">":
      return modifier === "i" ? innerPair(buffer, cursor, "<", ">") : aPair(buffer, cursor, "<", ">");
    default:
      return null;
  }
}

export function isTextObjectKey(key: string): boolean {
  return /^[wW"'`(){}\[\]<>bB]$/.test(key);
}
