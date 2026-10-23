/**
 * Retained terminal frame flushing.
 *
 * The renderer builds a full desired payload for each terminal row. This module
 * compares it with the last flushed frame and emits only changed rows.
 *
 * When the message pane's viewport moves by fewer rows than its height, the
 * frame first tells the terminal to scroll just those rows (DECSTBM + SU/SD),
 * then writes only the rows that scroll exposed or that otherwise changed.
 * Terminals that animate region scrolls (st's smooth-scroll) glide the pane.
 */

export const ESC = "\x1b[";
export const clearLine = `${ESC}2K`;
export const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;

const beginSynchronizedUpdate = `${ESC}?2026h`;
const endSynchronizedUpdate = `${ESC}?2026l`;

export interface ScrollRegion {
  start: number;
  end: number;
}

export interface RenderFrame {
  rows: string[];
  cursor: string;
  /**
   * Rows (1-based, inclusive) holding nothing but the scrolling pane, across
   * the terminal's full width. Null when other columns or overlays share them.
   */
  scrollRegion: ScrollRegion | null;
  /** Index of the pane's first visible line; its change is the scroll amount. */
  viewStart: number;
  /**
   * Scroll the region in both directions with SU/SD (config `scrollRegions`,
   * default on). False keeps the older upward-only line-feed heuristic.
   */
  regionScrolls?: boolean;
  graphics?: { key: string; payload: string };
}

const lastRenderedFrames = new WeakMap<object, RenderFrame>();

export function invalidateFrame(owner: object): void {
  lastRenderedFrames.delete(owner);
}

export function createFrameRows(totalRows: number, clearPayload: string): string[] {
  return Array.from({ length: totalRows }, (_, index) => moveTo(index + 1, 1) + clearPayload);
}

export function appendRowWrite(frameRows: string[], row: number, col: number, text: string): void {
  if (row < 1 || row > frameRows.length) return;
  frameRows[row - 1] += moveTo(row, col) + text;
}

export function appendPositionedPayload(frameRows: string[], payload: string): void {
  const moveRe = /\x1b\[(\d+);(\d+)H/g;
  let currentRow: number | null = null;
  let currentCol: number | null = null;
  let lastEnd = 0;

  for (let match = moveRe.exec(payload); match !== null; match = moveRe.exec(payload)) {
    if (currentRow !== null && currentCol !== null && currentRow >= 1 && currentRow <= frameRows.length) {
      frameRows[currentRow - 1] += moveTo(currentRow, currentCol) + payload.slice(lastEnd, match.index);
    }
    currentRow = Number(match[1]);
    currentCol = Number(match[2]);
    lastEnd = moveRe.lastIndex;
  }

  if (currentRow !== null && currentCol !== null && currentRow >= 1 && currentRow <= frameRows.length) {
    frameRows[currentRow - 1] += moveTo(currentRow, currentCol) + payload.slice(lastEnd);
  }
}

function normalizeRowMoves(row: string | undefined): string | undefined {
  return row?.replace(/\x1b\[\d+;(\d+)H/g, "\x1b[ROW;$1H");
}

function sameRowContent(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normalizeRowMoves(a) === normalizeRowMoves(b);
}

function sameScrollRegion(a: ScrollRegion | null, b: ScrollRegion | null): a is ScrollRegion {
  return !!a && !!b && a.start === b.start && a.end === b.end;
}

function scrollUpRegion(region: ScrollRegion, amount: number): string {
  return `${ESC}${region.start};${region.end}r${moveTo(region.end, 1)}${"\n".repeat(amount)}${ESC}r`;
}

function detectUpwardScroll(prevFrame: RenderFrame, nextFrame: RenderFrame): number {
  if (!sameScrollRegion(prevFrame.scrollRegion, nextFrame.scrollRegion)) return 0;
  const region = nextFrame.scrollRegion;
  if (!region) return 0;

  const viewportShift = nextFrame.viewStart - prevFrame.viewStart;
  if (viewportShift <= 0) return 0;

  const height = region.end - region.start + 1;
  if (height < 4) return 0;

  const maxShift = Math.min(10, Math.floor(height / 2), viewportShift);
  let bestShift = 0;
  let bestMatches = 0;

  for (let shift = viewportShift; shift <= maxShift; shift++) {
    let matches = 0;
    for (let row = region.start - 1; row <= region.end - 1 - shift; row++) {
      if (sameRowContent(prevFrame.rows[row + shift], nextFrame.rows[row])) matches++;
    }

    const comparableRows = height - shift;
    const threshold = Math.max(3, Math.floor(comparableRows * 0.6));
    if (matches >= threshold && matches > bestMatches) {
      bestShift = shift;
      bestMatches = matches;
    }
  }

  return bestShift;
}

function isBlankRow(row: string | undefined): boolean {
  return !row || row.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").trim() === "";
}

/** Region scroll: set the margins, scroll the rows, restore full-screen margins. */
function scrollRegionBy(region: ScrollRegion, shift: number): string {
  const scroll = shift > 0 ? `${ESC}${shift}S` : `${ESC}${-shift}T`;
  return `${ESC}${region.start};${region.end}r${scroll}${ESC}r`;
}

/**
 * Signed row shift for a region scroll: positive moves content up (SU),
 * negative moves it down (SD), 0 repaints instead.
 *
 * The viewport delta proposes the shift; the rows must confirm it. History
 * prepends remap viewStart without moving content, and channel switches
 * replace it, so the shift is used only when it keeps most comparable rows,
 * keeps more than staying put would, and keeps at least one non-blank row.
 */
function detectRegionScroll(prevFrame: RenderFrame, nextFrame: RenderFrame): number {
  if (!sameScrollRegion(prevFrame.scrollRegion, nextFrame.scrollRegion)) return 0;
  const region = nextFrame.scrollRegion;
  if (!region) return 0;

  const height = region.end - region.start + 1;
  const shift = nextFrame.viewStart - prevFrame.viewStart;
  if (height < 2 || shift === 0 || Math.abs(shift) >= height) return 0;

  let shiftedMatches = 0;
  let stayMatches = 0;
  let nonBlankShiftedMatch = false;
  for (let row = region.start - 1; row <= region.end - 1; row++) {
    const nextRow = nextFrame.rows[row];
    if (prevFrame.rows[row] === nextRow) stayMatches++;
    const source = row + shift;
    if (source < region.start - 1 || source > region.end - 1) continue;
    if (sameRowContent(prevFrame.rows[source], nextRow)) {
      shiftedMatches++;
      if (!isBlankRow(nextRow)) nonBlankShiftedMatch = true;
    }
  }

  const comparableRows = height - Math.abs(shift);
  if (!nonBlankShiftedMatch) return 0;
  if (shiftedMatches < Math.ceil(comparableRows * 0.6)) return 0;
  if (shiftedMatches <= stayMatches) return 0;
  return shift;
}

/** Per-frame image commands that are reconciled outside the retained diff. */
export interface FrameImageCommands {
  /** Invisible data transfers, written before the synchronized update. */
  transmit: string;
  /** Placement changes, presented atomically with this frame's text. */
  update: string;
}

export function flushFrame(owner: object, nextFrame: RenderFrame, images?: FrameImageCommands): void {
  const prevFrame = lastRenderedFrames.get(owner);
  const out: string[] = [];
  const rowCount = Math.max(prevFrame?.rows.length ?? 0, nextFrame.rows.length);
  const regionScrolls = nextFrame.regionScrolls === true;
  const scrollShift = !prevFrame
    ? 0
    : regionScrolls
      ? detectRegionScroll(prevFrame, nextFrame)
      : detectUpwardScroll(prevFrame, nextFrame);
  const scrollRegion = scrollShift !== 0 ? nextFrame.scrollRegion : null;

  if (scrollRegion) {
    out.push(regionScrolls ? scrollRegionBy(scrollRegion, scrollShift) : scrollUpRegion(scrollRegion, scrollShift));
  }

  for (let i = 0; i < rowCount; i++) {
    const nextRow = nextFrame.rows[i];
    if (nextRow === undefined) continue;

    let unchanged = prevFrame?.rows[i] === nextRow;
    if (scrollRegion && i >= scrollRegion.start - 1 && i <= scrollRegion.end - 1) {
      // After the scroll this row shows what was `scrollShift` rows away, or
      // blank if that source was outside the region (an exposed row).
      const source = i + scrollShift;
      const shiftedPrevRow = source >= scrollRegion.start - 1 && source <= scrollRegion.end - 1
        ? prevFrame?.rows[source]
        : undefined;
      unchanged = sameRowContent(shiftedPrevRow, nextRow);
    }

    if (!unchanged) out.push(nextRow);
  }

  const graphicsChanged = prevFrame?.graphics?.key !== nextFrame.graphics?.key;
  if (graphicsChanged && nextFrame.graphics?.payload) {
    // Row writes happen first. Graphics are then replaced as one retained layer,
    // and the regular cursor payload below restores the application cursor.
    out.push(nextFrame.graphics.payload);
  }
  // Chat and viewer images join the same update as the text they sit in, so
  // no presented frame shows a resized box without its image or the reverse.
  if (images?.update) out.push(images.update);

  if (out.length > 0 || !prevFrame || prevFrame.cursor !== nextFrame.cursor) {
    out.push(nextFrame.cursor);
  }

  if (out.length > 0 || images?.transmit) {
    const payload = out.join("");
    const synchronized = out.length > 2 || !!images?.update || (regionScrolls && !!scrollRegion);
    process.stdout.write((images?.transmit ?? "")
      + (synchronized ? beginSynchronizedUpdate + payload + endSynchronizedUpdate : payload));
  }

  lastRenderedFrames.set(owner, nextFrame);
}
