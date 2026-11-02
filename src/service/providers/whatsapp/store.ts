/**
 * What the WhatsApp bridge knows, on disk in its state directory (`wa/`,
 * root-only): the account, contacts and chats in `meta.json`, and each
 * chat's messages in a file of its own (`messages/HASH.json`), loaded when
 * the chat is asked for and kept in memory for the few chats used last.
 * Messages are record's (`src/whatsapp/types.ts`), as its converters make
 * them, plus what the bridge reads off the same socket that record's
 * converters leave out (`Extras`: a thumbnail, the quoted text, receipts).
 * Merging follows record's `integration.ts`, which the bridge cannot import
 * (it pulls in record's terminal UI).
 */

import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDir, readJson, writePrivateAtomic } from "../../files";
import type { WhatsAppAccount, WhatsAppChat, WhatsAppContact, WhatsAppMessage } from "../../../whatsapp/types";

const STORE_VERSION = 1;
const SAVE_DELAY_MS = 2_000;
/** Messages kept per chat (the oldest go first). */
export const MAX_MESSAGES_PER_CHAT = 5_000;
/** Chats whose messages stay in memory once loaded. */
const LOADED_CHATS = 8;

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

/** A notice row: who did what (rendered with the names known when shown). */
export interface SystemNotice {
  type: "created" | "subject" | "icon" | "description" | "added" | "removed" | "left" | "joined" | "missed_voice" | "missed_video" | "number";
  /** Who did it (a jid), when known. */
  actor?: string;
  /** Whom it was done to (jids). */
  targets?: string[];
  /** The new subject, for `subject` and `created`. */
  text?: string;
}

/** What record's converters leave out, read off the same socket. */
export interface Extras {
  /** The message's own thumbnail (JPEG, base64): a photo's or video's preview. */
  thumb?: string;
  /** The quoted message as the sender's phone attached it. */
  quote?: { text: string; participant?: string };
  forwarded?: boolean;
  deleted?: boolean;
  status?: MessageStatus;
  system?: SystemNotice;
  /** A message this bridge sent (writes on): the app's id for it. */
  clientId?: string;
}

export interface StoredMessage extends WhatsAppMessage {
  x?: Extras;
}

/** The chat list's preview of a chat's newest message. */
export interface LastMessage {
  id: string;
  ts: number;
  fromMe: boolean;
  sender?: string;
  senderName?: string;
  /** The text, or what stands for it (`📷 Photo`). */
  text: string;
  status?: MessageStatus;
  deleted?: boolean;
  system?: boolean;
}

export interface ChatMeta extends WhatsAppChat {
  last?: LastMessage | null;
  members?: number;
}

interface SavedMeta {
  version: number;
  account: WhatsAppAccount | null;
  chats: ChatMeta[];
  contacts: WhatsAppContact[];
  unreadDelta: string[];
  /** jid → when it was found to have no picture. */
  noPicture: Record<string, number>;
}

interface SavedMessages {
  version: number;
  chat: string;
  messages: StoredMessage[];
}

/** record's integration.ts mergeDefined: a patch's missing fields keep the old values. */
export function mergeDefined<T extends object>(previous: T | undefined, patch: T): T {
  const merged = { ...(previous ?? {}), ...patch } as T;
  for (const [key, value] of Object.entries(patch)) {
    if (!previous || !(key in previous)) continue;
    const previousValue = (previous as Record<string, unknown>)[key];
    const missingPatch = value === undefined
      || (typeof value === "string" && value.trim() === ""
        && typeof previousValue === "string" && previousValue.trim() !== "");
    if (missingPatch) (merged as Record<string, unknown>)[key] = previousValue;
  }
  return merged;
}

/** record's compareWhatsAppMessages: by wire time, then arrival. */
export function compareMessages(
  left: Pick<WhatsAppMessage, "timestampMs" | "receivedAtMs">,
  right: Pick<WhatsAppMessage, "timestampMs" | "receivedAtMs">,
): number {
  const time = (left.timestampMs ?? left.receivedAtMs ?? 0) - (right.timestampMs ?? right.receivedAtMs ?? 0);
  return time || (left.receivedAtMs ?? 0) - (right.receivedAtMs ?? 0);
}

/** record's mergeWhatsAppMessage, keeping the bridge's extras. */
export function mergeMessage(previous: StoredMessage | undefined, incoming: StoredMessage, preferExisting = false): StoredMessage {
  let message = incoming;
  const receivedAtMs = previous?.receivedAtMs ?? message.receivedAtMs ?? Date.now();
  if (!previous) return { ...message, receivedAtMs };
  if (preferExisting) {
    const newerContent = (message.editedTimestampMs ?? 0) > (previous.editedTimestampMs ?? 0)
      || (previous.content.kind === "unsupported" && message.content.kind !== "unsupported");
    [previous, message] = [message, previous];
    if (previous.reactions || message.reactions) {
      const reactions = new Map([...(previous.reactions ?? []), ...(message.reactions ?? [])]
        .map((reaction) => [reaction.senderId, reaction]));
      message = { ...message, reactions: [...reactions.values()] };
    }
    if (newerContent) {
      message = { ...message, content: previous.content, editedTimestampMs: previous.editedTimestampMs ?? message.editedTimestampMs };
    }
  }
  const content = message.content.kind === "media" && previous.content.kind === "media"
    ? { ...previous.content, ...message.content, download: message.content.download ?? previous.content.download }
    : message.content;
  const extras = previous.x || message.x ? { ...previous.x, ...message.x } : undefined;
  if (extras && previous.x?.deleted) extras.deleted = true;
  if (extras?.status && previous.x?.status && STATUS_RANK[previous.x.status] > STATUS_RANK[extras.status]) {
    extras.status = previous.x.status;
  }
  const merged: StoredMessage = {
    ...previous, ...message, content, receivedAtMs,
    key: { ...previous.key, ...message.key },
    timestampMs: message.timestampMs ?? previous.timestampMs,
    senderId: message.senderId ?? previous.senderId,
    senderName: message.senderName ?? previous.senderName,
    replyTo: message.replyTo ?? previous.replyTo,
  };
  if (extras) merged.x = extras;
  else delete merged.x;
  return merged;
}

const STATUS_RANK: Record<MessageStatus, number> = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 };

export function higherStatus(a: MessageStatus | undefined, b: MessageStatus | undefined): MessageStatus | undefined {
  if (!a) return b;
  if (!b) return a;
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/** record's isVisibleWhatsAppMessage: control envelopes are not messages. */
export function isVisibleMessage(message: WhatsAppMessage): boolean {
  return message.chatId !== "status@broadcast" && !(message.content.kind === "unsupported" && [
    "protocolMessage", "reactionMessage", "albumMessage", "secretEncryptedMessage", "associatedChildMessage",
    "senderKeyDistributionMessage", "messageContextInfo", "keepInChatMessage", "pinInChatMessage",
    "encReactionMessage", "pollUpdateMessage", "encEventResponseMessage",
  ].includes(message.content.sourceType ?? ""));
}

function fileName(jid: string): string {
  return `${createHash("sha256").update(jid).digest("hex").slice(0, 24)}.json`;
}

export class WaStore {
  account: WhatsAppAccount | null = null;
  readonly chats = new Map<string, ChatMeta>();
  readonly contacts = new Map<string, WhatsAppContact>();
  /** Chats whose unread count was built from chats.update deltas only. */
  readonly unreadDelta = new Set<string>();
  readonly noPicture = new Map<string, number>();
  private readonly loaded = new Map<string, StoredMessage[]>();
  private readonly dirty = new Set<string>();
  private metaDirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly dir: string | null;

  constructor(stateDir: string | null) {
    this.dir = stateDir ? join(stateDir, "wa") : null;
    if (!this.dir) return;
    ensurePrivateDir(join(this.dir, "messages"));
    const saved = readJson<SavedMeta>(join(this.dir, "meta.json"));
    if (saved?.version !== STORE_VERSION) return;
    this.account = saved.account ?? null;
    for (const chat of saved.chats ?? []) if (chat?.id) this.chats.set(chat.id, chat);
    for (const contact of saved.contacts ?? []) if (contact?.id) this.contacts.set(contact.id, contact);
    for (const id of saved.unreadDelta ?? []) this.unreadDelta.add(id);
    for (const [jid, at] of Object.entries(saved.noPicture ?? {})) if (typeof at === "number") this.noPicture.set(jid, at);
  }

  /** The chat's messages, oldest first (loaded from disk the first time). */
  messages(jid: string): StoredMessage[] {
    let list = this.loaded.get(jid);
    if (list) {
      // Most recently used last.
      this.loaded.delete(jid);
      this.loaded.set(jid, list);
      return list;
    }
    list = [];
    if (this.dir) {
      const saved = readJson<SavedMessages>(join(this.dir, "messages", fileName(jid)));
      if (saved?.version === STORE_VERSION && saved.chat === jid && Array.isArray(saved.messages)) list = saved.messages;
    }
    this.loaded.set(jid, list);
    this.evict();
    return list;
  }

  /** Whether a chat's messages are in memory (no disk read to look). */
  isLoaded(jid: string): boolean {
    return this.loaded.has(jid);
  }

  private evict(): void {
    while (this.loaded.size > LOADED_CHATS) {
      const oldest = [...this.loaded.keys()].find((jid) => !this.dirty.has(jid));
      if (!oldest) return;
      this.loaded.delete(oldest);
    }
  }

  /** Replaces a chat's messages (sorted, capped) and saves them soon. */
  setMessages(jid: string, list: StoredMessage[]): void {
    if (list.length > MAX_MESSAGES_PER_CHAT) list = list.slice(list.length - MAX_MESSAGES_PER_CHAT);
    this.loaded.delete(jid);
    this.loaded.set(jid, list);
    this.dirty.add(jid);
    this.scheduleSave();
  }

  /** The chat's messages changed in place. */
  touchMessages(jid: string): void {
    if (!this.loaded.has(jid)) return;
    this.dirty.add(jid);
    this.scheduleSave();
  }

  /** Moves a chat's messages to another jid (an LID that turned out to be a phone number). */
  moveMessages(from: string, to: string, merge: (a: StoredMessage[], b: StoredMessage[]) => StoredMessage[]): void {
    const moved = this.messages(from);
    if (moved.length === 0) return;
    this.setMessages(to, merge(this.messages(to), moved));
    this.loaded.delete(from);
    this.dirty.delete(from);
    if (this.dir) rmSync(join(this.dir, "messages", fileName(from)), { force: true });
  }

  dropChat(jid: string): void {
    this.chats.delete(jid);
    this.loaded.delete(jid);
    this.dirty.delete(jid);
    this.unreadDelta.delete(jid);
    if (this.dir) rmSync(join(this.dir, "messages", fileName(jid)), { force: true });
    this.changedMeta();
  }

  changedMeta(): void {
    this.metaDirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.dir || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SAVE_DELAY_MS);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dir) return;
    for (const jid of this.dirty) {
      const messages = this.loaded.get(jid) ?? [];
      const saved: SavedMessages = { version: STORE_VERSION, chat: jid, messages };
      writePrivateAtomic(join(this.dir, "messages", fileName(jid)), JSON.stringify(saved));
    }
    this.dirty.clear();
    this.evict();
    if (!this.metaDirty) return;
    this.metaDirty = false;
    const saved: SavedMeta = {
      version: STORE_VERSION,
      account: this.account,
      chats: [...this.chats.values()],
      contacts: [...new Map([...this.contacts.values()].map((contact) => [contact.id, contact])).values()],
      unreadDelta: [...this.unreadDelta],
      noPicture: Object.fromEntries(this.noPicture),
    };
    writePrivateAtomic(join(this.dir, "meta.json"), JSON.stringify(saved));
  }

  /** Forgets everything (signed out): the files go too. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.account = null;
    this.chats.clear();
    this.contacts.clear();
    this.unreadDelta.clear();
    this.noPicture.clear();
    this.loaded.clear();
    this.dirty.clear();
    this.metaDirty = false;
    if (!this.dir) return;
    rmSync(join(this.dir, "meta.json"), { force: true });
    for (const name of readdirSync(join(this.dir, "messages"))) rmSync(join(this.dir, "messages", name), { force: true });
  }
}
