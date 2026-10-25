/**
 * Long-lived helper processes Record must never leave behind: the WhatsApp
 * worker, voice engine, stream helper, call widget, players and recorders.
 *
 * Owners still stop their processes normally; this registry is the backstop
 * every exit path (quit, TERM/HUP/INT, crash) runs synchronously at the end.
 * Programs opened for the user (openers) are intentionally not tracked.
 */

import type { ChildProcess } from "child_process";

interface TrackedProcess {
  pid?: number;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | string | null;
  kill(signal?: NodeJS.Signals | number): unknown;
}

interface TrackOptions {
  /** Spawned detached as its own process group: signal the whole group. */
  group?: boolean;
}

const tracked = new Map<TrackedProcess, TrackOptions>();

/** Register a child until it exits; returns it for inline use. */
export function trackChildProcess<T extends ChildProcess | TrackedProcess>(child: T, options: TrackOptions = {}): T {
  const entry = child as unknown as TrackedProcess;
  tracked.set(entry, options);
  const forget = () => { tracked.delete(entry); };
  const nodeChild = child as unknown as Partial<ChildProcess>;
  if (typeof nodeChild.once === "function") {
    nodeChild.once("exit", forget);
    nodeChild.once("error", forget);
  }
  const exited = (child as unknown as { exited?: Promise<unknown> }).exited;
  if (exited && typeof exited.then === "function") void exited.then(forget, forget);
  return child;
}

function alive(child: TrackedProcess): boolean {
  return child.exitCode === null && !child.signalCode;
}

/** Signal every tracked child that is still running. Synchronous; never throws. */
export function killTrackedChildProcesses(signal: NodeJS.Signals = "SIGTERM"): number {
  let signalled = 0;
  for (const [child, options] of [...tracked]) {
    if (!alive(child)) {
      tracked.delete(child);
      continue;
    }
    try {
      if (options.group && child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
      signalled++;
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }
  return signalled;
}

export function trackedChildProcessCount(): number {
  return [...tracked.keys()].filter(alive).length;
}
