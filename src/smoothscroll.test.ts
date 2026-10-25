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
  /** The region a frame's region scroll moved (the band). */
  const band = { start: 3, end: 20 };
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

  test("an input is one move and one region scroll: laid out at the target, st glides from its kept lines", () => {
    const smooth = scroller();
    expect(smooth.layout(10, 100, 0, 20, "a")).toBe(10);
    expect(smooth.afterFlush(0, rects)).toBe(rectsPayload(rects));
    // Three rows towards older history: the history is laid out there at
    // once (the region scroll pushes out the lines st draws the glide from),
    // and one easing term of -3 rows keeps it where it was at first.
    smooth.intend();
    const grid = smooth.layout(13, 100, 0, 20, "a");
    expect(grid).toBe(13);
    const out = smooth.afterFlush(10 - grid, rects, true, band);
    expect(moves(out)).toEqual([[0, -3000]]);
    expect(out).toContain(";100\x1b\\");
    // Nothing more until it rests.
    expect(smooth.needsLayout()).toBe(false);
    expect(settle(smooth, 13)).toBe("");
    expect(smooth.busy()).toBe(false);
  });

  test("towards newer history the same: one scroll, drawn lower at first", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    const grid = smooth.layout(7, 100, 0, 20, "a");
    expect(grid).toBe(7);
    expect(moves(smooth.afterFlush(10 - grid, rects, true, band))).toEqual([[0, 3000]]);
    settle(smooth, 7);
    expect(smooth.busy()).toBe(false);
  });

  test("a second input mid-glide adds to the first without a jump", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    const first = smooth.layout(13, 100, 0, 20, "a");
    smooth.afterFlush(10 - first, rects, true, band);
    now += 40;
    smooth.intend();
    const second = smooth.layout(16, 100, 0, 20, "a");
    expect(second).toBe(16);
    expect(moves(smooth.afterFlush(first - second, rects, true, band))).toEqual([[0, -3000]]);
    settle(smooth, 16);
    expect(smooth.busy()).toBe(false);
  });

  test("however fast inputs stack up, the offset stays within the lines the scrolls kept", () => {
    // Key repeat / wheel momentum: 3 rows every 8 ms, frames every 4 ms.
    const smooth = scroller();
    smooth.layout(100, 1000, 0, 40, "a");
    smooth.afterFlush(0, rects);
    let logical = 100;
    let kept = 0;
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      now += 4;
      if (i % 2 === 0 && i < 40) {
        logical -= 3;
        smooth.intend();
      }
      const before = gridOf(smooth);
      const grid = smooth.layout(logical, 1000, 0, 40, "a");
      kept = Math.min(40, before === grid ? kept : kept + Math.abs(before - grid));
      smooth.afterFlush(before - grid, rects, true, band);
      if (!smooth.busy()) kept = 0;
      worst = Math.max(worst, Math.abs(offsetOf(smooth)) - kept);
    }
    expect(worst).toBeLessThanOrEqual(0);
    for (let i = 0; i < 40 && smooth.busy(); i++) {
      now += 4;
      const before = gridOf(smooth);
      smooth.afterFlush(before - smooth.layout(logical, 1000, 0, 40, "a"), rects, true, band);
    }
    expect(smooth.busy()).toBe(false);
    expect(gridOf(smooth)).toBe(logical);
  });

  test("the only wake after an input is when the glide comes to rest, never a poll", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    const grid = smooth.layout(13, 100, 0, 20, "a");
    smooth.afterFlush(10 - grid, rects, true, band);
    const wait = smooth.nextWakeMs();
    expect(wait).toBeGreaterThanOrEqual(100);
    now += wait;
    expect(smooth.needsLayout()).toBe(false);
    expect(smooth.busy()).toBe(false);
  });

  test("further than a band in one go: one region scroll per frame, each when due", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    smooth.afterFlush(0, rects, false, band);
    smooth.intend();
    // 16 rows in a 18-row band: 15 rows (band - 3) now, the last one when due.
    let grid = smooth.layout(16, 100, 0, 20, "a");
    expect(grid).toBe(15);
    smooth.afterFlush(0 - grid, rects, true, band);
    let frames = 0;
    for (let i = 0; i < 200 && smooth.busy(); i++) {
      now += Math.max(1, smooth.nextWakeMs());
      if (!smooth.needsLayout()) continue;
      frames++;
      const next = smooth.layout(16, 100, 0, 20, "a");
      smooth.afterFlush(grid - next, rects, true, band);
      grid = next;
    }
    expect(frames).toBe(1);
    expect(grid).toBe(16);
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
    // The next frame is one region scroll as far as the band allows (st
    // kept nothing to glide from before it): 18 rows - 3.
    now += 1;
    expect(smooth.needsLayout()).toBe(true);
    expect(smooth.layout(500, 1000, 0, 20, "a")).toBe(Math.min(500, grid + 15));
  });

  test("a band edge that moved under a glide (more than a row) snaps it instead of showing an empty strip", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects, false, band);
    smooth.intend();
    const grid = smooth.layout(14, 100, 0, 20, "a");
    smooth.afterFlush(10 - grid, rects, true, band);
    now += 10;
    // An overlay took the band's last rows while the strip is at the bottom.
    smooth.layout(14, 100, 0, 20, "a");
    const out = smooth.afterFlush(0, [{ ...rects[0]!, bottom: 15 }]);
    expect(out).toContain(offsetPayload(0));
    expect(smooth.busy()).toBe(false);
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

  test("content that arrived at the bottom stays laid out where it ends: no frames until rest", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.layout(0, 100, 0, 20, "a");
    smooth.afterFlush(3, rects, true);
    let frames = 0;
    for (let i = 0; i < 40 && smooth.busy(); i++) {
      now += Math.max(1, smooth.nextWakeMs());
      if (smooth.needsLayout()) frames++;
    }
    expect(frames).toBe(0);
    expect(smooth.busy()).toBe(false);
    expect(gridOf(smooth)).toBe(0);
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
