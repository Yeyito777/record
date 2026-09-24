import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { instagramAuthPath } from "./auth";

/** Explicit false overrides also matter: unmuting locally must beat remote mute. */
export type InstagramMuteOverrides = Record<string, boolean>;

export function instagramMutePath(accountId: string): string {
  if (!/^\d+$/.test(accountId)) throw new Error("Invalid Instagram account ID.");
  return join(dirname(instagramAuthPath()), "accounts", accountId, "local-mutes.json");
}

function validateOverrides(value: unknown): InstagramMuteOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([id, muted]) => !/^\d+$/.test(id) || typeof muted !== "boolean")) {
    throw new Error("Invalid Instagram local mute settings.");
  }
  return { ...value } as InstagramMuteOverrides;
}

export function loadInstagramMutes(accountId: string): InstagramMuteOverrides {
  try {
    const data = JSON.parse(readFileSync(instagramMutePath(accountId), "utf8"));
    if (data.version !== 1) throw new Error("Unsupported Instagram mute settings version.");
    return validateOverrides(data.overrides);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveInstagramMutes(accountId: string, overrides: InstagramMuteOverrides): Promise<void> {
  const path = instagramMutePath(accountId);
  const data = JSON.stringify({ version: 1, overrides: validateOverrides(overrides) });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function isInstagramThreadMuted(overrides: InstagramMuteOverrides, thread: { thread_id: string; muted?: boolean }): boolean {
  return overrides[thread.thread_id] ?? Boolean(thread.muted);
}
