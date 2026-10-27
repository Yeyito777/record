/**
 * Opt-in performance trace for measuring Record on real hardware.
 *
 * RECORD_PERF_LOG=path writes one JSON line per rendered frame (render time,
 * bytes written to the terminal since the previous frame) and per stall of
 * the event loop, then a summary with percentiles when Record exits. Off by
 * default; costs nothing when unset.
 */

import { closeSync, openSync, writeSync } from "fs";

const path = process.env.RECORD_PERF_LOG?.trim() || null;

let fd: number | null = null;
let bytesSinceFrame = 0;
let writes = 0;
let totalBytes = 0;
const frameMs: number[] = [];
const stallMs: number[] = [];
const inputToFrameMs: number[] = [];
const inputToTerminalMs: number[] = [];
let inputAt: number | null = null;
const started = performance.now();

export const perfTraceEnabled = path !== null;

function line(record: Record<string, unknown>): void {
  if (fd === null) return;
  try {
    writeSync(fd, `${JSON.stringify({ t: Math.round(performance.now() - started), ...record })}\n`);
  } catch {
    // Tracing must never affect the client.
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! * 10) / 10;
}

/** Start tracing (if enabled): count terminal bytes and watch for event-loop stalls. */
export function startPerfTrace(): void {
  if (!path || fd !== null) return;
  fd = openSync(path, "w", 0o600);
  const stdout = process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const original = stdout.write.bind(process.stdout);
  stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk as Uint8Array).byteLength ?? 0;
    bytesSinceFrame += size;
    totalBytes += size;
    writes += 1;
    return original(chunk, ...rest);
  };
  // A 10 ms timer that fires late measures how long the loop was blocked.
  let expected = performance.now() + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    if (late >= 25) {
      stallMs.push(late);
      line({ stall: Math.round(late) });
    }
    expected = now + 10;
  }, 10);
  timer.unref?.();
  process.once("exit", () => {
    const seconds = (performance.now() - started) / 1000;
    const cpu = process.cpuUsage();
    line({
      summary: true,
      seconds: Math.round(seconds * 10) / 10,
      cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / (seconds * 1000)) * 1000) / 10,
      frames: frameMs.length,
      frameP50: percentile(frameMs, 0.5),
      frameP90: percentile(frameMs, 0.9),
      frameP99: percentile(frameMs, 0.99),
      frameMax: percentile(frameMs, 1),
      keyToFrameP50: percentile(inputToFrameMs, 0.5),
      keyToFrameP90: percentile(inputToFrameMs, 0.9),
      keyToTerminalP50: percentile(inputToTerminalMs, 0.5),
      keyToTerminalP90: percentile(inputToTerminalMs, 0.9),
      keyToTerminalMax: percentile(inputToTerminalMs, 1),
      stalls: stallMs.length,
      stallMax: percentile(stallMs, 1),
      writes,
      bytes: totalBytes,
      bytesPerSecond: Math.round(totalBytes / Math.max(0.001, seconds)),
    });
    if (fd !== null) closeSync(fd);
    fd = null;
  });
}

/** Bytes written to the terminal without process.stdout.write (the writer's bulk lane). */
export function tracePerfBytes(bytes: number): void {
  if (fd === null) return;
  bytesSinceFrame += bytes;
  totalBytes += bytes;
  writes += 1;
}

/** Input arrived (keys, mouse): the next frame's latency is measured from here. */
export function tracePerfInput(): void {
  if (fd !== null && inputAt === null) inputAt = performance.now();
}

/**
 * One rendered frame: how long it took and what it wrote. `written(cb)` runs
 * cb once this frame's bytes have been handed to the terminal.
 */
export function tracePerfFrame(ms: number, fields: Record<string, unknown> = {}, written?: (done: () => void) => void): void {
  if (fd === null) return;
  frameMs.push(ms);
  if (inputAt !== null) {
    const since = inputAt;
    inputAt = null;
    inputToFrameMs.push(performance.now() - since);
    written?.(() => inputToTerminalMs.push(performance.now() - since));
  }
  line({ frame: Math.round(ms * 100) / 100, bytes: bytesSinceFrame, ...fields });
  bytesSinceFrame = 0;
}

/** A named span (image decode, video packet, cache write) worth seeing in the trace. */
export function tracePerfSpan(name: string, ms: number, fields: Record<string, unknown> = {}): void {
  if (fd === null || ms < 2) return;
  line({ span: name, ms: Math.round(ms * 100) / 100, ...fields });
}
