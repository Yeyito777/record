import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { instagramAuthPath } from "./auth";
import type { InstagramOutgoing } from "./integration";
import type { IgThread } from "./model";

/** What startup needs to show chats instantly before the first resync. */
export interface InstagramCacheSnapshot {
  version: 1;
  accountId: string;
  account: { id: string; fbid: string; username: string; name: string } | null;
  mailboxId: string;
  sequenceId: string;
  threads: IgThread[];
  requestIds: string[];
  /** Failed / unconfirmed sends, kept until the user discards them or a refresh shows they landed. */
  outgoing: InstagramOutgoing[];
}

export const MAX_CACHED_THREADS = 60;
export const MAX_CACHED_MESSAGES = 80;

export function instagramCachePath(accountId: string): string {
  if (!/^\d+$/.test(accountId)) throw new Error("Invalid Instagram account ID.");
  return join(dirname(instagramAuthPath()), "accounts", accountId, "cache.json");
}

/** Newest threads with their newest messages; a trimmed thread keeps a cursor so history still pages. */
export function trimInstagramSnapshot(snapshot: InstagramCacheSnapshot): InstagramCacheSnapshot {
  const keep = new Set([...snapshot.requestIds, ...snapshot.outgoing.map(send => send.threadId)]);
  const threads = [...snapshot.threads].sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    .filter((thread, index) => index < MAX_CACHED_THREADS || keep.has(thread.id))
    .map(thread => thread.messages.length <= MAX_CACHED_MESSAGES ? thread : {
      ...thread, messages: thread.messages.slice(-MAX_CACHED_MESSAGES),
      // The oldest kept page's cursor isn't known: reopen pages from the server's newest window.
      hasOlder: true, cursor: null, detailLoaded: false,
    });
  return {
    ...snapshot, threads,
    // A send in flight when Record quit may have landed: it comes back unconfirmed, never resent.
    outgoing: snapshot.outgoing.map(send => send.status === "pending" ? { ...send, status: "unconfirmed" as const,
      error: "Record quit while sending; it may have been delivered. Refresh before resending." } : send),
  };
}

function valid(value: unknown, accountId: string): value is InstagramCacheSnapshot {
  const data = value as InstagramCacheSnapshot;
  return !!data && data.version === 1 && data.accountId === accountId && Array.isArray(data.threads)
    && Array.isArray(data.requestIds) && Array.isArray(data.outgoing)
    && data.threads.every(thread => thread && /^\d+$/.test(thread.id) && Array.isArray(thread.messages));
}

export function loadInstagramCache(accountId: string, path = instagramCachePath(accountId)): InstagramCacheSnapshot | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return valid(data, accountId) ? data : null;
  } catch {
    return null;
  }
}

/** Private (0600 in a 0700 directory), atomic, best effort. */
export async function saveInstagramCache(snapshot: InstagramCacheSnapshot, path = instagramCachePath(snapshot.accountId)): Promise<void> {
  const data = JSON.stringify(trimInstagramSnapshot(snapshot));
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

export async function removeInstagramCache(accountId: string): Promise<void> {
  if (!/^\d+$/.test(accountId)) return;
  await rm(instagramCachePath(accountId), { force: true });
}
