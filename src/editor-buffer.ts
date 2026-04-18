/**
 * Prompt editor buffer primitives.
 */

export function lineStartOf(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  const idx = buffer.lastIndexOf("\n", pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

export function lineEndOf(buffer: string, pos: number): number {
  const idx = buffer.indexOf("\n", pos);
  return idx === -1 ? buffer.length : idx;
}

export function clampInsertCursor(buffer: string, cursor: number): number {
  return Math.max(0, Math.min(cursor, buffer.length));
}

export function clampNormalCursor(buffer: string, cursor: number): number {
  if (buffer.length === 0) return 0;
  const max = buffer[buffer.length - 1] === "\n" ? buffer.length : buffer.length - 1;
  return Math.max(0, Math.min(cursor, max));
}
