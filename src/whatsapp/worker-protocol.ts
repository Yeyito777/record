import type {
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppLoginResult,
  WhatsAppMediaRecoveryAnchor,
  WhatsAppMessage,
  WhatsAppMessageKey,
} from "./types";

export type WhatsAppWorkerMethod =
  | "start-login"
  | "cancel-login"
  | "send-text"
  | "send-images"
  | "download-media"
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

export interface WhatsAppDownloadMediaParams {
  message: WhatsAppMessage;
  destinationPath: string;
  recoveryAnchor?: WhatsAppMediaRecoveryAnchor;
}

export interface WhatsAppDownloadMediaResult {
  path: string;
  sizeBytes: number;
}

export interface WhatsAppMarkReadParams {
  keys: WhatsAppMessageKey[];
}

export interface WhatsAppFetchHistoryParams {
  count: number;
  oldestKey: WhatsAppMessageKey;
  oldestTimestampMs: number;
}

export interface WhatsAppSetChatMutedParams {
  chatId: string;
  muted: boolean;
}

export interface WhatsAppSetChatMutedResult {
  mutedUntilMs: number | null;
}

export type WhatsAppStartLoginResult = WhatsAppLoginResult;
