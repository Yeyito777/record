/**
 * Character classification for prompt vim motions and text objects.
 */

// Variation selectors and enclosing marks (U+FE0F, keycaps) belong to emoji,
// which stay punctuation like their base symbols.
const WORD_CHAR_RE = /(?![\uFE00-\uFE0F])[\p{L}\p{N}\p{Mn}\p{Mc}_]/u;

/** Word character: letters, digits and combining marks in any script, underscore. */
export function isWordChar(ch: string): boolean {
  return WORD_CHAR_RE.test(ch);
}

export function isBufferSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

export function isPunct(ch: string): boolean {
  return !isWordChar(ch) && !isBufferSpace(ch);
}

export function isWORDChar(ch: string): boolean {
  return ch !== " " && ch !== "\t" && ch !== "\n";
}
