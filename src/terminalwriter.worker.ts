/**
 * Writes Record's terminal output on its own thread (see terminaloutput.ts).
 * A write to a terminal blocks until the terminal has read it; here that only
 * blocks this thread, never Record's event loop.
 *
 * Two lanes: interactive output (frames, cursor, queries) is written before
 * queued bulk output (GIF packets), so keys and scrolling are not stuck behind
 * media the terminal is still reading. Each message is written whole; lanes
 * only alternate between messages, never inside an escape sequence.
 */

import { writeSync } from "fs";

declare const self: Worker;

type Message = { init: SharedArrayBuffer } | { bulk: string | Uint8Array } | { dropBulk: true } | string | Uint8Array;

/** [0] bytes done (written or dropped), [1] interactive bytes done. */
let counters: BigInt64Array | null = null;
const interactive: Buffer[] = [];
const bulk: Buffer[] = [];
let pumping = false;

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function done(bytes: number, isInteractive: boolean): void {
  if (!counters) return;
  Atomics.add(counters, 0, BigInt(bytes));
  if (isInteractive) Atomics.add(counters, 1, BigInt(bytes));
  Atomics.notify(counters, 0);
}

let terminalGone = false;

/** Write all of `bytes`, counting progress as the terminal takes it. */
function writeWhole(bytes: Buffer, isInteractive: boolean): void {
  let offset = 0;
  while (offset < bytes.length && !terminalGone) {
    try {
      const count = writeSync(1, bytes, offset, Math.min(bytes.length - offset, 16 * 1024));
      offset += count;
      done(count, isInteractive);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      // The terminal went away (EIO): nothing more can be written.
      terminalGone = true;
    }
  }
  if (offset < bytes.length) done(bytes.length - offset, isInteractive);
}

function pump(): void {
  pumping = false;
  const isInteractive = interactive.length > 0;
  const next = isInteractive ? interactive.shift() : bulk.shift();
  if (!next) return;
  writeWhole(next, isInteractive);
  self.postMessage(0);
  if (interactive.length > 0 || bulk.length > 0) {
    pumping = true;
    // Yield, so output posted meanwhile (a frame) is seen before the next pick.
    setImmediate(pump);
  }
}

self.onmessage = (event: MessageEvent<Message>) => {
  const data = event.data;
  if (typeof data === "object" && data && "init" in data) {
    counters = new BigInt64Array(data.init);
    return;
  }
  if (typeof data === "object" && data && "dropBulk" in data) {
    const dropped = bulk.splice(0).reduce((sum, item) => sum + item.length, 0);
    done(dropped, false);
    return;
  }
  if (typeof data === "object" && data && "bulk" in data) bulk.push(toBuffer(data.bulk));
  else interactive.push(toBuffer(data as string | Uint8Array));
  if (!pumping) {
    pumping = true;
    setImmediate(pump);
  }
};
