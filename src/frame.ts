/**
 * Retained terminal frame flushing.
 *
 * The renderer builds a full desired payload for each terminal row. This module
 * compares it with the last flushed frame and emits only changed rows.
 *
 * When the message pane's viewport moves by fewer rows than its height, the
 * frame first tells the terminal to scroll just those rows (DECSTBM + SU/SD),
 * then writes only the rows that scroll exposed or that otherwise changed.
 *
 * With app-driven smooth scrolling (st mode 2032, smoothscroll.ts) frames
 * carry `afterScroll`: the scrolled band may then sit beside the sidebar and
 * member list (their `pinned` segments are repainted beside the moved rows),
 * end above an overlay, change between frames (the common rows scroll), and
 * the shift is also found from the rows themselves when older history arrives
 * in the same frame. Images and graphics learn which rows the scroll moved.
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
  /**
   * Per-row segments, already part of `rows[i]`, that paint columns beside
   * the scrolled pane (the sidebar, the member list). A region scroll moves
   * whole rows (st has no left/right margins), so rows whose other content
   * moved intact get only these segments repainted. Each segment must paint
   * all of its columns, starting with its own cursor move.
   */
  pinned?: (readonly string[] | undefined)[];
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
  /**
   * Retained graphics layer (custom emoji). A function is told which rows the
   * frame's region scroll moved (null without one): terminals move or drop
   * placements with the rows they sit on.
   */
  graphics?: { key: string; payload: string } | ((scrolled: ScrollRegion | null) => string);
  /**
   * App-driven smooth scrolling: sent last inside the same synchronized
   * update, given how far the region scroll moved the content (up positive,
   * 0 without one) and whether every row it moved arrived intact.
   */
  afterScroll?: (regionShift: number, intact: boolean) => string;
}

interface RetainedFrame extends RenderFrame {
  /** Lazily computed content keys (see `contentKey`), by row. */
  keys?: (string | undefined)[];
}

const lastRenderedFrames = new WeakMap<object, RetainedFrame>();

export function invalidateFrame(owner: object): void {
  lastRenderedFrames.delete(owner);
}

/** The rows of the last flushed frame (tests: what a full repaint of it would draw). */
export function retainedFrameRows(owner: object): readonly string[] | undefined {
  return lastRenderedFrames.get(owner)?.rows;
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


// ── Smooth-scroll frames (afterScroll set) ──────────────────────────

/** Rows both frames' bands share: what a region scroll may move (null below 4 rows). */
function commonRegion(a: ScrollRegion | null, b: ScrollRegion | null): ScrollRegion | null {
  if (!a || !b) return null;
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end - start + 1 >= 4 ? { start, end } : null;
}

/** A row's payload without its pinned segments, with absolute row numbers removed. */
function contentKey(frame: RetainedFrame, index: number): string | undefined {
  const keys = frame.keys ??= [];
  if (index in keys) return keys[index];
  let row = frame.rows[index];
  for (const segment of frame.pinned?.[index] ?? []) {
    const at = row === undefined || !segment ? -1 : row.indexOf(segment);
    if (at >= 0) row = row!.slice(0, at) + row!.slice(at + segment.length);
  }
  const key = normalizeRowMoves(row);
  keys[index] = key;
  return key;
}

/**
 * What row `index` of a scrolled region needs: nothing, only its pinned
 * segments that changed (the content beside them moved intact), or the
 * whole row.
 */
function scrolledRowUpdate(
  prevFrame: RetainedFrame,
  nextFrame: RetainedFrame,
  region: ScrollRegion,
  index: number,
  shift: number,
): string | null {
  const nextRow = nextFrame.rows[index]!;
  const source = index + shift;
  if (source < region.start - 1 || source > region.end - 1) return nextRow;
  const key = contentKey(nextFrame, index);
  if (key === undefined || key !== contentKey(prevFrame, source)) return nextRow;
  const nextPinned = nextFrame.pinned?.[index] ?? [];
  const prevPinned = prevFrame.pinned?.[source] ?? [];
  if (nextPinned.length !== prevPinned.length) return nextRow;
  let update = "";
  for (let i = 0; i < nextPinned.length; i++) {
    if (!sameRowContent(prevPinned[i], nextPinned[i])) update += nextPinned[i];
  }
  return update || null;
}

/**
 * The viewport's own move, confirmed by the rows (as detectRegionScroll,
 * comparing rows without their pinned segments, within `region`).
 */
function detectViewportScroll(
  prevFrame: RenderFrame,
  nextFrame: RenderFrame,
  region: ScrollRegion,
  same: (prevIndex: number, nextIndex: number) => boolean,
): number {
  const height = region.end - region.start + 1;
  const shift = nextFrame.viewStart - prevFrame.viewStart;
  if (shift === 0 || Math.abs(shift) > height - 3) return 0;

  let shiftedMatches = 0;
  let stayMatches = 0;
  let nonBlankShiftedMatch = false;
  for (let row = region.start - 1; row <= region.end - 1; row++) {
    if (same(row, row)) stayMatches++;
    const source = row + shift;
    if (source < region.start - 1 || source > region.end - 1) continue;
    if (same(source, row)) {
      shiftedMatches++;
      if (!isBlankRow(nextFrame.rows[row])) nonBlankShiftedMatch = true;
    }
  }

  const comparableRows = height - Math.abs(shift);
  if (!nonBlankShiftedMatch) return 0;
  if (shiftedMatches < Math.max(3, Math.floor(comparableRows * 0.6))) return 0;
  if (shiftedMatches <= stayMatches) return 0;
  return shift;
}

/**
 * How far the band's content moved, found from the rows themselves: the
 * shift that explains the most rows that changed. Used when the viewport's
 * own move does not explain the frame: its first line's index also jumps when
 * older history is prepended (a page arriving mid-glide) while the content on
 * screen moved by just the scroll step.
 */
function detectContentScroll(
  prevFrame: RenderFrame,
  nextFrame: RenderFrame,
  region: ScrollRegion,
  same: (prevIndex: number, nextIndex: number) => boolean,
): number {
  const height = region.end - region.start + 1;
  // Unchanged rows (blank lines, a still pinned-only row) say nothing.
  const first = region.start - 1;
  const last = region.end - 1;
  const changed: number[] = [];
  for (let row = first; row <= last; row++) if (!same(row, row)) changed.push(row);
  if (changed.length < 3) return 0;

  const hint = nextFrame.viewStart - prevFrame.viewStart;
  let best = 0;
  let bestMatches = 0;
  for (let distance = 1; distance <= height - 3; distance++) {
    for (const direction of [1, -1]) {
      const shift = distance * direction;
      let comparable = 0;
      let matches = 0;
      let nonBlank = false;
      for (const row of changed) {
        const source = row + shift;
        if (source < first || source > last) continue;
        comparable++;
        if (same(source, row)) {
          matches++;
          if (!isBlankRow(nextFrame.rows[row])) nonBlank = true;
        }
      }
      if (!nonBlank || matches < Math.max(3, Math.floor(comparable * 0.6))) continue;
      // Most rows explained wins; on a tie the viewport's own move, else the shorter one.
      if (matches > bestMatches || (matches === bestMatches && shift === hint)) {
        best = shift;
        bestMatches = matches;
      }
    }
  }
  return best;
}

/** Per-frame image commands that are reconciled outside the retained diff. */
export interface FrameImageCommands {
  /** Invisible data transfers, written before the synchronized update. */
  transmit: string;
  /** Placement changes, presented atomically with this frame's text. */
  update: string;
}

/** Image commands for a frame; a function is told which rows its region scroll moved. */
export type FrameImages = FrameImageCommands | ((scrolled: ScrollRegion | null) => FrameImageCommands);

export function flushFrame(owner: object, nextFrame: RenderFrame, images?: FrameImages): void {
  if (nextFrame.afterScroll) {
    flushSmoothFrame(owner, nextFrame, images);
    return;
  }
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
  const imageCommands = typeof images === "function" ? images(scrollRegion) : images;

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

  const graphics = typeof nextFrame.graphics === "function" ? nextFrame.graphics(scrollRegion) : nextFrame.graphics;
  if (typeof graphics === "string") {
    if (graphics) out.push(graphics);
  } else {
    const prevGraphics = prevFrame?.graphics;
    const graphicsChanged = (typeof prevGraphics === "object" ? prevGraphics.key : undefined) !== graphics?.key;
    if (graphicsChanged && graphics?.payload) {
      // Row writes happen first. Graphics are then replaced as one retained layer,
      // and the regular cursor payload below restores the application cursor.
      out.push(graphics.payload);
    }
  }
  // Chat and viewer images join the same update as the text they sit in, so
  // no presented frame shows a resized box without its image or the reverse.
  if (imageCommands?.update) out.push(imageCommands.update);

  if (out.length > 0 || !prevFrame || prevFrame.cursor !== nextFrame.cursor) {
    out.push(nextFrame.cursor);
  }

  if (out.length > 0 || imageCommands?.transmit) {
    const payload = out.join("");
    const synchronized = out.length > 2 || !!imageCommands?.update || (regionScrolls && !!scrollRegion);
    process.stdout.write((imageCommands?.transmit ?? "")
      + (synchronized ? beginSynchronizedUpdate + payload + endSynchronizedUpdate : payload));
  }

  lastRenderedFrames.set(owner, { ...nextFrame, graphics: typeof graphics === "object" ? graphics : undefined });
}

/**
 * A frame under app-driven smooth scrolling: the band may sit beside pinned
 * side panels and change between frames, and the frame ends with the
 * scroller's rectangles and motion inside the same synchronized update.
 */
function flushSmoothFrame(owner: object, nextFrame: RenderFrame, images?: FrameImages): void {
  const prevFrame = lastRenderedFrames.get(owner);
  const next: RetainedFrame = { ...nextFrame };
  const out: string[] = [];
  const rowCount = Math.max(prevFrame?.rows.length ?? 0, nextFrame.rows.length);
  const region = prevFrame ? commonRegion(prevFrame.scrollRegion, nextFrame.scrollRegion) : null;
  // Compare without the side panels, which stay put while the content moves.
  const sameContent = (prevIndex: number, nextIndex: number) => {
    const key = contentKey(next, nextIndex);
    return key !== undefined && key === contentKey(prevFrame!, prevIndex);
  };
  const scrollShift = !prevFrame || !region
    ? 0
    : detectViewportScroll(prevFrame, next, region, sameContent) || detectContentScroll(prevFrame, next, region, sameContent);
  const scrollRegion = scrollShift !== 0 ? region : null;
  let hasDrawingUpdates = false;
  /** Every row the region scroll supplied matches this frame (near the bottom edge aside). */
  let scrolledIntact = scrollRegion !== null;

  if (scrollRegion) {
    out.push(scrollRegionBy(scrollRegion, scrollShift));
    hasDrawingUpdates = true;
  }

  for (let i = 0; i < rowCount; i++) {
    const nextRow = nextFrame.rows[i];
    if (nextRow === undefined) continue;

    if (scrollRegion && prevFrame && i >= scrollRegion.start - 1 && i <= scrollRegion.end - 1) {
      const update = scrolledRowUpdate(prevFrame, next, scrollRegion, i, scrollShift);
      const source = i + scrollShift;
      // The rows just above the ones it exposed may change with it (the
      // footer of what was the last message).
      if (update === nextRow && source >= scrollRegion.start - 1 && source <= scrollRegion.end - 1
        && i < scrollRegion.end - 1 - Math.abs(scrollShift) - 2) scrolledIntact = false;
      if (update !== null) {
        out.push(update);
        hasDrawingUpdates = true;
      }
      continue;
    }

    if (prevFrame?.rows[i] !== nextRow) {
      out.push(nextRow);
      hasDrawingUpdates = true;
    }
  }

  // Images draw above text, so placing them after the rows is equivalent and
  // keeps both inside the same synchronized update.
  const graphics = typeof nextFrame.graphics === "function" ? nextFrame.graphics(scrollRegion) : nextFrame.graphics;
  const graphicsPayload = typeof graphics === "string"
    ? graphics
    : graphics && (scrollRegion || (typeof prevFrame?.graphics === "object" ? prevFrame.graphics.key : undefined) !== graphics.key)
      ? graphics.payload
      : "";
  if (graphicsPayload) {
    out.push(graphicsPayload);
    hasDrawingUpdates = true;
  }
  const imageCommands = typeof images === "function" ? images(scrollRegion) : images;
  if (imageCommands?.update) {
    out.push(imageCommands.update);
    hasDrawingUpdates = true;
  }

  const smooth = nextFrame.afterScroll!(scrollShift, scrolledIntact);
  if (smooth) out.push(smooth);

  if (out.length > 0 || !prevFrame || prevFrame.cursor !== nextFrame.cursor) {
    out.push(nextFrame.cursor);
  }

  if (out.length > 0 || imageCommands?.transmit) {
    const payload = out.join("");
    process.stdout.write((imageCommands?.transmit ?? "")
      + (hasDrawingUpdates ? beginSynchronizedUpdate + payload + endSynchronizedUpdate : payload));
  }

  next.graphics = typeof graphics === "object" ? graphics : undefined;
  next.afterScroll = undefined;
  lastRenderedFrames.set(owner, next);
}
