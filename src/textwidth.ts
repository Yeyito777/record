/**
 * Terminal-width-aware text helpers.
 *
 * These helpers count terminal columns rather than UTF-16 code units, so UI
 * layout can safely truncate and pad strings containing emoji, CJK, combining
 * marks, and other wide / zero-width glyphs.
 */

const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115F],
  [0x231A, 0x231B],
  [0x2329, 0x232A],
  [0x23E9, 0x23EC],
  [0x23F0, 0x23F0],
  [0x23F3, 0x23F3],
  [0x25FD, 0x25FE],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267F, 0x267F],
  [0x2693, 0x2693],
  [0x26A1, 0x26A1],
  [0x26AA, 0x26AB],
  [0x26BD, 0x26BE],
  [0x26C4, 0x26C5],
  [0x26CE, 0x26CE],
  [0x26D4, 0x26D4],
  [0x26EA, 0x26EA],
  [0x26F2, 0x26F3],
  [0x26F5, 0x26F5],
  [0x26FA, 0x26FA],
  [0x26FD, 0x26FD],
  [0x2705, 0x2705],
  [0x270A, 0x270B],
  [0x2728, 0x2728],
  [0x274C, 0x274C],
  [0x274E, 0x274E],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27B0, 0x27B0],
  [0x27BF, 0x27BF],
  [0x2B1B, 0x2B1C],
  [0x2B50, 0x2B50],
  [0x2B55, 0x2B55],
  [0x2E80, 0x9FFF],
  [0xA000, 0xA4CF],
  [0xAC00, 0xD7AF],
  [0xF900, 0xFAFF],
  [0xFE10, 0xFE19],
  [0xFE30, 0xFE6F],
  [0xFF01, 0xFF60],
  [0xFFE0, 0xFFE6],
  [0x1F004, 0x1F004],
  [0x1F0CF, 0x1F0CF],
  [0x1F18E, 0x1F18E],
  [0x1F191, 0x1F19A],
  [0x1F201, 0x1F202],
  [0x1F21A, 0x1F21A],
  [0x1F22F, 0x1F22F],
  [0x1F232, 0x1F23A],
  [0x1F250, 0x1F251],
  [0x1F300, 0x1F320],
  [0x1F32D, 0x1F335],
  [0x1F337, 0x1F37C],
  [0x1F37E, 0x1F393],
  [0x1F3A0, 0x1F3CA],
  [0x1F3CF, 0x1F3D3],
  [0x1F3E0, 0x1F3F0],
  [0x1F3F4, 0x1F3F4],
  [0x1F3F8, 0x1F43E],
  [0x1F440, 0x1F440],
  [0x1F442, 0x1F4FC],
  [0x1F4FF, 0x1F53D],
  [0x1F54B, 0x1F54E],
  [0x1F550, 0x1F567],
  [0x1F57A, 0x1F57A],
  [0x1F595, 0x1F596],
  [0x1F5A4, 0x1F5A4],
  [0x1F5FB, 0x1F64F],
  [0x1F680, 0x1F6C5],
  [0x1F6CC, 0x1F6CC],
  [0x1F6D0, 0x1F6D2],
  [0x1F6D5, 0x1F6D7],
  [0x1F6DD, 0x1F6DF],
  [0x1F6EB, 0x1F6EC],
  [0x1F6F4, 0x1F6FC],
  [0x1F7E0, 0x1F7EB],
  [0x1F7F0, 0x1F7F0],
  [0x1F90C, 0x1F93A],
  [0x1F93C, 0x1F945],
  [0x1F947, 0x1F9FF],
  [0x1FA70, 0x1FA74],
  [0x1FA78, 0x1FA7C],
  [0x1FA80, 0x1FA86],
  [0x1FA90, 0x1FAAC],
  [0x1FAB0, 0x1FABA],
  [0x1FAC0, 0x1FAC5],
  [0x1FAD0, 0x1FAD9],
  [0x1FAE0, 0x1FAE7],
  [0x1FAF0, 0x1FAF6],
  [0x20000, 0x3FFFF],
];

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;
const ANSI_RESET = "\x1b[0m";

function inRanges(cp: number, ranges: readonly [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }

  return false;
}

function isZeroWidth(cp: number): boolean {
  if (cp >= 0x200B && cp <= 0x200F) return true;
  if (cp >= 0x2028 && cp <= 0x202E) return true;
  if (cp >= 0x2060 && cp <= 0x2069) return true;
  if (cp === 0xFEFF || cp === 0x00AD) return true;
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
  if (cp >= 0x0300 && cp <= 0x036F) return true;
  if (cp >= 0x1AB0 && cp <= 0x1AFF) return true;
  if (cp >= 0x1DC0 && cp <= 0x1DFF) return true;
  if (cp >= 0x20D0 && cp <= 0x20FF) return true;
  if (cp >= 0xFE20 && cp <= 0xFE2F) return true;
  return false;
}

function isTagChar(cp: number): boolean {
  return cp >= 0xE0020 && cp <= 0xE007F;
}

function ansiEscapeEnd(text: string, start: number): number | null {
  if (text.charCodeAt(start) !== 0x1b || text[start + 1] !== "[") return null;
  let index = start + 2;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    index++;
  }
  return null;
}

function nextCluster(text: string, start: number): [width: number, end: number] {
  const ansiEnd = ansiEscapeEnd(text, start);
  if (ansiEnd !== null) return [0, ansiEnd];

  const cp = text.codePointAt(start)!;
  const charLen = cp > 0xFFFF ? 2 : 1;

  if (isZeroWidth(cp)) {
    return [0, start + charLen];
  }

  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) {
    let end = start + charLen;
    if (end < text.length) {
      const next = text.codePointAt(end)!;
      if (next >= 0x1F1E6 && next <= 0x1F1FF) {
        end += next > 0xFFFF ? 2 : 1;
        return [2, end];
      }
    }
    return [1, end];
  }

  const width = inRanges(cp, WIDE_RANGES) ? 2 : 1;
  let end = start + charLen;

  if (width === 2) {
    if (end < text.length && text.codePointAt(end) === 0xFE0F) {
      end++;
    }
    while (end < text.length && isTagChar(text.codePointAt(end)!)) {
      end += 2;
    }
  }

  while (end < text.length) {
    const trail = text.codePointAt(end)!;
    if (!isZeroWidth(trail)) break;
    end += trail > 0xFFFF ? 2 : 1;
  }

  return [width, end];
}

export function termWidth(text: string): number {
  let width = 0;
  let index = 0;

  while (index < text.length) {
    const [clusterWidth, end] = nextCluster(text, index);
    width += clusterWidth;
    index = end;
  }

  return width;
}

export function sliceByWidth(text: string, maxWidth: number): [taken: string, rest: string] {
  let width = 0;
  let index = 0;

  while (index < text.length) {
    const [clusterWidth, end] = nextCluster(text, index);
    if (width + clusterWidth > maxWidth) break;
    width += clusterWidth;
    index = end;
  }

  return [text.slice(0, index), text.slice(index)];
}

export function visibleLength(text: string): number {
  return termWidth(text.replace(ANSI_ESCAPE_RE, ""));
}

// Keep color/style SGR escapes active when a styled word is split across
// physical terminal rows. Without this, a hard-wrapped link only keeps its
// accent color on the first visual line.
function activeSgrPrefix(text: string): string {
  let active = "";
  ANSI_SGR_RE.lastIndex = 0;
  for (;;) {
    const match = ANSI_SGR_RE.exec(text);
    if (!match) break;
    const params = match[1] || "0";
    if (params.split(";").some((param) => param === "0")) {
      active = "";
    } else {
      active += match[0];
    }
  }
  return active;
}

function closeIfStyled(text: string): string {
  return activeSgrPrefix(text) ? `${text}${ANSI_RESET}` : text;
}

export function hardBreak(word: string, width: number, result: string[]): string {
  let remaining = word;
  for (;;) {
    const [taken, rest] = sliceByWidth(remaining, width);
    if (!rest) return remaining;
    if (taken === "") {
      result.push(closeIfStyled(remaining.slice(0, 1)));
      remaining = remaining.slice(1);
    } else {
      const active = activeSgrPrefix(taken);
      result.push(active ? `${taken}${ANSI_RESET}` : taken);
      remaining = active ? `${active}${rest}` : rest;
    }
  }
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (termWidth(text) <= width) return text;
  if (width === 1) return "…";
  const [taken] = sliceByWidth(text, width - 1);
  return `${taken}…`;
}

export function padRightToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  const padding = Math.max(0, width - termWidth(clipped));
  return clipped + " ".repeat(padding);
}

export function padVisibleRightToWidth(text: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(text));
  return text + " ".repeat(padding);
}

export function getViewportByWidth(
  text: string,
  cursorIndex: number,
  maxWidth: number,
): { visibleText: string; cursorCol: number; startIndex: number } {
  const safeMaxWidth = Math.max(0, maxWidth);
  const safeCursorIndex = Math.max(0, Math.min(cursorIndex, text.length));
  if (safeMaxWidth === 0) {
    return { visibleText: "", cursorCol: 0, startIndex: safeCursorIndex };
  }

  let startIndex = 0;
  while (startIndex < safeCursorIndex && termWidth(text.slice(startIndex, safeCursorIndex)) > safeMaxWidth) {
    startIndex = nextCluster(text, startIndex)[1];
  }

  const [visibleText] = sliceByWidth(text.slice(startIndex), safeMaxWidth);
  const cursorCol = Math.min(safeMaxWidth, termWidth(text.slice(startIndex, safeCursorIndex)));

  return { visibleText, cursorCol, startIndex };
}

export const truncate = truncateToWidth;
export const padRight = padRightToWidth;
