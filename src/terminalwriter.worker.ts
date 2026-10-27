/**
 * Writes Record's terminal output on its own thread (see terminaloutput.ts).
 * A write to a terminal blocks until the terminal has read it; here that only
 * blocks this thread, never Record's event loop.
 */

import { writeSync } from "fs";

declare const self: Worker;

const CHUNK_BYTES = 64 * 1024;
let written: BigInt64Array | null = null;

self.onmessage = (event: MessageEvent<{ init: SharedArrayBuffer } | string | Uint8Array>) => {
  const data = event.data;
  if (typeof data === "object" && data && "init" in data) {
    written = new BigInt64Array(data.init);
    return;
  }
  const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, Math.min(bytes.length - offset, CHUNK_BYTES));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      // The terminal went away (EIO): nothing more can be written.
      break;
    }
  }
  if (!written) return;
  Atomics.add(written, 0, BigInt(bytes.length));
  Atomics.notify(written, 0);
  self.postMessage(Number(Atomics.load(written, 0)));
};
