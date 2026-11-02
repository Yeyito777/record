/**
 * The bridge protocol's objects (a26-system docs/social-protocol.md, version
 * 1): what record's headless service sends Moon's social apps. Plain JSON,
 * times in Unix milliseconds, ids opaque strings.
 */

export const PROTOCOL_VERSION = 1;

export type ServiceName = "discord" | "instagram" | "whatsapp";
export const SERVICE_NAMES: readonly ServiceName[] = ["discord", "instagram", "whatsapp"];

export type StatusState = "signed_out" | "connecting" | "online" | "offline" | "error";

export interface WireUser {
  id: string;
  name: string;
  username?: string | null;
  avatar?: WireMedia | null;
}

export type MediaKind = "image" | "video" | "gif" | "sticker" | "audio" | "file";

export interface WireMedia {
  /** Opaque: handed back to `media.fetch`. */
  ref: string;
  kind: MediaKind;
  w?: number | null;
  h?: number | null;
  mime?: string | null;
  name?: string | null;
  size?: number | null;
  duration_ms?: number | null;
  /** A smaller picture of it (a video's poster). */
  thumb?: string | null;
  /** A tiny inline JPEG, base64, shown at once. */
  blur?: string | null;
}

export interface WireStatus {
  service: ServiceName;
  state: StatusState;
  detail: string | null;
  writes: boolean;
  account: WireUser | null;
}

export type ChatKind = "dm" | "group" | "channel" | "thread" | "forum" | "voice";

export interface WireChatLast {
  id: string;
  ts: number;
  author: string | null;
  text: string;
  mine: boolean;
}

export interface WireChat {
  id: string;
  kind: ChatKind;
  title: string;
  avatar?: WireMedia | null;
  last?: WireChatLast | null;
  /** Last activity: the list is newest first, pinned first. */
  ts: number;
  unread: number;
  mentions?: number;
  muted?: boolean;
  pinned?: boolean;
  archived?: boolean;
  /** The folder it is in on the service: `inbox` (default), `requests`, `archived`. */
  folder?: string;
  parent?: string | null;
  members?: number | null;
  ext?: Record<string, unknown>;
}

export interface WireReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export interface WireMessage {
  id: string;
  chat: string;
  ts: number;
  author: { id: string; name: string; avatar?: WireMedia | null };
  mine: boolean;
  text: string;
  format: "plain" | "discord" | "whatsapp" | "instagram";
  media: WireMedia[];
  reply_to?: { id: string; author: string | null; text: string } | null;
  reactions: WireReaction[];
  edited_ts?: number | null;
  deleted?: boolean;
  system?: boolean;
  forwarded?: boolean;
  status?: MessageStatus | null;
  client_id?: string | null;
  ext?: Record<string, unknown>;
}

export interface Settings {
  writes: boolean;
  notifications: boolean;
  previews: boolean;
}

export const DEFAULT_SETTINGS: Settings = { writes: false, notifications: true, previews: true };

export type ErrorCode =
  | "invalid_request" | "unknown_command" | "invalid_argument" | "not_found" | "signed_out"
  | "unavailable" | "rate_limited" | "challenge" | "read_only" | "uncertain" | "internal";

/** An answer's error; `message` is for logs, never secret. */
export class BridgeError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export type BridgeEvent =
  | { event: "status"; status: WireStatus }
  | { event: "chat"; chat: WireChat }
  | { event: "chat_removed"; id: string }
  | { event: "message"; message: WireMessage; live: boolean }
  | { event: "message_removed"; chat: string; id: string }
  | { event: "typing"; chat: string; user: WireUser; until: number }
  | { event: "read"; chat: string; user: WireUser | null; message: string }
  | { event: "login"; state: "qr" | "code" | "waiting" | "done" | "failed"; [key: string]: unknown }
  | { event: `${ServiceName}.${string}`; [key: string]: unknown };
