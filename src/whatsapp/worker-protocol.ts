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

export type WhatsAppStartLoginResult = WhatsAppLoginResult;
