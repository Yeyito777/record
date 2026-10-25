/**
 * Terminal-width-aware text helpers.
 *
 * These helpers count terminal columns rather than UTF-16 code units, so UI
 * layout can safely truncate and pad strings containing emoji, CJK, combining
 * marks, and other wide / zero-width glyphs.
 */

// Sorted ranges of always-double-width codepoints [start, end] (inclusive).
// Generated from glibc 2.43 wcwidth (Unicode 17), which st uses: East Asian
// Width W/F + Emoji_Presentation=Yes. Code points glibc leaves unassigned keep
// their previous width; zero-width ones (checked first) may bridge ranges.
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115F],
  [0x231A, 0x231B],
  [0x2329, 0x232A],
  [0x23E9, 0x23EC],
  [0x23F0, 0x23F0],
  [0x23F3, 0x23F3],
  [0x25FD, 0x25FE],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267F, 0x267F],
  [0x268A, 0x268F],
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
  [0x2E80, 0x303E],
  [0x3040, 0xA4CF],
  [0xA960, 0xA97C],
  [0xAC00, 0xD7AF],
  // Record reserves the BMP private-use block for inline custom-emoji markers.
  // They occupy a square two-column footprint in an ordinarily narrow terminal
  // cell grid, just like other wide grapheme clusters.
  [0xE000, 0xF8FF],
  [0xF900, 0xFAFF],
  [0xFE10, 0xFE19],
  [0xFE30, 0xFE6F],
  [0xFF01, 0xFF60],
  [0xFFE0, 0xFFE6],
  [0x16FE0, 0x16FE3],
  [0x16FF0, 0x16FF6],
  [0x17000, 0x18CD5],
  [0x18CFF, 0x18D1E],
  [0x18D80, 0x18DF2],
  [0x1AFF0, 0x1AFF3],
  [0x1AFF5, 0x1AFFB],
  [0x1AFFD, 0x1AFFE],
  [0x1B000, 0x1B122],
  [0x1B132, 0x1B132],
  [0x1B150, 0x1B152],
  [0x1B155, 0x1B155],
  [0x1B164, 0x1B167],
  [0x1B170, 0x1B2FB],
  [0x1D300, 0x1D356],
  [0x1D360, 0x1D376],
  [0x1F004, 0x1F004],
  [0x1F0CF, 0x1F0CF],
  [0x1F18E, 0x1F18E],
  [0x1F191, 0x1F19A],
  [0x1F200, 0x1F202],
  [0x1F210, 0x1F23B],
  [0x1F240, 0x1F248],
  [0x1F250, 0x1F251],
  [0x1F260, 0x1F265],
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
  [0x1F6D5, 0x1F6D8],
  [0x1F6DC, 0x1F6DF],
  [0x1F6EB, 0x1F6EC],
  [0x1F6F4, 0x1F6FC],
  [0x1F7E0, 0x1F7EB],
  [0x1F7F0, 0x1F7F0],
  [0x1F90C, 0x1F93A],
  [0x1F93C, 0x1F945],
  [0x1F947, 0x1F9FF],
  [0x1FA70, 0x1FA7C],
  [0x1FA80, 0x1FA8A],
  [0x1FA8E, 0x1FAC6],
  [0x1FAC8, 0x1FAC8],
  [0x1FACD, 0x1FADC],
  [0x1FADF, 0x1FAEA],
  [0x1FAEF, 0x1FAF8],
  [0x20000, 0x3FFFF],
];

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;
const ANSI_RESET = "\x1b[0m";
const NONSPACING_OR_ENCLOSING_MARK_RE = /[\p{Mn}\p{Me}]/u;

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
  // Nothing below U+0300 (the first combining mark) is zero-width here; this
  // skips the Unicode-property regex for Latin text.
  if (cp < 0x0300) return false;
  if (NONSPACING_OR_ENCLOSING_MARK_RE.test(String.fromCodePoint(cp))) return true;
  if (cp >= 0x200B && cp <= 0x200F) return true;
  if (cp >= 0x2028 && cp <= 0x202E) return true;
  if (cp >= 0x2060 && cp <= 0x206F) return true;
  if (cp === 0xFEFF || cp === 0x061C || cp === 0x180E) return true;
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;
  // Hangul conjoining vowels and finals (they join the preceding initial) and fillers.
  if ((cp >= 0x1160 && cp <= 0x11FF) || (cp >= 0xD7B0 && cp <= 0xD7FF)) return true;
  if (cp === 0x3164 || cp === 0xFFA0) return true;
  if ((cp >= 0x1BCA0 && cp <= 0x1BCA3) || (cp >= 0x1D173 && cp <= 0x1D17A)) return true;
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

/**
 * Width of a private-use character the application draws as something else
 * (a custom emoji shown as its name without Kitty graphics); undefined keeps
 * the usual two cells. Null when nothing is drawn differently.
 */
let privateUseWidth: ((codePoint: number) => number | undefined) | null = null;

export function setPrivateUseWidth(width: ((codePoint: number) => number | undefined) | null): void {
  privateUseWidth = width;
}

function nextCluster(text: string, start: number): [width: number, end: number] {
  const ansiEnd = ansiEscapeEnd(text, start);
  if (ansiEnd !== null) return [0, ansiEnd];

  const cp = text.codePointAt(start)!;
  const charLen = cp > 0xFFFF ? 2 : 1;

  if (privateUseWidth && cp >= 0xE000 && cp <= 0xF8FF) {
    const width = privateUseWidth(cp);
    if (width !== undefined) return [width, start + charLen];
  }

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

/** Source-string end offset of the next terminal-width cluster. */
export function nextWidthClusterEnd(text: string, start = 0): number {
  if (start < 0) start = 0;
  if (start >= text.length) return text.length;
  return nextCluster(text, start)[1];
}

export function termWidth(text: string): number {
  let width = 0;
  let index = 0;

  while (index < text.length) {
    // Printable ASCII is one cell; a combining mark after it is counted (as
    // zero) on the next step, so the total matches cluster parsing.
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) {
      width++;
      index++;
      continue;
    }
    const [clusterWidth, end] = nextCluster(text, index);
    width += clusterWidth;
    index = end;
  }

  return width;
}

/**
 * End offset and width of the longest prefix of `text` from `start` that fits
 * in `maxWidth` cells. Printable ASCII skips cluster parsing, which keeps long
 * prompts cheap to wrap; zero-width trailers still attach on the next step.
 */
export function sliceByWidthFrom(text: string, start: number, maxWidth: number): [end: number, width: number] {
  let width = 0;
  let index = Math.max(0, Math.min(start, text.length));

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) {
      if (width + 1 > maxWidth) break;
      width++;
      index++;
      continue;
    }

    const [clusterWidth, end] = nextCluster(text, index);
    if (width + clusterWidth > maxWidth) break;
    width += clusterWidth;
    index = end;
  }

  return [index, width];
}

export function sliceByWidth(text: string, maxWidth: number): [taken: string, rest: string] {
  const [index] = sliceByWidthFrom(text, 0, maxWidth);
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

export function hardBreak(word: string, width: number, result: string[]): string {
  let remaining = word;
  for (;;) {
    let [taken, rest] = sliceByWidth(remaining, width);
    if (!rest) return remaining;
    // Nothing visible fits (a wide character on a one-column line; the slice
    // took only its color): the character gets a line of its own, whole.
    if (termWidth(taken) === 0) [taken, rest] = sliceByWidth(remaining, 2);
    const active = activeSgrPrefix(taken);
    result.push(active ? `${taken}${ANSI_RESET}` : taken);
    remaining = active ? `${active}${rest}` : rest;
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
