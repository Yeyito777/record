import {
  getContentType,
  normalizeMessageContent,
  proto,
  type Chat,
  type ChatUpdate,
  type Contact,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
} from "@whiskeysockets/baileys";

import type {
  WhatsAppChat,
  WhatsAppChatKind,
  WhatsAppContact,
  WhatsAppHistorySyncKind,
  WhatsAppMediaContent,
  WhatsAppMessage,
  WhatsAppMessageContent,
  WhatsAppMessageKey,
} from "./types";

function finiteNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  // WhatsApp fields are not fully consistent: normalize seconds and millis.
  return Math.abs(number) < 100_000_000_000 ? number * 1_000 : number;
}

function chatKind(id: string): WhatsAppChatKind {
  if (id.endsWith("@g.us")) return "group";
  if (id.endsWith("@s.whatsapp.net") || id.endsWith("@lid")) return "direct";
  if (id.endsWith("@broadcast")) return "broadcast";
  if (id.endsWith("@newsletter")) return "newsletter";
  return "unknown";
}

export function toWhatsAppMessageKey(key: WAMessageKey | proto.IMessageKey): WhatsAppMessageKey | null {
  const id = key.id;
  const chatId = key.remoteJid;
  if (!id || !chatId) return null;

  const extended = key as WAMessageKey;
  const result: WhatsAppMessageKey = { id, chatId };
  if (key.fromMe != null) result.fromMe = key.fromMe;
  if (key.participant) result.participantId = key.participant;
  if (extended.remoteJidAlt) result.alternateChatId = extended.remoteJidAlt;
  if (extended.participantAlt) result.alternateParticipantId = extended.participantAlt;
  return result;
}

export interface WhatsAppMessageConversionOptions {
  /** Needed to identify the sender of outgoing one-to-one messages. */
  selfId?: string;
  /** Baileys uses messageTimestamp as the edit time in messages.update. */
  edited?: boolean;
}

function contextInfoFor(message: proto.IMessage): proto.IContextInfo | undefined {
  return message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.stickerMessage?.contextInfo ??
    undefined;
}

function normalizeEphemeralExpiration(value: unknown): number | undefined {
  if (value == null) return undefined;
  const number = finiteNumber(value);
  if (number === undefined || number < 0) return undefined;
  return Math.floor(number);
}

/**
 * Returns the disappearing-message duration carried by a WhatsApp message.
 * `undefined` means the message has no setting; `0` explicitly disables it.
 */
export function getWhatsAppMessageEphemeralExpiration(
  message: WAMessage | proto.IWebMessageInfo,
): number | undefined {
  const normalized = normalizeMessageContent(message.message);
  if (!normalized) return undefined;

  const protocol = normalized.protocolMessage;
  if (protocol?.type === proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING) {
    return normalizeEphemeralExpiration(protocol.ephemeralExpiration);
  }
  return normalizeEphemeralExpiration(contextInfoFor(normalized)?.expiration);
}

/** Converts a message-level disappearing setting into a persistable chat patch. */
export function toWhatsAppEphemeralChatPatch(
  message: WAMessage | proto.IWebMessageInfo,
): WhatsAppChat | null {
  const id = message.key?.remoteJid;
  if (!id) return null;
  const ephemeralExpirationSeconds = getWhatsAppMessageEphemeralExpiration(message);
  if (ephemeralExpirationSeconds === undefined) return null;
  return { id, kind: chatKind(id), ephemeralExpirationSeconds };
}

function replyKeyFor(message: proto.IMessage, chatId: string): WhatsAppMessageKey | undefined {
  const context = contextInfoFor(message);
  if (!context?.stanzaId) return undefined;

  const key: WhatsAppMessageKey = {
    id: context.stanzaId,
    chatId: context.remoteJid || chatId,
  };
  if (context.participant) key.participantId = context.participant;
  return key;
}

function mediaContent(
  mediaKind: WhatsAppMediaContent["mediaKind"],
  media: {
    caption?: string | null;
    mimetype?: string | null;
    fileName?: string | null;
    fileLength?: unknown;
    width?: number | null;
    height?: number | null;
    seconds?: number | null;
    ptt?: boolean | null;
    gifPlayback?: boolean | null;
    isAnimated?: boolean | null;
    viewOnce?: boolean | null;
  },
): WhatsAppMediaContent {
  const content: WhatsAppMediaContent = { kind: "media", mediaKind };
  if (media.caption != null) content.caption = media.caption;
  if (media.mimetype) content.mimeType = media.mimetype;
  if (media.fileName) content.fileName = media.fileName;

  const sizeBytes = finiteNumber(media.fileLength);
  if (sizeBytes !== undefined) content.sizeBytes = sizeBytes;
  if (media.width != null) content.width = media.width;
  if (media.height != null) content.height = media.height;
  if (media.seconds != null) content.durationSeconds = media.seconds;
  if (media.ptt != null) content.voiceNote = media.ptt;
  if (media.gifPlayback != null) content.animated = media.gifPlayback;
  if (media.isAnimated != null) content.animated = media.isAnimated;
  if (media.viewOnce != null) content.viewOnce = media.viewOnce;
  return content;
}

function contentFor(message: proto.IMessage): WhatsAppMessageContent {
  if (message.conversation != null) {
    return { kind: "text", text: message.conversation };
  }
  if (message.extendedTextMessage?.text != null) {
    return { kind: "text", text: message.extendedTextMessage.text };
  }
  if (message.imageMessage) return mediaContent("image", message.imageMessage);
  if (message.videoMessage) return mediaContent("video", message.videoMessage);
  if (message.audioMessage) return mediaContent("audio", message.audioMessage);
  if (message.documentMessage) return mediaContent("document", message.documentMessage);
  if (message.stickerMessage) return mediaContent("sticker", message.stickerMessage);
  return { kind: "unsupported", sourceType: getContentType(message) };
}

export function toWhatsAppMessage(
  message: WAMessage | proto.IWebMessageInfo,
  options: WhatsAppMessageConversionOptions = {},
): WhatsAppMessage | null {
  const key = message.key ? toWhatsAppMessageKey(message.key as WAMessageKey) : null;
  const normalized = normalizeMessageContent(message.message);
  if (!key || !normalized) return null;
  // A disappearing-message toggle updates chat state; it is not a timeline
  // message. The backend forwards it separately as a WhatsAppChat patch.
  if (normalized.protocolMessage) return null;

  const participant = message.key?.participant || (message.key as WAMessageKey | undefined)?.participantAlt;
  const fromMe = Boolean(message.key?.fromMe);
  const senderId = participant || (fromMe ? options.selfId : key.chatId);
  const timestampSeconds = finiteNumber(message.messageTimestamp);
  const result: WhatsAppMessage = {
    key,
    id: key.id,
    chatId: key.chatId,
    fromMe,
    timestampMs: options.edited || timestampSeconds === undefined ? null : timestampSeconds * 1_000,
    content: contentFor(normalized),
  };

  if (options.edited && timestampSeconds !== undefined) result.editedTimestampMs = timestampSeconds * 1_000;
  if (senderId) result.senderId = senderId;
  if (message.pushName) result.senderName = message.pushName;
  const replyTo = replyKeyFor(normalized, key.chatId);
  if (replyTo) result.replyTo = replyTo;
  return result;
}

/** Converts content-bearing Baileys patches, including message edits. */
export function toWhatsAppMessageUpdate(
  entry: WAMessageUpdate,
  options: WhatsAppMessageConversionOptions = {},
): WhatsAppMessage | null {
  if (!entry.update.message) return null;
  const edited = Boolean(entry.update.message.editedMessage);
  const message = {
    ...entry.update,
    key: { ...entry.key, ...entry.update.key },
  } as WAMessage;
  return toWhatsAppMessage(message, { ...options, edited });
}

export function toWhatsAppChat(chat: Chat | ChatUpdate): WhatsAppChat | null {
  if (!chat.id) return null;
  const result: WhatsAppChat = { id: chat.id, kind: chatKind(chat.id) };

  const displayName = chat.name ?? chat.displayName;
  if (displayName != null) result.name = displayName;

  const lastMessageAtMs = epochMilliseconds(chat.lastMessageRecvTimestamp ?? chat.lastMsgTimestamp);
  if (lastMessageAtMs !== undefined) result.lastMessageAtMs = lastMessageAtMs;
  if (chat.unreadCount != null) result.unreadCount = chat.unreadCount;
  if (chat.archived != null) result.archived = chat.archived;
  if (chat.pinned != null) {
    const pinned = finiteNumber(chat.pinned);
    result.pinned = pinned !== undefined && pinned > 0;
  }
  if (chat.readOnly != null) result.readOnly = chat.readOnly;
  if (chat.ephemeralExpiration != null) {
    result.ephemeralExpirationSeconds = chat.ephemeralExpiration;
  }
  if (chat.muteEndTime != null) {
    const mute = finiteNumber(chat.muteEndTime);
    result.mutedUntilMs = mute && mute > 0 ? epochMilliseconds(mute) ?? null : null;
  }
  return result;
}

export function toWhatsAppContact(contact: Partial<Contact>): WhatsAppContact | null {
  if (!contact.id) return null;
  const result: WhatsAppContact = { id: contact.id };
  if (contact.lid != null) result.lid = contact.lid;
  if (contact.phoneNumber != null) result.phoneId = contact.phoneNumber;
  if (contact.name != null) result.name = contact.name;
  if (contact.notify != null) result.pushName = contact.notify;
  if (contact.verifiedName != null) result.verifiedName = contact.verifiedName;
  if (contact.imgUrl !== undefined) result.avatarUrl = contact.imgUrl;
  if (contact.status != null) result.status = contact.status;
  return result;
}

export function toWhatsAppHistorySyncKind(syncType: number | null | undefined): WhatsAppHistorySyncKind {
  switch (syncType) {
    case 0: return "initial-bootstrap";
    case 1: return "initial-status";
    case 2: return "full";
    case 3: return "recent";
    case 4: return "push-name";
    case 5: return "non-blocking-data";
    case 6: return "on-demand";
    case 7: return "no-history";
    case 8: return "message-access-status";
    default: return "unknown";
  }
}
