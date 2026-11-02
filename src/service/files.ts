/** Private files for the bridge's state and cache: root-only, written atomically. */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Writes `data` to `path` (mode 0600) through a temporary file and a rename. */
export function writePrivateAtomic(path: string, data: string | Uint8Array): void {
  ensurePrivateDir(dirname(path));
  const temporary = `${path}.tmp${process.pid}`;
  writeFileSync(temporary, data, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** The parsed JSON at `path`, or null when it is missing or unreadable. */
export function readJson<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
