/**
 * What the WhatsApp provider runs on: record's backend (its events and
 * operations, `src/whatsapp/`) behind one long-lived object, plus what the
 * bridge reads off the same socket beside record's converters (`RawEvent`).
 * `live.ts` is the real one (Baileys in this process), `fixtures.ts` a
 * made-up account.
 */

import type {
  WhatsAppBackendEventListener,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppLoginResult,
  WhatsAppMediaRecoveryAnchor,
  WhatsAppMessage,
  WhatsAppMessageKey,
} from "../../../whatsapp/types";
import type { Extras, MessageStatus, StoredMessage } from "./store";

export type RawEvent =
  /** Extras for the message with this id, which record's events bring next. */
  | { kind: "extras"; id: string; extras: Extras }
  /** A notice row (a group change, a missed call): no record message carries it. */
  | { kind: "system"; message: StoredMessage; live: boolean }
  /** Deleted for everyone. */
  | { kind: "revoke"; chatId: string; id: string }
  /** A receipt for one of the account's messages. */
  | { kind: "status"; chatId: string; id: string; status: MessageStatus }
  /** A group's name or size, from WhatsApp's group events or metadata. */
  | { kind: "group"; chatId: string; subject?: string; size?: number };

export interface GroupInfo {
  subject: string | null;
  size: number | null;
}

export interface WaBackend {
  readonly state: WhatsAppConnectionState;
  on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>): () => void;
  onRaw(listener: (event: RawEvent) => void): () => void;
  /** Whether a linked session is saved (start resumes it, no QR). */
  hasSession(): Promise<boolean>;
  /** Resumes the saved session, or starts a QR login (`qr` events). */
  startLogin(): Promise<WhatsAppLoginResult>;
  cancelLogin(): boolean;
  /** Unlinks this device (the user's own action) and forgets the session. */
  logout(): Promise<void>;
  /** Closes the connection; the session stays (start again later). */
  shutdown(): Promise<void>;
  /** On-demand history before `key` (the request id the history event carries). */
  fetchHistory(count: number, key: WhatsAppMessageKey, timestampMs: number): Promise<string>;
  downloadMedia(message: WhatsAppMessage, path: string, anchor?: WhatsAppMediaRecoveryAnchor): Promise<unknown>;
  /** Writes jid's profile picture (preview size) to `path`; false when it has none. */
  profilePicture(jid: string, path: string): Promise<boolean>;
  groupInfo(jid: string): Promise<GroupInfo | null>;
  /** Writes (writes on only; the bridge guards them). */
  newMessageId(): string;
  sendText(chatId: string, text: string, quoted: WhatsAppMessage | undefined, messageId: string): Promise<WhatsAppMessage>;
  sendReaction(key: WhatsAppMessageKey, emoji: string): Promise<void>;
  markRead(keys: WhatsAppMessageKey[]): Promise<void>;
}
