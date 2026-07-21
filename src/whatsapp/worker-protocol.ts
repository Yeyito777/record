import type {
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppLoginResult,
  WhatsAppMessage,
  WhatsAppMessageKey,
} from "./types";

export type WhatsAppWorkerMethod =
  | "start-login"
  | "cancel-login"
  | "send-text"
  | "send-images"
  | "fetch-history"
  | "set-chat-muted"
  | "mark-read"
  | "logout"
  | "shutdown";

export interface WhatsAppWorkerRequest {
  type: "request";
  id: number;
  method: WhatsAppWorkerMethod;
  params?: Record<string, unknown>;
}

export interface WhatsAppWorkerResponse {
  type: "response";
  id: number;
  result?: unknown;
  error?: string;
}

export interface WhatsAppWorkerEvent<K extends WhatsAppBackendEventName = WhatsAppBackendEventName> {
  type: "event";
  event: K;
  data: WhatsAppBackendEventMap[K];
}

export type WhatsAppWorkerMessage = WhatsAppWorkerResponse | WhatsAppWorkerEvent;

export interface WhatsAppSendTextParams {
  chatId: string;
  text: string;
  quoted?: WhatsAppMessage;
  /** Known per-chat disappearing-message duration. Zero explicitly means off. */
  ephemeralExpirationSeconds?: number;
}

export interface WhatsAppImageUpload {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  base64: string;
  sizeBytes: number;
  filename?: string;
}

export interface WhatsAppSendImagesParams {
  chatId: string;
  caption: string;
  images: WhatsAppImageUpload[];
  quoted?: WhatsAppMessage;
  /** Known per-chat disappearing-message duration. Zero explicitly means off. */
  ephemeralExpirationSeconds?: number;
}

export interface WhatsAppMarkReadParams {
  keys: WhatsAppMessageKey[];
}

export interface WhatsAppFetchHistoryParams {
  count: number;
  oldestKey: WhatsAppMessageKey;
  oldestTimestampMs: number;
}

export const WHATSAPP_CHAT_MUTE_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface WhatsAppSetChatMutedParams {
  chatId: string;
  muted: boolean;
}

export interface WhatsAppSetChatMutedResult {
  mutedUntilMs: number | null;
}

export type WhatsAppStartLoginResult = WhatsAppLoginResult;
