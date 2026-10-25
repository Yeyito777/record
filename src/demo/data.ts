/**
 * Deterministic synthetic Discord world for demo mode. Everything is derived
 * from fixed seeds so screenshots of the same view stay comparable.
 *
 * Objects are kept in Discord's REST/gateway response shapes so the real
 * mapping code in discord.ts/appgateway.ts runs unchanged on them.
 */

import type {
  DiscordAttachmentResponse,
  DiscordChannelResponse,
  DiscordEmbedResponse,
  DiscordMessageAuthorResponse,
  DiscordMessageReactionResponse,
  DiscordMessageResponse,
} from "../discord";
import { DEMO_TOKEN } from "./env";
import { hexColor, type Rgb } from "./png";

export { DEMO_TOKEN };
export const DISCORD_EPOCH = 1420070400000n;
/** History ends here unless RECORD_DEMO_NOW overrides it (fixed for comparable screenshots). */
export const DEFAULT_DEMO_ANCHOR_MS = Date.UTC(2026, 9, 24, 21, 0, 0);

export function snowflake(ms: number, sequence = 0): string {
  return (((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n) | BigInt(sequence & 0x3fffff)).toString();
}

export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export type Rng = () => number;

export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function hexHash(seed: string): string {
  const rng = seededRng(hashString(seed));
  let out = "";
  for (let i = 0; i < 32; i += 1) out += Math.floor(rng() * 16).toString(16);
  return out;
}

// ---------------------------------------------------------------------------
// Users, roles, emoji

export type DemoPresence = "online" | "idle" | "dnd" | "offline";

export interface DemoUser {
  id: string;
  username: string;
  globalName: string;
  avatar: string | null;
  color: Rgb;
  initials: string;
  bot: boolean;
  status: DemoPresence;
}

export interface DemoRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  hoist: boolean;
}

export interface DemoEmoji {
  id: string;
  name: string;
  animated: boolean;
  color: Rgb;
}

export interface DemoGuild {
  id: string;
  name: string;
  initials: string;
  icon: string | null;
  color: Rgb;
  ownerId: string;
  roles: DemoRole[];
  emojis: DemoEmoji[];
  channels: DiscordChannelResponse[];
  threads: DiscordChannelResponse[];
  memberIds: string[];
  memberRoles: Record<string, string[]>;
  muted: boolean;
  voiceStates: Array<{ channelId: string; userId: string; selfMute: boolean; selfDeaf: boolean }>;
}

export type HistoryStyle = "chat" | "images" | "code" | "long" | "emoji" | "announce" | "dm";

export interface HistorySpec {
  channelId: string;
  guildId: string | null;
  count: number;
  style: HistoryStyle;
  lastMs: number;
  /** Authors that speak here (DM recipients + self, or guild members). */
  authorIds: string[];
}

// Permission bits Record's visibility checks look at.
const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  ADMINISTRATOR: 1n << 3n,
};
const EVERYONE_PERMISSIONS = Object.entries(P)
  .filter(([name]) => name !== "ADMINISTRATOR" && name !== "MENTION_EVERYONE")
  .reduce((bits, [, bit]) => bits | bit, 0n)
  .toString();
const ADMIN_PERMISSIONS = (BigInt(EVERYONE_PERMISSIONS) | P.ADMINISTRATOR | P.MENTION_EVERYONE).toString();

const PEOPLE: Array<[string, string]> = [
  ["mira", "Mira Okafor"], ["juno", "Juno Park"], ["tobias", "Tobias Lindqvist"], ["amara", "Amara Silva"],
  ["kenji", "Kenji Watanabe"], ["noor", "Noor Haddad"], ["felix", "Felix Brandt"], ["ines", "Inês Duarte"],
  ["oskar", "Oskar Nowak"], ["priya", "Priya Raman"], ["leo", "Leo Marchetti"], ["sasha", "Sasha Volkova"],
  ["dmitri", "Dmitri K."], ["hana", "Hana Kobayashi"], ["rafael", "Rafael Ortega"], ["zoe", "Zoë Fischer"],
  ["omar", "Omar Farouk"], ["elin", "Elin Berg"], ["thabo", "Thabo Nkosi"], ["chloe", "Chloé Martin"],
  ["arjun", "Arjun Mehta"], ["maya", "Maya Cohen"], ["bram", "Bram de Vries"], ["lucia", "Lucía Romero"],
  ["kai", "Kai Nakamura"], ["freya", "Freya Holm"], ["yusuf", "Yusuf Demir"], ["ivy", "Ivy Chen"],
  ["mateo", "Mateo García"], ["anya", "Anya Petrova"], ["sven", "Sven Ek"], ["leila", "Leila Amini"],
  ["nils", "Nils Ahlgren"], ["rosa", "Rosa Bianchi"], ["eitan", "Eitan Levi"], ["wren", "Wren Abbott"],
  ["quinn", "Quinn Murphy"], ["tariq", "Tariq Aziz"], ["vera", "Vera Novak"], ["hugo", "Hugo Lefèvre"],
  ["a_very_long_username_for_wrapping", "Bartholomew Maximilian Fitzgerald-Wolfenstein III"],
  ["xx", "x"],
];

const BOTS: Array<[string, string]> = [["recordbot", "Record Bot"], ["ci", "CI Pipeline"], ["rss", "RSS Feed"]];

const PALETTE = [
  0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0xf47b67, 0x3ba55c, 0x00a8fc,
  0x9b59b6, 0xe67e22, 0x1abc9c, 0xe91e63, 0x2ecc71, 0x34495e, 0xf1c40f, 0x7289da,
];

function initialsOf(name: string, max = 2): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, max).toUpperCase();
  return words.slice(0, max).map((word) => word[0]!.toUpperCase()).join("");
}

const GUILD_SPECS: Array<{ name: string; icon: boolean; color: number; size: "big" | "medium" | "small"; muted?: boolean }> = [
  { name: "Record Lounge", icon: true, color: 0x5865f2, size: "big" },
  { name: "Terminal Dwellers", icon: true, color: 0x2ecc71, size: "medium" },
  { name: "Rustaceans Anonymous", icon: true, color: 0xe67e22, size: "medium" },
  { name: "Lofi Study Hall", icon: true, color: 0x9b59b6, size: "small" },
  { name: "Pixel Garden", icon: true, color: 0x57f287, size: "small" },
  { name: "Night Owls", icon: false, color: 0x34495e, size: "small" },
  { name: "Kernel Panic", icon: true, color: 0xed4245, size: "medium" },
  { name: "Bun & Friends", icon: true, color: 0xfee75c, size: "small" },
  { name: "Mechanical Keebs", icon: true, color: 0x00a8fc, size: "small" },
  { name: "Open Source Café", icon: false, color: 0x1abc9c, size: "small" },
  { name: "Synthwave FM", icon: true, color: 0xeb459e, size: "small" },
  { name: "Board Game Night", icon: true, color: 0xf47b67, size: "small", muted: true },
  { name: "Climbing Crew", icon: false, color: 0x3ba55c, size: "small" },
  { name: "Polyglot Club", icon: true, color: 0x7289da, size: "small" },
  { name: "Speedrun Lab", icon: true, color: 0xf1c40f, size: "small" },
];

const EMOJI_NAMES = ["blobwave", "pepehands", "kekw", "catjam", "partyparrot", "thonk", "pog", "sadge", "yes", "no", "100", "ship_it", "rust", "bun", "vim", "ferris"];

// ---------------------------------------------------------------------------
// World

export interface DemoWorld {
  anchorMs: number;
  self: DemoUser;
  users: Map<string, DemoUser>;
  guilds: DemoGuild[];
  directMessages: DiscordChannelResponse[];
  histories: Map<string, HistorySpec>;
  /** Channels whose messages mention the user, for READY read states. */
  mentionCounts: Map<string, number>;
  /** DM channels to show as unread. */
  unreadDirectMessages: Set<string>;
  emojisById: Map<string, DemoEmoji>;
  /** The channel the demo opens first. */
  defaultChannel: { guildId: string; channelId: string };
}

/**
 * The demo account's server folders (accounts/<id>/server-folders.json): a
 * top-level folder that starts expanded and holds a nested folder two levels
 * deep, plus a collapsed one, so the tree view and its badges can be seen.
 */
export function demoServerFolderLayout(world: Pick<DemoWorld, "guilds">) {
  const id = (name: string): string => {
    const guild = world.guilds.find((candidate) => candidate.name === name);
    if (!guild) throw new Error(`demo guild ${name} is missing`);
    return guild.id;
  };
  const folders = [
    { id: "demo-folder-dev", name: "Dev", parentId: null, pinned: false, sortOrder: 1 },
    { id: "demo-folder-tools", name: "Tools", parentId: "demo-folder-dev", pinned: false, sortOrder: 2 },
    { id: "demo-folder-archive", name: "Archive", parentId: "demo-folder-tools", pinned: false, sortOrder: 3 },
    { id: "demo-folder-chill", name: "Chill", parentId: null, pinned: false, sortOrder: 3 },
  ];
  const placements: Array<[string, string | null, number]> = [
    ["Record Lounge", null, 0],
    ["Pixel Garden", null, 2],
    ["Board Game Night", null, 4],
    ["Climbing Crew", null, 5],
    ["Polyglot Club", null, 6],
    ["Terminal Dwellers", "demo-folder-dev", 0],
    ["Rustaceans Anonymous", "demo-folder-dev", 1],
    ["Kernel Panic", "demo-folder-tools", 0],
    ["Bun & Friends", "demo-folder-tools", 1],
    ["Mechanical Keebs", "demo-folder-tools", 2],
    ["Open Source Café", "demo-folder-archive", 0],
    ["Speedrun Lab", "demo-folder-archive", 1],
    ["Lofi Study Hall", "demo-folder-chill", 0],
    ["Synthwave FM", "demo-folder-chill", 1],
    ["Night Owls", "demo-folder-chill", 2],
  ];
  return {
    folders,
    guildPlacements: Object.fromEntries(placements.map(([name, folderId, sortOrder]) => [id(name), { folderId, pinned: false, sortOrder }])),
    expandedFolderIds: ["demo-folder-dev"],
  };
}

export function buildDemoWorld(anchorMs = DEFAULT_DEMO_ANCHOR_MS): DemoWorld {
  const base = Date.UTC(2021, 0, 1);
  let entitySeq = 0;
  const entityId = (): string => snowflake(base + (entitySeq += 1) * 60_000);

  const self: DemoUser = {
    id: entityId(), username: "demo", globalName: "Demo User", avatar: hexHash("self"),
    color: hexColor(0x5865f2), initials: "DU", bot: false, status: "online",
  };
  const users = new Map<string, DemoUser>([[self.id, self]]);
  const people: DemoUser[] = PEOPLE.map(([username, globalName], index) => {
    const statusRoll = index % 7;
    return {
      id: entityId(),
      username,
      globalName,
      // Every sixth user keeps Discord's default avatar.
      avatar: index % 6 === 5 ? null : hexHash(`avatar:${username}`),
      color: hexColor(PALETTE[index % PALETTE.length]!),
      initials: initialsOf(globalName),
      bot: false,
      status: statusRoll < 3 ? "online" : statusRoll === 3 ? "idle" : statusRoll === 4 ? "dnd" : "offline",
    };
  });
  const bots: DemoUser[] = BOTS.map(([username, globalName], index) => ({
    id: entityId(), username, globalName, avatar: hexHash(`bot:${username}`),
    color: hexColor(PALETTE[(index * 5 + 3) % PALETTE.length]!), initials: initialsOf(globalName), bot: true, status: "online",
  }));
  for (const user of [...people, ...bots]) users.set(user.id, user);

  const histories = new Map<string, HistorySpec>();
  const mentionCounts = new Map<string, number>();
  const emojisById = new Map<string, DemoEmoji>();
  const unreadDirectMessages = new Set<string>();

  const guilds: DemoGuild[] = GUILD_SPECS.map((spec, guildIndex) => {
    const rng = seededRng(hashString(`guild:${spec.name}`));
    const id = entityId();
    const memberCount = spec.size === "big" ? people.length : spec.size === "medium" ? 24 : int(rng, 6, 16);
    const members = [self, ...people.slice(guildIndex % 5, guildIndex % 5 + memberCount), ...bots.slice(0, spec.size === "small" ? 1 : 3)];
    const roles: DemoRole[] = [
      { id, name: "@everyone", color: 0, position: 0, permissions: EVERYONE_PERMISSIONS, hoist: false },
      { id: entityId(), name: "Admin", color: 0xed4245, position: 4, permissions: ADMIN_PERMISSIONS, hoist: true },
      { id: entityId(), name: "Moderator", color: 0x57f287, position: 3, permissions: EVERYONE_PERMISSIONS, hoist: true },
      { id: entityId(), name: "Regular", color: 0x00a8fc, position: 2, permissions: EVERYONE_PERMISSIONS, hoist: false },
      { id: entityId(), name: "Bots", color: 0x9b59b6, position: 1, permissions: EVERYONE_PERMISSIONS, hoist: true },
    ];
    const memberRoles: Record<string, string[]> = {};
    members.forEach((member, index) => {
      if (member.bot) memberRoles[member.id] = [roles[4]!.id];
      else if (index === 1) memberRoles[member.id] = [roles[1]!.id];
      else if (index % 9 === 2) memberRoles[member.id] = [roles[2]!.id, roles[3]!.id];
      else if (index % 3 === 0) memberRoles[member.id] = [roles[3]!.id];
      else memberRoles[member.id] = [];
    });
    memberRoles[self.id] = spec.size === "big" ? [roles[1]!.id] : [roles[3]!.id];

    const emojiCount = guildIndex === 0 ? 10 : guildIndex % 3 === 0 ? 4 : 0;
    const emojis: DemoEmoji[] = Array.from({ length: emojiCount }, (_, index) => {
      const emoji: DemoEmoji = {
        id: entityId(),
        name: EMOJI_NAMES[(index + guildIndex * 3) % EMOJI_NAMES.length]!,
        animated: index === 3,
        color: hexColor(PALETTE[(index * 3 + guildIndex) % PALETTE.length]!),
      };
      emojisById.set(emoji.id, emoji);
      return emoji;
    });

    const guild: DemoGuild = {
      id,
      name: spec.name,
      initials: initialsOf(spec.name, 3),
      icon: spec.icon ? hexHash(`icon:${spec.name}`) : null,
      color: hexColor(spec.color),
      ownerId: guildIndex === 0 ? self.id : members[1]!.id,
      roles,
      emojis,
      channels: [],
      threads: [],
      memberIds: members.map((member) => member.id),
      memberRoles,
      muted: Boolean(spec.muted),
      voiceStates: [],
    };

    const authorIds = members.map((member) => member.id);
    let position = 0;
    const category = (name: string): DiscordChannelResponse => {
      const channel: DiscordChannelResponse = { id: entityId(), guild_id: id, parent_id: null, name, type: 4, position: position += 1 };
      guild.channels.push(channel);
      return channel;
    };
    const text = (
      parent: DiscordChannelResponse | null,
      name: string,
      count: number,
      style: HistoryStyle,
      options: { type?: number; topic?: string; recentMinutes?: number; overwrites?: DiscordChannelResponse["permission_overwrites"] } = {},
    ): DiscordChannelResponse => {
      const channelId = entityId();
      const lastMs = anchorMs - Math.round((options.recentMinutes ?? int(rng, 5, 60 * 36)) * 60_000) - int(rng, 0, 59_000);
      const channel: DiscordChannelResponse = {
        id: channelId,
        guild_id: id,
        parent_id: parent?.id ?? null,
        name,
        type: options.type ?? 0,
        position: position += 1,
        topic: options.topic ?? null,
        last_message_id: count > 0 ? snowflake(lastMs) : null,
        permission_overwrites: options.overwrites ?? [],
      };
      guild.channels.push(channel);
      if (count > 0) histories.set(channelId, { channelId, guildId: id, count, style, lastMs, authorIds });
      return channel;
    };
    const voice = (parent: DiscordChannelResponse, name: string): DiscordChannelResponse => {
      const channel: DiscordChannelResponse = { id: entityId(), guild_id: id, parent_id: parent.id, name, type: 2, position: position += 1 };
      guild.channels.push(channel);
      return channel;
    };
    const thread = (
      parent: DiscordChannelResponse,
      name: string,
      count: number,
      joined: boolean,
      style: HistoryStyle = "chat",
    ): DiscordChannelResponse => {
      const channelId = entityId();
      const lastMs = anchorMs - int(rng, 10, 600) * 60_000;
      const created = new Date(lastMs - 3 * 86_400_000).toISOString();
      const channel: DiscordChannelResponse = {
        id: channelId,
        guild_id: id,
        parent_id: parent.id,
        name,
        type: 11,
        position: 0,
        owner_id: members[2]!.id,
        last_message_id: snowflake(lastMs),
        message_count: count,
        member_count: Math.min(12, members.length),
        total_message_sent: count,
        thread_metadata: { archived: false, locked: false, auto_archive_duration: 4320, archive_timestamp: created, create_timestamp: created },
        ...(joined ? { member: { join_timestamp: created, flags: 1, muted: false } } : {}),
      };
      guild.threads.push(channel);
      histories.set(channelId, { channelId, guildId: id, count, style, lastMs, authorIds });
      return channel;
    };

    if (spec.size === "big") {
      const info = category("Information");
      text(info, "announcements", 24, "announce", { type: 5, topic: "Release notes and news" });
      text(info, "rules", 6, "long", { topic: "Be kind. No spoilers outside #spoilers." });
      const chat = category("Text Channels");
      const general = text(chat, "general", 2400, "chat", { recentMinutes: 3, topic: "The long one: 2,400 messages to scroll through" });
      const images = text(chat, "images", 220, "images", { recentMinutes: 40, topic: "Inline images of many sizes" });
      text(chat, "code-review", 160, "code", { topic: "Code blocks and markdown" });
      text(chat, "long-lines", 90, "long", { topic: "Wrapped paragraphs" });
      text(chat, "emoji-reactions", 140, "emoji", { topic: "Custom emoji and reactions" });
      text(chat, "quiet", 3, "chat", { topic: "Barely used" });
      text(chat, "empty", 0, "chat", { topic: "No messages at all" });
      text(chat, "staff-only", 12, "chat", {
        topic: "Hidden from @everyone",
        overwrites: [{ id, type: 0, allow: "0", deny: P.VIEW_CHANNEL.toString() }],
      });
      const forum = text(chat, "help-forum", 0, "chat", { type: 15, topic: "Forum channel with posts" });
      thread(general, "scrolling feedback", 80, true);
      thread(general, "bug triage", 30, false, "code");
      thread(forum, "How do I enable images?", 12, true);
      thread(forum, "Sidebar icons look blurry", 7, false);
      const voiceCategory = category("Voice Channels");
      const lounge = voice(voiceCategory, "Lounge");
      voice(voiceCategory, "Gaming");
      voice(voiceCategory, "AFK");
      for (const member of members.slice(3, 6)) {
        guild.voiceStates.push({ channelId: lounge.id!, userId: member.id, selfMute: member === members[4], selfDeaf: false });
      }
      mentionCounts.set(images.id, 2);
    } else {
      const chat = category("Text Channels");
      const general = text(chat, "general", spec.size === "medium" ? (guildIndex === 1 ? 600 : 320) : int(rng, 20, 160), "chat");
      text(chat, pick(rng, ["random", "off-topic", "memes", "lounge"]), int(rng, 8, 120), pick(rng, ["chat", "emoji", "images"] as const));
      if (spec.size !== "small" || rng() > 0.4) text(chat, pick(rng, ["showcase", "links", "media", "screenshots"]), int(rng, 10, 90), "images");
      if (spec.size === "medium") {
        text(chat, "help", int(rng, 40, 200), "code");
        text(chat, "long-reads", int(rng, 15, 50), "long");
        thread(general, "weekly thread", int(rng, 20, 60), true);
      }
      const voiceCategory = category("Voice Channels");
      const room = voice(voiceCategory, spec.name === "Synthwave FM" ? "Listening Party" : "General");
      if (spec.name === "Synthwave FM") {
        for (const member of members.slice(1, 3)) guild.voiceStates.push({ channelId: room.id!, userId: member.id, selfMute: false, selfDeaf: member === members[2] });
      }
      if (guildIndex === 1) mentionCounts.set(general.id, 5);
      if (spec.name === "Kernel Panic") mentionCounts.set(guild.channels.find((channel) => channel.type === 0 && channel !== general)?.id ?? general.id, 1);
    }
    return guild;
  });

  // Direct messages and group DMs.
  const dmPartners = [people[0]!, people[1]!, people[2]!, people[3]!, people[5]!, people[8]!, people[13]!, people[40]!, bots[0]!];
  const directMessages: DiscordChannelResponse[] = [];
  dmPartners.forEach((partner, index) => {
    const id = entityId();
    const count = index === 0 ? 1500 : index === 1 ? 260 : index === 8 ? 12 : 20 + index * 13;
    const lastMs = anchorMs - (index === 0 ? 2 : index * 97 + 30) * 60_000;
    directMessages.push({
      id, type: 1, parent_id: null, last_message_id: snowflake(lastMs),
      recipients: [{ id: partner.id, username: partner.username, global_name: partner.globalName, avatar: partner.avatar }],
    });
    histories.set(id, { channelId: id, guildId: null, count, style: index === 2 ? "images" : "dm", lastMs, authorIds: [self.id, partner.id] });
    if (index === 1 || index === 4) unreadDirectMessages.add(id);
  });
  const groups: Array<{ name: string | null; members: DemoUser[]; count: number }> = [
    { name: "weekend plans", members: [people[0]!, people[4]!, people[6]!, people[9]!], count: 300 },
    { name: null, members: [people[1]!, people[2]!], count: 45 },
    { name: null, members: [people[10]!, people[11]!, people[12]!, people[14]!, people[15]!], count: 18 },
  ];
  groups.forEach((group, index) => {
    const id = entityId();
    const lastMs = anchorMs - (index * 211 + 15) * 60_000;
    directMessages.push({
      id, type: 3, parent_id: null, name: group.name, last_message_id: snowflake(lastMs), owner_id: group.members[0]!.id,
      recipients: group.members.map((member) => ({ id: member.id, username: member.username, global_name: member.globalName, avatar: member.avatar })),
    });
    histories.set(id, { channelId: id, guildId: null, count: group.count, style: "dm", lastMs, authorIds: [self.id, ...group.members.map((member) => member.id)] });
    if (index === 0) unreadDirectMessages.add(id);
  });

  const lounge = guilds[0]!;
  const general = lounge.channels.find((channel) => channel.name === "general")!;
  return {
    anchorMs, self, users, guilds, directMessages, histories, mentionCounts, unreadDirectMessages, emojisById,
    defaultChannel: { guildId: lounge.id, channelId: general.id },
  };
}

// ---------------------------------------------------------------------------
// Message histories

export interface ImageVariant {
  key: string;
  width: number;
  height: number;
  from: Rgb;
  to: Rgb;
  seed: number;
}

/** Shared picture shapes: wide, banner, tall, square, tiny, phone, extreme. */
const IMAGE_SHAPES: Array<[number, number, string]> = [
  [1600, 900, "screenshot"], [1200, 300, "banner"], [300, 900, "tall"], [800, 800, "square"],
  [64, 64, "tiny"], [640, 480, "photo"], [1080, 1920, "phone"], [400, 250, "thumb"],
  [2000, 200, "panorama"], [128, 512, "strip"],
];
const IMAGE_PALETTES: Array<[number, number]> = [[0x0f2027, 0x2c5364], [0xff512f, 0xdd2476], [0x11998e, 0x38ef7d], [0x8e2de2, 0x4a00e0]];

export function imageVariant(index: number): ImageVariant {
  const shape = IMAGE_SHAPES[index % IMAGE_SHAPES.length]!;
  const palette = IMAGE_PALETTES[Math.floor(index / IMAGE_SHAPES.length) % IMAGE_PALETTES.length]!;
  return {
    key: `${shape[2]}-${index}`,
    width: shape[0],
    height: shape[1],
    from: hexColor(palette[0]),
    to: hexColor(palette[1]),
    seed: index * 7919 + 13,
  };
}
export const IMAGE_VARIANT_COUNT = IMAGE_SHAPES.length * IMAGE_PALETTES.length;
export const IMAGE_SHAPE_NAMES = IMAGE_SHAPES.map(([, , name]) => name);

const SHORT_LINES = [
  "morning all", "anyone around?", "lol", "that's wild", "ok that worked", "brb coffee", "same here",
  "can confirm", "ship it", "wait what", "nice!", "hmm", "yeah I saw that", "gn everyone", "ty!",
  "did the build pass?", "pushed a fix", "looks good to me", "trying it now", "it scrolls so smoothly now",
  "the sidebar icons are a nice touch", "which terminal are you on?", "st with the patches", "kitty here",
  "did you try turning it off and on again", "on it", "I'll take a look after lunch", "+1",
  "this is the way", "honestly underrated", "weird, works on my machine", "nope", "ah I see",
  "fair point", "classic", "send screenshot?", "back", "almost there", "omg finally", "😂",
];

const WORDS = ("the quick terminal renders every frame without flicker while the scroll region moves rows up and "
  + "down so only exposed lines are painted again we measured latency across several machines and found that "
  + "batching writes keeps the cursor stable even when images and emoji share a row with wide characters and "
  + "long words like internationalization or supercalifragilisticexpialidocious force awkward wrapping decisions").split(" ");

const CODE_SNIPPETS = [
  "```ts\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}\n```",
  "```rust\nfn main() {\n    let lines: Vec<&str> = include_str!(\"log.txt\").lines().collect();\n    println!(\"{} lines\", lines.len());\n}\n```",
  "```py\nfor i, row in enumerate(rows):\n    if row.startswith(\"#\"):\n        continue\n    print(f\"{i:>4}: {row}\")\n```",
  "```sh\n$ bun test --timeout 5000\n  412 pass\n  0 fail\nRan 412 tests across 61 files. [3.21s]\n```",
  "```diff\n- const offset = rows * cellHeight;\n+ const offset = Math.round(rows * cellHeight);\n```",
  "```json\n{\n  \"images\": { \"mode\": \"show\" },\n  \"scrollRegions\": true\n}\n```",
  "```\nplain code block without a language, with a very long line that will definitely need horizontal handling or wrapping in a narrow terminal window\n```",
];

const MARKDOWN_SAMPLES = [
  "**bold**, *italic*, __underline__, ~~strike~~ and `inline code` in one line",
  "> quoting the docs here\n> second quoted line\nand my reply under it",
  "checklist:\n- scroll to the top\n- load older pages\n- jump back to the bottom\n  - nested item",
  "||spoiler: the cake is a lie|| — don't open that",
  "# Big heading\n## Smaller heading\nsome body text after headings",
  "1. first\n2. second\n3. third with `code`",
  "a line with a link https://example.com/docs/terminal-graphics?section=kitty#placement and more text",
];

const LINKS: Array<{ url: string; embed: DiscordEmbedResponse }> = [
  { url: "https://github.com/example/record", embed: { type: "link", title: "example/record: a terminal chat client", url: "https://github.com/example/record", description: "Discord, WhatsApp and Instagram in your terminal.", provider: { name: "GitHub" } } },
  { url: "https://en.wikipedia.org/wiki/Terminal_emulator", embed: { type: "article", title: "Terminal emulator - Wikipedia", url: "https://en.wikipedia.org/wiki/Terminal_emulator", description: "A terminal emulator is a computer program that emulates a video terminal within some other display architecture.", provider: { name: "Wikipedia" } } },
  { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", embed: { type: "video", title: "Smooth scrolling explained in 4 minutes", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", provider: { name: "YouTube" }, author: { name: "Demo Channel" } } },
  { url: "https://news.example.org/2026/10/terminals", embed: { type: "rich", title: "Why terminals are having a moment", description: "Long-form article preview text that goes on for a while to test how embeds wrap inside the message pane.", provider: { name: "Example News" } } },
];

const UNICODE_EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "🔥", "✅", "🙏", "😭", "🚀"];

function longParagraph(rng: Rng): string {
  const length = int(rng, 40, 140);
  const words: string[] = [];
  for (let i = 0; i < length; i += 1) words.push(pick(rng, WORDS));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

function authorResponse(user: DemoUser): DiscordMessageAuthorResponse {
  return { id: user.id, username: user.username, global_name: user.globalName, avatar: user.avatar, ...(user.bot ? { bot: true } : {}) };
}

export interface HistoryContext {
  world: DemoWorld;
  guild: DemoGuild | null;
  /** Image attachment id -> variant index, filled as histories are built. */
  registerImage: (attachmentId: string, variantIndex: number) => number;
}

export function buildMessageAuthor(world: DemoWorld, guild: DemoGuild | null, userId: string): Pick<DiscordMessageResponse, "author" | "member"> {
  const user = world.users.get(userId) ?? world.self;
  return {
    author: authorResponse(user),
    ...(guild ? { member: { nick: null, roles: guild.memberRoles[user.id] ?? [] } } : {}),
  };
}

/** Build one channel's whole history, oldest first. */
export function buildHistory(spec: HistorySpec, context: HistoryContext): DiscordMessageResponse[] {
  const { world, guild } = context;
  const rng = seededRng(hashString(`history:${spec.channelId}`));
  // Timestamps walk backwards from lastMs so the newest id equals the channel's last_message_id.
  const times: number[] = new Array(spec.count);
  let t = spec.lastMs;
  for (let i = spec.count - 1; i >= 0; i -= 1) {
    times[i] = t;
    const roll = rng();
    const gapSeconds = roll < 0.7 ? int(rng, 20, 240) : roll < 0.95 ? int(rng, 300, 3600) : int(rng, 7200, 72000);
    t -= gapSeconds * 1000 + int(rng, 0, 999);
  }

  const humans = spec.authorIds.filter((id) => !world.users.get(id)?.bot);
  const botIds = spec.authorIds.filter((id) => world.users.get(id)?.bot);
  const emojis = guild?.emojis.length ? guild.emojis : world.guilds[0]!.emojis;
  const out: DiscordMessageResponse[] = [];
  let previousAuthor = humans[0]!;

  for (let i = 0; i < spec.count; i += 1) {
    const id = snowflake(times[i]!);
    let authorId = rng() < 0.45 ? previousAuthor : pick(rng, humans);
    if (spec.style === "announce" && botIds.length > 0 && rng() < 0.6) authorId = pick(rng, botIds);
    if (spec.style === "chat" && botIds.length > 0 && rng() < 0.03) authorId = pick(rng, botIds);
    previousAuthor = authorId;

    const message: DiscordMessageResponse = {
      id,
      channel_id: spec.channelId,
      ...(spec.guildId ? { guild_id: spec.guildId } : {}),
      content: "",
      timestamp: new Date(times[i]!).toISOString(),
      edited_timestamp: null,
      type: 0,
      mention_everyone: false,
      mention_roles: [],
      mentions: [],
      attachments: [],
      embeds: [],
      ...buildMessageAuthor(world, guild, authorId),
    };

    // Occasional member-join system message in servers.
    if (guild && rng() < 0.01) {
      message.type = 7;
      out.push(message);
      continue;
    }

    const roll = rng();
    const style = spec.style;
    const imageChance = style === "images" ? 0.45 : style === "dm" ? 0.05 : 0.04;
    const codeChance = style === "code" ? 0.4 : 0.04;
    const longChance = style === "long" ? 0.5 : 0.06;
    const emojiChance = style === "emoji" ? 0.5 : 0.08;
    let cursor = 0;
    const within = (chance: number): boolean => {
      cursor += chance;
      return roll < cursor;
    };

    if (within(imageChance)) {
      const images = rng() < 0.2 ? int(rng, 2, 4) : 1;
      for (let n = 0; n < images; n += 1) {
        const attachmentId = snowflake(times[i]!, n + 1);
        const variant = int(rng, 0, IMAGE_VARIANT_COUNT - 1);
        const shape = imageVariant(variant);
        const size = context.registerImage(attachmentId, variant);
        const filename = `${shape.key}.png`;
        message.attachments!.push(imageAttachment(spec.channelId, attachmentId, filename, shape.width, shape.height, size));
      }
      if (rng() < 0.5) message.content = pick(rng, ["look at this", "screenshot from earlier", "new wallpaper", "before / after", "", "📸"]);
    } else if (within(codeChance)) {
      message.content = rng() < 0.5 ? pick(rng, CODE_SNIPPETS) : `${pick(rng, ["try this:", "here's the patch", "minimal repro:"])}\n${pick(rng, CODE_SNIPPETS)}`;
    } else if (within(longChance)) {
      message.content = rng() < 0.3 ? `${longParagraph(rng)}\n\n${longParagraph(rng)}` : longParagraph(rng);
    } else if (within(emojiChance)) {
      const emoji = pick(rng, emojis);
      const custom = `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
      message.content = pick(rng, [custom, `${custom} ${custom} ${custom}`, `that's so ${custom}`, `${pick(rng, UNICODE_EMOJI)} ${custom}`]);
    } else if (within(0.06)) {
      message.content = pick(rng, MARKDOWN_SAMPLES);
    } else if (within(0.04)) {
      const link = pick(rng, LINKS);
      message.content = rng() < 0.5 ? link.url : `worth a read ${link.url}`;
      message.embeds = [link.embed];
    } else if (within(0.03) && guild) {
      const target = world.users.get(pick(rng, humans))!;
      message.content = `<@${target.id}> ${pick(rng, SHORT_LINES)}`;
      message.mentions = [authorResponse(target)];
    } else if (within(0.01) && guild) {
      const channel = pick(rng, guild.channels.filter((candidate) => candidate.type === 0));
      message.content = `see <#${channel.id}> for that`;
    } else if (within(0.01)) {
      message.content = "";
      message.attachments!.push({
        id: snowflake(times[i]!, 9),
        filename: pick(rng, ["notes.pdf", "build-log.txt", "archive.zip", "song.mp3"]),
        content_type: null,
        size: int(rng, 2_000, 9_000_000),
        url: `https://cdn.discordapp.com/attachments/${spec.channelId}/${snowflake(times[i]!, 9)}/file.bin`,
      });
    } else if (within(0.005)) {
      message.sticker_items = [{ id: snowflake(times[i]!, 8), name: "wave", format_type: 1 }];
    } else {
      message.content = rng() < 0.08 ? `${pick(rng, SHORT_LINES)}\n${pick(rng, SHORT_LINES)}` : pick(rng, SHORT_LINES);
      if (rng() < 0.05) message.content += ` ${pick(rng, UNICODE_EMOJI)}`;
    }

    if (out.length > 3 && rng() < 0.08) {
      const target = out[out.length - 1 - int(rng, 0, Math.min(25, out.length - 1))]!;
      if (target.type === 0 || target.type === 19) {
        message.type = 19;
        message.message_reference = { type: 0, message_id: target.id, channel_id: target.channel_id, ...(spec.guildId ? { guild_id: spec.guildId } : {}) };
        message.referenced_message = {
          id: target.id, content: target.content, timestamp: target.timestamp, author: target.author,
          ...(target.member ? { member: target.member } : {}),
          attachments: target.attachments, embeds: target.embeds, mentions: target.mentions,
        };
      }
    }

    const reactionChance = style === "emoji" ? 0.45 : 0.07;
    if (rng() < reactionChance) {
      const reactions: DiscordMessageReactionResponse[] = [];
      const kinds = int(rng, 1, style === "emoji" ? 5 : 3);
      for (let k = 0; k < kinds; k += 1) {
        const custom = rng() < 0.4;
        const emoji = custom ? pick(rng, emojis) : null;
        const name = emoji ? emoji.name : UNICODE_EMOJI[(k + i) % UNICODE_EMOJI.length]!;
        if (reactions.some((reaction) => reaction.emoji?.name === name)) continue;
        reactions.push({
          count: int(rng, 1, 14),
          me: rng() < 0.3,
          emoji: emoji ? { id: emoji.id, name: emoji.name, animated: emoji.animated } : { id: null, name },
        });
      }
      message.reactions = reactions;
    }
    if (rng() < 0.03) message.edited_timestamp = new Date(times[i]! + int(rng, 10, 600) * 1000).toISOString();
    out.push(message);
  }
  return out;
}

export function imageAttachment(channelId: string, attachmentId: string, filename: string, width: number, height: number, size: number): DiscordAttachmentResponse {
  return {
    id: attachmentId,
    filename,
    content_type: "image/png",
    size,
    url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/${filename}`,
    width,
    height,
  };
}

/** A fresh incoming message for the follow-the-bottom exercises. */
export function buildIncomingContent(rng: Rng, counter: number): { content: string; long: boolean } {
  const roll = rng();
  if (roll < 0.15) return { content: longParagraph(rng), long: true };
  if (roll < 0.25) return { content: pick(rng, CODE_SNIPPETS), long: true };
  return { content: `${pick(rng, SHORT_LINES)} (#${counter})`, long: false };
}
