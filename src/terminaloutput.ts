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
import { tracePerfBytes } from "./perftrace";

type Write = (chunk: unknown, ...rest: unknown[]) => boolean;

let worker: Worker | null = null;
/** [0] bytes done (written or dropped), [1] interactive bytes done, [2] bulk bytes done. */
let written: BigInt64Array | null = null;
let queued = 0n;
let queuedInteractive = 0n;
let queuedBulk = 0n;
/** Callbacks for bulk writes, by the bulk byte count at which each is done (FIFO). */
const bulkDone: Array<{ target: bigint; callback: () => void }> = [];
let directWrite: Write | null = null;
const waiters = new Set<{ bytes: number; listener: () => void }>();

/** Bytes handed to the terminal writer that the terminal has not read yet (both lanes). */
export function terminalOutputBacklog(): number {
  if (!written) return 0;
  return Number(queued - Atomics.load(written, 0));
}

/** Unread interactive output (frames, cursor, queries): what the next frame would wait behind. */
export function terminalInteractiveBacklog(): number {
  if (!written) return 0;
  return Number(queuedInteractive - Atomics.load(written, 1));
}

/**
 * Write media (GIF packets and the commands that open, query or close them):
 * the terminal gets it in order, after any interactive output queued at the
 * same time. Without the writer thread, it is a normal write.
 */
export function writeTerminalBulk(data: string, onWritten?: () => void, continues = false): void {
  if (!worker) {
    process.stdout.write(data);
    onWritten?.();
    return;
  }
  if (data.length === 0) {
    onWritten?.();
    return;
  }
  const size = BigInt(Buffer.byteLength(data));
  tracePerfBytes(Number(size));
  queued += size;
  queuedBulk += size;
  if (onWritten) bulkDone.push({ target: queuedBulk, callback: onWritten });
  worker.postMessage({ bulk: data, continues });
}

/** Group a chunked Kitty transfer into pieces of about this size. */
const TRANSFER_PIECE_CHARS = 32 * 1024;

/**
 * Write one chunked picture transfer (a=t,m=1 ... m=0) as background output
 * in ~32 KiB pieces: frames without graphics commands (typing, the prompt)
 * can reach the terminal between pieces instead of after the whole picture.
 */
export function writeTerminalBulkTransfer(data: string, onWritten?: () => void): void {
  const pieces: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = start + TRANSFER_PIECE_CHARS;
    if (end >= data.length) end = data.length;
    else {
      // Cut only after a whole command (ESC \ ends each chunk).
      const boundary = data.indexOf("\x1b\\", end);
      end = boundary < 0 ? data.length : boundary + 2;
    }
    pieces.push(data.slice(start, end));
    start = end;
  }
  pieces.forEach((piece, index) => {
    const last = index === pieces.length - 1;
    writeTerminalBulk(piece, last ? onWritten : undefined, !last);
  });
}

/** Whether bulk output can complete asynchronously (the writer thread runs). */
export function terminalOutputIsAsync(): boolean {
  return worker !== null;
}

/**
 * Run `listener` once the backlog drops to at most `bytes` (at once if it
 * already has). Returns a function that cancels the wait.
 */
export function whenTerminalOutputBelow(bytes: number, listener: () => void): () => void {
  if (terminalInteractiveBacklog() <= bytes) {
    listener();
    return () => {};
  }
  const waiter = { bytes, listener };
  waiters.add(waiter);
  return () => { waiters.delete(waiter); };
}

/** Run `listener` once every interactive byte queued so far has been written to the terminal. */
export function whenInteractiveOutputWritten(listener: () => void): void {
  if (!written) {
    listener();
    return;
  }
  const target = queuedInteractive;
  if (Atomics.load(written, 1) >= target) {
    listener();
    return;
  }
  const waiter = { bytes: -1, listener, target };
  writtenWaiters.add(waiter);
}

const writtenWaiters = new Set<{ bytes: number; listener: () => void; target: bigint }>();

/** Route process.stdout writes through the writer thread (a TTY only). */
export function installTerminalOutput(): boolean {
  if (worker || !process.stdout.isTTY || process.env.RECORD_SYNC_OUTPUT === "1") return false;
  try {
    worker = new Worker(new URL("./terminalwriter.worker.ts", import.meta.url).href);
  } catch (error) {
    debugLog("terminal.output_worker_failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  const shared = new SharedArrayBuffer(24);
  written = new BigInt64Array(shared);
  worker.postMessage({ init: shared });
  worker.onmessage = () => {
    if (bulkDone.length > 0 && written) {
      const done = Atomics.load(written, 2);
      while (bulkDone.length > 0 && bulkDone[0]!.target <= done) bulkDone.shift()!.callback();
    }
    if (writtenWaiters.size > 0 && written) {
      const done = Atomics.load(written, 1);
      for (const waiter of [...writtenWaiters]) {
        if (done < waiter.target) continue;
        writtenWaiters.delete(waiter);
        waiter.listener();
      }
    }
    if (waiters.size === 0) return;
    const backlog = terminalInteractiveBacklog();
    for (const waiter of [...waiters]) {
      if (backlog > waiter.bytes) continue;
      waiters.delete(waiter);
      waiter.listener();
    }
  };
  (worker as unknown as { unref?: () => void }).unref?.();
  const stdout = process.stdout as unknown as { write: Write };
  directWrite = stdout.write.bind(process.stdout) as Write;
  stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    if (!worker) return directWrite!(chunk, ...rest);
    const callback = rest.find((value) => typeof value === "function") as (() => void) | undefined;
    if (typeof chunk === "string") {
      if (chunk.length === 0) return true;
      const size = BigInt(Buffer.byteLength(chunk));
      queued += size;
      queuedInteractive += size;
      worker.postMessage(chunk);
    } else if (chunk instanceof Uint8Array) {
      if (chunk.byteLength === 0) return true;
      queued += BigInt(chunk.byteLength);
      queuedInteractive += BigInt(chunk.byteLength);
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
  // Media still queued is no use once Record is leaving.
  worker.postMessage({ dropBulk: true });
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
