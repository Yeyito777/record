import type { DiscordChannel, DiscordGuildMember, DiscordMessage, DiscordMessageAttachment, DiscordMessageReply } from "../discord";
import { WHATSAPP_GUILD_ID, whatsappChannelId, whatsappJidFromChannelId } from "../chatproviders";
import { createLoginModalState, type LoginModalState } from "./loginmodal";
import { sanitizeTerminalLabel, sanitizeTerminalText } from "./sanitize";
import type {
  WhatsAppAccount,
  WhatsAppChat,
  WhatsAppConnectionState,
  WhatsAppContact,
  WhatsAppMessage,
} from "./types";

export interface WhatsAppUiState {
  connection: WhatsAppConnectionState;
  loginModal: LoginModalState | null;
  account: WhatsAppAccount | null;
  chatsById: Record<string, WhatsAppChat>;
  contactsById: Record<string, WhatsAppContact>;
  messagesByChatId: Record<string, WhatsAppMessage[]>;
  loginRequestId: number;
  receivedQr: boolean;
}

const MAX_MESSAGES_PER_CHAT = 300;

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

export function createWhatsAppUiState(): WhatsAppUiState {
  return {
    connection: { status: "idle" },
    loginModal: null,
    account: null,
    chatsById: {},
    contactsById: {},
    messagesByChatId: {},
    loginRequestId: 0,
    receivedQr: false,
  };
}

export function resetWhatsAppUiState(state: WhatsAppUiState): void {
  const requestId = state.loginRequestId + 1;
  Object.assign(state, createWhatsAppUiState(), { loginRequestId: requestId });
}

export function beginWhatsAppLoginUi(state: WhatsAppUiState): number {
  state.loginRequestId += 1;
  state.receivedQr = false;
  state.loginModal = createLoginModalState({ phase: "starting" });
  return state.loginRequestId;
}

function mergeDefined<T extends object>(previous: T | undefined, patch: T): T {
  const merged = { ...(previous ?? {}), ...patch } as T;
  for (const [key, value] of Object.entries(patch)) {
    if (!previous || !(key in previous)) continue;
    const previousValue = (previous as Record<string, unknown>)[key];
    const missingPatch = value === undefined
      || (typeof value === "string" && value.trim() === ""
        && typeof previousValue === "string" && previousValue.trim() !== "");
    if (missingPatch) {
      (merged as Record<string, unknown>)[key] = previousValue;
    }
  }
  return merged;
}

export function upsertWhatsAppChats(state: WhatsAppUiState, chats: readonly WhatsAppChat[]): void {
  for (const chat of chats) {
    if (!chat.id || chat.id === "status@broadcast") continue;
    const id = canonicalWhatsAppJid(state, chat.id);
    const patch = id === chat.id ? chat : { ...chat, id };
    state.chatsById[id] = mergeDefined(state.chatsById[id], patch);
  }
}

export function upsertWhatsAppContacts(state: WhatsAppUiState, contacts: readonly WhatsAppContact[]): void {
  for (const contact of contacts) {
    if (!contact.id) continue;
    const id = normalizedDirectJid(contact.id);
    const previous = state.contactsById[id];
    const merged = mergeDefined(previous, contact);
    state.contactsById[id] = merged;
    for (const alias of [contact.lid, contact.phoneId, previous?.lid, previous?.phoneId]) {
      if (alias) {
        const normalizedAlias = normalizedDirectJid(alias);
        state.contactsById[normalizedAlias] = mergeDefined(state.contactsById[normalizedAlias], merged);
      }
    }
    const pair = directIdentityPair([id, contact.lid, contact.phoneId, previous?.lid, previous?.phoneId]);
    if (pair) registerWhatsAppLidMapping(state, pair.lid, pair.phoneId);
  }
}

export function registerWhatsAppLidMapping(state: WhatsAppUiState, lid: string, phoneId: string): boolean {
  const pair = directIdentityPair([lid, phoneId]);
  if (!pair) return false;
  lid = pair.lid;
  phoneId = pair.phoneId;

  const lidContact = state.contactsById[lid];
  const phoneContact = state.contactsById[phoneId];
  const mergedContact = mergeDefined(lidContact, {
    ...(phoneContact ?? {}),
    id: phoneId,
    lid,
    phoneId,
  });
  state.contactsById[lid] = mergedContact;
  state.contactsById[phoneId] = mergedContact;

  const lidChat = state.chatsById[lid];
  const phoneChat = state.chatsById[phoneId];
  if (lidChat || phoneChat) {
    const mergedChat = mergeDefined(phoneChat, {
      ...(lidChat ?? {}),
      id: phoneId,
      kind: "direct" as const,
    });
    const newestTimestamp = Math.max(phoneChat?.lastMessageAtMs ?? 0, lidChat?.lastMessageAtMs ?? 0);
    if (newestTimestamp > 0) mergedChat.lastMessageAtMs = newestTimestamp;
    state.chatsById[phoneId] = mergedChat;
    delete state.chatsById[lid];
  }

  const combined = [
    ...(state.messagesByChatId[phoneId] ?? []),
    ...(state.messagesByChatId[lid] ?? []),
  ].map((message) => canonicalizeWhatsAppMessage(state, message));
  if (combined.length > 0) {
    const byId = new Map<string, WhatsAppMessage>();
    for (const message of combined) byId.set(message.id, message);
    const sorted = [...byId.values()].sort(compareWhatsAppMessages);
    state.messagesByChatId[phoneId] = sorted.slice(Math.max(0, sorted.length - MAX_MESSAGES_PER_CHAT));
  }
  delete state.messagesByChatId[lid];
  return Boolean(lidChat || phoneChat || combined.length > 0 || lidContact || phoneContact);
}

/** Prefer stable phone JIDs while retaining Baileys' original key for protocol operations. */
export function canonicalWhatsAppJid(state: WhatsAppUiState, jid: string): string {
  const normalized = normalizedDirectJid(jid);
  if (!normalized.endsWith("@lid")) return normalized;
  const phoneId = state.contactsById[normalized]?.phoneId;
  return phoneId?.endsWith("@s.whatsapp.net") ? normalizedDirectJid(phoneId) : normalized;
}

function canonicalizeWhatsAppMessage(state: WhatsAppUiState, message: WhatsAppMessage): WhatsAppMessage {
  const chatId = canonicalWhatsAppJid(state, message.chatId);
  const replyChatId = message.replyTo ? canonicalWhatsAppJid(state, message.replyTo.chatId) : undefined;
  if (chatId === message.chatId && (!message.replyTo || replyChatId === message.replyTo.chatId)) return message;
  return {
    ...message,
    chatId,
    ...(message.replyTo && replyChatId
      ? { replyTo: { ...message.replyTo, chatId: replyChatId } }
      : {}),
  };
}

export function upsertWhatsAppMessages(state: WhatsAppUiState, messages: readonly WhatsAppMessage[]): void {
  const touched = new Set<string>();
  for (const incoming of messages) {
    // Protocol control envelopes from caches produced by older Record builds are
    // not user-visible messages (edits now arrive through messages.update).
    if (incoming.content.kind === "unsupported" && incoming.content.sourceType === "protocolMessage") continue;
    const pair = directIdentityPair([
      incoming.chatId,
      incoming.key.chatId,
      incoming.key.alternateChatId,
    ]);
    if (pair) registerWhatsAppLidMapping(state, pair.lid, pair.phoneId);
    const message = canonicalizeWhatsAppMessage(state, incoming);
    if (!message.chatId || message.chatId === "status@broadcast") continue;
    const existing = state.messagesByChatId[message.chatId] ?? [];
    const index = existing.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) {
      const previous = existing[index];
      existing[index] = {
        ...previous,
        ...message,
        key: { ...previous.key, ...message.key },
        timestampMs: message.timestampMs ?? previous.timestampMs,
        senderId: message.senderId ?? previous.senderId,
        senderName: message.senderName ?? previous.senderName,
        replyTo: message.replyTo ?? previous.replyTo,
      };
    } else existing.push(message);
    state.messagesByChatId[message.chatId] = existing;
    touched.add(message.chatId);

    const chat = state.chatsById[message.chatId] ?? {
      id: message.chatId,
      kind: message.chatId.endsWith("@g.us") ? "group" as const : "direct" as const,
    };
    const timestamp = message.timestampMs ?? 0;
    state.chatsById[message.chatId] = {
      ...chat,
      ...(timestamp > (chat.lastMessageAtMs ?? 0) ? { lastMessageAtMs: timestamp } : {}),
    };
  }

  for (const chatId of touched) {
    const sorted = (state.messagesByChatId[chatId] ?? []).slice().sort(compareWhatsAppMessages);
    state.messagesByChatId[chatId] = sorted.slice(Math.max(0, sorted.length - MAX_MESSAGES_PER_CHAT));
  }
}

function compareWhatsAppMessages(left: WhatsAppMessage, right: WhatsAppMessage): number {
  const time = (left.timestampMs ?? 0) - (right.timestampMs ?? 0);
  return time || left.id.localeCompare(right.id);
}

function bareJid(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}

function formattedPhone(jid: string): string {
  const value = bareJid(jid);
  return /^\d{7,15}$/.test(value) ? `+${value}` : value;
}

export function whatsAppDisplayName(state: WhatsAppUiState, jid: string, fallback?: string): string {
  jid = canonicalWhatsAppJid(state, jid);
  const contact = state.contactsById[jid];
  const chat = state.chatsById[jid];
  const recentSenderName = [...(state.messagesByChatId[jid] ?? [])]
    .reverse()
    .find((message) => !message.fromMe && sanitizeTerminalLabel(message.senderName ?? ""))
    ?.senderName;
  return sanitizeTerminalLabel(contact?.name ?? "")
    || sanitizeTerminalLabel(contact?.pushName ?? "")
    || sanitizeTerminalLabel(contact?.verifiedName ?? "")
    || sanitizeTerminalLabel(chat?.name ?? "")
    || sanitizeTerminalLabel(recentSenderName ?? "")
    || sanitizeTerminalLabel(fallback ?? "")
    || formattedPhone(jid)
    || "Unknown";
}

function chatRecipient(state: WhatsAppUiState, chat: WhatsAppChat): DiscordGuildMember[] | undefined {
  if (chat.kind !== "direct") return undefined;
  const contact = state.contactsById[chat.id];
  return [{
    id: chat.id,
    username: sanitizeTerminalLabel(contact?.pushName ?? "") || formattedPhone(chat.id),
    displayName: whatsAppDisplayName(state, chat.id),
    bot: false,
  }];
}

export function whatsAppChannels(state: WhatsAppUiState): DiscordChannel[] {
  return Object.values(state.chatsById)
    .filter((chat) => (chat.kind === "direct" || chat.kind === "group") && !chat.archived)
    .sort((left, right) => {
      if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
      return (right.lastMessageAtMs ?? 0) - (left.lastMessageAtMs ?? 0)
        || whatsAppDisplayName(state, left.id).localeCompare(whatsAppDisplayName(state, right.id));
    })
    .map((chat, position) => ({
      id: whatsappChannelId(chat.id),
      guildId: WHATSAPP_GUILD_ID,
      parentId: null,
      name: whatsAppDisplayName(state, chat.id),
      topic: null,
      position,
      type: chat.kind === "group" ? 3 : 1,
      nsfw: false,
      muted: Boolean(chat.mutedUntilMs && chat.mutedUntilMs > Date.now()),
      recipients: chatRecipient(state, chat),
    }));
}

function mediaAttachment(message: WhatsAppMessage): DiscordMessageAttachment[] {
  if (message.content.kind !== "media" || message.content.mediaKind === "sticker") return [];
  const media = message.content;
  const defaultExtension: Record<typeof media.mediaKind, string> = {
    image: "jpg",
    video: "mp4",
    audio: "ogg",
    document: "bin",
    sticker: "webp",
  };
  return [{
    id: `wa-media:${message.id}`,
    filename: sanitizeTerminalLabel(media.fileName ?? "") || `whatsapp-${media.mediaKind}-${message.id}.${defaultExtension[media.mediaKind]}`,
    contentType: media.mimeType ? sanitizeTerminalLabel(media.mimeType) : null,
    size: media.sizeBytes ?? 0,
    url: "",
    ...(media.durationSeconds !== undefined ? { durationSecs: media.durationSeconds } : {}),
  }];
}

function messageText(message: WhatsAppMessage): string {
  if (message.content.kind === "text") return sanitizeTerminalText(message.content.text, { multiline: true });
  if (message.content.kind === "media") return sanitizeTerminalText(message.content.caption ?? "", { multiline: true });
  return "[Unsupported WhatsApp message]";
}

function replyPreview(state: WhatsAppUiState, message: WhatsAppMessage): DiscordMessageReply | null {
  if (!message.replyTo) return null;
  const target = (state.messagesByChatId[message.replyTo.chatId] ?? [])
    .find((candidate) => candidate.id === message.replyTo?.id);
  return {
    messageId: message.replyTo.id,
    channelId: whatsappChannelId(message.replyTo.chatId),
    authorId: target?.senderId ?? message.replyTo.participantId ?? null,
    authorDisplayName: target
      ? whatsAppDisplayName(state, target.senderId ?? target.chatId, target.senderName)
      : null,
    timestamp: target?.timestampMs ?? null,
    summary: target ? messageText(target).replace(/\s+/g, " ").trim().slice(0, 160) || "(attachment)" : "(quoted message)",
  };
}

export function whatsAppMessageToTimeline(state: WhatsAppUiState, message: WhatsAppMessage): DiscordMessage {
  message = canonicalizeWhatsAppMessage(state, message);
  const senderId = message.senderId ?? (message.fromMe ? state.account?.id : message.chatId) ?? "unknown";
  const displayName = message.fromMe
    ? sanitizeTerminalLabel(state.account?.name ?? "") || "Me"
    : whatsAppDisplayName(state, senderId, message.senderName);
  const stickerNames = message.content.kind === "media" && message.content.mediaKind === "sticker"
    ? ["WhatsApp sticker"]
    : [];
  return {
    id: message.id,
    channelId: whatsappChannelId(message.chatId),
    guildId: WHATSAPP_GUILD_ID,
    type: 0,
    content: messageText(message),
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    mentionUsers: [],
    timestamp: message.timestampMs ?? Date.now(),
    editedTimestamp: message.editedTimestampMs ?? null,
    author: {
      id: senderId,
      username: displayName,
      displayName,
      bot: false,
    },
    reply: replyPreview(state, message),
    call: null,
    attachments: mediaAttachment(message),
    stickerNames,
    embedsCount: 0,
  };
}

export function whatsAppTimelineMessages(state: WhatsAppUiState, channelId: string): DiscordMessage[] {
  const decoded = whatsappJidFromChannelId(channelId);
  const jid = decoded ? canonicalWhatsAppJid(state, decoded) : null;
  if (!jid) return [];
  return (state.messagesByChatId[jid] ?? []).map((message) => whatsAppMessageToTimeline(state, message));
}
