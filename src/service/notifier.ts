/**
 * The service's notifications and its icon's badge, as the official apps
 * keep them: a message that arrives live, from someone else, in a chat that
 * is not muted, is posted to moon-notifyd (one notification per chat, the
 * newest replacing the last), unless the app shows that chat in front of an
 * awake, unlocked screen. Opening or reading the chat withdraws it. The
 * badge is the provider's count (by default the unread chats that are not
 * muted), set on Moon whenever it changes. Moon or moon-notifyd may be gone
 * for a while: posts wait (the newest per chat, at most 12 h) and the badge
 * is set again, with backoff.
 */

import type { Logger } from "./log";
import type { MoonLink } from "./moon";
import type { Settings, WireChat, WireMessage } from "./protocol";

const BODY_CHARS = 280;
const POST_TTL_MS = 12 * 3600_000;
const MAX_PENDING = 50;
const RETRY_MS = [1_000, 5_000, 15_000, 60_000, 300_000];

/** moon-notifyd's tag for a chat: the id when it is a valid tag, else its hash. */
export function tagFor(chatId: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(chatId)) return chatId;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(chatId)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `c${hash.toString(16).padStart(16, "0")}`;
}

/** A message in a few words, for a notification or a list row. */
export function summarize(message: Pick<WireMessage, "text" | "media" | "deleted">): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (text) return text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS - 1)}…` : text;
  if (message.deleted) return "This message was deleted";
  const kind = message.media[0]?.kind;
  switch (kind) {
    case "image": return message.media.length > 1 ? `📷 ${message.media.length} photos` : "📷 Photo";
    case "video": return "🎥 Video";
    case "gif": return "GIF";
    case "sticker": return "Sticker";
    case "audio": return "🎤 Voice message";
    case "file": return `📄 ${message.media[0]?.name ?? "File"}`;
    default: return "Message";
  }
}

export interface ViewState {
  chat: string | null;
  front: boolean;
}

interface Pending {
  chatId: string;
  body: Record<string, unknown>;
  at: number;
}

export class Notifier {
  /** What the apps connected now show (one entry per connection). */
  private readonly views = new Map<number, ViewState>();
  private readonly pending = new Map<string, Pending>();
  /** Tags of this app's notifications moon-notifyd holds (as far as known). */
  private readonly posted = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryStep = 0;
  private badgeShown: number | null = null;
  private badgeWanted: number | null = null;
  private badgeTimer: ReturnType<typeof setTimeout> | null = null;
  private badgeStep = 0;

  constructor(
    private readonly app: string,
    private readonly moon: MoonLink,
    private readonly settings: () => Settings,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  setView(client: number, view: ViewState | null): void {
    if (view) this.views.set(client, view);
    else this.views.delete(client);
  }

  /** Some app says it shows `chatId` (in front or not). */
  private viewed(chatId: string): boolean {
    for (const view of this.views.values()) if (view.chat === chatId && view.front) return true;
    return false;
  }

  /**
   * A message arrived live: posts it unless nobody should hear about it.
   * Returns "shown" when the app shows that chat in front of an awake,
   * unlocked screen (the user is reading it).
   */
  async incoming(message: WireMessage, chat: WireChat | null): Promise<"shown" | "posted" | "quiet"> {
    if (chat && this.viewed(chat.id)) {
      const moon = await this.moon.view();
      // Moon cannot say: the app said it shows it.
      if (!moon || (moon.view === this.app && moon.screenAwake && !moon.locked)) return "shown";
    }
    if (message.mine || message.system || !chat || chat.muted || chat.archived) return "quiet";
    if (!this.settings().notifications) return "quiet";
    const previews = this.settings().previews;
    const author = message.author.name || "Someone";
    const group = chat.kind !== "dm";
    const text = previews ? summarize(message) : "New message";
    const unread = Math.max(1, chat.unread);
    const body = group && previews ? `${author}: ${text}` : text;
    const post: Record<string, unknown> = {
      app: this.app,
      tag: tagFor(chat.id),
      title: (group ? chat.title || author : author).slice(0, 120),
      body: (unread > 1 ? `${body}\n${unread} new messages` : body).slice(0, 1000),
      urgency: "normal",
      open: { app: this.app, target: chat.id },
    };
    await this.deliver({ chatId: chat.id, body: post, at: this.now() });
    return "posted";
  }

  private async deliver(item: Pending): Promise<void> {
    const id = await this.moon.post(item.body);
    if (id) {
      this.posted.add(tagFor(item.chatId));
      this.pending.delete(item.chatId);
      this.retryStep = 0;
      return;
    }
    this.pending.set(item.chatId, item);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.pending.size === 0) return;
    const delay = RETRY_MS[Math.min(this.retryStep++, RETRY_MS.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const now = this.now();
      const items = [...this.pending.values()];
      this.pending.clear();
      for (const item of items) if (now - item.at < POST_TTL_MS) void this.deliver(item);
    }, delay);
  }

  /** Learns which notifications are already up (they outlive the bridge). */
  async init(): Promise<void> {
    for (const tag of (await this.moon.list(this.app)) ?? []) this.posted.add(tag);
  }

  /** The chat was opened or read: its notification goes. */
  async withdraw(chatId: string): Promise<void> {
    this.pending.delete(chatId);
    if (!this.posted.delete(tagFor(chatId))) return;
    if (!(await this.moon.withdraw(this.app, tagFor(chatId)))) {
      this.log.warn("notify.withdraw_failed");
    }
  }

  /** The badge should read `count` (null: not known yet; leave it). */
  setBadge(count: number | null): void {
    this.badgeWanted = count;
    if (count === null || count === this.badgeShown || this.badgeTimer) return;
    void this.applyBadge();
  }

  private async applyBadge(): Promise<void> {
    const count = this.badgeWanted;
    if (count === null || count === this.badgeShown) return;
    if (await this.moon.badge(this.app, count)) {
      this.badgeShown = count;
      this.badgeStep = 0;
      if (this.badgeWanted !== count) void this.applyBadge();
      return;
    }
    const delay = RETRY_MS[Math.min(this.badgeStep++, RETRY_MS.length - 1)]!;
    this.badgeTimer = setTimeout(() => {
      this.badgeTimer = null;
      void this.applyBadge();
    }, delay);
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    this.retryTimer = this.badgeTimer = null;
  }
}

/** The default badge: unread chats in the inbox that are not muted. */
export function unreadChats(chats: Iterable<WireChat>): number {
  let count = 0;
  for (const chat of chats) {
    if (chat.unread > 0 && !chat.muted && !chat.archived && (chat.folder ?? "inbox") === "inbox") count++;
  }
  return count;
}
