/**
 * record's Discord messages (src/discord.ts `DiscordMessage`, mapped by its
 * own code from REST and gateway payloads) as the bridge protocol's
 * messages (docs/social-protocol.md §2, §5 Discord). Text stays Discord's
 * markdown (`format: "discord"`); what an app needs to draw its tokens
 * comes in `ext`: the names behind `<@id>`, `<@&id>` and `<#id>`, the
 * custom emoji's pictures, embeds, stickers, the author's role colour.
 */

import type { DiscordMessage, DiscordMessageAttachment, DiscordMessageEmbed, DiscordMessageEmbedMedia } from "../../../discord";
import type { WireMedia, WireMessage } from "../../protocol";
import { type Account, userAvatar } from "./account";
import { emojiMedia, memberAvatarMedia, posterRef, proxiedRef, stickerMedia } from "./refs";

/** Voice messages (Discord's IS_VOICE_MESSAGE message flag). */
const VOICE_MESSAGE_FLAG = 1 << 13;
const NORMAL_TYPES = new Set([0, 19, 20, 23]);

const TOKEN = /<(@!?|@&|#|a?:[A-Za-z0-9_~]{1,64}:)(\d{1,22})>/g;

export interface WireEmbed {
  type: string | null;
  color: number | null;
  title: string | null;
  url: string | null;
  description: string | null;
  provider: string | null;
  author: { name: string; icon: WireMedia | null } | null;
  footer: { text: string; icon: WireMedia | null } | null;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  image: WireMedia | null;
  thumbnail: WireMedia | null;
  video: WireMedia | null;
  timestamp: number | null;
}

function iconMedia(url: string | null | undefined): WireMedia | null {
  if (!url || !/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net|images-ext-[12]\.discordapp\.net)\//.test(url)) return null;
  return { ref: `u:${url}`, kind: "image", w: 64, h: 64 };
}

function embedMedia(media: DiscordMessageEmbedMedia | null | undefined, kind: "image" | "video" | "gif"): WireMedia | null {
  if (!media) return null;
  const source = media.proxyUrl ?? media.url;
  if (!/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net|images-ext-[12]\.discordapp\.net)\//.test(source)) return null;
  if (kind === "video") {
    return {
      ref: `u:${source}`, kind: "video", w: media.width, h: media.height,
      thumb: posterRef(source, media.width, media.height),
      duration_ms: media.durationSecs ? Math.round(media.durationSecs * 1000) : null,
    };
  }
  return { ref: proxiedRef(source, media.width, media.height, null), kind, w: media.width, h: media.height };
}

export function wireEmbed(embed: DiscordMessageEmbed): WireEmbed {
  const gifv = embed.type === "gifv";
  return {
    type: embed.type,
    color: embed.color ?? null,
    title: embed.title,
    url: embed.url,
    description: embed.description,
    provider: embed.providerName,
    author: embed.authorName ? { name: embed.authorName, icon: iconMedia(embed.authorIconUrl) } : null,
    footer: embed.footer ? { text: embed.footer.text, icon: iconMedia(embed.footer.iconUrl) } : null,
    fields: embed.fields ?? [],
    image: embedMedia(embed.image, "image"),
    thumbnail: embedMedia(embed.thumbnail, gifv ? "gif" : "image"),
    video: gifv ? null : embedMedia(embed.video, "video"),
    timestamp: embed.timestamp ?? null,
  };
}

export function attachmentMedia(attachment: DiscordMessageAttachment, voice: boolean): WireMedia {
  const type = attachment.contentType?.toLowerCase().split(";")[0]?.trim() ?? "";
  const source = attachment.proxyUrl ?? attachment.url;
  const base = { name: attachment.filename, size: attachment.size || null, mime: attachment.contentType };
  if (voice || type.startsWith("audio/")) {
    return { ...base, ref: `u:${attachment.url}`, kind: "audio", duration_ms: attachment.durationSecs ? Math.round(attachment.durationSecs * 1000) : null };
  }
  if (type.startsWith("video/")) {
    return { ...base, ref: `u:${attachment.url}`, kind: "video", w: attachment.width, h: attachment.height, thumb: posterRef(source, attachment.width, attachment.height) };
  }
  const image = type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(attachment.filename);
  if (image && attachment.width && attachment.height) {
    const gif = type === "image/gif" || /\.gif$/i.test(attachment.filename);
    return { ...base, ref: proxiedRef(source, attachment.width, attachment.height, attachment.contentType), kind: gif ? "gif" : "image", w: attachment.width, h: attachment.height };
  }
  return { ...base, ref: `u:${attachment.url}`, kind: "file" };
}

function systemText(message: DiscordMessage, author: string): string {
  const other = message.mentionUsers?.[0]?.displayName ?? "someone";
  switch (message.type) {
    case 1: return `${author} added ${other} to the group.`;
    case 2: return other === author || !message.mentionUsers?.length ? `${author} left the group.` : `${author} removed ${other} from the group.`;
    case 3: return `${author} started a call.`;
    case 4: return `${author} changed the channel name: ${message.content}`;
    case 5: return `${author} changed the channel icon.`;
    case 6: return `${author} pinned a message to this channel.`;
    case 7: return `${author} joined the server.`;
    case 8: return `${author} just boosted the server!`;
    case 9: case 10: case 11: return `${author} just boosted the server! It reached a new level.`;
    case 12: return `${author} added ${message.content} to this channel.`;
    case 18: return `${author} started a thread: ${message.content.replace(/^🧵 Started a thread:?\s*/, "") || "a thread"}`;
    case 21: return message.content || "Started this thread.";
    default: return message.content || `${author} did something Discord shows only in its own app.`;
  }
}

export interface WireContext {
  account: Account;
}

/**
 * A message as the apps get it. `raw` (a gateway payload) adds what record's
 * model drops: the author's server nickname and avatar, the message flags.
 */
export function wireMessage(message: DiscordMessage, cx: WireContext, raw?: any): WireMessage {
  const { account } = cx;
  const guildId = message.guildId ?? account.channels.get(message.channelId)?.guildId ?? null;
  const member = guildId ? account.guilds.get(guildId)?.members.get(message.author.id) ?? null : null;
  const user = { id: message.author.id, avatar: message.author.avatar ?? null };
  const name = member?.nick ?? message.author.displayName;
  const avatar = guildId && member?.avatar ? memberAvatarMedia(guildId, user.id, member.avatar) : userAvatar(user);
  const roles = member?.roles ?? message.author.roleIds ?? [];
  const color = guildId ? account.roleColor(guildId, roles) : null;
  const flags = typeof raw?.flags === "number" ? raw.flags : 0;
  const voice = (flags & VOICE_MESSAGE_FLAG) !== 0 || message.attachments.some((attachment) => Boolean(attachment.waveform));
  const system = !NORMAL_TYPES.has(message.type);

  const forwarded = message.forwarded ?? null;
  const attachments = forwarded ? forwarded.attachments : message.attachments;
  const media: WireMedia[] = attachments.map((attachment) => attachmentMedia(attachment, voice));
  const urls: Array<string | null> = attachments.map((attachment) => attachment.url ?? null);
  const stickers: string[] = [];
  for (const sticker of (forwarded?.stickers ?? message.stickers ?? [])) {
    const picture = stickerMedia(sticker.id, sticker.name, sticker.formatType);
    if (picture) {
      media.push(picture);
      urls.push(null);
    } else {
      stickers.push(sticker.name);
    }
  }
  const text = system ? systemText(message, name) : forwarded ? forwarded.content : message.content;

  // The names behind the text's tokens, and the custom emoji's pictures.
  const users: Record<string, string> = {};
  const roleNames: Record<string, { name: string; color: number | null }> = {};
  const channels: Record<string, string> = {};
  const emoji: Record<string, WireMedia> = {};
  for (const mentioned of [...(message.mentionUsers ?? []), ...(forwarded?.mentionUsers ?? []), ...(message.reply?.mentionUsers ?? [])]) {
    const nick = guildId ? account.guilds.get(guildId)?.members.get(mentioned.id)?.nick : null;
    users[mentioned.id] = nick ?? mentioned.displayName;
  }
  const scan = (value: string | null | undefined) => {
    if (!value) return;
    for (const match of value.matchAll(TOKEN)) {
      const [, kind, id] = match as unknown as [string, string, string];
      if (kind === "@&" && guildId) {
        const role = account.roleInfo(guildId, id);
        if (role) roleNames[id] = role;
      } else if (kind === "#") {
        const channel = account.channels.get(id);
        if (channel) channels[id] = account.title(channel);
      } else if (kind.startsWith("@") && !users[id]) {
        const known = account.users.get(id);
        if (known) users[id] = known.name;
      } else if (kind.endsWith(":")) {
        emoji[id] = emojiMedia(id, kind.startsWith("a"));
      }
    }
  };
  scan(text);
  const embeds = (forwarded?.embeds ?? message.embeds ?? []).map(wireEmbed);
  for (const embed of embeds) {
    scan(embed.description);
    scan(embed.title);
    for (const field of embed.fields) scan(field.value);
  }
  const reactions = (message.reactions ?? []).map((reaction) => {
    const token = reaction.emoji.id ? `<${reaction.emoji.animated ? "a" : ""}:${reaction.emoji.name || "emoji"}:${reaction.emoji.id}>` : reaction.emoji.name;
    if (reaction.emoji.id) emoji[reaction.emoji.id] = emojiMedia(reaction.emoji.id, reaction.emoji.animated);
    return { emoji: token, count: reaction.count, mine: reaction.me };
  });

  const selfId = account.self?.id ?? null;
  const myRoles = guildId ? new Set(account.guilds.get(guildId)?.myRoles ?? []) : new Set<string>();
  const mentioned = selfId !== null && message.author.id !== selfId && (
    message.mentionUserIds.includes(selfId)
    || (guildId !== null && message.mentionEveryone)
    || message.mentionRoleIds.some((role) => myRoles.has(role))
  );

  const ext: Record<string, unknown> = { type: message.type };
  if (color !== null) ext.color = color;
  if (message.author.bot) ext.bot = true;
  if (mentioned) ext.mentioned = true;
  if (Object.keys(users).length) ext.users = users;
  if (Object.keys(roleNames).length) ext.roles = roleNames;
  if (Object.keys(channels).length) ext.channels = channels;
  if (Object.keys(emoji).length) ext.emoji = emoji;
  if (embeds.length) ext.embeds = embeds;
  if (stickers.length) ext.stickers = stickers;
  if (urls.some(Boolean)) ext.urls = urls;
  if (message.threadId) {
    const thread = account.channels.get(message.threadId);
    ext.thread = { id: message.threadId, name: thread?.name ?? null };
  }
  if (forwarded && message.content.trim() && !/^\[Forwarded\]/.test(message.content)) ext.comment = message.content;

  const reply = message.reply && message.type !== 21
    ? { id: message.reply.messageId ?? "", author: message.reply.authorDisplayName, text: message.reply.summary }
    : message.type === 21 && message.reply
      ? { id: message.reply.messageId ?? "", author: message.reply.authorDisplayName, text: message.reply.summary }
      : null;
  if (reply && message.reply?.authorId) {
    const replyMember = guildId ? account.guilds.get(guildId)?.members.get(message.reply.authorId) : null;
    if (replyMember?.nick) reply.author = replyMember.nick;
    if (guildId && replyMember) {
      const replyColor = account.roleColor(guildId, replyMember.roles);
      if (replyColor !== null) ext.reply_color = replyColor;
    }
    if (message.reply.authorId === selfId) ext.reply_mine = true;
  }

  return {
    id: message.id,
    chat: message.channelId,
    ts: message.timestamp,
    author: { id: message.author.id, name, avatar },
    mine: selfId !== null && message.author.id === selfId,
    text,
    format: "discord",
    media,
    reply_to: reply,
    reactions,
    edited_ts: message.editedTimestamp,
    deleted: false,
    system,
    forwarded: forwarded !== null,
    status: selfId !== null && message.author.id === selfId ? "sent" : null,
    client_id: message.nonce ?? null,
    ext,
  };
}

/**
 * Discord's markdown as plain words (a notification, the DM list's line):
 * mentions, channels and roles by name, custom emoji as `:name:`,
 * timestamps as dates, spoilers hidden, emphasis markers dropped.
 */
export function plainText(message: Pick<WireMessage, "text" | "ext">): string {
  const ext = (message.ext ?? {}) as { users?: Record<string, string>; roles?: Record<string, { name: string }>; channels?: Record<string, string> };
  return message.text
    .replace(/\|\|[\s\S]+?\|\|/g, "[spoiler]")
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${ext.users?.[id] ?? "someone"}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${ext.roles?.[id]?.name ?? "role"}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${ext.channels?.[id] ?? "channel"}`)
    .replace(/<a?:([A-Za-z0-9_~]+):\d+>/g, ":$1:")
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, seconds: string) => new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " "))
    .replace(/<\/([^:>]+):\d+>/g, "/$1")
    .replace(/(\*\*|__|~~|```|`)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/^(?:#{1,3}|-#|>{1,3}) /gm, "");
}

/** A message in a few words: the DM list's line under the name. */
export function lastLine(message: WireMessage): string {
  const text = plainText(message).replace(/\s+/g, " ").trim();
  if (text) return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  const first = message.media[0];
  if (!first) return message.ext && Array.isArray((message.ext as any).embeds) ? "Embed" : "Message";
  switch (first.kind) {
    case "image": return message.media.length > 1 ? `${message.media.length} images` : "Image";
    case "gif": return "GIF";
    case "video": return "Video";
    case "audio": return "Voice message";
    case "sticker": return "Sticker";
    default: return first.name ?? "File";
  }
}
