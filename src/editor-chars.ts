/**
 * Character classification for prompt vim motions and text objects.
 */

export function isWordChar(ch: string): boolean {
  return /\w/.test(ch);
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
