/**
 * The real WhatsApp: record's backend (`src/whatsapp/backend.ts`, Baileys,
 * its browser identity, version and history settings, its auth store) run
 * in the bridge's own process, with its worker's operations
 * (`src/whatsapp/worker.ts`) as methods. One setting differs from record's
 * terminal client: `markOnlineOnConnect` is off, so the account never shows
 * "online" and the primary phone keeps its pushes (Baileys then sends
 * WhatsApp Web's inactive receipts). Read receipts, presence and typing are
 * never sent here; sends happen only through the bridge's writes guard.
 *
 * Beside record's converters, the bridge listens to the same socket for
 * what they leave out (thumbnails, quoted text, receipts, deletions, group
 * notices and names): `RawEvent`s, emitted before record's own events for
 * the same messages.
 */

import makeWASocket, {
  generateMessageIDV2,
  normalizeMessageContent,
  proto,
  WAMessageStubType,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createRecordWhatsAppBackend, type RecordWhatsAppBackend } from "../../../whatsapp/backend";
import { toWhatsAppMessage, toWhatsAppMessageKey } from "../../../whatsapp/converters";
import { downloadWhatsAppMediaToFile } from "../../../whatsapp/media";
import { fetchWhatsAppProfilePictureUrl } from "../../../whatsapp/profilepicture";
import { buildWhatsAppSendOptions, resolveWhatsAppEphemeralExpiration, sendWhatsAppReaction } from "../../../whatsapp/sending";
import type {
  WhatsAppBackendEventListener,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppMessage,
} from "../../../whatsapp/types";
import { downloadUrl } from "../../media";
import type { GroupInfo, RawEvent, WaBackend } from "./backend";
import type { Extras, MessageStatus, StoredMessage, SystemNotice } from "./store";

const THUMB_MAX_BYTES = 24 * 1024;
const PICTURE_MAX_BYTES = 4 * 1024 * 1024;

type Listener = (event: unknown) => void;

function contextInfo(message: proto.IMessage): proto.IContextInfo | undefined {
  return message.extendedTextMessage?.contextInfo
    ?? message.imageMessage?.contextInfo
    ?? message.videoMessage?.contextInfo
    ?? message.audioMessage?.contextInfo
    ?? message.documentMessage?.contextInfo
    ?? message.stickerMessage?.contextInfo
    ?? message.ptvMessage?.contextInfo
    ?? message.contactMessage?.contextInfo
    ?? message.locationMessage?.contextInfo
    ?? message.pollCreationMessage?.contextInfo
    ?? undefined;
}

/** A quoted message in a few words (as WhatsApp's reply bar shows it). */
export function quotedText(message: proto.IMessage | null | undefined): string {
  const content = normalizeMessageContent(message);
  if (!content) return "";
  const text = content.conversation ?? content.extendedTextMessage?.text
    ?? content.imageMessage?.caption ?? content.videoMessage?.caption ?? content.documentMessage?.caption;
  if (text) return text.replace(/\s+/g, " ").trim().slice(0, 200);
  if (content.imageMessage) return "📷 Photo";
  if (content.videoMessage?.gifPlayback) return "GIF";
  if (content.videoMessage || content.ptvMessage) return "🎥 Video";
  if (content.audioMessage) return content.audioMessage.ptt ? "🎤 Voice message" : "🎵 Audio";
  if (content.stickerMessage) return "Sticker";
  if (content.documentMessage) return `📄 ${content.documentMessage.fileName ?? "Document"}`;
  if (content.contactMessage) return `👤 ${content.contactMessage.displayName ?? "Contact"}`;
  if (content.locationMessage || content.liveLocationMessage) return "📍 Location";
  if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) return "📊 Poll";
  return "";
}

const STATUS: Record<number, MessageStatus> = {
  [proto.WebMessageInfo.Status.ERROR]: "failed",
  [proto.WebMessageInfo.Status.PENDING]: "pending",
  [proto.WebMessageInfo.Status.SERVER_ACK]: "sent",
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: "delivered",
  [proto.WebMessageInfo.Status.READ]: "read",
  [proto.WebMessageInfo.Status.PLAYED]: "read",
};

export function messageStatus(value: unknown): MessageStatus | undefined {
  return typeof value === "number" ? STATUS[value] : undefined;
}

/** What record's converter leaves out of a message, or null. */
export function messageExtras(message: WAMessage): Extras | null {
  const extras: Extras = {};
  const content = normalizeMessageContent(message.message);
  if (content) {
    const media = content.imageMessage ?? content.videoMessage ?? content.ptvMessage ?? content.documentMessage
      ?? content.stickerMessage;
    const thumb = (media as { jpegThumbnail?: Uint8Array | null } | null | undefined)?.jpegThumbnail;
    if (thumb && thumb.byteLength > 0 && thumb.byteLength <= THUMB_MAX_BYTES) {
      extras.thumb = Buffer.from(thumb).toString("base64");
    }
    const context = contextInfo(content);
    if (context?.quotedMessage) {
      const text = quotedText(context.quotedMessage);
      extras.quote = { text, ...(context.participant ? { participant: context.participant } : {}) };
    }
    if (context?.isForwarded) extras.forwarded = true;
    const argb = content.extendedTextMessage?.backgroundArgb;
    if (typeof argb === "number" && argb !== 0) extras.color = argb >>> 0;
  }
  if (message.key?.fromMe) {
    const status = messageStatus(message.status);
    if (status) extras.status = status;
  }
  return Object.keys(extras).length > 0 ? extras : null;
}

function participantJid(parameter: string): string {
  try {
    const value = JSON.parse(parameter) as { phoneNumber?: string; lid?: string; id?: string };
    if (value && typeof value === "object") return value.phoneNumber ?? value.lid ?? value.id ?? parameter;
  } catch {
    // Older stubs carry the jid itself.
  }
  return parameter;
}

/** A group notice or missed call as a notice row, or null for stubs nobody needs to see. */
export function stubNotice(message: WAMessage): SystemNotice | null {
  const type = message.messageStubType;
  if (!type) return null;
  const parameters = message.messageStubParameters ?? [];
  const actor = message.key?.participant ?? message.participant ?? undefined;
  const targets = () => parameters.map(participantJid).filter(Boolean);
  const with_ = (notice: SystemNotice): SystemNotice => (actor ? { ...notice, actor } : notice);
  switch (type) {
    case WAMessageStubType.GROUP_CREATE: return with_({ type: "created", text: parameters[0] ?? "" });
    case WAMessageStubType.GROUP_CHANGE_SUBJECT: return with_({ type: "subject", text: parameters[0] ?? "" });
    case WAMessageStubType.GROUP_CHANGE_ICON: return with_({ type: "icon" });
    case WAMessageStubType.GROUP_CHANGE_DESCRIPTION: return with_({ type: "description" });
    case WAMessageStubType.GROUP_PARTICIPANT_ADD: return with_({ type: "added", targets: targets() });
    case WAMessageStubType.GROUP_PARTICIPANT_REMOVE: return with_({ type: "removed", targets: targets() });
    case WAMessageStubType.GROUP_PARTICIPANT_LEAVE: return { type: "left", targets: targets() };
    case WAMessageStubType.GROUP_PARTICIPANT_INVITE: return { type: "joined", targets: targets() };
    case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER: return { type: "number", targets: targets() };
    case WAMessageStubType.CALL_MISSED_VOICE:
    case WAMessageStubType.CALL_MISSED_GROUP_VOICE:
      return { type: "missed_voice" };
    case WAMessageStubType.CALL_MISSED_VIDEO:
    case WAMessageStubType.CALL_MISSED_GROUP_VIDEO:
      return { type: "missed_video" };
    default: return null;
  }
}

/** A stub message as a stored notice row, or null. */
export function noticeMessage(message: WAMessage, selfId: string | undefined): StoredMessage | null {
  const notice = stubNotice(message);
  const key = message.key ? toWhatsAppMessageKey(message.key) : null;
  if (!notice || !key) return null;
  const seconds = Number(message.messageTimestamp ?? 0);
  const fromMe = Boolean(key.fromMe);
  const senderId = notice.actor ?? (fromMe ? selfId : key.chatId);
  return {
    key, id: key.id, chatId: key.chatId, fromMe,
    timestampMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    content: { kind: "unsupported", sourceType: "stub" },
    ...(senderId ? { senderId } : {}),
    x: { system: notice },
  };
}

/** The quoted message record's worker builds for a reply. */
function quotedMessage(message: WhatsAppMessage): WAMessage {
  const body = message.content.kind === "text"
    ? { conversation: message.content.text }
    : message.content.kind === "media" && message.content.caption
      ? { extendedTextMessage: { text: message.content.caption } }
      : { conversation: "" };
  return {
    key: { id: message.key.id, remoteJid: message.key.chatId, fromMe: message.key.fromMe ?? message.fromMe, participant: message.key.participantId },
    message: body,
    messageTimestamp: Math.floor((message.timestampMs ?? Date.now()) / 1000),
  };
}

const RECORD_EVENTS: WhatsAppBackendEventName[] = ["state", "qr", "history", "messages", "reactions", "chats", "contacts", "lid-mapping", "error"];

export function createLiveBackend(options: { authDirectory: string }): WaBackend {
  // As record's worker: Signal code writes sessions and keys through the
  // global console, not Baileys' (silent) logger. The bridge's own log
  // writes to stderr directly.
  for (const method of ["log", "info", "debug", "warn", "error", "dir", "trace"] as const) {
    console[method] = (() => {}) as typeof console[typeof method];
  }
  const listeners = new Map<WhatsAppBackendEventName, Set<Listener>>();
  const rawListeners = new Set<(event: RawEvent) => void>();
  let inner: RecordWhatsAppBackend | null = null;
  let unbind: (() => void)[] = [];
  let state: WhatsAppConnectionState = { status: "idle" };

  const raw = (event: RawEvent) => {
    for (const listener of rawListeners) {
      try { listener(event); } catch { /* the provider logs its own failures */ }
    }
  };

  const tapMessages = (socket: WASocket, messages: readonly WAMessage[], live: boolean) => {
    for (const message of messages) {
      const id = message.key?.id;
      if (!id) continue;
      if (message.messageStubType) {
        const notice = noticeMessage(message, socket.user?.id);
        if (notice) raw({ kind: "system", message: notice, live });
        continue;
      }
      const extras = messageExtras(message);
      if (extras) raw({ kind: "extras", id, extras });
    }
  };

  // Registered as the socket is made, before record's backend binds its
  // own listeners: a message's extras arrive before record's event for it.
  const tap = (socket: WASocket) => {
    socket.ev.on("messages.upsert", ({ messages, type }) => tapMessages(socket, messages, type === "notify"));
    socket.ev.on("messaging-history.set", ({ messages }) => tapMessages(socket, messages, false));
    socket.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        if (!key?.id || !key.remoteJid) continue;
        if (update.messageStubType === WAMessageStubType.REVOKE && update.message === null) {
          raw({ kind: "revoke", chatId: key.remoteJid, id: key.id });
          continue;
        }
        const status = key.fromMe ? messageStatus(update.status) : undefined;
        if (status) raw({ kind: "status", chatId: key.remoteJid, id: key.id, status });
      }
    });
    socket.ev.on("groups.update", (updates) => {
      for (const update of updates) {
        if (update.id && typeof update.subject === "string") raw({ kind: "group", chatId: update.id, subject: update.subject });
      }
    });
    socket.ev.on("groups.upsert", (groups: GroupMetadata[]) => {
      for (const group of groups) {
        if (group.id) raw({ kind: "group", chatId: group.id, subject: group.subject, size: group.participants?.length ?? group.size });
      }
    });
  };

  const make = () => {
    for (const off of unbind.splice(0)) off();
    const backend = createRecordWhatsAppBackend({
      authDirectory: options.authDirectory,
      socketFactory: (config: UserFacingSocketConfig) => {
        const socket = makeWASocket(config);
        tap(socket);
        return socket;
      },
      socketConfig: { markOnlineOnConnect: false },
    });
    for (const event of RECORD_EVENTS) {
      unbind.push(backend.on(event, (data: unknown) => {
        if (event === "state") state = data as WhatsAppConnectionState;
        for (const listener of [...(listeners.get(event) ?? [])]) {
          try { listener(data); } catch { /* the provider logs its own failures */ }
        }
      }));
    }
    inner = backend;
    return backend;
  };

  const current = () => inner ?? make();
  const socket = () => current().getSocket();

  return {
    get state() { return state; },
    on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(listener as Listener);
      return () => set!.delete(listener as Listener);
    },
    onRaw(listener) {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
    async hasSession() {
      try {
        const creds = JSON.parse(readFileSync(join(options.authDirectory, "creds.json"), "utf8"));
        return Boolean(creds?.registered || creds?.me?.id || creds?.me?.lid);
      } catch {
        return false;
      }
    },
    startLogin() {
      // A backend that was shut down (or failed for good) cannot start again.
      const backend = inner && !["stopped"].includes(inner.state.status) ? inner : make();
      return backend.startLogin();
    },
    cancelLogin() {
      return inner?.cancelLogin() ?? false;
    },
    async logout() {
      const backend = inner;
      if (!backend) return;
      try {
        await backend.getSocket().logout();
      } finally {
        await backend.shutdown().catch(() => {});
        inner = null;
      }
    },
    async shutdown() {
      const backend = inner;
      inner = null;
      for (const off of unbind.splice(0)) off();
      await backend?.shutdown();
      state = { status: "stopped" };
    },
    fetchHistory(count, key, timestampMs) {
      return current().fetchHistory(count, key, timestampMs);
    },
    async downloadMedia(message, path, anchor) {
      const backend = current();
      const source = message.content.kind === "media" && message.content.download
        ? message
        : await backend.recoverMediaMessage(message, anchor);
      return downloadWhatsAppMediaToFile(backend.getSocket(), source, path);
    },
    async profilePicture(jid, path, full = false) {
      // The full picture as WhatsApp Web asks for it on a contact's page.
      const url = full
        ? await socket().profilePictureUrl(jid, "image", 10_000).then(
          (value) => (typeof value === "string" && value.startsWith("https://") ? value : null),
          (error) => {
            const code = (error as { data?: unknown }).data;
            if (code === 404 || code === 401) return null;
            throw error;
          },
        )
        : await fetchWhatsAppProfilePictureUrl(socket(), jid);
      if (!url) return false;
      await downloadUrl(url, path, { maxBytes: PICTURE_MAX_BYTES, timeoutMs: 20_000 });
      return true;
    },
    async groupInfo(jid): Promise<GroupInfo | null> {
      const metadata = await socket().groupMetadata(jid);
      return { subject: metadata.subject ?? null, size: metadata.participants?.length ?? metadata.size ?? null };
    },
    newMessageId() {
      return generateMessageIDV2(inner?.isConnected ? socket().user?.id : undefined);
    },
    async sendText(chatId, text, quoted, messageId) {
      const live = socket();
      const expiration = await resolveWhatsAppEphemeralExpiration(live, chatId, undefined);
      const sent = await live.sendMessage(chatId, { text }, {
        ...buildWhatsAppSendOptions(quoted ? quotedMessage(quoted) : undefined, expiration),
        messageId,
      });
      const converted = sent ? toWhatsAppMessage(sent, { selfId: live.user?.id }) : null;
      if (!converted) throw new Error("WhatsApp did not return the sent message.");
      return converted;
    },
    async sendReaction(key, emoji) {
      await sendWhatsAppReaction(socket(), key, emoji);
    },
    async markRead(keys) {
      await socket().readMessages(keys.map((key) => ({
        remoteJid: key.chatId, id: key.id, fromMe: key.fromMe, participant: key.participantId,
      })));
    },
  };
}
