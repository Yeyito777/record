/**
 * App-driven smooth scrolling of the message pane.
 *
 * On a terminal that supports it (st's mode 2032, ~/Config/st
 * docs/app-smooth-scroll.md) Record animates scrolls itself: the history is
 * laid out at whole rows, as usual, with an ordinary region scroll plus the
 * rows it exposes (the sidebar and member list repainted beside them in the
 * same synchronized update), and the terminal draws the moving rectangle
 * shifted by an offset it eases itself. Ported from the Exocortex TUI
 * (tui/src/smoothscroll.ts); see README "Scroll regions".
 */

const ESC = "\x1b";
const ST = `${ESC}\\`;

export const SMOOTH_SCROLL_QUERY = `${ESC}[?2032$p`;
export const SMOOTH_SCROLL_ON = `${ESC}[?2032h`;
export const SMOOTH_SCROLL_OFF = `${ESC}[?2032l`;
/** Same feel as st's own glides (smoothscroll_ms). */
export const SMOOTH_SCROLL_DURATION_MS = 100;
/** Longest wait between checks while a glide moves (the next row is scheduled for when it is due). */
export const SMOOTH_SCROLL_FRAME_MS = 16;

/** DECRQM reply for mode 2032: true when the terminal can do it, null if not a reply. */
export function parseSmoothScrollReport(sequence: string): boolean | null {
  const match = /^\x1b\[\?2032;([0-4])\$y$/.exec(sequence);
  if (!match) return null;
  return match[1] === "1" || match[1] === "2";
}

/** A moving rectangle: 1-based, inclusive screen cells. */
export interface ScrollRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function rectsPayload(rects: readonly ScrollRect[]): string {
  const list = rects.map((rect) => `;${rect.top},${rect.left},${rect.bottom},${rect.right}`).join("");
  return `${ESC}]2032;r${list}${ST}`;
}

export function offsetPayload(thousandths: number): string {
  return `${ESC}]2032;o;${thousandths}${ST}`;
}

/** Cubic ease-out remainder, 1 at the start and exactly 0 at the end (st's curve). */
export function easeRemaining(progress: number): number {
  if (!(progress < 1)) return 0;
  const rest = 1 - Math.max(0, progress);
  return rest * rest * rest;
}

/** OSC 2032 move: offset += dA rows; plus `ease` rows easing to 0 over `ms` (st times it). */
export function movePayload(deltaRows: number, easeRows = 0, ms = SMOOTH_SCROLL_DURATION_MS): string {
  const delta = Math.round(deltaRows * 1000);
  const ease = Math.round(easeRows * 1000);
  return ease === 0
    ? `${ESC}]2032;m;${delta}${ST}`
    : `${ESC}]2032;m;${delta};${ease};${ms}${ST}`;
}

/**
 * How far ahead of st's clock rows are laid out: covers the wake-up, a render
 * and the trip through the pty (or ssh), so the glide st draws never runs
 * past the lines its scrolls kept.
 */
export const SMOOTH_SCROLL_LEAD_MS = 30;
/** How early (in rows) the next row may be laid out: the offset st draws stays within 1 + this. */
export const SMOOTH_SCROLL_MARGIN_ROWS = 0.25;
/**
 * Images placed past the pane's bottom for a glide are cropped again once
 * less than this (rows) of the glide's upward offset is left: at rest st
 * clips nothing, so the crop must reach st before its glide ends (and its
 * clock runs behind Record's by the trip through the pty or ssh). Cropped
 * this early, the image's lowest pixels may be missing for the glide's last
 * 15-50 ms; never does it draw over the prompt.
 */
export const SMOOTH_SCROLL_IMAGE_CROP_ROWS = 0.125;

interface EaseTerm {
  rows: number;
  start: number;
}

/**
 * Scroll animation in rows from the bottom of the history (0 is the newest
 * row at the pane's bottom; larger is older history, so content moves down
 * on screen as it grows).
 *
 * The terminal draws the moving rectangles `offset` rows lower than laid out
 * (st's mode 2032), where offset = base + easing terms that st times itself
 * at the display's refresh. This class keeps the same curve so it knows
 * where st is: the eased position is `grid + offset`. Inputs move the
 * target (one move message: base += step, plus an easing term of -step, so
 * nothing jumps). Every row laid out is a region scroll plus `base -= rows`
 * in the same synchronized update, and the strip a shifted rectangle
 * uncovers shows the lines that scroll kept.
 *
 * Unlike the Exocortex TUI, which lays out one row at a time just ahead of
 * the glide (its rows re-wrap beside the Tasks panel), Record re-wraps
 * nothing while gliding, so it lays the history out at the glide's target
 * right away, up to the band's height a frame: one region scroll per input,
 * after which st animates the whole glide from the lines it kept. Traffic is
 * one frame per input whatever the side panels cost per row, and the glide
 * never waits on Record's frames (over ssh it cannot judder). Content that
 * moved by itself (a message arriving while following the bottom) gets an
 * easing term from where it was drawn.
 */
export class SmoothScroller {
  private target = 0;
  /** Whole offset of the last laid-out frame. */
  private grid = 0;
  private gridValid = false;
  private base = 0;
  private terms: EaseTerm[] = [];
  /** Region shift (up positive) the last layout step makes. */
  private expectedShift = 0;
  private height = 0;
  private maxOffset = 0;
  /** Most rows one frame's region scroll can move (the band's height - 3). */
  private maxStep = Infinity;
  /** The region the glide's last region scroll moved: the lines st keeps for it. */
  private keptRegion: { start: number; end: number } | null = null;
  private sentRects = "";
  private context: string | null = null;
  /** The user scrolled since the last layout (markScrollIntent). */
  private intent = false;
  /** An explicit re-layout (markRelayout) is being laid out: nothing it moves glides. */
  private relayout = false;
  /** This frame and the one before it both sat at the bottom (content arriving there may glide). */
  private following = false;
  /** Not yet sent: start over from `base` (`o`), then move by these. */
  private pendingReset = false;
  private pendingDelta = 0;
  private pendingEase = 0;
  private terminalNonzero = false;
  /** Terms not sent yet: they start when st receives them. */
  private unsent: EaseTerm[] = [];

  constructor(
    private readonly durationMs = SMOOTH_SCROLL_DURATION_MS,
    private readonly now: () => number = () => performance.now(),
    private readonly leadMs = SMOOTH_SCROLL_LEAD_MS,
  ) {}

  private offsetAt(time: number): number {
    let offset = this.base;
    for (const term of this.terms) offset += term.rows * easeRemaining((time - term.start) / this.durationMs);
    return offset;
  }

  private prune(time: number): void {
    this.terms = this.terms.filter((term) => easeRemaining((time - term.start) / this.durationMs) > 0);
  }

  private addTerm(rows: number, time: number): void {
    if (rows === 0) return;
    const term = { rows, start: time };
    this.terms.push(term);
    this.unsent.push(term);
    this.pendingEase += rows;
  }

  /** Lay out at grid + offset from here on: base = target - grid, eased from `from`. */
  private restart(from: number, time: number): void {
    this.terms = [];
    this.unsent = [];
    this.base = this.target - this.grid;
    this.pendingReset = true;
    this.pendingDelta = 0;
    this.pendingEase = 0;
    this.addTerm(from - this.target, time);
  }

  private gridFor(time: number, maxOffset: number): number {
    const position = this.grid + this.offsetAt(time);
    if (position === this.target && this.terms.length === 0) return this.target;
    // At least where the glide will be a little later (and the next row a
    // quarter row early), so st's clock never reaches rows not laid out yet.
    const ahead = this.grid + this.offsetAt(time + this.leadMs);
    let grid: number;
    if (this.target > position) {
      grid = Math.max(Math.ceil(position), Math.min(Math.ceil(ahead), Math.floor(position + SMOOTH_SCROLL_MARGIN_ROWS) + 1));
      grid = Math.min(this.target, grid);
      // Otherwise as far towards the target as one region scroll from the
      // rows on screen goes: what it pushes out is what st draws the glide
      // from. Beyond that (a jump) the frame is a repaint; lay it out at
      // the glide.
      if (grid - this.grid <= this.maxStep) grid = Math.max(grid, Math.min(this.target, this.grid + this.maxStep));
    } else if (this.target < position) {
      grid = Math.min(Math.floor(position), Math.max(Math.floor(ahead), Math.ceil(position - SMOOTH_SCROLL_MARGIN_ROWS) - 1));
      grid = Math.max(this.target, grid);
      if (this.grid - grid <= this.maxStep) grid = Math.min(grid, Math.max(this.target, this.grid - this.maxStep));
    } else {
      grid = Math.round(position);
    }
    return Math.max(0, Math.min(maxOffset, grid));
  }

  /** Jump without animating: a different channel, a resize, a repaint. */
  snap(logical: number): void {
    this.target = this.grid = logical;
    this.terms = [];
    this.unsent = [];
    this.base = 0;
    this.gridValid = false;
    this.expectedShift = 0;
    this.following = false;
    this.keptRegion = null;
    this.pendingReset = this.terminalNonzero;
    this.pendingDelta = this.pendingEase = 0;
    this.relayout = true;
  }

  /**
   * The whole offset to lay this frame out at. `logical` is the frame's
   * scroll position (rows from the bottom) after its adjustments; `pinDelta`
   * is how far keeping the same content on screen moved it (messages
   * arriving below a scrolled-up view; not a scroll). A different `context`
   * (channel, pane geometry) starts over without animating.
   */
  layout(logical: number, maxOffset: number, pinDelta: number, height: number, context: string): number {
    const time = this.now();
    this.height = height;
    this.maxStep = Math.min(this.maxStep, Math.max(1, height - 3));
    this.maxOffset = maxOffset;
    if (context !== this.context) {
      this.context = context;
      this.gridValid = false;
    }
    if (pinDelta !== 0) {
      this.target += pinDelta;
      this.grid += pinDelta;
    }
    if (!this.gridValid) {
      this.snap(logical);
      this.gridValid = true;
      this.intent = false;
      return logical;
    }
    this.prune(time);
    const startGrid = this.grid;
    const wasFollowing = this.target === 0;
    if (logical !== this.target && !this.intent) {
      // Not a scroll: Record jumped (to the bottom after a send, to a
      // reloaded history). Keeping the same content in view is `pinDelta`,
      // so what is left moves the content on screen. It never glides: the
      // laid-out rows move with it and whatever glide is in flight carries
      // on from there.
      const step = logical - this.target;
      this.target = logical;
      this.grid = Math.max(0, Math.min(maxOffset, this.grid + step));
    }
    this.intent = false;
    if (logical !== this.target) {
      const position = this.grid + this.offsetAt(time);
      const step = logical - this.target;
      this.target = logical;
      if (Math.abs(logical - position) > height) {
        // Jumps further than a screen glide in from one screen away.
        this.restart(logical - Math.sign(logical - position) * height, time);
      } else {
        this.base += step;
        this.pendingDelta += step;
        this.addTerm(-step, time);
      }
    }
    const grid = this.gridFor(time, maxOffset);
    // The region scroll this frame should make: the jump plus the glide's row.
    this.expectedShift = startGrid - grid;
    this.base -= grid - this.grid;
    this.pendingDelta -= grid - this.grid;
    this.grid = grid;
    this.following = wasFollowing && this.target === 0;
    return grid;
  }

  /**
   * After the frame was flushed: `regionShift` is how far its region scroll
   * moved the content (up positive, 0 when it was repainted), `intact`
   * whether every row it moved arrived unchanged and `scrolled` the region
   * it scrolled. Returns what to send inside the same synchronized update
   * (rectangles, motion).
   */
  afterFlush(
    regionShift: number,
    rects: readonly ScrollRect[],
    intact = false,
    scrolled: { start: number; end: number } | null = null,
  ): string {
    const time = this.now();
    // The band (less 3 rows) is how far the next frames' region scrolls go.
    const band = rects.length > 0
      ? { start: Math.min(...rects.map((rect) => rect.top)), end: Math.max(...rects.map((rect) => rect.bottom)) }
      : null;
    this.maxStep = band ? Math.max(1, band.end - band.start + 1 - 3) : 1;
    if (regionShift !== 0 && scrolled) this.keptRegion = scrolled;
    if (this.expectedShift !== 0 && regionShift === 0) {
      // Repainted, not scrolled: nothing on screen to glide from; ease on from here.
      this.keptRegion = null;
      this.restart(this.grid, time);
    } else if (regionShift !== this.expectedShift) {
      // Content moved by itself. Only what grows or shrinks at the bottom
      // while following it (everything above moved intact: a message
      // arriving, the typing line coming or going) eases from where it was;
      // anything else (a toggle, a send, rows re-wrapped) is a re-layout and
      // snaps.
      const moved = regionShift - this.expectedShift;
      if (intact && moved !== 0 && this.following && !this.relayout) this.addTerm(moved, time);
    }
    this.relayout = false;
    this.expectedShift = 0;
    const offset = this.offsetAt(time);
    // The strip a rectangle uncovers shows kept lines only where its edge is
    // the scrolled region's (st fills the rest with the row beyond's
    // background): when the band changed under a glide (an overlay, the
    // typing line) by more than the row it frees, or the offset outgrew the
    // lines st keeps, the glide snaps instead.
    const kept = this.keptRegion;
    const stripEdgeMoved = Math.abs(offset) > 1 && !!kept && !!band
      && (offset < 0 ? band.end !== kept.end : band.start !== kept.start);
    if (!band || stripEdgeMoved || Math.abs(offset) >= Math.max(1, this.height - 1)) {
      this.restart(this.grid, time);
      this.terms = [];
      this.unsent = [];
      this.pendingEase = 0;
    }
    if (this.base === 0 && this.terms.length === 0) this.keptRegion = null;
    let out = "";
    const rectKey = rectsPayload(rects);
    if (rectKey !== this.sentRects) {
      out += rectKey;
      this.sentRects = rectKey;
    }
    return out + this.takeMotion();
  }

  private takeMotion(): string {
    let out = "";
    // `o` starts over from the base before this frame's moves.
    if (this.pendingReset) out += offsetPayload(Math.round((this.base - this.pendingDelta) * 1000));
    if (this.pendingDelta !== 0 || this.pendingEase !== 0) out += movePayload(this.pendingDelta, this.pendingEase, this.durationMs);
    const sentAt = this.now();
    for (const term of this.unsent) term.start = sentAt;
    this.unsent = [];
    this.pendingReset = false;
    this.pendingDelta = this.pendingEase = 0;
    this.terminalNonzero = this.base !== 0 || this.terms.length > 0;
    return out;
  }

  /** The animation crosses a row: lay the next frame out. */
  needsLayout(): boolean {
    return this.gridValid && this.gridFor(this.now(), this.maxOffset) !== this.grid;
  }

  /** Milliseconds (at most `limit`) until the glide needs its next row laid out. */
  msUntilLayout(limit = SMOOTH_SCROLL_FRAME_MS): number {
    if (!this.gridValid) return limit;
    const time = this.now();
    for (let ms = 0; ms < limit; ms++) {
      if (this.gridFor(time + ms, this.maxOffset) !== this.grid) return ms;
    }
    return limit;
  }

  /**
   * Milliseconds until the glide next needs a frame: its next row, or coming
   * to rest (one more frame then crops images back to the pane).
   */
  nextWakeMs(): number {
    if (!this.gridValid) return 0;
    const time = this.now();
    let idle = 0;
    for (const term of this.terms) idle = Math.max(idle, term.start + this.durationMs - time);
    return this.msUntilLayout(Math.max(1, Math.ceil(idle) + 1));
  }

  /** The last frame placed images past the pane's bottom (noteImagesExtended). */
  private imagesExtended = false;

  /**
   * Whether images cut off by the pane's bottom must still be placed whole,
   * past it: st may still draw the content higher than laid out (offset
   * below -SMOOTH_SCROLL_IMAGE_CROP_ROWS), uncovering a strip at the bottom
   * where the image continues. Only the upward easing counts (a lower bound
   * of every offset still to come): content drawn lower needs nothing below
   * the pane, and every term only eases out.
   */
  extendBelow(time = this.now()): boolean {
    if (!this.gridValid) return false;
    let lowest = this.base;
    for (const term of this.terms) {
      if (term.rows < 0) lowest += term.rows * easeRemaining((time - term.start) / this.durationMs);
    }
    return lowest < -SMOOTH_SCROLL_IMAGE_CROP_ROWS;
  }

  /** The frame just planned placed (true) or did not place images past the pane's bottom. */
  noteImagesExtended(extended: boolean): void {
    this.imagesExtended = extended;
  }

  /** Images placed past the pane's bottom must be cropped again now. */
  private cropDue(time: number): boolean {
    return this.imagesExtended && !this.extendBelow(time);
  }

  /**
   * When main should render next for the glide: 0 now (images to crop), `ms`
   * from now (the next row is due, or images must be cropped), or null when
   * nothing is due until the next input; st animates the rest itself. Called
   * after every frame and when its timer fires.
   */
  frameDueIn(): number | null {
    if (!this.gridValid) return null;
    const time = this.now();
    if (this.cropDue(time)) return 0;
    if (!this.busy()) return null;
    if (this.gridFor(time, this.maxOffset) !== this.grid) return 1;
    let end = time;
    for (const term of this.terms) end = Math.max(end, term.start + this.durationMs);
    const limit = Math.max(2, Math.ceil(end - time) + 2);
    for (let ms = 1; ms <= limit; ms++) {
      if (this.gridFor(time + ms, this.maxOffset) !== this.grid || this.cropDue(time + ms)) return ms;
    }
    return null;
  }

  /** Frames (row crossings) may still be needed. */
  busy(): boolean {
    this.prune(this.now());
    return this.gridValid && (this.terms.length > 0 || this.grid !== this.target);
  }

  /** The user scrolled: the next change of the offset glides. */
  intend(): void {
    this.intent = true;
  }

  /** An explicit re-layout (a toggle, a send, a resize): the next frame snaps. */
  relayoutNext(): void {
    this.relayout = true;
  }

  /** The terminal dropped its state (resize, screen switch): send it again. */
  terminalReset(): void {
    this.sentRects = "";
    this.terminalNonzero = false;
  }
}

const scrollers = new WeakMap<object, SmoothScroller>();

/**
 * The user is scrolling (wheel, scroll keys, history-cursor motions, jumps):
 * the offset change the next frame lays out glides. Every other change of
 * the offset (re-layouts keeping their anchor, jumps to the bottom after a
 * send) snaps.
 */
export function markScrollIntent(owner: object): void {
  scrollers.get(owner)?.intend();
}

/**
 * A re-layout the user caused (a key or click, a resize): whatever it moves
 * snaps, even content at the bottom that would otherwise glide as a message
 * arriving while following it.
 */
export function markRelayout(owner: object): void {
  scrollers.get(owner)?.relayoutNext();
}

/** Attach (or with null, detach) app-driven smooth scrolling to a render state. */
export function setSmoothScroller(owner: object, scroller: SmoothScroller | null): void {
  if (scroller) scrollers.set(owner, scroller);
  else scrollers.delete(owner);
}

export function smoothScrollerFor(owner: object): SmoothScroller | null {
  return scrollers.get(owner) ?? null;
}
