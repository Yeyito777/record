/**
 * The chats a bridge knows, as the apps see them: kept in memory, saved to
 * the state directory a moment after they change (so the next start, and an
 * app's first frame, have the list at once), and listed newest first with
 * the pinned ones on top. It also keeps the chats read **locally** (opened
 * while writes are off: docs/social-protocol.md §3.3), whose unread count
 * shows as 0 until something newer arrives.
 */

import { join } from "node:path";

import { readJson, writePrivateAtomic } from "./files";
import type { WireChat } from "./protocol";

const SAVE_DELAY_MS = 2_000;
const CACHE_VERSION = 1;

interface SavedChats {
  version: number;
  chats: WireChat[];
  /** chat id → the newest message ts read here. */
  readLocally: Record<string, number>;
}

export interface ChatPage {
  chats: WireChat[];
  cursor: string | null;
}

export function compareChats(a: WireChat, b: WireChat): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  return b.ts - a.ts || a.id.localeCompare(b.id);
}

export class ChatStore {
  private readonly chats = new Map<string, WireChat>();
  private readonly readLocally = new Map<string, number>();
  private sorted: WireChat[] | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly path: string | null;
  /** Called with each chat as the apps should now see it. */
  onChange: (chat: WireChat) => void = () => {};
  onRemove: (id: string) => void = () => {};

  constructor(stateDir: string | null) {
    this.path = stateDir ? join(stateDir, "chats.json") : null;
    const saved = this.path ? readJson<SavedChats>(this.path) : null;
    if (saved?.version === CACHE_VERSION && Array.isArray(saved.chats)) {
      for (const chat of saved.chats) if (chat && typeof chat.id === "string") this.chats.set(chat.id, chat);
      for (const [id, ts] of Object.entries(saved.readLocally ?? {})) {
        if (typeof ts === "number") this.readLocally.set(id, ts);
      }
    }
  }

  get size(): number {
    return this.chats.size;
  }

  /** The chat as the apps see it (the local read applied). */
  get(id: string): WireChat | null {
    const chat = this.chats.get(id);
    return chat ? this.shown(chat) : null;
  }

  /** The chat as the service last described it. */
  raw(id: string): WireChat | null {
    return this.chats.get(id) ?? null;
  }

  all(): WireChat[] {
    if (!this.sorted) this.sorted = [...this.chats.values()].sort(compareChats);
    return this.sorted.map((chat) => this.shown(chat));
  }

  private shown(chat: WireChat): WireChat {
    const read = this.readLocally.get(chat.id);
    if (read === undefined || chat.unread === 0) return chat;
    const newest = chat.last?.ts ?? chat.ts;
    return newest <= read ? { ...chat, unread: 0, mentions: 0 } : chat;
  }

  /** Adds or replaces chats (the provider's view of them); tells the apps. */
  upsert(...chats: WireChat[]): void {
    for (const chat of chats) {
      const before = this.chats.get(chat.id);
      if (before && JSON.stringify(before) === JSON.stringify(chat)) continue;
      this.chats.set(chat.id, chat);
      this.sorted = null;
      this.onChange(this.shown(chat));
    }
    this.scheduleSave();
  }

  /** Changes some fields of a known chat. */
  patch(id: string, fields: Partial<WireChat>): WireChat | null {
    const chat = this.chats.get(id);
    if (!chat) return null;
    const next = { ...chat, ...fields, id };
    this.upsert(next);
    return this.shown(next);
  }

  remove(id: string): void {
    if (!this.chats.delete(id)) return;
    this.readLocally.delete(id);
    this.sorted = null;
    this.onRemove(id);
    this.scheduleSave();
  }

  /** Replaces the whole list (a fresh full load); chats not in it go. */
  replaceAll(chats: WireChat[]): void {
    const keep = new Set(chats.map((chat) => chat.id));
    for (const id of [...this.chats.keys()]) if (!keep.has(id)) this.remove(id);
    this.upsert(...chats);
  }

  /** The user saw the chat up to its newest message, here (writes off). */
  markReadLocally(id: string): boolean {
    const chat = this.chats.get(id);
    if (!chat) return false;
    const newest = chat.last?.ts ?? chat.ts;
    if ((this.readLocally.get(id) ?? -1) >= newest && this.shown(chat).unread === 0) return false;
    const wasUnread = this.shown(chat).unread > 0;
    this.readLocally.set(id, newest);
    this.scheduleSave();
    if (wasUnread) this.onChange(this.shown(chat));
    return wasUnread;
  }

  page(options: { cursor?: string | null; limit?: number; folder?: string | null } = {}): ChatPage {
    const folder = options.folder ?? "inbox";
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    const start = options.cursor && /^o:\d+$/.test(options.cursor) ? Number(options.cursor.slice(2)) : 0;
    const list = this.all().filter((chat) => (chat.folder ?? "inbox") === folder);
    const chats = list.slice(start, start + limit);
    return { chats, cursor: start + limit < list.length ? `o:${start + limit}` : null };
  }

  private scheduleSave(): void {
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  save(): void {
    if (!this.path) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const saved: SavedChats = {
      version: CACHE_VERSION,
      chats: [...this.chats.values()],
      readLocally: Object.fromEntries(this.readLocally),
    };
    writePrivateAtomic(this.path, JSON.stringify(saved));
  }
}
