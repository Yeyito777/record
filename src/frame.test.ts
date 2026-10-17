import { describe, expect, test } from "bun:test";

import { flushFrame } from "./frame";

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
