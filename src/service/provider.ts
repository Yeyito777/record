/**
 * What a service provider plugs into the bridge. The bridge (server.ts)
 * owns the socket, the settings and the writes guard, the chat list and its
 * cache, notifications and the badge, and the media cache; a provider owns
 * the service: its session, its connection or polling, and turning what the
 * service says into the protocol's objects (protocol.ts).
 *
 * A provider module exports `createProvider(host: ProviderHost): Provider`.
 * record's own are in providers/; `--provider-module PATH` loads one kept
 * elsewhere (a private one).
 */

import type { ChatStore } from "./chatstore";
import type { Logger } from "./log";
import type { FetchedMedia, MediaCache } from "./media";
import type { MoonLink, MoonView } from "./moon";
import type { Notifier } from "./notifier";
import type { BridgeEvent, ServiceName, Settings, StatusState, WireChat, WireMessage, WireUser } from "./protocol";

export interface ProviderHost {
  readonly service: ServiceName;
  /** `/var/lib/moon-social/SERVICE`: the session, the chat cache (root, 0700). */
  readonly stateDir: string;
  /** `/var/cache/moon-social/SERVICE`. */
  readonly cacheDir: string;
  /** Made-up data, no account, no network (`--fixtures`). */
  readonly fixtures: boolean;
  readonly log: Logger;
  readonly chats: ChatStore;
  readonly media: MediaCache;
  readonly notifier: Notifier;
  settings(): Settings;
  /**
   * Throws `read_only` unless writes are on. Call it before anything that
   * someone else could see or that changes the account (sending, reacting,
   * read receipts and acks, typing, presence, joining, calling).
   */
  guardWrite(what: string): void;
  /** The connection's state, as the apps should see it. */
  setStatus(state: StatusState, detail?: string | null, account?: WireUser | null): void;
  /** Sends an event to every subscribed app. */
  emit(event: BridgeEvent): void;
  /**
   * A message is new or changed. `live`: it just arrived (it may notify);
   * otherwise history being filled in.
   */
  message(message: WireMessage, live: boolean): void;
  /** Moon's view right now (for polling cadence: the screen is off, the app is in front). */
  moonView(): Promise<MoonView | null>;
  readonly moon: MoonLink;
  /** What the apps show now: chats in view, and whether one is in front. */
  viewing(): { chats: Set<string>; front: boolean };
}

export interface HistoryPage {
  messages: WireMessage[];
  more: boolean;
}

export interface CommandContext {
  /** The connection asking (one per app). */
  client: number;
}

export interface Provider {
  /** Names of what it supports beyond the core (docs/social-protocol.md §3.1). */
  readonly capabilities: string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  history(chat: string, options: { before?: string | null; limit: number }): Promise<HistoryPage>;
  fetchMedia(ref: string, max: number | null): Promise<FetchedMedia>;
  /** What the apps show changed (after the bridge's own handling). */
  viewChanged?(view: { chats: Set<string>; front: boolean }): void;
  /** Writes: the bridge checks the guard before calling these. */
  send?(args: { chat: string; text: string; reply_to?: string | null; client_id?: string | null; media?: string[] }): Promise<WireMessage>;
  react?(args: { chat: string; message: string; emoji: string; remove: boolean }): Promise<void>;
  edit?(args: { chat: string; message: string; text: string }): Promise<WireMessage>;
  delete?(args: { chat: string; message: string }): Promise<void>;
  markRead?(args: { chat: string; message?: string | null }): Promise<void>;
  typing?(args: { chat: string }): Promise<void>;
  /** Signing in (docs/social-protocol.md §3.6). */
  loginStart?(args: Record<string, unknown>): Promise<void>;
  loginCancel?(): Promise<void>;
  logout?(): Promise<void>;
  /** The badge's count (default: unread chats not muted); null while unknown. */
  badge?(chats: WireChat[]): number | null;
  /**
   * Extension commands, by full name (`discord.guilds`). `write: true`
   * ones are refused while writes are off.
   */
  readonly commands?: Record<string, { write?: boolean; run: (args: Record<string, any>, cx: CommandContext) => Promise<unknown> }>;
}

export type ProviderFactory = (host: ProviderHost) => Provider | Promise<Provider>;
