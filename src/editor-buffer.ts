/**
 * Prompt editor buffer primitives.
 */

const graphemeSegmenter: Intl.Segmenter | null = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function charLengthAt(buffer: string, pos: number): number {
  const codePoint = buffer.codePointAt(pos);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function codePointAt(buffer: string, pos: number): number | undefined {
  return buffer.codePointAt(pos);
}

function isCombiningMark(codePoint: number): boolean {
  return (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f);
}

function isVariationSelector(codePoint: number): boolean {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function fallbackNextGraphemeEnd(buffer: string, pos: number): number {
  let end = Math.min(buffer.length, pos + charLengthAt(buffer, pos));

  while (end < buffer.length) {
    const cp = codePointAt(buffer, end);
    if (cp === undefined) break;

    if (isVariationSelector(cp) || isCombiningMark(cp) || isEmojiModifier(cp)) {
      end += charLengthAt(buffer, end);
      continue;
    }

    if (cp === 0x200d && end < buffer.length - 1) {
      end += charLengthAt(buffer, end);
      end += charLengthAt(buffer, end);
      continue;
    }

    break;
  }

  return end;
}

function nextGraphemeEndFallback(buffer: string, pos: number): number {
  if (pos >= buffer.length) return buffer.length;
  let index = 0;
  while (index < buffer.length) {
    const end = fallbackNextGraphemeEnd(buffer, index);
    if (index <= pos && pos < end) return end;
    if (index >= pos) return end;
    index = end;
  }
  return buffer.length;
}

function previousGraphemeStartFallback(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let previous = 0;
  let index = 0;
  while (index < buffer.length) {
    const end = fallbackNextGraphemeEnd(buffer, index);
    if (index >= pos) return previous;
    if (end >= pos) return index;
    previous = index;
    index = end;
  }
  return previous;
}

function graphemeStartAtOrAfterFallback(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= buffer.length) return pos;
  let index = 0;
  while (index < buffer.length) {
    const end = fallbackNextGraphemeEnd(buffer, index);
    if (index >= pos) return index;
    if (end > pos) return index;
    index = end;
  }
  return pos;
}

function graphemeBoundaryAtOrAfterFallback(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= buffer.length) return buffer.length;
  let index = 0;
  while (index < buffer.length) {
    const end = fallbackNextGraphemeEnd(buffer, index);
    if (index === pos) return pos;
    if (index > pos) return index;
    if (end > pos) return end;
    index = end;
  }
  return buffer.length;
}

export function previousGraphemeStart(buffer: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, buffer.length));
  if (clamped <= 0) return 0;
  if (!graphemeSegmenter) return previousGraphemeStartFallback(buffer, clamped);

  let previous = 0;
  for (const segment of graphemeSegmenter.segment(buffer)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    if (start >= clamped) return previous;
    if (end >= clamped) return start;
    previous = start;
  }
  return previous;
}

export function nextGraphemeEnd(buffer: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, buffer.length));
  if (clamped >= buffer.length) return buffer.length;
  if (!graphemeSegmenter) return nextGraphemeEndFallback(buffer, clamped);

  for (const segment of graphemeSegmenter.segment(buffer)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    if (start <= clamped && clamped < end) return end;
    if (start >= clamped) return end;
  }
  return buffer.length;
}

function graphemeStartAtOrAfter(buffer: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, buffer.length));
  if (clamped === 0 || clamped >= buffer.length) return clamped;
  if (!graphemeSegmenter) return graphemeStartAtOrAfterFallback(buffer, clamped);

  for (const segment of graphemeSegmenter.segment(buffer)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    if (start >= clamped) return start;
    if (end > clamped) return start;
  }
  return clamped;
}

export function graphemeBoundaryAtOrAfter(buffer: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, buffer.length));
  if (clamped === 0 || clamped >= buffer.length) return clamped;
  if (!graphemeSegmenter) return graphemeBoundaryAtOrAfterFallback(buffer, clamped);

  for (const segment of graphemeSegmenter.segment(buffer)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    if (start === clamped) return clamped;
    if (start > clamped) return start;
    if (end > clamped) return end;
  }
  return clamped;
}

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
  const max = buffer[buffer.length - 1] === "\n" ? buffer.length : previousGraphemeStart(buffer, buffer.length);
  return graphemeStartAtOrAfter(buffer, Math.max(0, Math.min(cursor, max)));
}
