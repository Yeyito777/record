/**
 * Debug log: what Record writes to the terminal. Writes go through a writer
 * thread (terminaloutput.ts), so they no longer block; what the terminal has
 * not read yet is the backlog, and every byte in it is a byte a key's frame
 * waits behind.
 *
 * `tty.stats` every few seconds: bytes and writes per second for media (GIF
 * and video packets) and for everything else (frames, pictures, controls),
 * the largest backlog seen, and the milliseconds per second writes blocked
 * (only with RECORD_SYNC_OUTPUT=1).
 *
 * RECORD_PERF_PROBE=1 also measures how long a key takes to reach the
 * terminal's screen state: after the frame a key produced, a status request
 * (DSR, `ESC [ 5 n`) goes out; the terminal answers once it has processed
 * every byte before it. `perf.key` logs key-to-answer milliseconds.
 */

const STATS_EVERY_MS = 5000;

type Kind = "media" | "other";

interface Counters {
  bytes: number;
  writes: number;
  blockedMs: number;
}

let mediaWriting = false;
const counters: Record<Kind, Counters> = {
  media: { bytes: 0, writes: 0, blockedMs: 0 },
  other: { bytes: 0, writes: 0, blockedMs: 0 },
};
let maxBlock = { ms: 0, kind: "other" as Kind, bytes: 0 };
let maxBacklog = 0;
let since = 0;
let installed = false;

function reset(now: number): void {
  for (const kind of ["media", "other"] as const) counters[kind] = { bytes: 0, writes: 0, blockedMs: 0 };
  maxBlock = { ms: 0, kind: "other", bytes: 0 };
  maxBacklog = 0;
  since = now;
}

/** Count every write to stdout; log a summary every few seconds while there are writes. */
export function installTtyStats(log: (event: string, fields: Record<string, unknown>) => void, backlog: () => number = () => 0): void {
  if (installed) return;
  installed = true;
  since = performance.now();
  const stdout = process.stdout as unknown as { write: (...args: unknown[]) => boolean };
  const original = stdout.write.bind(stdout);
  stdout.write = (...args: unknown[]): boolean => {
    const chunk = args[0];
    const bytes = typeof chunk === "string" ? chunk.length : chunk instanceof Uint8Array ? chunk.byteLength : 0;
    const kind: Kind = mediaWriting ? "media" : "other";
    const started = performance.now();
    const result = original(...args);
    const ended = performance.now();
    const ms = ended - started;
    const counter = counters[kind];
    // Media is counted by writeMedia (it may not come through here).
    if (kind === "other") {
      counter.bytes += bytes;
      counter.writes += 1;
    }
    counter.blockedMs += ms;
    if (ms > maxBlock.ms) maxBlock = { ms, kind, bytes };
    maxBacklog = Math.max(maxBacklog, backlog());
    if (ended - since >= STATS_EVERY_MS) {
      const seconds = (ended - since) / 1000;
      const per = (value: number) => Math.round(value / seconds);
      log("tty.stats", {
        mediaBytesPerSec: per(counters.media.bytes),
        otherBytesPerSec: per(counters.other.bytes),
        mediaWritesPerSec: per(counters.media.writes),
        otherWritesPerSec: per(counters.other.writes),
        mediaBlockedMsPerSec: per(counters.media.blockedMs),
        otherBlockedMsPerSec: per(counters.other.blockedMs),
        maxBlockMs: Math.round(maxBlock.ms),
        maxBlockKind: maxBlock.kind,
        maxBlockBytes: maxBlock.bytes,
        maxBacklogBytes: maxBacklog,
      });
      reset(ended);
    }
    return result;
  };
}

/** Write media (GIF and video packets) with `write` (the writer's bulk lane): counted apart from frames. */
export function writeMedia(data: string, write: (data: string) => void = (chunk) => { process.stdout.write(chunk); }): void {
  counters.media.bytes += data.length;
  counters.media.writes += 1;
  mediaWriting = true;
  try {
    write(data);
  } finally {
    mediaWriting = false;
  }
}

/** The status request the key probe sends, and the terminal's answer. */
export const DSR_REQUEST = "\x1b[5n";
export function isDsrAnswer(sequence: string): boolean {
  return sequence === "\x1b[0n";
}

/**
 * RECORD_PERF_PROBE=1: key-to-terminal latency. `keyPressed()` when a key
 * arrives; `frameWritten()` after the frame that follows (once per key
 * batch); the answer to the status request then logs `perf.key`.
 */
export class KeyLatencyProbe {
  private keyAt: number | null = null;
  private waiting: { keyAt: number; writtenAt: number }[] = [];

  constructor(
    private readonly write: (data: string) => void,
    private readonly log: (event: string, fields: Record<string, unknown>) => void,
  ) {}

  keyPressed(): void {
    this.keyAt ??= performance.now();
  }

  frameWritten(): void {
    if (this.keyAt === null) return;
    // At most a few in flight: a terminal that stopped answering is not flooded.
    if (this.waiting.length < 8) {
      this.waiting.push({ keyAt: this.keyAt, writtenAt: performance.now() });
      this.write(DSR_REQUEST);
    }
    this.keyAt = null;
  }

  /** The terminal answered a status request: true if it was the probe's. */
  answered(sequence: string): boolean {
    if (!isDsrAnswer(sequence)) return false;
    const sent = this.waiting.shift();
    const now = performance.now();
    // ms: key to answer; frameMs: key to the frame written; terminalMs: frame written to answer.
    if (sent) this.log("perf.key", { ms: Math.round(now - sent.keyAt), frameMs: Math.round(sent.writtenAt - sent.keyAt), terminalMs: Math.round(now - sent.writtenAt) });
    return true;
  }
}
