import { beforeEach, describe, expect, test } from "bun:test";

import {
  SMOOTH_SCROLL_MARGIN_ROWS,
  SmoothScroller,
  easeRemaining,
  offsetPayload,
  parseSmoothScrollReport,
  rectsPayload,
} from "./smoothscroll";
import { TerminalControlBuffer } from "./terminalclipboard";

describe("mode 2032 protocol", () => {
  test("DECRQM replies", () => {
    expect(parseSmoothScrollReport("\x1b[?2032;1$y")).toBe(true);
    expect(parseSmoothScrollReport("\x1b[?2032;2$y")).toBe(true);
    expect(parseSmoothScrollReport("\x1b[?2032;0$y")).toBe(false);
    expect(parseSmoothScrollReport("\x1b[?2032;4$y")).toBe(false);
    expect(parseSmoothScrollReport("\x1b[?2026;1$y")).toBeNull();
  });

  test("the reply reaches the control-sequence handler, not the keyboard", () => {
    const input: string[] = [];
    const control: string[] = [];
    const buffer = new TerminalControlBuffer((data) => input.push(data), (sequence) => control.push(sequence));
    buffer.feed("\x1b[?2032;2$yj");
    expect(control).toEqual(["\x1b[?2032;2$y"]);
    expect(input).toEqual(["j"]);
    buffer.dispose();
  });

  test("payloads", () => {
    expect(rectsPayload([{ top: 3, left: 29, bottom: 40, right: 100 }])).toBe("\x1b]2032;r;3,29,40,100\x1b\\");
    expect(rectsPayload([])).toBe("\x1b]2032;r\x1b\\");
    expect(offsetPayload(-250)).toBe("\x1b]2032;o;-250\x1b\\");
  });

  test("the ease runs from 1 to exactly 0", () => {
    expect(easeRemaining(0)).toBe(1);
    expect(easeRemaining(0.5)).toBeCloseTo(0.125);
    expect(easeRemaining(1)).toBe(0);
    expect(easeRemaining(3)).toBe(0);
  });
});

describe("SmoothScroller", () => {
  let now = 0;
  const rects = [{ top: 3, left: 1, bottom: 20, right: 80 }];
  const scroller = () => new SmoothScroller(100, () => now, 30);
  beforeEach(() => { now = 1000; });
  const moves = (out: string) => [...out.matchAll(/\x1b\]2032;m;(-?\d+)(?:;(-?\d+);(\d+))?\x1b\\/g)]
    .map((match) => [Number(match[1]), Number(match[2] ?? 0)]);
  const gridOf = (smooth: SmoothScroller) => (smooth as unknown as { grid: number }).grid;
  const offsetOf = (smooth: SmoothScroller) => (smooth as unknown as { offsetAt(time: number): number }).offsetAt(now);

  /** Run the animation to rest the way main.ts does; returns everything sent. */
  function settle(smooth: SmoothScroller, logical: number): string {
    let out = "";
    for (let i = 0; i < 40 && smooth.busy(); i++) {
      now += 8;
      if (!smooth.needsLayout()) continue;
      const before = gridOf(smooth);
      const grid = smooth.layout(logical, 100, 0, 20, "a");
      out += smooth.afterFlush(before - grid, rects);
    }
    return out;
  }

  test("an input is one move: the step, eased out by st, and rows laid out ahead", () => {
    const smooth = scroller();
    expect(smooth.layout(10, 100, 0, 20, "a")).toBe(10);
    expect(smooth.afterFlush(0, rects)).toBe(rectsPayload(rects));
    // Three rows towards older history: laid out ahead (the row just past
    // the position), so the offset is drawn higher, over lines st kept below.
    smooth.intend();
    const grid = smooth.layout(13, 100, 0, 20, "a");
    expect(grid).toBe(11);
    const out = smooth.afterFlush(10 - grid, rects);
    // base += 3 (target) - 1 (row laid out); -3 rows easing from now: no jump.
    expect(moves(out)).toEqual([[2000, -3000]]);
    expect(out).toContain(";100\x1b\\");
    // Each further row is a region scroll plus base -1; nothing in between.
    expect(moves(settle(smooth, 13))).toEqual([[-1000, 0], [-1000, 0]]);
    expect(smooth.busy()).toBe(false);
    expect(smooth.needsLayout()).toBe(false);
  });

  test("towards newer history rows are laid out behind (floor) and drawn lower", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    const grid = smooth.layout(7, 100, 0, 20, "a");
    expect(grid).toBe(9);
    expect(moves(smooth.afterFlush(10 - grid, rects))).toEqual([[-2000, 3000]]);
    settle(smooth, 7);
    expect(smooth.busy()).toBe(false);
  });

  test("a second input mid-glide adds to the first without a jump", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    const first = smooth.layout(13, 100, 0, 20, "a");
    smooth.afterFlush(10 - first, rects);
    now += 40;
    smooth.intend();
    const second = smooth.layout(16, 100, 0, 20, "a");
    const [[delta, ease]] = moves(smooth.afterFlush(first - second, rects));
    expect(ease).toBe(-3000);
    expect(delta).toBe(3000 - (second - first) * 1000);
    settle(smooth, 16);
    expect(smooth.busy()).toBe(false);
  });

  test("however fast inputs stack up, rows are laid out at most one past the glide", () => {
    // Key repeat / wheel momentum: 3 rows every 8 ms, laid out every 4 ms.
    const smooth = scroller();
    smooth.layout(100, 1000, 0, 40, "a");
    smooth.afterFlush(0, rects);
    let logical = 100;
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      now += 4;
      if (i % 2 === 0 && i < 40) {
        logical -= 3;
        smooth.intend();
      }
      const before = gridOf(smooth);
      smooth.afterFlush(before - smooth.layout(logical, 1000, 0, 40, "a"), rects);
      worst = Math.max(worst, Math.abs(offsetOf(smooth)));
    }
    expect(worst).toBeLessThanOrEqual(1 + SMOOTH_SCROLL_MARGIN_ROWS);
    for (let i = 0; i < 40 && smooth.busy(); i++) {
      now += 4;
      const before = gridOf(smooth);
      smooth.afterFlush(before - smooth.layout(logical, 1000, 0, 40, "a"), rects);
    }
    expect(smooth.busy()).toBe(false);
    expect(gridOf(smooth)).toBe(logical);
  });

  test("the next wake is when a row is due or the glide comes to rest, never a poll", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    let grid = smooth.layout(13, 100, 0, 20, "a");
    smooth.afterFlush(10 - grid, rects);
    const position = () => grid + offsetOf(smooth);
    let wakes = 0;
    for (let i = 0; i < 200 && smooth.busy(); i++) {
      const wait = smooth.nextWakeMs();
      expect(wait).toBeGreaterThanOrEqual(0);
      now += Math.max(1, wait);
      wakes++;
      if (!smooth.needsLayout()) continue;
      // Laid out with about a quarter row to spare (a 1 ms step moves < 0.1 row).
      if (grid < 13) expect(grid - position()).toBeGreaterThanOrEqual(SMOOTH_SCROLL_MARGIN_ROWS - 0.1);
      const next = smooth.layout(13, 100, 0, 20, "a");
      smooth.afterFlush(grid - next, rects);
      grid = next;
    }
    expect(grid).toBe(13);
    expect(smooth.busy()).toBe(false);
    // Two rows to lay out after the input's own frame, then rest: no 16 ms ticks.
    expect(wakes).toBeLessThanOrEqual(3);
  });

  test("pinning and a new context never animate", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    expect(smooth.layout(15, 100, 5, 20, "a")).toBe(15);
    expect(smooth.afterFlush(0, rects)).toBe("");
    expect(smooth.busy()).toBe(false);
    expect(smooth.layout(40, 100, 0, 20, "b")).toBe(40);
    expect(smooth.busy()).toBe(false);
  });

  test("a change of the offset without the user's intent snaps", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    expect(smooth.layout(0, 100, 0, 20, "a")).toBe(0);
    expect(moves(smooth.afterFlush(10, rects))).toEqual([]);
    expect(smooth.busy()).toBe(false);
  });

  test("a stale intent from before a context change does not glide the next change", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    expect(smooth.layout(30, 100, 0, 20, "b")).toBe(30);
    smooth.afterFlush(0, rects);
    expect(smooth.layout(0, 100, 0, 20, "b")).toBe(0);
    expect(smooth.busy()).toBe(false);
  });

  test("jumps further than a screen glide in from one screen away", () => {
    const smooth = scroller();
    smooth.layout(0, 1000, 0, 20, "a");
    smooth.afterFlush(0, rects);
    now += 1;
    smooth.intend();
    const grid = smooth.layout(500, 1000, 0, 20, "a");
    expect(grid).toBeGreaterThanOrEqual(480);
    expect(grid).toBeLessThan(500);
    // A repaint: st starts over at the laid-out rows and eases from there.
    const out = smooth.afterFlush(0, rects);
    expect(out).toContain(offsetPayload((500 - grid) * 1000));
    expect(moves(out)).toEqual([[0, -(500 - grid) * 1000]]);
    expect(smooth.busy()).toBe(true);
  });

  test("content that moved by itself at the bottom eases from where it was drawn", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.layout(0, 100, 0, 20, "a");
    // A message pushed everything up two rows: draw it two rows lower.
    expect(moves(smooth.afterFlush(2, rects, true))).toEqual([[0, 2000]]);
    expect(smooth.busy()).toBe(true);
    now += 120;
    expect(smooth.busy()).toBe(false);
  });

  test("content moved by a re-layout, not intact, or above the bottom snaps", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.relayoutNext();
    smooth.layout(0, 100, 0, 20, "a");
    expect(moves(smooth.afterFlush(2, rects, true))).toEqual([]);
    smooth.layout(0, 100, 0, 20, "a");
    expect(moves(smooth.afterFlush(2, rects, false))).toEqual([]);
    smooth.layout(5, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.layout(5, 100, 0, 20, "a");
    expect(moves(smooth.afterFlush(1, rects, true))).toEqual([]);
    expect(smooth.busy()).toBe(false);
  });

  test("a resize makes it send its rectangles again", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    expect(smooth.afterFlush(0, rects)).toContain("2032;r;");
    smooth.layout(0, 100, 0, 20, "a");
    expect(smooth.afterFlush(0, rects)).toBe("");
    smooth.terminalReset();
    smooth.layout(0, 100, 0, 20, "a");
    expect(smooth.afterFlush(0, rects)).toContain("2032;r;");
  });
});
