/**
 * WhatsApp for Moon's apps (a26-system docs/social-protocol.md §5): record's
 * WhatsApp (Baileys, as record's terminal client runs it: `whatsapp/live.ts`)
 * or a made-up account (`--fixtures`: `whatsapp/fixtures.ts`), turned into
 * the protocol's chats and messages.
 *
 * The bridge links as one more of the account's devices (a QR scanned with
 * the primary phone: `login.start`), keeps what WhatsApp syncs to it on disk
 * (`whatsapp/store.ts`), pages older history from the primary phone on
 * demand when the app scrolls past what it has, downloads media and profile
 * pictures when the app draws them, and hands live messages to the bridge
 * for notifications. It never shows the account online, never sends read
 * receipts or typing, and sends, reacts or marks read only with writes on.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDir } from "../files";
import { errorText } from "../log";
import { BridgeError, type WireChat, type WireMedia, type WireMessage, type WireUser } from "../protocol";
import type { Provider, ProviderHost } from "../provider";
import { isWhatsAppChatMuted } from "../../whatsapp/mute";
import type {
  WhatsAppChat,
  WhatsAppConnectionState,
  WhatsAppContact,
  WhatsAppMessage,
  WhatsAppMessageKey,
  WhatsAppReactionEvent,
} from "../../whatsapp/types";
import type { RawEvent, WaBackend } from "./whatsapp/backend";
import {
  compareMessages, higherStatus, isVisibleMessage, mergeDefined, mergeMessage, WaStore,
  type ChatMeta, type Extras, type LastMessage, type StoredMessage,
} from "./whatsapp/store";
import {
  avatarRef, cleanName, formattedPhone, jidOfChat, mediaRef, messageSummary, messageText, noticeSentence, parseRef,
  wireChatId, wireUserId,
} from "./whatsapp/wire";

/** Older history from the primary phone: how long the app's page waits for it. */
const ON_DEMAND_WAIT_MS = 12_000;
const ON_DEMAND_COUNT = 50;
/** A login (QR codes) ends by itself after this long. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** A message delivered while the bridge was away still notifies when this recent. */
const LIVE_APPEND_MS = 15 * 60_000;
const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
/** Profile pictures: trusted a week, "none" three days (record's sidebar icons). */
const PICTURE_MAX_AGE_MS = 7 * 86_400_000;
const NO_PICTURE_MAX_AGE_MS = 3 * 86_400_000;
const PICTURE_BACKOFF_MS = 60_000;
const MAX_PENDING_EXTRAS = 20_000;

function normalizedDirectJid(jid: string): string {
  const at = jid.lastIndexOf("@");
  if (at <= 0) return jid;
  const domain = jid.slice(at + 1);
  if (domain !== "lid" && domain !== "s.whatsapp.net") return jid;
  const user = jid.slice(0, at).split(":")[0];
  return user ? `${user}@${domain}` : jid;
}

function directIdentityPair(values: readonly (string | undefined)[]): { lid: string; phoneId: string } | null {
  let lid: string | undefined;
  let phoneId: string | undefined;
  for (const value of values) {
    if (!value) continue;
    const normalized = normalizedDirectJid(value);
    if (normalized.endsWith("@lid")) lid = normalized;
    else if (normalized.endsWith("@s.whatsapp.net")) phoneId = normalized;
  }
  return lid && phoneId ? { lid, phoneId } : null;
}

function listable(chat: ChatMeta): boolean {
  if (chat.kind !== "direct" && chat.kind !== "group") return false;
  if (chat.id === "status@broadcast" || chat.id.endsWith("@newsletter")) return false;
  return Boolean(chat.last || (chat.lastMessageAtMs ?? 0) > 0);
}

/** A QR code's modules as rows of `0`/`1` (protocol §3.6). */
async function qrRows(payload: string): Promise<{ size: number; rows: string[] }> {
  const { default: QRCode } = await import("qrcode");
  const modules = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  const rows: string[] = [];
  for (let row = 0; row < modules.size; row++) {
    let line = "";
    for (let col = 0; col < modules.size; col++) line += modules.get(row, col) ? "1" : "0";
    rows.push(line);
  }
  return { size: modules.size, rows };
}

/** Never let a jid or a phone number reach the log. */
function safeError(error: unknown): string {
  return errorText(error).replace(/\d{5,}/g, "#").replace(/[^\s@]+@(s\.whatsapp\.net|lid|g\.us)/g, "jid");
}

export async function createProvider(host: ProviderHost): Promise<Provider> {
  let fixtures: ReturnType<typeof import("./whatsapp/fixtures").createFixturesBackend> | null = null;
  let backend: WaBackend;
  if (host.fixtures) {
    const { createFixturesBackend } = await import("./whatsapp/fixtures");
    backend = fixtures = createFixturesBackend();
  } else {
    const { createLiveBackend } = await import("./whatsapp/live");
    backend = createLiveBackend({ authDirectory: join(host.stateDir, "auth") });
  }
  return new WhatsAppProvider(host, backend, fixtures);
}

interface PendingHistory {
  promise: Promise<void>;
  resolve: () => void;
  requestId: string | null;
}

export class WhatsAppProvider implements Provider {
  readonly capabilities: string[];
  readonly store: WaStore;
  private readonly lidToPhone = new Map<string, string>();
  private readonly pendingExtras = new Map<string, Extras>();
  private readonly touched = new Set<string>();
  private flushQueued = false;
  private readonly historyRequests = new Map<string, PendingHistory>();
  /** History pages that came before fetchHistory said their request id. */
  private readonly earlyPages = new Set<string>();
  /** chat → the oldest message's id when the phone had nothing older. */
  private readonly exhausted = new Map<string, string>();
  private readonly unbind: (() => void)[] = [];
  private status: WhatsAppConnectionState = { status: "idle" };
  private login: { timer: ReturnType<typeof setTimeout>; serial: number } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryStep = 0;
  private stopped = false;
  private pictureQueue: (() => Promise<void>)[] = [];
  private pictureBusy = false;
  private picturePausedUntil = 0;
  private groupQueue = new Set<string>();
  private groupAsked = new Set<string>();
  private groupBusy = false;
  private readonly lockPath: string;

  constructor(
    private readonly host: ProviderHost,
    private readonly backend: WaBackend,
    private readonly fixtures: ReturnType<typeof import("./whatsapp/fixtures").createFixturesBackend> | null,
  ) {
    this.store = new WaStore(host.stateDir);
    this.lockPath = join(host.stateDir, "wa", "bridge.pid");
    this.capabilities = ["send", "react", "mark_read", "whatsapp.qr"];
    if (fixtures) this.capabilities.push("whatsapp.fixtures");
    for (const contact of [...this.store.contacts.values()]) this.registerContactAliases(contact);
  }

  get log() {
    return this.host.log;
  }

  private get connected(): boolean {
    return this.backend.state.status === "connected";
  }

  private get selfJid(): string | null {
    return this.store.account?.id ? normalizedDirectJid(this.store.account.id) : null;
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    this.takeLock();
    this.unbind.push(
      this.backend.on("state", (state) => this.onState(state)),
      this.backend.on("qr", ({ qr }) => void this.onQr(qr)),
      this.backend.on("history", (event) => this.guarded("history", () => {
        this.upsertContacts(event.contacts);
        const chats = event.syncKind === "on-demand"
          ? event.chats.map(({ unreadCount: _u, lastMessageAtMs: _l, ...chat }) => chat)
          : event.chats;
        this.upsertChats(chats, false);
        this.upsertMessages(event.messages, { preferExisting: true, live: false });
        this.pendingExtras.clear();
        this.applyReactions(event.reactions ?? []);
        if (event.syncKind === "on-demand") this.historyArrived(event.requestId, event.messages);
      })),
      this.backend.on("messages", (event) => this.guarded("messages", () => {
        if (event.kind === "update") this.upsertMessages(event.messages, { preferExisting: false, live: false });
        else this.upsertMessages(event.messages, { preferExisting: true, live: event.upsertType === "notify" ? "notify" : "append" });
        // Extras for messages record's converters skipped (reactions, protocol messages).
        this.pendingExtras.clear();
      })),
      this.backend.on("reactions", (events) => this.guarded("reactions", () => this.applyReactions(events))),
      this.backend.on("chats", (event) => this.guarded("chats", () => this.upsertChats(event.chats, event.kind === "update"))),
      this.backend.on("contacts", (event) => this.guarded("contacts", () => this.upsertContacts(event.contacts))),
      this.backend.on("lid-mapping", ({ lid, phoneId }) => this.guarded("lid", () => this.registerLid(lid, phoneId))),
      this.backend.on("error", (event) => {
        if (!event.recoverable) this.log.warn("wa.error", { phase: event.phase, error: safeError(event.error) });
      }),
      this.backend.onRaw((event) => this.guarded("raw", () => this.onRaw(event))),
    );
    // The list the store has, at once (the bridge's own cache drew it already).
    const chats: WireChat[] = [];
    for (const meta of this.store.chats.values()) if (listable(meta)) chats.push(this.wireChat(meta));
    if (chats.length > 0 || this.store.chats.size === 0) this.host.chats.replaceAll(chats);
    if (await this.backend.hasSession()) {
      this.host.setStatus("connecting", null, this.wireAccount());
      void this.backend.startLogin().catch((error) => this.log.warn("wa.start_failed", { error: safeError(error) }));
    } else {
      this.host.setStatus("signed_out", null, null);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.login) clearTimeout(this.login.timer);
    for (const off of this.unbind.splice(0)) off();
    for (const pending of this.historyRequests.values()) pending.resolve();
    await this.backend.shutdown().catch((error) => this.log.warn("wa.stop_failed", { error: safeError(error) }));
    this.flushTouched();
    this.store.flush();
    rmSync(this.lockPath, { force: true });
  }

  /** One bridge per session: a second one on the same state refuses to start. */
  private takeLock(): void {
    try {
      const pid = Number(readFileSync(this.lockPath, "utf8").trim());
      if (pid > 0 && pid !== process.pid) {
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
        const command = alive ? (() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; } })() : "";
        if (alive && /service/.test(command)) throw new Error("another WhatsApp bridge runs on this state directory");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("another")) throw error;
    }
    writeFileSync(this.lockPath, `${process.pid}\n`, { mode: 0o600 });
  }

  private guarded(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.log.error("wa.event_failed", { event: what, error: safeError(error) });
    }
    this.scheduleFlush();
  }

  private onState(state: WhatsAppConnectionState): void {
    const previous = this.status.status;
    this.status = state;
    switch (state.status) {
      case "connected": {
        this.retryStep = 0;
        if (state.account) {
          this.store.account = { ...state.account, ...(state.account.name ? { name: cleanName(state.account.name) } : {}) };
          this.store.changedMeta();
        }
        this.host.setStatus("online", null, this.wireAccount());
        if (this.login) {
          clearTimeout(this.login.timer);
          this.login = null;
          this.host.emit({ event: "login", state: "done" });
        }
        for (const meta of this.store.chats.values()) if (meta.kind === "group" && !meta.name) this.groupQueue.add(meta.id);
        void this.pumpGroups();
        return;
      }
      case "awaiting-qr":
        this.host.setStatus("signed_out", null, null);
        return;
      case "loading-auth":
      case "connecting":
        if (this.login && previous === "awaiting-qr") this.host.emit({ event: "login", state: "waiting" });
        if (!this.login) this.host.setStatus("connecting", null, this.wireAccount());
        return;
      case "reconnecting":
        if (!this.login) {
          this.host.setStatus(state.attempt <= 2 ? "connecting" : "offline", state.attempt <= 2 ? null : "Can't reach WhatsApp. Retrying…", this.wireAccount());
        }
        return;
      case "logged-out":
        this.log.info("wa.logged_out");
        void this.forgetSession("This phone was logged out of WhatsApp. Link it again to see your chats.");
        return;
      case "connection-replaced":
        this.host.setStatus("error", "WhatsApp was opened with this session somewhere else.", this.wireAccount());
        return;
      case "failed":
        if (this.login) {
          this.endLogin("Linking failed. Try again.");
          return;
        }
        this.host.setStatus("offline", "Can't reach WhatsApp. Retrying…", this.wireAccount());
        this.scheduleRetry();
        return;
      case "cancelled":
        if (!this.connected) this.host.setStatus("signed_out", null, null);
        return;
      default:
        return;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = RETRY_MS[Math.min(this.retryStep++, RETRY_MS.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped || this.connected || this.login) return;
      void this.backend.hasSession().then((saved) => {
        if (saved) void this.backend.startLogin().catch((error) => this.log.warn("wa.retry_failed", { error: safeError(error) }));
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  private wireAccount(): WireUser | null {
    const account = this.store.account;
    if (!account) return null;
    const phoneJid = account.phoneId ?? account.id;
    return { id: "me", name: cleanName(account.name) || "You", username: formattedPhone(normalizedDirectJid(phoneJid)) };
  }

  // ---- login ----

  async loginStart(args: Record<string, unknown>): Promise<void> {
    const method = args.method ?? "qr";
    if (method !== "qr") throw new BridgeError("invalid_argument", "WhatsApp links with a QR code (method qr)");
    if (this.connected || (await this.backend.hasSession())) throw new BridgeError("invalid_argument", "already signed in");
    if (this.login) return;
    const serial = Date.now();
    this.login = {
      serial,
      timer: setTimeout(() => {
        if (this.login?.serial !== serial) return;
        this.backend.cancelLogin();
        this.endLogin("The QR code expired. Try again.");
      }, LOGIN_TIMEOUT_MS),
    };
    this.log.info("wa.login_start");
    void this.backend.startLogin().then((result) => {
      if (this.login?.serial === serial && result.status !== "connected" && result.status !== "cancelled") {
        this.endLogin("Linking failed. Try again.");
      }
    }).catch((error) => {
      this.log.warn("wa.login_failed", { error: safeError(error) });
      if (this.login?.serial === serial) this.endLogin("Linking failed. Try again.");
    });
  }

  async loginCancel(): Promise<void> {
    if (!this.login) return;
    clearTimeout(this.login.timer);
    this.login = null;
    this.backend.cancelLogin();
  }

  private endLogin(detail: string): void {
    if (this.login) clearTimeout(this.login.timer);
    this.login = null;
    this.host.emit({ event: "login", state: "failed", detail });
    if (!this.connected) this.host.setStatus("signed_out", null, null);
  }

  private async onQr(payload: string): Promise<void> {
    const login = this.login;
    if (!login) {
      // A QR nobody asked for (a saved session WhatsApp no longer accepts).
      this.backend.cancelLogin();
      return;
    }
    const qr = await qrRows(payload);
    if (this.login !== login) return;
    const first = Date.now() - login.serial < 15_000;
    this.host.emit({ event: "login", state: "qr", qr, expires_ms: first ? 60_000 : 20_000 });
  }

  async logout(): Promise<void> {
    this.log.info("wa.logout");
    try {
      if (this.connected) await this.backend.logout();
    } catch (error) {
      this.log.warn("wa.logout_failed", { error: safeError(error) });
    }
    await this.forgetSession(null);
  }

  /** The session is gone: its keys, the chats and their media go too. */
  private async forgetSession(detail: string | null): Promise<void> {
    await this.backend.shutdown().catch(() => {});
    rmSync(join(this.host.stateDir, "auth"), { recursive: true, force: true });
    this.store.clear();
    this.lidToPhone.clear();
    this.exhausted.clear();
    this.host.chats.replaceAll([]);
    // The account's pictures and files go; the bridge's media cache writes there again.
    rmSync(join(this.host.cacheDir, "media"), { recursive: true, force: true });
    ensurePrivateDir(join(this.host.cacheDir, "media"));
    this.host.setStatus("signed_out", detail, null);
  }

  // ---- contacts, chats, ids ----

  private canonical(jid: string): string {
    const normalized = normalizedDirectJid(jid);
    if (!normalized.endsWith("@lid")) return normalized;
    return this.lidToPhone.get(normalized) ?? normalized;
  }

  private registerContactAliases(contact: WhatsAppContact): void {
    const pair = directIdentityPair([contact.id, contact.lid, contact.phoneId]);
    if (pair) this.lidToPhone.set(pair.lid, pair.phoneId);
  }

  private upsertContacts(contacts: readonly WhatsAppContact[]): void {
    for (const contact of contacts) {
      if (!contact.id) continue;
      const id = normalizedDirectJid(contact.id);
      const previous = this.store.contacts.get(id);
      const merged = mergeDefined(previous, { ...contact, id });
      this.store.contacts.set(id, merged);
      for (const alias of [contact.lid, contact.phoneId, previous?.lid, previous?.phoneId]) {
        if (!alias) continue;
        const normalized = normalizedDirectJid(alias);
        this.store.contacts.set(normalized, mergeDefined(this.store.contacts.get(normalized), { ...merged, id: normalized }));
      }
      const pair = directIdentityPair([id, contact.lid, contact.phoneId, previous?.lid, previous?.phoneId]);
      if (pair) this.registerLid(pair.lid, pair.phoneId);
      const chat = this.canonical(id);
      if (this.store.chats.has(chat)) this.touched.add(chat);
    }
    if (contacts.length > 0) this.store.changedMeta();
  }

  /** An LID turned out to be a phone number: one chat, under the number. */
  private registerLid(lidJid: string, phoneJid: string): void {
    const pair = directIdentityPair([lidJid, phoneJid]);
    if (!pair) return;
    const { lid, phoneId } = pair;
    if (this.lidToPhone.get(lid) === phoneId && !this.store.chats.has(lid)) return;
    this.lidToPhone.set(lid, phoneId);
    const lidChat = this.store.chats.get(lid);
    if (!lidChat) return;
    const phoneChat = this.store.chats.get(phoneId);
    const merged: ChatMeta = mergeDefined(phoneChat, { ...lidChat, id: phoneId, kind: "direct" });
    merged.lastMessageAtMs = Math.max(phoneChat?.lastMessageAtMs ?? 0, lidChat.lastMessageAtMs ?? 0) || undefined;
    if (phoneChat?.unreadCount !== undefined && lidChat.unreadCount !== undefined) {
      merged.unreadCount = this.store.unreadDelta.has(lid) ? phoneChat.unreadCount + lidChat.unreadCount : Math.max(phoneChat.unreadCount, lidChat.unreadCount);
    }
    this.store.chats.set(phoneId, merged);
    this.store.moveMessages(lid, phoneId, (a, b) => {
      const byId = new Map<string, StoredMessage>();
      for (const message of [...a, ...b]) byId.set(message.id, mergeMessage(byId.get(message.id), { ...message, chatId: phoneId }));
      return [...byId.values()].sort(compareMessages);
    });
    this.store.dropChat(lid);
    this.host.chats.remove(wireChatId(lid));
    this.refreshLast(phoneId);
    this.touched.add(phoneId);
  }

  private chatMeta(jid: string, kind?: WhatsAppChat["kind"]): ChatMeta {
    let meta = this.store.chats.get(jid);
    if (!meta) {
      meta = { id: jid, kind: kind ?? (jid.endsWith("@g.us") ? "group" : jid.endsWith("@newsletter") ? "newsletter" : jid.endsWith("@broadcast") ? "broadcast" : "direct") };
      this.store.chats.set(jid, meta);
      if (meta.kind === "group") this.groupQueue.add(jid);
    }
    return meta;
  }

  /** Baileys' chats.upsert (absolute) and chats.update (unread is a delta) semantics, as record applies them. */
  private upsertChats(chats: readonly WhatsAppChat[], update: boolean): void {
    for (const chat of chats) {
      if (!chat.id || chat.id === "status@broadcast") continue;
      const id = this.canonical(chat.id);
      const previous = this.store.chats.get(id);
      const patch: WhatsAppChat = id === chat.id ? { ...chat } : { ...chat, id };
      const delta = update ? patch.unreadCount : undefined;
      if (update) delete patch.unreadCount;
      const merged: ChatMeta = mergeDefined(previous, patch as ChatMeta);
      const newest = Math.max(previous?.lastMessageAtMs ?? 0, patch.lastMessageAtMs ?? 0);
      if (newest > 0) merged.lastMessageAtMs = newest;
      if (delta !== undefined) {
        const old = Math.max(0, previous?.unreadCount ?? 0);
        merged.unreadCount = delta > 0 ? old + delta : delta === 0 ? 0 : Math.max(1, old);
        if (delta > 0 && (previous?.unreadCount === undefined || this.store.unreadDelta.has(id))) this.store.unreadDelta.add(id);
        else if (delta <= 0) this.store.unreadDelta.delete(id);
      } else if (!update && chat.unreadCount !== undefined) {
        this.store.unreadDelta.delete(id);
      }
      if (merged.kind === "group" && !merged.name && !previous) this.groupQueue.add(id);
      this.store.chats.set(id, merged);
      this.touched.add(id);
    }
    if (chats.length > 0) this.store.changedMeta();
  }

  // ---- messages ----

  private takeExtras(message: WhatsAppMessage): StoredMessage {
    const extras = this.pendingExtras.get(message.id);
    if (!extras) return message;
    this.pendingExtras.delete(message.id);
    return { ...message, x: { ...(message as StoredMessage).x, ...extras } };
  }

  private upsertMessages(
    messages: readonly StoredMessage[],
    options: { preferExisting: boolean; live: false | "notify" | "append" },
  ): void {
    const byChat = new Map<string, StoredMessage[]>();
    for (const incoming of messages) {
      if (!isVisibleMessage(incoming)) continue;
      const pair = directIdentityPair([incoming.chatId, incoming.key.chatId, incoming.key.alternateChatId]);
      if (pair) this.registerLid(pair.lid, pair.phoneId);
      const chatId = this.canonical(incoming.chatId);
      if (!chatId || chatId === "status@broadcast" || chatId.endsWith("@newsletter")) continue;
      const message = this.takeExtras(chatId === incoming.chatId ? incoming : { ...incoming, chatId });
      let list = byChat.get(chatId);
      if (!list) byChat.set(chatId, list = []);
      list.push(message);
    }
    const viewing = this.host.viewing().chats;
    for (const [jid, incoming] of byChat) {
      this.chatMeta(jid);
      const stored = this.store.messages(jid);
      const index = new Map(stored.map((message, position) => [message.id, position]));
      const fresh: StoredMessage[] = [];
      let appendOnly = true;
      for (const message of incoming) {
        const at = index.get(message.id);
        const merged = mergeMessage(at === undefined ? undefined : stored[at], message, options.preferExisting);
        if (at === undefined) {
          const last = stored.at(-1);
          if (last && compareMessages(last, merged) > 0) appendOnly = false;
          index.set(merged.id, stored.length);
          stored.push(merged);
          fresh.push(merged);
        } else {
          stored[at] = merged;
          fresh.push(merged);
        }
      }
      if (!appendOnly) stored.sort(compareMessages);
      this.store.setMessages(jid, stored);
      this.refreshLast(jid);
      this.touched.add(jid);
      const wireId = wireChatId(jid);
      const shown = viewing.has(wireId);
      for (const message of fresh) {
        const live = options.live === "notify"
          || (options.live === "append" && !message.fromMe && Date.now() - (message.timestampMs ?? 0) < LIVE_APPEND_MS);
        if (live || shown) this.emitMessage(jid, message, Boolean(live));
      }
    }
  }

  private emitMessage(jid: string, message: StoredMessage, live: boolean): void {
    // The chat's list entry first: the notification reads its title and count.
    if (live) this.flushTouched();
    this.host.message(this.wireMessage(jid, message), live);
  }

  private applyReactions(events: readonly WhatsAppReactionEvent[]): void {
    const viewing = this.host.viewing().chats;
    for (const event of events) {
      const jid = this.canonical(event.target.chatId);
      if (!this.store.chats.has(jid)) continue;
      const list = this.store.messages(jid);
      const message = list.find((candidate) => candidate.id === event.target.id);
      if (!message) continue;
      const reactions = (message.reactions ?? []).filter((reaction) =>
        !(reaction.fromMe && event.reaction.fromMe) && reaction.senderId !== event.reaction.senderId);
      if (event.reaction.emoji) reactions.push(event.reaction);
      message.reactions = reactions;
      this.store.touchMessages(jid);
      if (viewing.has(wireChatId(jid))) this.emitMessage(jid, message, false);
    }
  }

  private onRaw(event: RawEvent): void {
    switch (event.kind) {
      case "extras": {
        this.pendingExtras.set(event.id, { ...this.pendingExtras.get(event.id), ...event.extras });
        if (this.pendingExtras.size > MAX_PENDING_EXTRAS) this.pendingExtras.delete(this.pendingExtras.keys().next().value!);
        return;
      }
      case "system": {
        const message = event.message;
        this.upsertMessages([message], { preferExisting: true, live: false });
        return;
      }
      case "revoke":
      case "status": {
        const jid = this.canonical(event.chatId);
        if (!this.store.chats.has(jid)) return;
        const list = this.store.messages(jid);
        const message = list.find((candidate) => candidate.id === event.id);
        if (!message) return;
        if (event.kind === "revoke") {
          message.x = { ...message.x, deleted: true };
          message.content = message.content.kind === "media" ? { kind: "text", text: "" } : { ...message.content, ...(message.content.kind === "text" ? { text: "" } : {}) };
        } else {
          const status = higherStatus(message.x?.status, event.status);
          if (status === message.x?.status) return;
          message.x = { ...message.x, status };
        }
        this.store.touchMessages(jid);
        this.refreshLast(jid);
        this.touched.add(jid);
        if (this.host.viewing().chats.has(wireChatId(jid))) this.emitMessage(jid, message, false);
        return;
      }
      case "group": {
        const jid = event.chatId;
        const meta = this.chatMeta(jid, "group");
        if (event.subject) meta.name = event.subject;
        if (event.size) meta.members = event.size;
        this.groupQueue.delete(jid);
        this.store.changedMeta();
        this.touched.add(jid);
        return;
      }
    }
  }

  /** The chat list's preview: its newest message that shows. */
  private refreshLast(jid: string): void {
    const meta = this.store.chats.get(jid);
    if (!meta) return;
    const list = this.store.messages(jid);
    let newest: StoredMessage | undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      if (isVisibleMessage(list[i]!)) { newest = list[i]; break; }
    }
    if (!newest) return;
    const ts = newest.timestampMs ?? newest.receivedAtMs ?? 0;
    const last: LastMessage = {
      id: newest.id, ts, fromMe: newest.fromMe,
      text: messageSummary(newest, (notice) => noticeSentence(notice, (j) => this.name(j))),
      ...(newest.senderId ? { sender: newest.senderId } : {}),
      ...(newest.senderName ? { senderName: newest.senderName } : {}),
      ...(newest.x?.status ? { status: newest.x.status } : {}),
      ...(newest.x?.deleted ? { deleted: true } : {}),
      ...(newest.x?.system ? { system: true } : {}),
    };
    if (JSON.stringify(meta.last) === JSON.stringify(last)) return;
    meta.last = last;
    if (ts > (meta.lastMessageAtMs ?? 0)) meta.lastMessageAtMs = ts;
    this.store.changedMeta();
  }

  private scheduleFlush(): void {
    if (this.flushQueued || this.touched.size === 0) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flushTouched());
  }

  /** Tells the bridge about the chats that changed. */
  private flushTouched(): void {
    this.flushQueued = false;
    if (this.touched.size === 0) return;
    const wires: WireChat[] = [];
    for (const jid of this.touched) {
      const meta = this.store.chats.get(jid);
      if (meta && listable(meta)) wires.push(this.wireChat(meta));
      else if (!meta || !listable(meta)) this.host.chats.remove(wireChatId(jid));
    }
    this.touched.clear();
    if (wires.length > 0) this.host.chats.upsert(...wires);
    if (this.connected) void this.pumpGroups();
  }

  // ---- names and wire objects ----

  /** Someone's name as the account's phone shows it. */
  name(jid: string, pushName?: string): string {
    const id = this.canonical(jid);
    if (this.selfJid && (id === this.selfJid || id === normalizedDirectJid(this.store.account?.lid ?? ""))) return "You";
    const contact = this.store.contacts.get(id);
    return cleanName(contact?.name) || cleanName(contact?.verifiedName)
      || formattedPhone(id) || cleanName(contact?.pushName) || cleanName(pushName)
      || cleanName(this.store.chats.get(id)?.name) || "Unknown";
  }

  private chatTitle(meta: ChatMeta): string {
    if (meta.kind === "group") return cleanName(meta.name) || "Group";
    const contact = this.store.contacts.get(meta.id);
    return cleanName(contact?.name) || cleanName(contact?.verifiedName) || formattedPhone(meta.id)
      || cleanName(contact?.pushName) || cleanName(meta.name) || cleanName(meta.last?.senderName) || "Unknown";
  }

  private pictureKnownAbsent(jid: string): boolean {
    const at = this.store.noPicture.get(jid);
    return at !== undefined && Date.now() - at < NO_PICTURE_MAX_AGE_MS;
  }

  wireChat(meta: ChatMeta): WireChat {
    const group = meta.kind === "group";
    const last = meta.last;
    const contact = group ? undefined : this.store.contacts.get(meta.id);
    const unread = meta.unreadCount === -1 ? 1 : Math.max(0, meta.unreadCount ?? 0);
    const ext: Record<string, unknown> = {};
    if (last?.fromMe && last.status && !last.system) ext.status = last.status;
    if (last?.deleted) ext.deleted = true;
    if (last?.system) ext.notice = true;
    if (meta.unreadCount === -1) ext.marked_unread = true;
    if (meta.readOnly) ext.read_only = true;
    if (!group && !contact?.name && contact?.pushName) ext.push_name = cleanName(contact.pushName);
    return {
      id: wireChatId(meta.id),
      kind: group ? "group" : "dm",
      title: this.chatTitle(meta),
      avatar: this.pictureKnownAbsent(meta.id) ? null : { ref: avatarRef(meta.id), kind: "image", w: 96, h: 96, mime: "image/jpeg" },
      last: last ? {
        id: last.id, ts: last.ts,
        author: last.fromMe ? "You" : last.system ? null : this.name(last.sender ?? meta.id, last.senderName),
        text: last.text, mine: last.fromMe,
      } : null,
      ts: Math.max(meta.lastMessageAtMs ?? 0, last?.ts ?? 0),
      unread,
      mentions: 0,
      muted: isWhatsAppChatMuted(meta.mutedUntilMs),
      pinned: Boolean(meta.pinned),
      archived: Boolean(meta.archived),
      folder: meta.archived ? "archived" : "inbox",
      parent: null,
      members: meta.members ?? null,
      ext,
    };
  }

  private wireMedia(jid: string, message: StoredMessage): WireMedia[] {
    // View once: as on WhatsApp Web, only the primary phone opens it.
    if (message.content.kind !== "media" || message.x?.deleted || message.content.viewOnce) return [];
    const media = message.content;
    const thumb = message.x?.thumb ? mediaRef("thumb", jid, message.id) : null;
    const base = {
      ref: mediaRef("media", jid, message.id),
      mime: media.mimeType ?? (media.mediaKind === "sticker" ? "image/webp" : null),
      size: media.sizeBytes ?? null,
      thumb,
    };
    switch (media.mediaKind) {
      case "image": return [{ ...base, kind: "image", w: media.width ?? null, h: media.height ?? null }];
      case "sticker": return [{ ...base, kind: "sticker", w: media.width ?? 512, h: media.height ?? 512 }];
      case "video": return [{ ...base, kind: media.animated ? "gif" : "video", w: media.width ?? null, h: media.height ?? null, duration_ms: media.durationSeconds ? media.durationSeconds * 1000 : null }];
      case "audio": return [{ ...base, kind: "audio", duration_ms: media.durationSeconds ? media.durationSeconds * 1000 : null }];
      case "document": return [{ ...base, kind: "file", name: cleanName(media.fileName) || "Document" }];
    }
  }

  wireMessage(jid: string, message: StoredMessage): WireMessage {
    const system = message.x?.system;
    const deleted = Boolean(message.x?.deleted);
    const authorJid = message.fromMe ? (this.selfJid ?? "me") : this.canonical(message.senderId ?? jid);
    const contact = message.fromMe ? undefined : this.store.contacts.get(authorJid);
    const ext: Record<string, unknown> = {};
    if (!message.fromMe && !contact?.name && (message.senderName || contact?.pushName)) {
      ext.push_name = cleanName(message.senderName || contact?.pushName);
    }
    if (message.content.kind === "media" && message.content.mediaKind === "audio" && message.content.voiceNote) ext.voice = true;
    if (message.content.kind === "media" && message.content.viewOnce) ext.view_once = true;
    let reply: WireMessage["reply_to"] = null;
    if (message.replyTo) {
      const target = this.store.messages(jid).find((candidate) => candidate.id === message.replyTo!.id);
      const participant = target ? (target.fromMe ? this.selfJid : target.senderId) : message.x?.quote?.participant ?? message.replyTo.participantId;
      const mineTarget = target ? target.fromMe : Boolean(participant && this.selfJid && this.canonical(participant) === this.selfJid);
      reply = {
        id: message.replyTo.id,
        author: mineTarget ? "You" : participant ? this.name(participant) : this.name(jid),
        text: target ? messageSummary(target) : message.x?.quote?.text ?? "",
      };
    }
    const reactions = new Map<string, { count: number; mine: boolean }>();
    for (const reaction of message.reactions ?? []) {
      if (!reaction.emoji) continue;
      const entry = reactions.get(reaction.emoji) ?? { count: 0, mine: false };
      entry.count += 1;
      entry.mine ||= reaction.fromMe;
      reactions.set(reaction.emoji, entry);
    }
    return {
      id: message.id,
      chat: wireChatId(jid),
      ts: message.timestampMs ?? message.receivedAtMs ?? 0,
      author: message.fromMe ? { id: "me", name: "You" } : { id: wireUserId(authorJid), name: this.name(authorJid, message.senderName) },
      mine: message.fromMe,
      text: deleted ? ""
        : system ? noticeSentence(system, (j) => this.name(j))
        : message.content.kind === "media" && message.content.viewOnce ? "View once message. Open WhatsApp on your phone to see it."
        : messageText(message),
      format: "whatsapp",
      media: this.wireMedia(jid, message),
      reply_to: deleted ? null : reply,
      reactions: [...reactions].map(([emoji, entry]) => ({ emoji, count: entry.count, mine: entry.mine })),
      edited_ts: message.editedTimestampMs ?? null,
      deleted,
      system: Boolean(system),
      forwarded: Boolean(message.x?.forwarded),
      status: message.fromMe ? (message.x?.status ?? "sent") : null,
      client_id: message.x?.clientId ?? null,
      ext,
    };
  }

  // ---- history ----

  private chatFor(id: string): string {
    const jid = this.canonical(jidOfChat(id));
    if (!this.store.chats.has(jid)) throw new BridgeError("not_found", "no such chat");
    return jid;
  }

  private visible(jid: string): StoredMessage[] {
    return this.store.messages(jid).filter(isVisibleMessage);
  }

  private hasOlder(jid: string, list: StoredMessage[]): boolean {
    const oldest = list[0];
    if (!oldest) return false;
    if (oldest.x?.system?.type === "created") return false;
    return this.exhausted.get(jid) !== oldest.id;
  }

  async history(chat: string, { before, limit }: { before?: string | null; limit: number }) {
    const jid = this.chatFor(chat);
    let list = this.visible(jid);
    let end = before ? list.findIndex((message) => message.id === before) : list.length;
    if (end < 0) throw new BridgeError("not_found", "no such message");
    if (before && end - limit < 0 && this.connected && this.hasOlder(jid, list)) {
      await this.fetchOlder(jid);
      list = this.visible(jid);
      end = list.findIndex((message) => message.id === before);
      if (end < 0) end = 0;
    }
    const start = Math.max(0, end - limit);
    const more = start > 0 || ((this.connected || !before) && this.hasOlder(jid, list));
    return { messages: list.slice(start, end).map((message) => this.wireMessage(jid, message)), more };
  }

  /** Asks the primary phone for the page before the chat's oldest message, and waits for it. */
  private fetchOlder(jid: string): Promise<void> {
    const running = this.historyRequests.get(jid);
    if (running) return running.promise;
    const list = this.store.messages(jid);
    const oldest = list.find((message) => message.timestampMs !== null && message.key?.id && !message.x?.system)
      ?? list.find((message) => message.timestampMs !== null);
    if (!oldest?.timestampMs) return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const pending: PendingHistory = { promise, resolve, requestId: null };
    this.historyRequests.set(jid, pending);
    const anchorId = list[0]?.id ?? oldest.id;
    const finish = () => {
      clearTimeout(timer);
      if (this.historyRequests.get(jid) !== pending) return;
      this.historyRequests.delete(jid);
      const now = this.store.messages(jid)[0]?.id;
      if (now === anchorId) this.exhausted.set(jid, anchorId);
      resolve();
    };
    const timer = setTimeout(() => {
      this.log.info("wa.history_timeout");
      finish();
    }, ON_DEMAND_WAIT_MS);
    pending.resolve = finish;
    const key: WhatsAppMessageKey = { ...oldest.key };
    if (key.chatId.endsWith("@lid") && jid.endsWith("@s.whatsapp.net")) key.alternateChatId = jid;
    this.backend.fetchHistory(ON_DEMAND_COUNT, key, oldest.timestampMs).then((requestId) => {
      pending.requestId = requestId;
      if (this.earlyPages.delete(requestId)) finish();
    }).catch((error) => {
      this.log.warn("wa.history_failed", { error: safeError(error) });
      finish();
    });
    return promise;
  }

  private historyArrived(requestId: string | undefined, messages: readonly WhatsAppMessage[]): void {
    for (const pending of this.historyRequests.values()) {
      if (requestId && pending.requestId === requestId) {
        pending.resolve();
        return;
      }
    }
    if (requestId) {
      this.earlyPages.add(requestId);
      if (this.earlyPages.size > 50) this.earlyPages.delete(this.earlyPages.values().next().value!);
      return;
    }
    const chat = messages[0] ? this.canonical(messages[0].chatId) : null;
    if (chat) this.historyRequests.get(chat)?.resolve();
  }

  // ---- media ----

  async fetchMedia(ref: string, _max: number | null) {
    const parsed = parseRef(ref);
    if (parsed.kind === "avatar") return this.fetchPicture(this.canonical(parsed.jid));
    const jid = this.canonical(parsed.jid);
    if (!this.store.chats.has(jid)) throw new BridgeError("not_found", "no such media");
    const list = this.store.messages(jid);
    const message = list.find((candidate) => candidate.id === parsed.id);
    if (!message || message.content.kind !== "media") throw new BridgeError("not_found", "no such media");
    if (parsed.kind === "thumb") {
      const thumb = message.x?.thumb;
      if (!thumb) throw new BridgeError("not_found", "no thumbnail");
      return this.host.media.fetch(`wa:t:${jid}:${message.id}`, "image/jpeg", async (path) => {
        writeFileSync(path, Buffer.from(thumb, "base64"), { mode: 0o600 });
      });
    }
    const mime = (message.content.mimeType ?? (message.content.mediaKind === "sticker" ? "image/webp" : "application/octet-stream")).split(";")[0]!.trim();
    return this.host.media.fetch(`wa:m:${jid}:${message.id}`, mime, async (path) => {
      if (!this.connected) throw new BridgeError("unavailable", "WhatsApp is not connected");
      const index = list.indexOf(message);
      const newer = list.slice(index + 1).find((candidate) => (candidate.timestampMs ?? 0) > 0 && candidate.key?.id && !candidate.x?.system);
      try {
        await this.backend.downloadMedia(message, path, newer?.timestampMs ? { key: newer.key, timestampMs: newer.timestampMs } : undefined);
      } catch (error) {
        this.log.warn("wa.media_failed", { error: safeError(error) });
        throw new BridgeError("unavailable", "WhatsApp could not download this media");
      }
    });
  }

  private fetchPicture(jid: string) {
    if (this.pictureKnownAbsent(jid)) return Promise.reject(new BridgeError("not_found", "no picture"));
    const week = Math.floor(Date.now() / PICTURE_MAX_AGE_MS);
    return this.host.media.fetch(`wa:a:${jid}:${week}`, "image/jpeg", (path) => this.queuePicture(async () => {
      if (!this.connected) throw new BridgeError("unavailable", "WhatsApp is not connected");
      const wait = this.picturePausedUntil - Date.now();
      if (wait > 0) throw new BridgeError("rate_limited", "profile pictures are paused", { retry_after_ms: wait });
      let found: boolean;
      try {
        found = await this.backend.profilePicture(jid, path);
      } catch (error) {
        const code = (error as { data?: unknown })?.data;
        if (code === 429) {
          this.picturePausedUntil = Date.now() + PICTURE_BACKOFF_MS;
          throw new BridgeError("rate_limited", "WhatsApp asks to slow down", { retry_after_ms: PICTURE_BACKOFF_MS });
        }
        throw new BridgeError("unavailable", "the picture could not be fetched");
      }
      if (!found) {
        this.store.noPicture.set(jid, Date.now());
        this.store.changedMeta();
        if (this.store.chats.has(jid)) {
          this.touched.add(jid);
          this.scheduleFlush();
        }
        throw new BridgeError("not_found", "no picture");
      }
      if (this.store.noPicture.delete(jid)) this.store.changedMeta();
    }));
  }

  /** Profile pictures are queries through the session: one at a time. */
  private queuePicture(run: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pictureQueue.push(() => run().then(resolve, reject));
      void this.pumpPictures();
    });
  }

  private async pumpPictures(): Promise<void> {
    if (this.pictureBusy) return;
    this.pictureBusy = true;
    try {
      while (this.pictureQueue.length > 0) await this.pictureQueue.shift()!();
    } finally {
      this.pictureBusy = false;
    }
  }

  /** Groups whose name is unknown: asked one at a time, once a session. */
  private async pumpGroups(): Promise<void> {
    if (this.groupBusy || !this.connected) return;
    this.groupBusy = true;
    try {
      while (this.connected && !this.stopped) {
        const jid = [...this.groupQueue].find((candidate) => !this.groupAsked.has(candidate));
        if (!jid) break;
        this.groupQueue.delete(jid);
        this.groupAsked.add(jid);
        const meta = this.store.chats.get(jid);
        if (!meta || meta.name || !listable(meta)) continue;
        try {
          const info = await this.backend.groupInfo(jid);
          if (info?.subject) meta.name = info.subject;
          if (info?.size) meta.members = info.size;
          this.store.changedMeta();
          this.touched.add(jid);
          this.scheduleFlush();
        } catch (error) {
          this.log.info("wa.group_info_failed", { error: safeError(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      this.groupBusy = false;
    }
  }

  // ---- writes (the bridge checks the writes guard first) ----

  async send(args: { chat: string; text: string; reply_to?: string | null; client_id?: string | null; media?: string[] }): Promise<WireMessage> {
    const jid = this.chatFor(args.chat);
    if (args.media && args.media.length > 0) throw new BridgeError("invalid_argument", "sending media is not supported yet");
    if (!this.connected) throw new BridgeError("unavailable", "WhatsApp is not connected");
    const list = this.store.messages(jid);
    const quoted = args.reply_to ? list.find((message) => message.id === args.reply_to) : undefined;
    const id = this.backend.newMessageId();
    const self = this.selfJid ?? undefined;
    const pending: StoredMessage = {
      key: { id, chatId: jid, fromMe: true }, id, chatId: jid, fromMe: true, ...(self ? { senderId: self } : {}),
      timestampMs: Date.now(), receivedAtMs: Date.now(), content: { kind: "text", text: args.text },
      ...(quoted ? { replyTo: { id: quoted.id, chatId: jid, ...(quoted.senderId ? { participantId: quoted.senderId } : {}) } } : {}),
      x: { status: "pending", ...(args.client_id ? { clientId: args.client_id } : {}) },
    };
    this.upsertMessages([pending], { preferExisting: false, live: false });
    this.scheduleFlush();
    try {
      const sent = await this.backend.sendText(jid, args.text, quoted, id);
      const stored = this.takeExtras(sent);
      this.upsertMessages([{ ...stored, x: { ...stored.x, status: higherStatus(stored.x?.status, "sent") ?? "sent", ...(args.client_id ? { clientId: args.client_id } : {}) } }], { preferExisting: false, live: false });
    } catch (error) {
      this.log.warn("wa.send_failed", { error: safeError(error) });
      const failed = this.store.messages(jid).find((message) => message.id === id);
      if (failed) {
        failed.x = { ...failed.x, status: "failed" };
        this.store.touchMessages(jid);
        this.emitMessage(jid, failed, false);
      }
      throw new BridgeError("uncertain", "the message may not have been sent");
    } finally {
      this.scheduleFlush();
    }
    const message = this.store.messages(jid).find((candidate) => candidate.id === id)!;
    return this.wireMessage(jid, message);
  }

  async react(args: { chat: string; message: string; emoji: string; remove: boolean }): Promise<void> {
    const jid = this.chatFor(args.chat);
    const message = this.store.messages(jid).find((candidate) => candidate.id === args.message);
    if (!message) throw new BridgeError("not_found", "no such message");
    if (!this.connected) throw new BridgeError("unavailable", "WhatsApp is not connected");
    await this.backend.sendReaction(message.key, args.remove ? "" : args.emoji);
  }

  async markRead(args: { chat: string; message?: string | null }): Promise<void> {
    const jid = this.chatFor(args.chat);
    const meta = this.store.chats.get(jid)!;
    const unread = Math.max(1, meta.unreadCount ?? 0);
    const keys = this.store.messages(jid).filter((message) => !message.fromMe && !message.x?.system)
      .slice(-Math.min(unread, 50)).map((message) => message.key);
    if (keys.length > 0 && this.connected) await this.backend.markRead(keys);
    meta.unreadCount = 0;
    this.store.unreadDelta.delete(jid);
    this.store.changedMeta();
    this.touched.add(jid);
    this.scheduleFlush();
  }

  // ---- extensions ----

  get commands(): Provider["commands"] {
    const commands: NonNullable<Provider["commands"]> = {
      /** What the chat header and the contact page show. */
      "whatsapp.chat_info": {
        run: async (args) => {
          const jid = this.chatFor(String(args.chat ?? ""));
          const meta = this.store.chats.get(jid)!;
          const contact = this.store.contacts.get(jid);
          if (meta.kind === "group" && this.connected && !meta.members) {
            try {
              const info = await this.backend.groupInfo(jid);
              if (info?.size) meta.members = info.size;
              if (info?.subject) meta.name = info.subject;
            } catch { /* best effort */ }
          }
          return {
            title: this.chatTitle(meta),
            phone: meta.kind === "group" ? null : formattedPhone(jid),
            push_name: cleanName(contact?.pushName) || null,
            members: meta.members ?? null,
            group: meta.kind === "group",
            muted: isWhatsAppChatMuted(meta.mutedUntilMs),
            messages: this.store.messages(jid).length,
          };
        },
      },
    };
    if (this.fixtures) {
      const fixtures = this.fixtures;
      commands["whatsapp.fixtures.scan"] = { run: async () => { fixtures.scan(); return {}; } };
      commands["whatsapp.fixtures.poke"] = {
        run: async (args) => {
          const chat = typeof args.chat === "string" ? this.canonical(jidOfChat(args.chat)) : undefined;
          fixtures.poke(chat, typeof args.text === "string" ? args.text : undefined);
          return {};
        },
      };
    }
    return commands;
  }
}
