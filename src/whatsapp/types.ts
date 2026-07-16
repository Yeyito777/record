/** Provider-neutral data exposed by Record's in-process WhatsApp backend. */

export interface WhatsAppMessageKey {
  id: string;
  chatId: string;
  fromMe?: boolean;
  participantId?: string;
  alternateChatId?: string;
  alternateParticipantId?: string;
}

export type WhatsAppMediaKind = "image" | "video" | "audio" | "document" | "sticker";

export interface WhatsAppTextContent {
  kind: "text";
  text: string;
}

export interface WhatsAppMediaContent {
  kind: "media";
  mediaKind: WhatsAppMediaKind;
  caption?: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  voiceNote?: boolean;
  animated?: boolean;
  viewOnce?: boolean;
}

/** A message Record does not render yet, retained so event consumers do not lose it. */
export interface WhatsAppUnsupportedContent {
  kind: "unsupported";
  sourceType?: string;
}

export type WhatsAppMessageContent =
  | WhatsAppTextContent
  | WhatsAppMediaContent
  | WhatsAppUnsupportedContent;

export interface WhatsAppMessage {
  key: WhatsAppMessageKey;
  id: string;
  chatId: string;
  /** Absent only when converting an outgoing DM without the current account ID. */
  senderId?: string;
  senderName?: string;
  fromMe: boolean;
  timestampMs: number | null;
  editedTimestampMs?: number;
  content: WhatsAppMessageContent;
  replyTo?: WhatsAppMessageKey;
}

export type WhatsAppChatKind = "direct" | "group" | "broadcast" | "newsletter" | "unknown";

/**
 * Chats are patches: Baileys deliberately omits unchanged fields from update
 * events. Only id and kind are guaranteed by this converter.
 */
export interface WhatsAppChat {
  id: string;
  kind: WhatsAppChatKind;
  name?: string;
  lastMessageAtMs?: number;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean;
  mutedUntilMs?: number | null;
  readOnly?: boolean;
  ephemeralExpirationSeconds?: number;
}

/** Contacts are also patches; optional fields were not necessarily cleared. */
export interface WhatsAppContact {
  id: string;
  lid?: string;
  phoneId?: string;
  name?: string;
  pushName?: string;
  verifiedName?: string;
  avatarUrl?: string | null;
  status?: string;
}

export interface WhatsAppAccount {
  id: string;
  lid?: string;
  phoneId?: string;
  name?: string;
}

export interface WhatsAppDisconnect {
  code: number | null;
  name: string | null;
}

export type WhatsAppConnectionState =
  | { status: "idle" }
  | { status: "loading-auth" }
  | {
      status: "connecting";
      source: "login" | "saved-session" | "reconnect";
      attempt: number;
    }
  | { status: "awaiting-qr"; attempt: number }
  | {
      status: "connected";
      resumed: boolean;
      connectedAtMs: number;
      account?: WhatsAppAccount;
    }
  | {
      status: "reconnecting";
      attempt: number;
      delayMs: number;
      disconnect: WhatsAppDisconnect;
    }
  | { status: "logged-out"; disconnect: WhatsAppDisconnect }
  | { status: "connection-replaced"; disconnect: WhatsAppDisconnect }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown; disconnect?: WhatsAppDisconnect }
  | { status: "stopped" };

export type WhatsAppLoginResult =
  | { status: "connected"; resumed: boolean; account?: WhatsAppAccount }
  | { status: "cancelled" }
  | { status: "logged-out"; disconnect: WhatsAppDisconnect }
  | { status: "connection-replaced"; disconnect: WhatsAppDisconnect }
  | { status: "failed"; error: unknown; disconnect?: WhatsAppDisconnect }
  | { status: "stopped" };

export interface WhatsAppQrEvent {
  /** Sensitive, short-lived QR payload. The backend never logs or stores it in state. */
  qr: string;
  issuedAtMs: number;
}

export type WhatsAppHistorySyncKind =
  | "initial-bootstrap"
  | "initial-status"
  | "full"
  | "recent"
  | "push-name"
  | "non-blocking-data"
  | "on-demand"
  | "no-history"
  | "message-access-status"
  | "unknown";

export interface WhatsAppHistoryEvent {
  chats: WhatsAppChat[];
  contacts: WhatsAppContact[];
  messages: WhatsAppMessage[];
  skippedMessages: number;
  isLatest?: boolean;
  progress?: number | null;
  syncKind: WhatsAppHistorySyncKind;
}

export type WhatsAppMessagesEvent = {
  kind: "upsert";
  upsertType: "append" | "notify";
  messages: WhatsAppMessage[];
  skippedMessages: number;
  requestId?: string;
} | {
  kind: "update";
  messages: WhatsAppMessage[];
  skippedMessages: number;
};

export interface WhatsAppChatsEvent {
  kind: "upsert" | "update";
  chats: WhatsAppChat[];
}

export interface WhatsAppContactsEvent {
  kind: "upsert" | "update";
  contacts: WhatsAppContact[];
}

export interface WhatsAppLidMappingEvent {
  lid: string;
  phoneId: string;
}

export interface WhatsAppBackendErrorEvent {
  phase: "auth" | "socket" | "event" | "callback";
  error: unknown;
  recoverable: boolean;
}

export interface WhatsAppBackendEventMap {
  state: WhatsAppConnectionState;
  qr: WhatsAppQrEvent;
  history: WhatsAppHistoryEvent;
  messages: WhatsAppMessagesEvent;
  chats: WhatsAppChatsEvent;
  contacts: WhatsAppContactsEvent;
  "lid-mapping": WhatsAppLidMappingEvent;
  error: WhatsAppBackendErrorEvent;
}

export type WhatsAppBackendEventName = keyof WhatsAppBackendEventMap;

export type WhatsAppBackendEventListener<K extends WhatsAppBackendEventName> = (
  event: WhatsAppBackendEventMap[K],
) => void | Promise<void>;

export interface WhatsAppBackendCallbacks {
  onStateChange?: WhatsAppBackendEventListener<"state">;
  onQr?: WhatsAppBackendEventListener<"qr">;
  onHistory?: WhatsAppBackendEventListener<"history">;
  onMessages?: WhatsAppBackendEventListener<"messages">;
  onChats?: WhatsAppBackendEventListener<"chats">;
  onContacts?: WhatsAppBackendEventListener<"contacts">;
  onLidMapping?: WhatsAppBackendEventListener<"lid-mapping">;
  onError?: WhatsAppBackendEventListener<"error">;
}
