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

async function captureWriteAsync(run: () => Promise<void>): Promise<string> {
  let output = "";
  const originalWrite = process.stdout.write;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
  }
  return output;
}

describe("retained terminal graphics frames", () => {
  test("emits graphics after rows and only when placement identity changes", () => {
    const owner = {};
    const base = {
      rows: ["ROW"],
      cursor: "CURSOR",
      terminalCursor: null,
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

  test("settles st cursor damage with a separate image repaint", async () => {
    const owner = {};
    const graphics = {
      key: "image@4,10",
      payload: "INITIAL-GRAPHICS",
      repaintPayload: "REPAINT-GRAPHICS",
      cells: [{ row: 4, startCol: 10, endCol: 11 }],
    };

    const output = await captureWriteAsync(async () => {
      flushFrame(owner, {
        rows: ["ROW"],
        cursor: "CURSOR-ON-IMAGE",
        terminalCursor: { row: 4, col: 10 },
        scrollRegion: null,
        viewStart: 0,
        graphics,
      });
      flushFrame(owner, {
        rows: ["ROW"],
        cursor: "CURSOR-AWAY",
        terminalCursor: { row: 4, col: 12 },
        scrollRegion: null,
        viewStart: 0,
        graphics,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(output).toContain("CURSOR-AWAY");
    expect(output).toContain("REPAINT-GRAPHICS");
    expect(output.lastIndexOf("REPAINT-GRAPHICS")).toBeLessThan(output.lastIndexOf("CURSOR-AWAY"));
  });
});
