/**
 * The Discord provider (a26-system docs/social-protocol.md §5 Discord): the
 * user's DMs and servers with their channels and threads, history, media,
 * live messages, unread and mention state, notifications for DMs and
 * mentions (and channels the user set to all messages) and the badge, on
 * record's own Discord code: its REST client (src/discord.ts: every request
 * with its headers and super properties) and its gateway's wire protocol
 * (discord/gateway.ts), so the bridge looks to Discord like record does.
 *
 * Reading is all it does on its own. The bridge's writes guard stands in
 * front of sending, reacting, editing, deleting and read receipts; nothing
 * here types, joins or calls. Presence: while writes are off the session is
 * invisible and away (`afk`), so the bridge never shows the user online;
 * with writes on it carries the status the user set and follows their
 * changes (an op 3 when their settings change), as the official clients do.
 *
 * `--fixtures`: record's made-up Discord (discord/fixtures.ts), in-process.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  ackChannelMessage, applyDiscordMessagePatch, deleteChannelMessage, DiscordRateLimitError, DiscordResourceNotFoundError,
  editChannelMessage, fetchChannelMessages, fetchChannelThreads, fetchCurrentUserStatusSettings, generateMessageNonce,
  mapDiscordMessage, mapDiscordMessagePatch, mapDiscordMessageReactionPatch, sendChannelMessage, setChannelMessageReaction,
  validateToken, type DiscordMessage, type DiscordMessageResponse,
} from "../../discord";
import { readJson, writePrivateAtomic } from "../files";
import { errorText } from "../log";
import { downloadUrl, type FetchedMedia } from "../media";
import { BridgeError, type WireChat, type WireMessage, type WireUser } from "../protocol";
import type { HistoryPage, Provider, ProviderHost } from "../provider";
import { Account, DM_TYPES, THREAD_TYPES, type Channel, userAvatar, userInfo } from "./discord/account";
import { DiscordGateway, type Presence, type PresenceStatus } from "./discord/gateway";
import { mediaRequest } from "./discord/refs";
import { decodeUserProto } from "./discord/userproto";
import { lastLine, plainText, wireMessage } from "./discord/wire";

/** Channels whose newest messages are kept (what the app opened lately). */
const CACHED_CHANNELS = 40;
const CACHED_MESSAGES = 150;
const GUILD_EVENT_DELAY_MS = 250;
const MEDIA_MAX_BYTES = 48 * 1024 * 1024;
const TYPING_MS = 10_000;

interface Cached {
  /** Oldest first. */
  messages: DiscordMessage[];
  /** Kept current by the gateway since it was fetched (no gap). */
  live: boolean;
  /** The oldest of `messages` is the channel's first. */
  complete: boolean;
}

interface Session {
  token: string;
}

function bridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof DiscordRateLimitError) {
    return new BridgeError("rate_limited", "Discord is rate limiting", error.retryAfterMs !== null ? { retry_after_ms: error.retryAfterMs } : {});
  }
  if (error instanceof DiscordResourceNotFoundError) return new BridgeError("not_found", "Discord has no such thing");
  const message = errorText(error);
  if (/rejected the token/i.test(message)) return new BridgeError("signed_out", "Discord refused the session");
  if (/denied access/i.test(message)) return new BridgeError("not_found", "no access to that channel");
  return new BridgeError("unavailable", message.slice(0, 160));
}

export function createProvider(host: ProviderHost): Provider {
  return new DiscordProvider(host);
}

class DiscordProvider implements Provider {
  readonly capabilities = ["discord", "edit", "delete", "react", "reply"];
  readonly commands: Provider["commands"];
  private readonly account = new Account();
  private token: string | null = null;
  private gateway: DiscordGateway | null = null;
  /** The status the user set (their settings); the session carries it only with writes on. */
  private userStatus: PresenceStatus = "invisible";
  private readonly cache = new Map<string, Cached>();
  private readonly guildDirty = new Set<string>();
  /** The server entries the apps were last sent (only changes go out). */
  private readonly sentGuilds = new Map<string, string>();
  private guildTimer: ReturnType<typeof setTimeout> | null = null;
  private everReady = false;
  private stopped = false;
  /** Discord nonce → the app's client_id, for a sent message's echo. */
  private readonly clientIds = new Map<string, string>();
  private fixtures: import("./discord/fixtures").Fixtures | null = null;
  /** DISCORD_BRIDGE_STATS: events by type, logged each minute (counts only). */
  private readonly stats = process.env.DISCORD_BRIDGE_STATS ? new Map<string, number>() : null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  /** The last member list Discord sent per channel subscribed (op 37). */
  private readonly memberLists = new Map<string, unknown>();

  constructor(private readonly host: ProviderHost) {
    // record's REST client logs to record's own debug log unless told not to;
    // the bridge logs to stderr only.
    process.env.RECORD_DEBUG ??= "0";
    this.commands = {
      "discord.guilds": { run: async () => ({ guilds: this.account.wireGuilds() }) },
      "discord.threads": { run: async (args) => this.threads(args) },
      "discord.member_list": { run: async (args) => this.memberList(args) },
      "discord.fixtures.emit": {
        run: async (args) => {
          if (!this.fixtures) throw new BridgeError("unknown_command", "fixtures only");
          const chat = typeof args.chat === "string" ? args.chat : "";
          const id = this.fixtures.emit(chat, typeof args.text === "string" ? args.text : "hello", { mention: args.mention === true });
          if (!id) throw new BridgeError("not_found", "no such chat");
          return { id };
        },
      },
    };
  }

  private get sessionPath(): string {
    return join(this.host.stateDir, "session.json");
  }

  async start(): Promise<void> {
    if (this.host.fixtures) {
      const { installFixtures } = await import("./discord/fixtures");
      this.fixtures = installFixtures();
      this.token = this.fixtures.token;
    } else {
      const saved = readJson<Session>(this.sessionPath);
      this.token = typeof saved?.token === "string" && saved.token.trim() ? saved.token.trim() : null;
    }
    if (!this.token) {
      this.host.setStatus("signed_out", null, null);
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    const token = this.token;
    if (!token || this.stopped) return;
    this.host.setStatus("connecting", null);
    let identity;
    try {
      [identity] = await Promise.all([
        validateToken(token),
        fetchCurrentUserStatusSettings(token).then((settings) => {
          this.userStatus = settings.presenceStatus ?? "invisible";
        }).catch(() => {}),
      ]);
    } catch (error) {
      const failure = bridgeError(error);
      if (failure.code === "signed_out") {
        this.host.log.warn("session.refused");
        this.host.setStatus("error", "Discord refused this session. Sign in again.", null);
        return;
      }
      this.host.log.warn("connect.failed", { error: failure.code });
      this.host.setStatus("offline", "Discord can't be reached. Retrying.");
      setTimeout(() => void this.connect(), 30_000).unref?.();
      return;
    }
    if (this.stopped) return;
    this.account.self = {
      id: identity.id, username: identity.username, name: identity.globalName ?? identity.username,
      avatar: identity.avatar, bot: identity.bot,
    };
    this.host.setStatus("connecting", null, this.wireSelf());
    this.gateway = new DiscordGateway(token, {
      ready: (data) => this.ready(data),
      dispatch: (type, data) => this.dispatch(type, data),
      lost: (fatal, code) => this.lost(fatal, code),
      token: (refreshed) => this.saveToken(refreshed),
      tick: () => this.followPresence(),
    }, { presence: () => this.presence() });
    this.gateway.start();
  }

  /** What the session should show of the user (see the header). */
  private presence(): Presence {
    return this.host.settings().writes ? { status: this.userStatus, afk: false } : { status: "invisible", afk: true };
  }

  /** The user's status or the writes switch changed: the session follows (checked every heartbeat). */
  private followPresence(): void {
    this.gateway?.setPresence(this.presence());
  }

  private wireSelf(): WireUser | null {
    const self = this.account.self;
    return self ? { id: self.id, name: self.name, username: self.username, avatar: userAvatar(self) } : null;
  }

  private saveToken(token: string): void {
    this.token = token;
    if (!this.host.fixtures) writePrivateAtomic(this.sessionPath, `${JSON.stringify({ token })}\n`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.gateway?.stop();
    if (this.guildTimer) clearTimeout(this.guildTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.fixtures) {
      const { uninstallFixtures } = await import("./discord/fixtures");
      uninstallFixtures();
      this.fixtures = null;
    }
  }

  // ---------------------------------------------------------------------
  // The gateway

  private ready(data: any | null): void {
    if (data === null) {
      // RESUMED: Discord replayed what was missed.
      this.host.setStatus("online", null, this.wireSelf());
      return;
    }
    const proto = decodeUserProto(typeof data.user_settings_proto === "string" ? data.user_settings_proto : null);
    if (proto.status) this.userStatus = proto.status;
    this.account.loadReady(data, proto.folders);
    // A fresh session: what was missed while away was not replayed.
    for (const cached of this.cache.values()) cached.live = false;
    const chats = this.account.chats().map((chat) => this.withPrevious(chat));
    this.host.chats.replaceAll(chats);
    const guilds = this.account.wireGuilds();
    this.sentGuilds.clear();
    for (const guild of guilds) this.sentGuilds.set(guild.id, JSON.stringify(guild));
    this.host.emit({ event: "discord.guilds", guilds });
    this.host.log.info("ready", {
      guilds: this.account.guilds.size,
      chats: chats.length,
      folders: proto.folders.length,
      settings: typeof data.user_settings_proto === "string",
      fresh: !this.everReady,
    });
    this.everReady = true;
    this.host.setStatus("online", null, this.wireSelf());
    // READY is the largest thing the bridge ever parses; give its memory back.
    setTimeout(() => Bun.gc(true), 0).unref?.();
    this.resubscribe();
  }

  private lost(fatal: boolean, code: number | null): void {
    for (const cached of this.cache.values()) cached.live = false;
    if (fatal) {
      this.host.log.warn("gateway.refused", { code });
      this.host.setStatus("error", code === 4004 ? "Discord refused this session. Sign in again." : "Discord closed the connection.", this.wireSelf());
      return;
    }
    this.host.setStatus("connecting", "Reconnecting", this.wireSelf());
  }

  /** The chat as the account says, keeping what only the bridge remembers (a DM's last line). */
  private withPrevious(chat: WireChat): WireChat {
    const previous = this.host.chats.raw(chat.id);
    if (!previous) return chat;
    if (chat.kind === "dm" || chat.kind === "group") return { ...chat, last: previous.last ?? null };
    const channel = this.account.channels.get(chat.id);
    return channel ? this.account.chat(channel, previous) : chat;
  }

  /** Hands the store a chat only when it changed (each upsert schedules a cache write). */
  private upsertChat(chat: WireChat): void {
    const previous = this.host.chats.raw(chat.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(chat)) return;
    if (this.stats) this.stats.set("~upsert", (this.stats.get("~upsert") ?? 0) + 1);
    this.host.chats.upsert(chat);
  }

  private syncChannel(channel: Channel): void {
    if (this.account.isChat(channel)) this.upsertChat(this.withPrevious(this.account.chat(channel)));
    else if (this.host.chats.raw(channel.id)) this.host.chats.remove(channel.id);
    if (channel.guildId) this.guildChanged(channel.guildId);
  }

  private syncGuild(guildId: string): void {
    const guild = this.account.guilds.get(guildId);
    if (!guild) return;
    for (const id of guild.channelIds) {
      const channel = this.account.channels.get(id);
      if (channel) this.syncChannel(channel);
    }
    this.guildChanged(guildId);
  }

  private guildChanged(guildId: string): void {
    this.guildDirty.add(guildId);
    if (this.guildTimer) return;
    this.guildTimer = setTimeout(() => {
      this.guildTimer = null;
      const order = this.account.guildOrder();
      for (const id of this.guildDirty) {
        const position = order.findIndex((entry) => entry.id === id);
        const guild = this.account.guilds.get(id);
        if (guild && position >= 0) {
          const wire = this.account.wireGuild(guild, position, order[position]!.folder);
          const key = JSON.stringify(wire);
          if (this.sentGuilds.get(id) === key) continue;
          this.sentGuilds.set(id, key);
          if (this.stats) this.stats.set("~guild", (this.stats.get("~guild") ?? 0) + 1);
          this.host.emit({ event: "discord.guild", guild: wire });
        } else {
          this.sentGuilds.delete(id);
          this.host.emit({ event: "discord.guild_removed", id });
        }
      }
      this.guildDirty.clear();
    }, GUILD_EVENT_DELAY_MS);
  }

  private viewed(chatId: string): boolean {
    return this.host.viewing().chats.has(chatId);
  }

  private dispatch(type: string, data: any): void {
    if (this.stats) {
      this.stats.set(type, (this.stats.get(type) ?? 0) + 1);
      this.statsTimer ??= setInterval(() => {
        const top = [...this.stats!.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        const memory = process.memoryUsage();
        this.host.log.info("gateway.events", {
          ...Object.fromEntries(top),
          rss_mb: Math.round(memory.rss / 1048576),
          heap_mb: Math.round(memory.heapUsed / 1048576),
          cpu_ms: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
        });
        this.stats!.clear();
      }, 60_000);
    }
    switch (type) {
      case "MESSAGE_CREATE":
        this.messageCreate(data);
        return;
      case "MESSAGE_UPDATE":
        this.messageUpdate(data);
        return;
      case "MESSAGE_DELETE":
        if (typeof data?.channel_id === "string" && typeof data.id === "string") this.messageDelete(data.channel_id, [data.id]);
        return;
      case "MESSAGE_DELETE_BULK":
        if (typeof data?.channel_id === "string" && Array.isArray(data.ids)) this.messageDelete(data.channel_id, data.ids.filter((id: unknown) => typeof id === "string"));
        return;
      case "MESSAGE_REACTION_ADD":
      case "MESSAGE_REACTION_REMOVE":
      case "MESSAGE_REACTION_REMOVE_ALL":
      case "MESSAGE_REACTION_REMOVE_EMOJI": {
        const kind = type === "MESSAGE_REACTION_ADD" ? "add" : type === "MESSAGE_REACTION_REMOVE" ? "remove" : type === "MESSAGE_REACTION_REMOVE_ALL" ? "clear" : "clearEmoji";
        const patch = mapDiscordMessageReactionPatch(data, kind, this.account.self?.id ?? null);
        if (patch) this.patchCached(patch.channelId, patch.id, (message) => applyDiscordMessagePatch(message, patch));
        return;
      }
      case "MESSAGE_REACTION_ADD_MANY":
        if (!Array.isArray(data?.reactions)) return;
        for (const reaction of data.reactions) {
          for (const userId of Array.isArray(reaction?.users) ? reaction.users : []) {
            const patch = mapDiscordMessageReactionPatch({ ...data, user_id: userId, emoji: reaction.emoji }, "add", this.account.self?.id ?? null);
            if (patch) this.patchCached(patch.channelId, patch.id, (message) => applyDiscordMessagePatch(message, patch));
          }
        }
        return;
      case "MESSAGE_ACK": {
        const channel = typeof data?.channel_id === "string" ? this.account.channels.get(data.channel_id) : null;
        if (!channel) return;
        this.account.ack(channel.id, typeof data.message_id === "string" ? data.message_id : null, typeof data.mention_count === "number" ? data.mention_count : 0);
        this.syncChannel(channel);
        return;
      }
      case "CHANNEL_UNREAD_UPDATE":
        for (const update of Array.isArray(data?.channel_unread_updates) ? data.channel_unread_updates : []) this.bump(update);
        return;
      case "PASSIVE_UPDATE_V2":
      case "PASSIVE_UPDATE_V1":
        for (const update of Array.isArray(data?.updated_channels) ? data.updated_channels : Array.isArray(data?.channels) ? data.channels : []) this.bump(update);
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE": {
        const channel = this.account.putChannel(data, typeof data?.guild_id === "string" ? data.guild_id : null);
        if (!channel) return;
        if (channel.type === 4 && channel.guildId) this.syncGuild(channel.guildId);
        else this.syncChannel(channel);
        return;
      }
      case "CHANNEL_DELETE":
      case "THREAD_DELETE": {
        const channel = typeof data?.id === "string" ? this.account.removeChannel(data.id) : null;
        if (!channel) return;
        this.cache.delete(channel.id);
        if (this.host.chats.raw(channel.id)) this.host.chats.remove(channel.id);
        if (channel.guildId) this.guildChanged(channel.guildId);
        return;
      }
      case "THREAD_LIST_SYNC": {
        const guildId = typeof data?.guild_id === "string" ? data.guild_id : null;
        if (!guildId) return;
        const joined = new Set((Array.isArray(data.members) ? data.members : []).filter((member: any) => member?.user_id === this.account.self?.id || member?.user_id === undefined).map((member: any) => member?.id));
        for (const raw of Array.isArray(data.threads) ? data.threads : []) {
          const channel = this.account.putChannel(joined.has(raw?.id) && !raw.member ? { ...raw, member: { muted: false } } : raw, guildId);
          if (channel) this.syncChannel(channel);
        }
        return;
      }
      case "THREAD_MEMBER_UPDATE": {
        const channel = typeof data?.id === "string" ? this.account.channels.get(data.id) : null;
        if (!channel) return;
        channel.joined = true;
        channel.threadMuted = data.muted === true;
        this.syncChannel(channel);
        return;
      }
      case "THREAD_MEMBERS_UPDATE": {
        const channel = typeof data?.id === "string" ? this.account.channels.get(data.id) : null;
        const selfId = this.account.self?.id;
        if (!channel || !selfId) return;
        if (Array.isArray(data.removed_member_ids) && data.removed_member_ids.includes(selfId)) channel.joined = false;
        else if (Array.isArray(data.added_members) && data.added_members.some((member: any) => member?.user_id === selfId)) channel.joined = true;
        else return;
        this.syncChannel(channel);
        return;
      }
      case "GUILD_CREATE":
      case "GUILD_UPDATE": {
        const selfId = this.account.self?.id;
        const member = Array.isArray(data?.members) ? data.members.find((entry: any) => entry?.user?.id === selfId || entry?.user_id === selfId) : null;
        const guild = this.account.loadGuild(data, member ?? undefined);
        if (guild) this.syncGuild(guild.id);
        return;
      }
      case "GUILD_DELETE": {
        if (typeof data?.id !== "string" || data.unavailable === true) return;
        for (const id of this.account.removeGuild(data.id)) {
          this.cache.delete(id);
          if (this.host.chats.raw(id)) this.host.chats.remove(id);
        }
        this.guildChanged(data.id);
        return;
      }
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE": {
        const guild = typeof data?.guild_id === "string" ? this.account.guilds.get(data.guild_id) : null;
        if (!guild) return;
        this.account.putRole(guild, data.role);
        this.syncGuild(guild.id);
        return;
      }
      case "GUILD_ROLE_DELETE": {
        const guild = typeof data?.guild_id === "string" ? this.account.guilds.get(data.guild_id) : null;
        if (!guild || typeof data.role_id !== "string") return;
        guild.roles.delete(data.role_id);
        this.syncGuild(guild.id);
        return;
      }
      case "GUILD_MEMBER_UPDATE": {
        const guildId = typeof data?.guild_id === "string" ? data.guild_id : null;
        const userId = typeof data?.user?.id === "string" ? data.user.id : null;
        if (!guildId || !userId) return;
        this.account.putMember(guildId, userId, data);
        if (userId === this.account.self?.id) this.syncGuild(guildId);
        return;
      }
      case "GUILD_MEMBERS_CHUNK":
        this.membersChunk(data);
        return;
      case "GUILD_MEMBER_LIST_UPDATE":
        this.memberListUpdate(data);
        return;
      case "USER_GUILD_SETTINGS_UPDATE": {
        this.account.updateSettings(data);
        if (typeof data?.guild_id === "string") this.syncGuild(data.guild_id);
        else for (const channel of this.account.channels.values()) if (!channel.guildId) this.syncChannel(channel);
        return;
      }
      case "USER_SETTINGS_PROTO_UPDATE": {
        const proto = typeof data?.settings?.proto === "string" && (data.settings.type ?? 1) === 1 ? decodeUserProto(data.settings.proto) : null;
        if (!proto) return;
        if (proto.status) {
          this.userStatus = proto.status;
          this.followPresence();
        }
        if (proto.folders.length > 0) {
          this.account.setFolders(proto.folders);
          this.host.emit({ event: "discord.guilds", guilds: this.account.wireGuilds() });
        }
        return;
      }
      case "TYPING_START": {
        const chat = typeof data?.channel_id === "string" ? data.channel_id : null;
        if (!chat || !this.viewed(chat) || data.user_id === this.account.self?.id) return;
        const member = data.member;
        const user = userInfo(member?.user ?? data.user ?? { id: data.user_id, username: "" });
        if (!user) return;
        const guildId = this.account.channels.get(chat)?.guildId;
        const known = guildId ? this.account.guilds.get(guildId)?.members.get(user.id) : null;
        const name = (typeof member?.nick === "string" && member.nick) || known?.nick || (user.username ? user.name : this.account.users.get(user.id)?.name) || "Someone";
        this.host.emit({ event: "typing", chat, user: { id: user.id, name }, until: Date.now() + TYPING_MS });
        return;
      }
      case "RELATIONSHIP_ADD":
      case "CHANNEL_RECIPIENT_ADD":
      case "CHANNEL_RECIPIENT_REMOVE":
        return;
      default:
        return;
    }
  }

  private bump(update: any): void {
    if (!update || typeof update.id !== "string") return;
    const lastId = typeof update.last_message_id === "string" ? update.last_message_id : null;
    if (!this.account.bumpLastMessage(update.id, lastId)) return;
    const channel = this.account.channels.get(update.id);
    if (channel) this.syncChannel(channel);
  }

  private messageCreate(raw: DiscordMessageResponse): void {
    if (!raw || typeof raw.id !== "string" || typeof raw.channel_id !== "string") return;
    const channel = this.account.channels.get(raw.channel_id);
    if (!channel) return;
    const viewed = this.viewed(channel.id);
    if (channel.guildId && raw.member && raw.author?.id && viewed) this.account.putMember(channel.guildId, raw.author.id, raw.member);
    const viewing = viewed && this.host.viewing().front;
    const arrival = this.account.arrive(raw, viewing);
    if (!arrival) return;
    const cached = this.cache.get(channel.id);
    const dm = !channel.guildId;
    // Most messages are in channels nobody looks at: only their unread state moves.
    const needed = viewed || arrival.notify || dm || cached?.live === true;
    let wire: WireMessage | null = null;
    if (needed) {
      const message = mapDiscordMessage(raw);
      if (cached?.live && !cached.messages.some((known) => known.id === message.id)) {
        cached.messages.push(message);
        if (cached.messages.length > CACHED_MESSAGES) {
          cached.messages.splice(0, cached.messages.length - CACHED_MESSAGES);
          cached.complete = false;
        }
      }
      wire = this.wire(message, raw);
      if (raw.nonce !== undefined && raw.nonce !== null) {
        const clientId = this.clientIds.get(String(raw.nonce));
        if (clientId) {
          wire.client_id = clientId;
          this.clientIds.delete(String(raw.nonce));
        }
      }
    }
    const previous = this.host.chats.raw(channel.id);
    let chat = this.account.chat(channel, previous);
    if (dm && wire) {
      chat = {
        ...chat,
        last: { id: wire.id, ts: wire.ts, author: wire.author.name, text: lastLine(wire), mine: wire.mine },
        ts: Math.max(chat.ts, wire.ts),
      };
    }
    this.upsertChat(chat);
    if (channel.guildId) this.guildChanged(channel.guildId);
    if (!wire) return;
    if (viewed) this.host.emit({ event: "message", message: wire, live: true });
    if (arrival.notify) {
      // The notification says it in words: names for mentions, no markdown.
      const words = { ...wire, text: plainText(wire) };
      void this.host.notifier.incoming(words, this.notificationChat(channel, chat, arrival.mentioned)).then((outcome) => {
        if (outcome === "shown") this.host.chats.markReadLocally(channel.id);
      });
    } else if (viewing && !wire.mine) {
      void this.host.moonView().then((moon) => {
        if (!moon || (moon.view === this.host.service && moon.screenAwake && !moon.locked)) this.host.chats.markReadLocally(channel.id);
      });
    }
  }

  /** The chat as a notification names it: "#general (Server)", a thread under its channel. */
  private notificationChat(channel: Channel, chat: WireChat, mentioned: boolean): WireChat {
    if (!channel.guildId) return chat;
    const guild = this.account.guilds.get(channel.guildId);
    const parent = THREAD_TYPES.has(channel.type) && channel.parentId ? this.account.channels.get(channel.parentId) : null;
    const place = parent ? `${channel.name} (#${parent.name}, ${guild?.name ?? "Discord"})` : `#${channel.name} (${guild?.name ?? "Discord"})`;
    return { ...chat, title: place, unread: mentioned ? Math.max(1, chat.mentions ?? 1) : 1 };
  }

  private messageUpdate(raw: any): void {
    if (!raw || typeof raw.id !== "string" || typeof raw.channel_id !== "string") return;
    const channel = this.account.channels.get(raw.channel_id);
    if (!channel) return;
    if (channel.guildId && raw.member && raw.author?.id) this.account.putMember(channel.guildId, raw.author.id, raw.member);
    const patch = mapDiscordMessagePatch(raw);
    const found = this.patchCached(raw.channel_id, raw.id, (message) => applyDiscordMessagePatch(message, patch), raw);
    // Not kept here, but whole (an edit): the app may hold it.
    if (!found && raw.author && typeof raw.content === "string" && this.viewed(raw.channel_id)) {
      this.host.emit({ event: "message", message: this.wire(mapDiscordMessage(raw), raw), live: false });
    }
  }

  private patchCached(channelId: string, messageId: string, change: (message: DiscordMessage) => DiscordMessage, raw?: any): boolean {
    const cached = this.cache.get(channelId);
    const index = cached ? cached.messages.findIndex((message) => message.id === messageId) : -1;
    if (!cached || index < 0) return false;
    const next = change(cached.messages[index]!);
    cached.messages[index] = next;
    if (this.viewed(channelId)) this.host.emit({ event: "message", message: this.wire(next, raw), live: false });
    return true;
  }

  private messageDelete(channelId: string, ids: string[]): void {
    const cached = this.cache.get(channelId);
    if (cached) cached.messages = cached.messages.filter((message) => !ids.includes(message.id));
    if (!this.account.channels.has(channelId)) return;
    for (const id of ids) this.host.emit({ event: "message_removed", chat: channelId, id });
  }

  private membersChunk(data: any): void {
    const guildId = typeof data?.guild_id === "string" ? data.guild_id : null;
    if (!guildId || !Array.isArray(data.members)) return;
    const updated = new Set<string>();
    const members: Array<{ id: string; name: string; color: number | null }> = [];
    for (const raw of data.members) {
      const user = userInfo(raw?.user);
      if (!user) continue;
      if (!this.account.users.has(user.id)) this.account.users.set(user.id, user);
      const member = this.account.putMember(guildId, user.id, raw);
      if (!member) continue;
      updated.add(user.id);
      members.push({ id: user.id, name: member.nick ?? user.name, color: this.account.roleColor(guildId, member.roles) });
    }
    if (members.length === 0) return;
    this.host.emit({ event: "discord.members", guild: guildId, members });
    // The messages on screen by these people: their names and colours as the server shows them.
    for (const chatId of this.host.viewing().chats) {
      const channel = this.account.channels.get(chatId);
      if (channel?.guildId !== guildId) continue;
      for (const message of this.cache.get(chatId)?.messages ?? []) {
        if (updated.has(message.author.id)) this.host.emit({ event: "message", message: this.wire(message), live: false });
      }
    }
  }

  private memberListUpdate(data: any): void {
    const guildId = typeof data?.guild_id === "string" ? data.guild_id : null;
    if (!guildId) return;
    const sync = Array.isArray(data.ops) ? data.ops.find((op: any) => op?.op === "SYNC") : null;
    if (!sync) return;
    // The list belongs to the channel subscribed in that guild.
    for (const chatId of this.host.viewing().chats) {
      if (this.account.channels.get(chatId)?.guildId !== guildId) continue;
      const items = Array.isArray(sync.items) ? sync.items : [];
      const list = items.map((item: any) => {
        if (item?.group) return { group: String(item.group.id), count: Number(item.group.count) || 0 };
        const member = item?.member;
        const user = userInfo(member?.user);
        if (!user) return null;
        this.account.putMember(guildId, user.id, member);
        return {
          id: user.id,
          name: (typeof member.nick === "string" && member.nick) || user.name,
          avatar: userAvatar(user),
          color: this.account.roleColor(guildId, Array.isArray(member.roles) ? member.roles : []),
          status: typeof member.presence?.status === "string" ? member.presence.status : "offline",
          bot: user.bot,
        };
      }).filter(Boolean);
      const groups = Array.isArray(data.groups) ? data.groups.map((group: any) => ({ id: String(group.id), count: Number(group.count) || 0, name: this.groupName(guildId, String(group.id)) })) : [];
      const value = { chat: chatId, groups, items: list, members: data.member_count ?? null, online: data.online_count ?? null };
      this.memberLists.set(chatId, value);
      this.host.emit({ event: "discord.member_list", ...value });
    }
  }

  private groupName(guildId: string, id: string): string {
    if (id === "online") return "Online";
    if (id === "offline") return "Offline";
    return this.account.roleInfo(guildId, id)?.name ?? id;
  }

  private resubscribe(): void {
    const view = this.host.viewing();
    if (view.front) this.viewChanged(view);
  }

  viewChanged(view: { chats: Set<string>; front: boolean }): void {
    if (!view.front || !this.gateway) return;
    for (const chatId of view.chats) {
      const channel = this.account.channels.get(chatId);
      if (channel?.guildId) this.gateway.subscribe(channel.guildId, THREAD_TYPES.has(channel.type) ? channel.parentId ?? channel.id : channel.id);
    }
  }

  private wire(message: DiscordMessage, raw?: any): WireMessage {
    return wireMessage(message, { account: this.account }, raw);
  }

  private requireToken(): string {
    if (!this.token) throw new BridgeError("signed_out", "not signed in");
    return this.token;
  }

  // ---------------------------------------------------------------------
  // Commands

  async history(chat: string, options: { before?: string | null; limit: number }): Promise<HistoryPage> {
    const token = this.requireToken();
    const channel = this.account.channels.get(chat);
    if (!channel) throw new BridgeError("not_found", "no such chat");
    const cached = this.cache.get(chat);
    const before = options.before ?? null;
    const limit = options.limit;
    let page: DiscordMessage[];
    let more: boolean;
    const fromCache = (() => {
      if (!cached || !cached.live) return null;
      if (!before) return cached.messages.length >= limit || cached.complete ? cached.messages.slice(-limit) : null;
      const index = cached.messages.findIndex((message) => message.id === before);
      if (index < 0) return null;
      if (index >= limit || (cached.complete && index > 0)) return cached.messages.slice(Math.max(0, index - limit), index);
      return null;
    })();
    if (fromCache) {
      page = fromCache;
      more = !(cached!.complete && page[0]?.id === cached!.messages[0]?.id);
    } else {
      try {
        page = await fetchChannelMessages(token, chat, limit, before ?? undefined);
      } catch (error) {
        throw bridgeError(error);
      }
      more = page.length >= limit;
      this.remember(chat, page, before, more);
    }
    // Names and role colours for people not met yet in this server.
    if (channel.guildId && this.gateway) {
      const members = this.account.guilds.get(channel.guildId)?.members;
      const unknown = [...new Set(page.map((message) => message.author.id))].filter((id) => !members?.has(id));
      if (unknown.length > 0) this.gateway.requestMembers(channel.guildId, unknown);
    }
    const messages = page.map((message) => this.wire(message));
    // A DM's line in the list.
    if (!before && !channel.guildId && messages.length > 0) {
      const newest = messages.at(-1)!;
      const previous = this.host.chats.raw(chat);
      if (previous && previous.last?.id !== newest.id) {
        this.host.chats.upsert({ ...previous, last: { id: newest.id, ts: newest.ts, author: newest.author.name, text: lastLine(newest), mine: newest.mine } });
      }
    }
    return { messages, more };
  }

  /** Keeps a fetched page: the newest page starts a channel's cache, an older one extends it. */
  private remember(chat: string, page: DiscordMessage[], before: string | null, more: boolean): void {
    const live = this.gateway?.ready ?? false;
    let cached = this.cache.get(chat);
    if (!before) {
      cached = { messages: page.slice(-CACHED_MESSAGES), live, complete: !more };
    } else if (cached && cached.messages[0]?.id === before && cached.messages.length < CACHED_MESSAGES) {
      cached.messages = [...page, ...cached.messages].slice(-CACHED_MESSAGES);
      cached.complete = !more && cached.messages.length === page.length + cached.messages.length - page.length;
    } else {
      return;
    }
    this.cache.delete(chat);
    this.cache.set(chat, cached);
    while (this.cache.size > CACHED_CHANNELS) this.cache.delete(this.cache.keys().next().value!);
  }

  async fetchMedia(ref: string, max: number | null): Promise<FetchedMedia> {
    const request = mediaRequest(ref, max);
    return this.host.media.fetch(request.key, request.mime, (path) => downloadUrl(request.url, path, {
      headers: { Accept: "image/*" },
      maxBytes: MEDIA_MAX_BYTES,
    }));
  }

  /** `discord.threads`: a forum's posts or a channel's threads, joined or not. */
  private async threads(args: Record<string, any>): Promise<unknown> {
    const chat = typeof args.chat === "string" ? args.chat : "";
    const channel = this.account.channels.get(chat);
    if (!channel?.guildId) throw new BridgeError("not_found", "no such channel");
    const archived = args.archived === true;
    const known = (): WireChat[] => [...this.account.channels.values()]
      .filter((thread) => thread.parentId === chat && THREAD_TYPES.has(thread.type) && thread.archived === archived && this.account.canView(thread))
      .map((thread) => this.account.chat(thread));
    let threads: WireChat[];
    let more = false;
    try {
      const result = await fetchChannelThreads(this.requireToken(), chat, { archived, limit: 25, offset: Number.isInteger(args.offset) ? args.offset : 0 });
      const joined = new Set(result.members.filter((member) => member.user_id === undefined || member.user_id === this.account.self?.id).map((member) => member.id));
      threads = result.threads.map((raw) => {
        const thread = this.account.putChannel(joined.has(raw.id) && !raw.member ? { ...raw, member: { muted: false } } : raw, channel.guildId);
        return thread ? this.account.chat(thread) : null;
      }).filter((thread): thread is WireChat => thread !== null);
      more = result.hasMore;
    } catch (error) {
      const failure = bridgeError(error);
      if (failure.code !== "not_found") throw failure;
      threads = known();
    }
    return { threads, more };
  }

  private async memberList(args: Record<string, any>): Promise<unknown> {
    const chat = typeof args.chat === "string" ? args.chat : "";
    const channel = this.account.channels.get(chat);
    if (!channel) throw new BridgeError("not_found", "no such chat");
    if (!channel.guildId) {
      const self = this.account.self;
      const people = [...channel.recipients, ...(self ? [self] : [])];
      return { chat, groups: [], items: people.map((user) => ({ id: user.id, name: user.name, avatar: userAvatar(user), color: null, status: null, bot: user.bot })), members: people.length, online: null };
    }
    return this.memberLists.get(chat) ?? { chat, groups: [], items: [], members: null, online: null };
  }

  /** The badge: unread DM messages and mentions, as the chats show them now (local reads applied). */
  badge(chats: WireChat[]): number | null {
    if (!this.everReady && chats.length === 0) return null;
    let count = 0;
    for (const chat of chats) {
      if (chat.kind === "dm" || chat.kind === "group") {
        if (!chat.muted) count += chat.unread;
      } else {
        count += chat.mentions ?? 0;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Writes: the bridge's guard runs before every one of these.

  async send(args: { chat: string; text: string; reply_to?: string | null; client_id?: string | null; media?: string[] }): Promise<WireMessage> {
    const channel = this.account.channels.get(args.chat);
    if (!channel) throw new BridgeError("not_found", "no such chat");
    if (args.media && args.media.length > 0) throw new BridgeError("invalid_argument", "sending files is not supported yet");
    const nonce = generateMessageNonce();
    if (args.client_id) this.clientIds.set(nonce, args.client_id);
    try {
      const sent = await sendChannelMessage(this.requireToken(), channel.id, args.text, {
        nonce,
        reply: args.reply_to ? { messageId: args.reply_to, channelId: channel.id, guildId: channel.guildId, mention: true } : null,
      });
      const wire = this.wire(sent);
      if (args.client_id) wire.client_id = args.client_id;
      return wire;
    } catch (error) {
      this.clientIds.delete(nonce);
      const failure = bridgeError(error);
      throw failure.code === "unavailable" ? new BridgeError("uncertain", failure.message) : failure;
    }
  }

  async react(args: { chat: string; message: string; emoji: string; remove: boolean }): Promise<void> {
    const custom = args.emoji.match(/^<(a?):([A-Za-z0-9_~]+):(\d+)>$/);
    const emoji = custom ? { id: custom[3]!, name: custom[2]!, animated: custom[1] === "a" } : { id: null, name: args.emoji, animated: false };
    try {
      await setChannelMessageReaction(this.requireToken(), args.chat, args.message, emoji, args.remove);
    } catch (error) {
      throw bridgeError(error);
    }
  }

  async edit(args: { chat: string; message: string; text: string }): Promise<WireMessage> {
    try {
      return this.wire(await editChannelMessage(this.requireToken(), args.chat, args.message, args.text));
    } catch (error) {
      throw bridgeError(error);
    }
  }

  async delete(args: { chat: string; message: string }): Promise<void> {
    try {
      await deleteChannelMessage(this.requireToken(), args.chat, args.message);
    } catch (error) {
      throw bridgeError(error);
    }
  }

  async markRead(args: { chat: string; message?: string | null }): Promise<void> {
    const channel = this.account.channels.get(args.chat);
    const message = args.message ?? channel?.lastMessageId ?? null;
    if (!channel || !message) return;
    try {
      await ackChannelMessage(this.requireToken(), channel.id, message);
    } catch (error) {
      throw bridgeError(error);
    }
    this.account.ack(channel.id, message, 0);
    this.syncChannel(channel);
  }

  // ---------------------------------------------------------------------
  // Signing in: a token (the app's settings), checked with Discord first.

  async loginStart(args: Record<string, unknown>): Promise<void> {
    if (this.host.fixtures) throw new BridgeError("invalid_argument", "fixtures are always signed in");
    if (args.method !== "token" || typeof args.token !== "string" || !args.token.trim()) {
      throw new BridgeError("invalid_argument", "method token with a token");
    }
    const token = args.token.trim();
    this.host.emit({ event: "login", state: "waiting" });
    try {
      await validateToken(token);
    } catch (error) {
      const failure = bridgeError(error);
      this.host.emit({ event: "login", state: "failed", detail: failure.code === "signed_out" ? "Discord did not accept that token." : "Discord can't be reached." });
      throw failure;
    }
    this.gateway?.stop();
    this.gateway = null;
    this.saveToken(token);
    this.stopped = false;
    this.host.emit({ event: "login", state: "done" });
    await this.connect();
  }

  async logout(): Promise<void> {
    if (this.host.fixtures) throw new BridgeError("invalid_argument", "fixtures are always signed in");
    this.gateway?.stop();
    this.gateway = null;
    this.token = null;
    this.cache.clear();
    if (existsSync(this.sessionPath)) rmSync(this.sessionPath, { force: true });
    this.host.chats.replaceAll([]);
    this.host.setStatus("signed_out", null, null);
  }
}

export { DM_TYPES };
