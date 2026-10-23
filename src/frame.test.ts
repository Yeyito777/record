import { describe, expect, test } from "bun:test";

import { appendRowWrite, clearLine, createFrameRows, flushFrame, invalidateFrame, moveTo, type RenderFrame } from "./frame";
import { VtScreen } from "./vtscreen.testutil";

function captureWrite(run: () => void): string {
  let output = "";
  const originalWrite = process.stdout.write;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
  }
  return output;
}

describe("retained terminal graphics frames", () => {
  test("image placement updates share the synchronized update with text", () => {
    const owner = {};
    const base = { rows: ["ROW"], cursor: "CURSOR", scrollRegion: null, viewStart: 0 };
    captureWrite(() => flushFrame(owner, base));

    // Even with no text change, a lone placement update is synchronized.
    const placementOnly = captureWrite(() => flushFrame(owner, base, { transmit: "", update: "PLACE" }));
    expect(placementOnly).toBe("\x1b[?2026hPLACECURSOR\x1b[?2026l");

    const withText = captureWrite(() => flushFrame(owner, { ...base, rows: ["NEW"] }, { transmit: "DATA", update: "PLACE" }));
    expect(withText).toBe("DATA\x1b[?2026hNEWPLACECURSOR\x1b[?2026l");

    // Invisible transfers alone do not open an update or move the cursor.
    expect(captureWrite(() => flushFrame(owner, { ...base, rows: ["NEW"] }, { transmit: "DATA", update: "" }))).toBe("DATA");
  });

  test("emits graphics after rows and only when placement identity changes", () => {
    const owner = {};
    const base = {
      rows: ["ROW"],
      cursor: "CURSOR",
      scrollRegion: null,
      viewStart: 0,
    };

    const first = captureWrite(() => flushFrame(owner, {
      ...base,
      graphics: { key: "image@1,1", payload: "GRAPHICS-ONE" },
    }));
    expect(first.indexOf("ROW")).toBeLessThan(first.indexOf("GRAPHICS-ONE"));
    expect(first.indexOf("GRAPHICS-ONE")).toBeLessThan(first.indexOf("CURSOR"));

    const unchanged = captureWrite(() => flushFrame(owner, {
      ...base,
      graphics: { key: "image@1,1", payload: "SHOULD-NOT-WRITE" },
    }));
    expect(unchanged).toBe("");

    const moved = captureWrite(() => flushFrame(owner, {
      ...base,
      graphics: { key: "image@1,2", payload: "GRAPHICS-TWO" },
    }));
    expect(moved).toContain("GRAPHICS-TWO");
    expect(moved).toContain("CURSOR");
  });

});

const PANE_TOP = 3;
const PANE_HEIGHT = 10;
const SCREEN_ROWS = PANE_TOP + PANE_HEIGHT + 1;
const SCREEN_COLS = 20;

/** A topbar, separator, message pane on rows 3..12 and a prompt row. */
function paneFrame(lines: string[], viewStart: number, options: { regionScrolls?: boolean; prompt?: string } = {}): RenderFrame {
  const rows = createFrameRows(SCREEN_ROWS, clearLine);
  appendRowWrite(rows, 1, 1, "TOP");
  appendRowWrite(rows, 2, 1, "-".repeat(SCREEN_COLS));
  for (let i = 0; i < PANE_HEIGHT; i++) {
    appendRowWrite(rows, PANE_TOP + i, 1, lines[viewStart + i] ?? "");
  }
  appendRowWrite(rows, SCREEN_ROWS, 1, `> ${options.prompt ?? ""}`);
  return {
    rows,
    cursor: moveTo(SCREEN_ROWS, 3),
    scrollRegion: { start: PANE_TOP, end: PANE_TOP + PANE_HEIGHT - 1 },
    viewStart,
    regionScrolls: options.regionScrolls ?? true,
  };
}

const history = Array.from({ length: 60 }, (_, i) => `message ${i}`);
const paneRow = (row: number, text: string) => moveTo(row, 1) + clearLine + moveTo(row, 1) + text;
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

function fullRepaint(frame: RenderFrame): string {
  const owner = {};
  return captureWrite(() => flushFrame(owner, frame));
}

describe("message pane region scrolls", () => {
  test("a small downward-in-history scroll emits DECSTBM + SU and only the exposed rows", () => {
    const owner = {};
    captureWrite(() => flushFrame(owner, paneFrame(history, 20)));

    const out = captureWrite(() => flushFrame(owner, paneFrame(history, 22)));
    expect(out).toBe(
      SYNC_BEGIN
      + "\x1b[3;12r\x1b[2S\x1b[r"
      + paneRow(11, "message 30")
      + paneRow(12, "message 31")
      + moveTo(SCREEN_ROWS, 3)
      + SYNC_END,
    );
  });

  test("a small upward-in-history scroll emits DECSTBM + SD and only the exposed rows", () => {
    const owner = {};
    captureWrite(() => flushFrame(owner, paneFrame(history, 20)));

    const out = captureWrite(() => flushFrame(owner, paneFrame(history, 17)));
    expect(out).toBe(
      SYNC_BEGIN
      + "\x1b[3;12r\x1b[3T\x1b[r"
      + paneRow(3, "message 17")
      + paneRow(4, "message 18")
      + paneRow(5, "message 19")
      + moveTo(SCREEN_ROWS, 3)
      + SYNC_END,
    );
  });

  test("other changed rows join the scroll frame", () => {
    const owner = {};
    captureWrite(() => flushFrame(owner, paneFrame(history, 20)));
    const edited = [...history];
    edited[25] = "message 25 (edited)";

    const out = captureWrite(() => flushFrame(owner, paneFrame(edited, 21, { prompt: "hi" })));
    expect(out).toBe(
      SYNC_BEGIN
      + "\x1b[3;12r\x1b[1S\x1b[r"
      + paneRow(7, "message 25 (edited)")
      + paneRow(12, "message 30")
      + paneRow(SCREEN_ROWS, "> hi")
      + moveTo(SCREEN_ROWS, 3)
      + SYNC_END,
    );
  });

  test("jumps of a pane height or more repaint the pane without scroll regions", () => {
    const owner = {};
    captureWrite(() => flushFrame(owner, paneFrame(history, 20)));

    const out = captureWrite(() => flushFrame(owner, paneFrame(history, 20 + PANE_HEIGHT)));
    expect(out).not.toContain("r\x1b[");
    expect(out).not.toMatch(/\x1b\[\d+[ST]/);
    for (let i = 0; i < PANE_HEIGHT; i++) expect(out).toContain(paneRow(PANE_TOP + i, `message ${30 + i}`));
  });

  test("a viewport remap without moving content (history prepend) does not scroll", () => {
    const owner = {};
    captureWrite(() => flushFrame(owner, paneFrame(history, 20)));
    const prepended = ["older 0", "older 1", "older 2", ...history];

    // Same visible lines, three indices later: nothing to write but the cursor.
    expect(captureWrite(() => flushFrame(owner, paneFrame(prepended, 23)))).toBe("");
  });

  test("a changed region (overlay, side column, resize) repaints instead", () => {
    const owner = {};
    captureWrite(() => flushFrame(owner, paneFrame(history, 20)));
    const next = { ...paneFrame(history, 22), scrollRegion: null };

    const out = captureWrite(() => flushFrame(owner, next));
    expect(out).not.toMatch(/\x1b\[\d+[ST]/);
    expect(out).not.toContain("\x1b[3;12r");
  });

  test("switched off, small scrolls emit the previous renderer's bytes", () => {
    const owner = {};
    captureWrite(() => flushFrame(owner, paneFrame(history, 20, { regionScrolls: false })));

    // Upward content moves keep the old line-feed region scroll.
    const up = captureWrite(() => flushFrame(owner, paneFrame(history, 22, { regionScrolls: false })));
    expect(up).toBe(
      SYNC_BEGIN
      + "\x1b[3;12r" + moveTo(12, 1) + "\n\n\x1b[r"
      + paneRow(11, "message 30")
      + paneRow(12, "message 31")
      + moveTo(SCREEN_ROWS, 3)
      + SYNC_END,
    );

    // Downward moves repaint every pane row, with no SD.
    const down = captureWrite(() => flushFrame(owner, paneFrame(history, 19, { regionScrolls: false })));
    let expected = "";
    for (let i = 0; i < PANE_HEIGHT; i++) expected += paneRow(PANE_TOP + i, `message ${19 + i}`);
    expect(down).toBe(SYNC_BEGIN + expected + moveTo(SCREEN_ROWS, 3) + SYNC_END);
  });

  test("after any sequence of scrolls and edits the screen equals a full repaint", () => {
    const owner = {};
    const screen = new VtScreen(SCREEN_ROWS, SCREEN_COLS);
    let lines = [...history];
    let viewStart = 25;
    screen.write(captureWrite(() => flushFrame(owner, paneFrame(lines, viewStart))));

    // Deterministic walk: small and large moves both ways, edits, prepends.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let scrolled = 0;
    for (let step = 0; step < 300; step++) {
      const roll = random();
      if (roll < 0.1) {
        lines = [`older ${step}`, ...lines];
        viewStart += 1;
      } else if (roll < 0.2) {
        const index = viewStart + Math.floor(random() * PANE_HEIGHT);
        lines[index] = `edit ${step}`;
      } else if (roll < 0.25) {
        lines.push(`new ${step}`);
      } else {
        const delta = Math.floor(random() * (PANE_HEIGHT + 4) * 2) - (PANE_HEIGHT + 4);
        viewStart += delta;
      }
      viewStart = Math.max(0, Math.min(viewStart, lines.length - PANE_HEIGHT));
      const frame = paneFrame(lines, viewStart, { prompt: String(step % 3) });
      const out = captureWrite(() => flushFrame(owner, frame));
      if (/\x1b\[\d+[ST]/.test(out)) scrolled++;
      screen.write(out);

      const reference = new VtScreen(SCREEN_ROWS, SCREEN_COLS);
      reference.write(fullRepaint(frame));
      expect(screen.snapshot()).toBe(reference.snapshot());
    }
    expect(scrolled).toBeGreaterThan(50);
    invalidateFrame(owner);
  });
});

