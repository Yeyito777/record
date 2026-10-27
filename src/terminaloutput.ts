/**
 * Non-blocking terminal output.
 *
 * In Bun (as in Node) a write to a TTY blocks until the terminal has read all
 * of it. A terminal that drains slowly (st on macOS reads its pty in small
 * pieces) therefore froze Record for as long as an image or video took to go
 * through: keys, timers and frames all waited (a 4 MB write to a slow reader
 * blocked for 10 s). Once installed, every process.stdout.write goes to a
 * writer thread in order and returns at once; Record tracks how far behind the
 * terminal is and draws its next frame once it has caught up.
 */

import { debugLog } from "./debuglog";

type Write = (chunk: unknown, ...rest: unknown[]) => boolean;

let worker: Worker | null = null;
let written: BigInt64Array | null = null;
let queued = 0n;
let directWrite: Write | null = null;
let drainedListeners: Array<() => void> = [];

/** Bytes handed to the terminal writer that the terminal has not read yet. */
export function terminalOutputBacklog(): number {
  if (!written) return 0;
  return Number(queued - Atomics.load(written, 0));
}

/** Run `listener` the next time the backlog drops to at most `bytes` (at once if it already has). */
export function whenTerminalOutputBelow(bytes: number, listener: () => void): void {
  if (terminalOutputBacklog() <= bytes) {
    listener();
    return;
  }
  const check = (): void => {
    if (terminalOutputBacklog() <= bytes) listener();
    else drainedListeners.push(check);
  };
  drainedListeners.push(check);
}

/** Route process.stdout writes through the writer thread (a TTY only). */
export function installTerminalOutput(): boolean {
  if (worker || !process.stdout.isTTY || process.env.RECORD_SYNC_OUTPUT === "1") return false;
  try {
    worker = new Worker(new URL("./terminalwriter.worker.ts", import.meta.url).href);
  } catch (error) {
    debugLog("terminal.output_worker_failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  const shared = new SharedArrayBuffer(8);
  written = new BigInt64Array(shared);
  worker.postMessage({ init: shared });
  worker.onmessage = () => {
    const listeners = drainedListeners;
    drainedListeners = [];
    for (const listener of listeners) listener();
  };
  (worker as unknown as { unref?: () => void }).unref?.();
  const stdout = process.stdout as unknown as { write: Write };
  directWrite = stdout.write.bind(process.stdout) as Write;
  stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    if (!worker) return directWrite!(chunk, ...rest);
    const callback = rest.find((value) => typeof value === "function") as (() => void) | undefined;
    if (typeof chunk === "string") {
      if (chunk.length === 0) return true;
      queued += BigInt(Buffer.byteLength(chunk));
      worker.postMessage(chunk);
    } else if (chunk instanceof Uint8Array) {
      if (chunk.byteLength === 0) return true;
      queued += BigInt(chunk.byteLength);
      worker.postMessage(chunk);
    } else {
      return directWrite!(chunk, ...rest);
    }
    if (callback) queueMicrotask(callback);
    return true;
  };
  // Exit: everything queued reaches the terminal before Record goes away.
  process.on("exit", () => flushTerminalOutputSync());
  return true;
}

/**
 * Block until the terminal has read everything queued (or `timeoutMs`), then
 * write directly again. For exit paths, where nothing asynchronous runs.
 */
export function flushTerminalOutputSync(timeoutMs = 2_000): void {
  if (!worker || !written) return;
  const deadline = performance.now() + timeoutMs;
  while (terminalOutputBacklog() > 0) {
    const left = deadline - performance.now();
    if (left <= 0) break;
    Atomics.wait(written, 0, Atomics.load(written, 0), Math.min(left, 50));
  }
  worker.terminate();
  worker = null;
  if (directWrite) (process.stdout as unknown as { write: Write }).write = directWrite;
}
