/**
 * The Discord account as the bridge keeps it: servers with their roles and
 * channels, DMs, read states, the user's notification settings and the
 * server rail's folders, from READY and kept current by the gateway's
 * events. It decides what the apps see (docs/social-protocol.md §5
 * Discord): which channels are chats (the ones the user can view), their
 * unread and mention state, and which live messages notify, as the mobile
 * app does (DMs, mentions, and channels set to all messages; nothing muted).
 *
 * Pure: no I/O. The provider feeds it events and turns what it answers into
 * chats, servers and notifications.
 */

import { compareSnowflakesDesc } from "../../../discord";
import type { WireChat, WireMedia } from "../../protocol";
import type { GuildFolder } from "./userproto";
import { avatarMedia, defaultAvatarMedia, groupIconMedia, guildIconMedia } from "./refs";

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;
const DISCORD_EPOCH = 1_420_070_400_000n;

export const TEXT_TYPES = new Set([0, 5]);
export const THREAD_TYPES = new Set([10, 11, 12]);
export const VOICE_TYPES = new Set([2, 13]);
export const FORUM_TYPES = new Set([15, 16]);
export const CATEGORY_TYPE = 4;
export const DM_TYPES = new Set([1, 3]);

/** Notification levels (Discord's message_notifications). */
export const ALL_MESSAGES = 0;
export const ONLY_MENTIONS = 1;
export const NO_MESSAGES = 2;
const INHERIT = 3;

export function snowflakeTime(id: string | null | undefined): number {
  if (!id || !/^\d+$/.test(id)) return 0;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString();
}

function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareSnowflakesDesc(a ?? null, b ?? null) < 0;
}

function bits(value: unknown): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return 0n;
}

export interface UserInfo {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  bot: boolean;
}

export function userInfo(raw: any): UserInfo | null {
  if (!raw || typeof raw.id !== "string") return null;
  const username = typeof raw.username === "string" ? raw.username : "";
  const global = typeof raw.global_name === "string" && raw.global_name.trim() ? raw.global_name : null;
  return { id: raw.id, username, name: global ?? (username || "Unknown"), avatar: typeof raw.avatar === "string" ? raw.avatar : null, bot: raw.bot === true };
}

export function userAvatar(user: Pick<UserInfo, "id" | "avatar">): WireMedia {
  return user.avatar ? avatarMedia(user.id, user.avatar) : defaultAvatarMedia(user.id);
}

interface Role {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: bigint;
}

interface Overwrite {
  id: string;
  type: number;
  allow: bigint;
  deny: bigint;
}

export interface Channel {
  id: string;
  guildId: string | null;
  type: number;
  name: string;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  overwrites: Overwrite[];
  lastMessageId: string | null;
  /** DMs: the people in it (not the user). */
  recipients: UserInfo[];
  icon: string | null;
  /** Threads. */
  archived: boolean;
  locked: boolean;
  joined: boolean;
  threadMuted: boolean;
  ownerId: string | null;
  messageCount: number;
}

export interface Member {
  nick: string | null;
  roles: string[];
  avatar: string | null;
}

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string | null;
  roles: Map<string, Role>;
  myRoles: string[];
  defaultNotifications: number;
  joinedAt: string | null;
  memberCount: number | null;
  channelIds: Set<string>;
  /** Names and roles of members met in this server's messages. */
  members: Map<string, Member>;
}

interface ReadState {
  lastMessageId: string | null;
  mentions: number;
}

interface Override {
  muted: boolean;
  level: number;
}

interface GuildSettings {
  muted: boolean;
  level: number;
  suppressEveryone: boolean;
  suppressRoles: boolean;
  channels: Map<string, Override>;
}

/** The server rail entry the apps get (`discord.guilds`). */
export interface WireGuild {
  id: string;
  name: string;
  icon: WireMedia | null;
  /** An unmuted channel the user can see has something unread. */
  unread: boolean;
  mentions: number;
  muted: boolean;
  /** Place on the rail (the user's order, folders kept together). */
  position: number;
  folder: { id: string; name: string | null; color: number | null } | null;
  categories: Array<{ id: string; name: string; position: number }>;
  owner: boolean;
  members: number | null;
}

/** What a live message means for the user. */
export interface Arrival {
  chat: WireChat;
  /** Post a notification for it. */
  notify: boolean;
  /** It mentions the user (highlight, the badge). */
  mentioned: boolean;
}

function mutedNow(raw: any, now: number): boolean {
  if (raw?.muted !== true) return false;
  const end = raw?.mute_config?.end_time;
  if (typeof end !== "string" || !end) return true;
  const until = Date.parse(end);
  return !Number.isFinite(until) || until > now;
}

function level(value: unknown): number {
  return typeof value === "number" && value >= 0 && value <= 3 ? value : INHERIT;
}

export class Account {
  self: UserInfo | null = null;
  readonly guilds = new Map<string, Guild>();
  readonly channels = new Map<string, Channel>();
  private readonly reads = new Map<string, ReadState>();
  private readonly settings = new Map<string, GuildSettings>();
  /** DMs' own settings (Discord keeps them under guild null). */
  private dmSettings: GuildSettings = { muted: false, level: ALL_MESSAGES, suppressEveryone: false, suppressRoles: false, channels: new Map() };
  private folders: GuildFolder[] = [];
  /** READY's guild order, for servers no folder places. */
  private readyOrder: string[] = [];
  /** Users seen (DM recipients, READY's users). */
  readonly users = new Map<string, UserInfo>();

  constructor(private readonly now: () => number = Date.now) {}

  // ---------------------------------------------------------------------
  // Loading

  /** A fresh READY: everything is replaced. */
  loadReady(data: any, folders: GuildFolder[]): void {
    this.guilds.clear();
    this.channels.clear();
    this.reads.clear();
    this.settings.clear();
    this.users.clear();
    this.self = userInfo(data?.user);
    for (const raw of Array.isArray(data?.users) ? data.users : []) {
      const user = userInfo(raw);
      if (user) this.users.set(user.id, user);
    }
    const selfId = this.self?.id ?? null;
    const myMembers = Array.isArray(data?.merged_members) ? data.merged_members : [];
    const guilds = Array.isArray(data?.guilds) ? data.guilds : [];
    this.readyOrder = [];
    guilds.forEach((raw: any, index: number) => {
      const member = Array.isArray(myMembers[index])
        ? myMembers[index].find((entry: any) => entry?.user_id === selfId) ?? myMembers[index][0]
        : null;
      if (raw?.unavailable === true && !raw.properties && !raw.name) return;
      this.loadGuild(raw, member);
      if (typeof raw?.id === "string") this.readyOrder.push(raw.id);
    });
    for (const raw of Array.isArray(data?.private_channels) ? data.private_channels : []) this.loadDirectMessage(raw);
    const entries = Array.isArray(data?.read_state?.entries) ? data.read_state.entries : Array.isArray(data?.read_state) ? data.read_state : [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string") continue;
      // Non-channel read states (the inbox, server events) have a type.
      if (typeof entry.read_state_type === "number" && entry.read_state_type !== 0) continue;
      this.reads.set(entry.id, {
        lastMessageId: typeof entry.last_message_id === "string" ? entry.last_message_id : entry.last_message_id ? String(entry.last_message_id) : null,
        mentions: typeof entry.mention_count === "number" ? entry.mention_count : 0,
      });
    }
    const settings = Array.isArray(data?.user_guild_settings?.entries) ? data.user_guild_settings.entries : Array.isArray(data?.user_guild_settings) ? data.user_guild_settings : [];
    for (const entry of settings) this.loadSettings(entry);
    this.folders = folders;
  }

  setFolders(folders: GuildFolder[]): void {
    this.folders = folders;
  }

  loadGuild(raw: any, myMember?: any): Guild | null {
    const id = typeof raw?.id === "string" ? raw.id : null;
    if (!id) return null;
    const properties = raw.properties ?? raw;
    const previous = this.guilds.get(id);
    const guild: Guild = {
      id,
      name: typeof properties.name === "string" ? properties.name : previous?.name ?? "",
      icon: typeof properties.icon === "string" ? properties.icon : properties.icon === null ? null : previous?.icon ?? null,
      ownerId: typeof properties.owner_id === "string" ? properties.owner_id : previous?.ownerId ?? null,
      roles: previous?.roles ?? new Map(),
      myRoles: Array.isArray(myMember?.roles) ? myMember.roles.filter((role: unknown) => typeof role === "string") : previous?.myRoles ?? [],
      defaultNotifications: typeof properties.default_message_notifications === "number" ? properties.default_message_notifications : previous?.defaultNotifications ?? ONLY_MENTIONS,
      joinedAt: typeof raw.joined_at === "string" ? raw.joined_at : typeof myMember?.joined_at === "string" ? myMember.joined_at : previous?.joinedAt ?? null,
      memberCount: typeof raw.member_count === "number" ? raw.member_count : previous?.memberCount ?? null,
      channelIds: previous?.channelIds ?? new Set(),
      members: previous?.members ?? new Map(),
    };
    if (Array.isArray(raw.roles)) {
      guild.roles = new Map();
      for (const role of raw.roles) this.putRole(guild, role);
    }
    this.guilds.set(id, guild);
    if (Array.isArray(raw.channels)) {
      for (const channelId of guild.channelIds) {
        const channel = this.channels.get(channelId);
        if (channel && !THREAD_TYPES.has(channel.type)) {
          this.channels.delete(channelId);
          guild.channelIds.delete(channelId);
        }
      }
      for (const channel of raw.channels) this.putChannel(channel, id);
    }
    if (Array.isArray(raw.threads)) for (const thread of raw.threads) this.putChannel(thread, id);
    return guild;
  }

  removeGuild(id: string): string[] {
    const guild = this.guilds.get(id);
    if (!guild) return [];
    const removed = [...guild.channelIds];
    for (const channelId of removed) this.channels.delete(channelId);
    this.guilds.delete(id);
    return removed;
  }

  putRole(guild: Guild, raw: any): void {
    if (!raw || typeof raw.id !== "string") return;
    guild.roles.set(raw.id, {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      color: typeof raw.color === "number" ? raw.color : 0,
      position: typeof raw.position === "number" ? raw.position : 0,
      permissions: bits(raw.permissions),
    });
  }

  loadDirectMessage(raw: any): Channel | null {
    if (!raw || typeof raw.id !== "string" || !DM_TYPES.has(raw.type)) return null;
    const recipients: UserInfo[] = [];
    for (const recipient of Array.isArray(raw.recipients) ? raw.recipients : []) {
      const user = userInfo(recipient);
      if (user) {
        recipients.push(user);
        this.users.set(user.id, user);
      }
    }
    if (recipients.length === 0) {
      for (const id of Array.isArray(raw.recipient_ids) ? raw.recipient_ids : []) {
        const user = this.users.get(id);
        if (user) recipients.push(user);
      }
    }
    const channel: Channel = {
      id: raw.id, guildId: null, type: raw.type, name: typeof raw.name === "string" ? raw.name : "",
      parentId: null, position: 0, topic: null, nsfw: false, overwrites: [],
      lastMessageId: typeof raw.last_message_id === "string" ? raw.last_message_id : null,
      recipients, icon: typeof raw.icon === "string" ? raw.icon : null,
      archived: false, locked: false, joined: true, threadMuted: false,
      ownerId: typeof raw.owner_id === "string" ? raw.owner_id : null, messageCount: 0,
    };
    const previous = this.channels.get(raw.id);
    if (previous && newer(previous.lastMessageId, channel.lastMessageId)) channel.lastMessageId = previous.lastMessageId;
    this.channels.set(raw.id, channel);
    return channel;
  }

  /** A guild channel or thread (READY, GUILD_CREATE, CHANNEL_*, THREAD_*). */
  putChannel(raw: any, fallbackGuildId: string | null): Channel | null {
    if (!raw || typeof raw.id !== "string" || typeof raw.type !== "number") return null;
    if (DM_TYPES.has(raw.type)) return this.loadDirectMessage(raw);
    const guildId = typeof raw.guild_id === "string" ? raw.guild_id : fallbackGuildId;
    const guild = guildId ? this.guilds.get(guildId) : null;
    if (!guild) return null;
    const previous = this.channels.get(raw.id);
    const thread = THREAD_TYPES.has(raw.type);
    const metadata = raw.thread_metadata ?? {};
    const channel: Channel = {
      id: raw.id,
      guildId: guild.id,
      type: raw.type,
      name: typeof raw.name === "string" ? raw.name : previous?.name ?? "",
      parentId: typeof raw.parent_id === "string" ? raw.parent_id : null,
      position: typeof raw.position === "number" ? raw.position : previous?.position ?? 0,
      topic: typeof raw.topic === "string" && raw.topic ? raw.topic : null,
      nsfw: raw.nsfw === true,
      overwrites: Array.isArray(raw.permission_overwrites)
        ? raw.permission_overwrites
          .filter((overwrite: any) => overwrite && typeof overwrite.id === "string")
          .map((overwrite: any) => ({ id: overwrite.id, type: Number(overwrite.type), allow: bits(overwrite.allow), deny: bits(overwrite.deny) }))
        : previous?.overwrites ?? [],
      lastMessageId: typeof raw.last_message_id === "string" ? raw.last_message_id : previous?.lastMessageId ?? null,
      recipients: [],
      icon: null,
      archived: thread ? metadata.archived === true : false,
      locked: thread ? metadata.locked === true : false,
      joined: thread ? (raw.member ? true : previous?.joined ?? false) : true,
      threadMuted: thread ? (raw.member ? raw.member.muted === true : previous?.threadMuted ?? false) : false,
      ownerId: typeof raw.owner_id === "string" ? raw.owner_id : previous?.ownerId ?? null,
      messageCount: typeof raw.message_count === "number" ? raw.message_count : previous?.messageCount ?? 0,
    };
    if (previous && newer(previous.lastMessageId, channel.lastMessageId)) channel.lastMessageId = previous.lastMessageId;
    this.channels.set(channel.id, channel);
    guild.channelIds.add(channel.id);
    return channel;
  }

  removeChannel(id: string): Channel | null {
    const channel = this.channels.get(id);
    if (!channel) return null;
    this.channels.delete(id);
    if (channel.guildId) this.guilds.get(channel.guildId)?.channelIds.delete(id);
    return channel;
  }

  loadSettings(entry: any): void {
    if (!entry || typeof entry !== "object") return;
    const now = this.now();
    const channels = new Map<string, Override>();
    const overrides = Array.isArray(entry.channel_overrides)
      ? entry.channel_overrides
      : entry.channel_overrides && typeof entry.channel_overrides === "object"
        ? Object.entries(entry.channel_overrides).map(([channel_id, value]: [string, any]) => ({ channel_id, ...value }))
        : [];
    for (const override of overrides) {
      if (!override || typeof override.channel_id !== "string") continue;
      channels.set(override.channel_id, { muted: mutedNow(override, now), level: level(override.message_notifications) });
    }
    const settings: GuildSettings = {
      muted: mutedNow(entry, now),
      level: level(entry.message_notifications),
      suppressEveryone: entry.suppress_everyone === true,
      suppressRoles: entry.suppress_roles === true,
      channels,
    };
    if (typeof entry.guild_id === "string") this.settings.set(entry.guild_id, settings);
    else this.dmSettings = settings;
  }

  /** USER_GUILD_SETTINGS_UPDATE carries one entry whole, or a partial one. */
  updateSettings(entry: any): void {
    if (!entry || typeof entry !== "object") return;
    const current = typeof entry.guild_id === "string" ? this.settings.get(entry.guild_id) : this.dmSettings;
    if (current && !Array.isArray(entry.channel_overrides) && entry.channel_overrides === undefined) {
      const now = this.now();
      if (entry.muted !== undefined) current.muted = mutedNow(entry, now);
      if (entry.message_notifications !== undefined) current.level = level(entry.message_notifications);
      if (entry.suppress_everyone !== undefined) current.suppressEveryone = entry.suppress_everyone === true;
      if (entry.suppress_roles !== undefined) current.suppressRoles = entry.suppress_roles === true;
      return;
    }
    this.loadSettings(entry);
  }

  // ---------------------------------------------------------------------
  // Read state

  read(channelId: string): ReadState {
    let state = this.reads.get(channelId);
    if (!state) {
      const channel = this.channels.get(channelId);
      const guild = channel?.guildId ? this.guilds.get(channel.guildId) : null;
      // Never opened: what came before the user joined is not unread.
      const joined = guild?.joinedAt ? Date.parse(guild.joinedAt) : NaN;
      state = { lastMessageId: Number.isFinite(joined) ? snowflakeAt(joined) : channel?.lastMessageId ?? null, mentions: 0 };
      this.reads.set(channelId, state);
    }
    return state;
  }

  /** The user read the channel (MESSAGE_ACK from one of their other clients, or their own message). */
  ack(channelId: string, messageId: string | null, mentions = 0): void {
    const state = this.read(channelId);
    if (messageId && !newer(state.lastMessageId, messageId)) state.lastMessageId = messageId;
    state.mentions = Math.max(0, mentions);
  }

  /** A newer message exists (PASSIVE_UPDATE_V2, CHANNEL_UNREAD_UPDATE): true when that changed it. */
  bumpLastMessage(channelId: string, messageId: string | null): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || !messageId || !newer(messageId, channel.lastMessageId)) return false;
    channel.lastMessageId = messageId;
    return true;
  }

  isUnread(channel: Channel): boolean {
    if (!channel.lastMessageId) return false;
    return newer(channel.lastMessageId, this.read(channel.id).lastMessageId);
  }

  // ---------------------------------------------------------------------
  // Permissions, mutes, notification levels

  canView(channel: Channel): boolean {
    if (!channel.guildId) return true;
    const guild = this.guilds.get(channel.guildId);
    const selfId = this.self?.id;
    if (!guild || !selfId) return false;
    if (guild.ownerId === selfId) return true;
    // Threads take their parent's overwrites.
    const source = THREAD_TYPES.has(channel.type) && channel.parentId ? this.channels.get(channel.parentId) ?? channel : channel;
    if (guild.roles.size === 0) return true;
    let permissions = guild.roles.get(guild.id)?.permissions ?? 0n;
    for (const roleId of guild.myRoles) permissions |= guild.roles.get(roleId)?.permissions ?? 0n;
    if ((permissions & ADMINISTRATOR) !== 0n) return true;
    const everyone = source.overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guild.id);
    if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;
    let allow = 0n;
    let deny = 0n;
    const mine = new Set(guild.myRoles);
    for (const overwrite of source.overwrites) {
      if (overwrite.type !== 0 || !mine.has(overwrite.id)) continue;
      allow |= overwrite.allow;
      deny |= overwrite.deny;
    }
    permissions = (permissions & ~deny) | allow;
    const member = source.overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === selfId);
    if (member) permissions = (permissions & ~member.deny) | member.allow;
    return (permissions & VIEW_CHANNEL) !== 0n;
  }

  guildMuted(guildId: string): boolean {
    return this.settings.get(guildId)?.muted ?? false;
  }

  /** The channel itself, its category or its thread's parent is muted (not the server). */
  channelMuted(channel: Channel): boolean {
    if (!channel.guildId) return this.dmSettings.channels.get(channel.id)?.muted ?? false;
    const settings = this.settings.get(channel.guildId);
    if (THREAD_TYPES.has(channel.type)) {
      if (channel.threadMuted) return true;
      const parent = channel.parentId ? this.channels.get(channel.parentId) : null;
      return parent ? this.channelMuted(parent) : false;
    }
    if (!settings) return false;
    if (settings.channels.get(channel.id)?.muted) return true;
    return channel.parentId ? settings.channels.get(channel.parentId)?.muted ?? false : false;
  }

  muted(channel: Channel): boolean {
    return (channel.guildId ? this.guildMuted(channel.guildId) : false) || this.channelMuted(channel);
  }

  /** ALL_MESSAGES, ONLY_MENTIONS or NO_MESSAGES, as the user set it (else the server's default). */
  notificationLevel(channel: Channel): number {
    if (!channel.guildId) return ALL_MESSAGES;
    const guild = this.guilds.get(channel.guildId);
    const settings = this.settings.get(channel.guildId);
    const chain: Array<string | null> = [channel.id];
    if (THREAD_TYPES.has(channel.type) && channel.parentId) {
      const parent = this.channels.get(channel.parentId);
      chain.push(channel.parentId, parent?.parentId ?? null);
    } else {
      chain.push(channel.parentId);
    }
    for (const id of chain) {
      const value = id ? settings?.channels.get(id)?.level : undefined;
      if (value !== undefined && value !== INHERIT) return value;
    }
    if (settings && settings.level !== INHERIT) return settings.level;
    return guild?.defaultNotifications === ALL_MESSAGES ? ALL_MESSAGES : ONLY_MENTIONS;
  }

  /** Does the message (raw, as Discord sends it) mention the user? */
  mentionsMe(raw: any, channel: Channel): boolean {
    const selfId = this.self?.id;
    if (!selfId) return false;
    if (Array.isArray(raw?.mentions) && raw.mentions.some((user: any) => user?.id === selfId)) return true;
    if (!channel.guildId) return false;
    const settings = this.settings.get(channel.guildId);
    if (raw?.mention_everyone === true && !settings?.suppressEveryone) return true;
    if (Array.isArray(raw?.mention_roles) && !settings?.suppressRoles) {
      const mine = new Set(this.guilds.get(channel.guildId)?.myRoles ?? []);
      if (raw.mention_roles.some((role: unknown) => typeof role === "string" && mine.has(role))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // What the apps see

  /** Is this channel one of the apps' chats? */
  isChat(channel: Channel): boolean {
    if (DM_TYPES.has(channel.type)) return true;
    if (!channel.guildId || !this.canView(channel)) return false;
    if (THREAD_TYPES.has(channel.type)) return channel.joined && !channel.archived;
    return TEXT_TYPES.has(channel.type) || FORUM_TYPES.has(channel.type) || VOICE_TYPES.has(channel.type);
  }

  chats(): WireChat[] {
    const out: WireChat[] = [];
    for (const channel of this.channels.values()) {
      if (this.isChat(channel)) out.push(this.chat(channel));
    }
    return out;
  }

  title(channel: Channel): string {
    if (channel.guildId) return channel.name;
    if (channel.name) return channel.name;
    const names = channel.recipients.map((user) => user.name);
    if (names.length === 0) return channel.type === 3 ? "Unnamed group" : "Unknown user";
    return names.join(", ");
  }

  /**
   * The chat for a channel. `ts` is its last activity; for a server channel
   * it moves only when its unread state changes (each message there would
   * otherwise rewrite the bridge's chat cache): the app orders those by
   * position, not by time.
   */
  chat(channel: Channel, previous?: WireChat | null): WireChat {
    const read = this.read(channel.id);
    const unreadMessages = this.isUnread(channel);
    const guild = channel.guildId ? this.guilds.get(channel.guildId) : null;
    const lastTs = snowflakeTime(channel.lastMessageId) || snowflakeTime(channel.id);
    if (!guild) {
      const dm = channel.type === 1;
      const recipient = channel.recipients[0];
      const unread = unreadMessages ? Math.max(1, read.mentions) : 0;
      return {
        id: channel.id,
        kind: dm ? "dm" : "group",
        title: this.title(channel),
        avatar: dm && recipient ? userAvatar(recipient) : channel.icon ? groupIconMedia(channel.id, channel.icon) : null,
        last: previous?.last ?? null,
        ts: lastTs,
        unread,
        mentions: unread,
        muted: this.channelMuted(channel),
        pinned: false,
        archived: false,
        folder: "inbox",
        parent: null,
        members: dm ? null : channel.recipients.length + 1,
        ext: {
          type: channel.type,
          recipients: channel.recipients.map((user) => ({ id: user.id, name: user.name, username: user.username, bot: user.bot })),
          ...(dm && recipient?.bot ? { bot: true } : {}),
        },
      };
    }
    const kind = THREAD_TYPES.has(channel.type) ? "thread" : FORUM_TYPES.has(channel.type) ? "forum" : VOICE_TYPES.has(channel.type) ? "voice" : "channel";
    const unread = unreadMessages ? 1 : 0;
    const keepTs = previous && previous.unread === unread && (previous.mentions ?? 0) === read.mentions;
    const parentChannel = channel.parentId ? this.channels.get(channel.parentId) : null;
    return {
      id: channel.id,
      kind,
      title: channel.name,
      avatar: null,
      last: null,
      ts: keepTs ? previous.ts : lastTs,
      unread,
      mentions: read.mentions,
      muted: this.muted(channel),
      pinned: false,
      archived: false,
      folder: "inbox",
      parent: channel.parentId,
      members: null,
      ext: {
        guild: guild.id,
        type: channel.type,
        position: channel.position,
        ...(kind === "thread" ? { category: parentChannel?.parentId ?? null } : { category: channel.parentId }),
        ...(channel.topic ? { topic: channel.topic } : {}),
        ...(channel.nsfw ? { nsfw: true } : {}),
        ...(channel.locked ? { locked: true } : {}),
        ...(this.channelMuted(channel) ? { channel_muted: true } : {}),
        ...(kind === "thread" && channel.messageCount ? { messages: channel.messageCount } : {}),
      },
    };
  }

  /** The servers for the rail, in the user's order. */
  wireGuilds(): WireGuild[] {
    const order: Array<{ id: string; folder: GuildFolder | null }> = [];
    const placed = new Set<string>();
    for (const folder of this.folders) {
      const grouped = folder.id !== null && folder.guildIds.length > 0;
      for (const id of folder.guildIds) {
        if (placed.has(id) || !this.guilds.has(id)) continue;
        placed.add(id);
        order.push({ id, folder: grouped ? folder : null });
      }
    }
    // Servers joined since the settings were read go on top, as Discord puts them.
    const rest = [...this.readyOrder, ...this.guilds.keys()].filter((id, index, all) => !placed.has(id) && this.guilds.has(id) && all.indexOf(id) === index);
    const ordered = this.folders.length > 0 ? [...rest.map((id) => ({ id, folder: null })), ...order] : rest.map((id) => ({ id, folder: null }));
    return ordered.map(({ id, folder }, position) => this.wireGuild(this.guilds.get(id)!, position, folder));
  }

  wireGuild(guild: Guild, position: number, folder: GuildFolder | null): WireGuild {
    let unread = false;
    let mentions = 0;
    const categories: WireGuild["categories"] = [];
    const guildMuted = this.guildMuted(guild.id);
    for (const id of guild.channelIds) {
      const channel = this.channels.get(id);
      if (!channel) continue;
      if (channel.type === CATEGORY_TYPE) {
        categories.push({ id: channel.id, name: channel.name, position: channel.position });
        continue;
      }
      if (!this.isChat(channel)) continue;
      mentions += this.read(channel.id).mentions;
      if (!unread && !guildMuted && !this.channelMuted(channel) && !VOICE_TYPES.has(channel.type) && this.isUnread(channel)) unread = true;
    }
    categories.sort((a, b) => a.position - b.position || compareSnowflakesDesc(b.id, a.id));
    return {
      id: guild.id,
      name: guild.name,
      icon: guild.icon ? guildIconMedia(guild.id, guild.icon) : null,
      unread,
      mentions,
      muted: guildMuted,
      position,
      folder: folder && folder.id !== null ? { id: folder.id, name: folder.name, color: folder.color } : null,
      categories,
      owner: guild.ownerId !== null && guild.ownerId === this.self?.id,
      members: guild.memberCount,
    };
  }

  /** The app icon's badge, as Discord's mobile app counts it: DM messages and mentions unread. */
  badge(): number {
    let count = 0;
    for (const channel of this.channels.values()) {
      if (!this.isChat(channel)) continue;
      if (!channel.guildId) {
        if (!this.channelMuted(channel) && this.isUnread(channel)) count += Math.max(1, this.read(channel.id).mentions);
      } else {
        count += this.read(channel.id).mentions;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Live messages

  /**
   * MESSAGE_CREATE: updates the channel's state and says whether it
   * notifies. Null for a channel that is not a chat.
   */
  arrive(raw: any, viewing: boolean): { channel: Channel; mentioned: boolean; notify: boolean } | null {
    const channel = typeof raw?.channel_id === "string" ? this.channels.get(raw.channel_id) : null;
    if (!channel || typeof raw.id !== "string") return null;
    if (newer(raw.id, channel.lastMessageId)) channel.lastMessageId = raw.id;
    if (!this.isChat(channel)) return null;
    const mine = raw.author?.id !== undefined && raw.author.id === this.self?.id;
    if (mine) {
      // Discord marks the user's own messages read.
      this.ack(channel.id, raw.id, 0);
      return { channel, mentioned: false, notify: false };
    }
    const mentioned = this.mentionsMe(raw, channel);
    const state = this.read(channel.id);
    if (!channel.guildId) state.mentions += 1;
    else if (mentioned) state.mentions += 1;
    const system = typeof raw.type === "number" && raw.type !== 0 && raw.type !== 19 && raw.type !== 20 && raw.type !== 23;
    let notify = false;
    if (!viewing && !system && !this.muted(channel)) {
      if (!channel.guildId) notify = true;
      else {
        const level = this.notificationLevel(channel);
        notify = level === ALL_MESSAGES || (level === ONLY_MENTIONS && mentioned);
      }
    }
    return { channel, mentioned, notify };
  }

  /** Remember a member's name and roles (GUILD_MEMBERS_CHUNK, a message's `member`). */
  putMember(guildId: string, userId: string, raw: any): Member | null {
    const guild = this.guilds.get(guildId);
    if (!guild || !raw) return null;
    const member: Member = {
      nick: typeof raw.nick === "string" && raw.nick.trim() ? raw.nick : null,
      roles: Array.isArray(raw.roles) ? raw.roles.filter((role: unknown) => typeof role === "string") : [],
      avatar: typeof raw.avatar === "string" ? raw.avatar : null,
    };
    guild.members.delete(userId);
    guild.members.set(userId, member);
    // Bounded: the oldest met go first.
    while (guild.members.size > 2000) guild.members.delete(guild.members.keys().next().value!);
    if (userId === this.self?.id) guild.myRoles = member.roles;
    return member;
  }

  /** A member's role colour (the highest coloured role), or null. */
  roleColor(guildId: string, roles: readonly string[]): number | null {
    const guild = this.guilds.get(guildId);
    if (!guild) return null;
    let best: Role | null = null;
    for (const id of roles) {
      const role = guild.roles.get(id);
      if (role && role.color !== 0 && (!best || role.position > best.position)) best = role;
    }
    return best?.color ?? null;
  }

  roleInfo(guildId: string, roleId: string): { name: string; color: number | null } | null {
    const role = this.guilds.get(guildId)?.roles.get(roleId);
    return role ? { name: role.name, color: role.color || null } : null;
  }
}
