/**
 * Private, atomic writes for Instagram's files (session, chat cache, local
 * mutes) that leave no temp file behind: each write's temp file is removed if
 * the write fails or Record exits mid-write, and a startup sweep removes those
 * a kill or crash left (`<name>.json.<pid>.<uuid>.tmp`, or the older
 * `<name>.json.<uuid>.tmp`).
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const inFlight = new Set<string>();
let exitHookInstalled = false;
const STALE_TEMP_MS = 10 * 60_000;
/** Older temp names carry no writer pid: any writer is long done after this. */
const LEGACY_TEMP_MS = 60_000;
const TEMP_NAME = /^(session|cache|local-mutes)\.json\.(?:(\d+)\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** 0600 in a 0700 directory, renamed into place. */
export async function writePrivateFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => { for (const temp of inFlight) rmSync(temp, { force: true }); });
  }
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  inFlight.add(temporary);
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    inFlight.delete(temporary);
    await rm(temporary, { force: true });
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function sweepIn(directory: string, now: number): number {
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const match = TEMP_NAME.exec(name);
    if (!match) continue;
    const file = join(directory, name);
    if (inFlight.has(file)) continue;
    try {
      const age = now - statSync(file).mtimeMs;
      const pid = match[2] ? Number(match[2]) : 0;
      // Another running Record's write in progress is left alone.
      if (pid > 0 ? processAlive(pid) && age < STALE_TEMP_MS : age < LEGACY_TEMP_MS) continue;
      rmSync(file, { force: true });
      removed++;
    } catch {
      // Raced with its writer finishing.
    }
  }
  return removed;
}

/** Remove leftover temp files in the Instagram directory and its account directories. */
export function sweepInstagramTemps(directory: string, now = Date.now()): number {
  let removed = sweepIn(directory, now);
  let accounts: string[] = [];
  try { accounts = readdirSync(join(directory, "accounts")); } catch { /* none yet */ }
  for (const account of accounts) removed += sweepIn(join(directory, "accounts", account), now);
  return removed;
}
