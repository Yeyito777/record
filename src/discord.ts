/**
 * Discord REST client.
 */

const API_BASE = "https://discord.com/api/v9";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) record/0.1.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const GUILD_PAGE_LIMIT = 200;
const SIDEBAR_GUILD_CHANNEL_TYPES = new Set([0, 4, 5, 11, 12]);
const DIRECT_MESSAGE_CHANNEL_TYPES = new Set([1, 3]);

export const DIRECT_MESSAGES_GUILD_ID = "@me::dms";
export const DIRECT_MESSAGES_GUILD_NAME = "Direct Messages";

export type DiscordPresenceStatus = "online" | "idle" | "dnd" | "offline";

interface DiscordErrorResponse {
  message?: string;
  code?: number;
}

interface DiscordMeResponse {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar: string | null;
  bot?: boolean;
  email?: string | null;
  verified?: boolean;
}

interface DiscordGuildResponse {
  id: string;
  name: string;
  icon: string | null;
}

interface DiscordUserSettingsResponse {
  status?: string | null;
}

interface DiscordDMRecipientResponse {
  id: string;
  username: string;
  global_name?: string | null;
}

interface DiscordChannelResponse {
  id: string;
  guild_id?: string;
  parent_id: string | null;
  name?: string | null;
  topic?: string | null;
  position?: number;
  type: number;
  nsfw?: boolean;
  last_message_id?: string | null;
  recipients?: DiscordDMRecipientResponse[];
}

interface DiscordMessageAuthorResponse {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

interface DiscordMessageMemberResponse {
  nick?: string | null;
}

interface DiscordAttachmentResponse {
  id: string;
  filename: string;
  content_type?: string | null;
  size: number;
  url: string;
}

interface DiscordMessageReferenceResponse {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

interface DiscordReferencedMessageResponse {
  id: string;
  content: string;
  timestamp: string;
  author: DiscordMessageAuthorResponse;
  member?: DiscordMessageMemberResponse;
  attachments?: DiscordAttachmentResponse[];
  embeds?: unknown[];
}

interface DiscordMessageResponse {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  author: DiscordMessageAuthorResponse;
  member?: DiscordMessageMemberResponse;
  message_reference?: DiscordMessageReferenceResponse | null;
  referenced_message?: DiscordReferencedMessageResponse | null;
  attachments?: DiscordAttachmentResponse[];
  embeds?: unknown[];
}

export interface DiscordIdentity {
  id: string;
  username: string;
  globalName: string | null;
  discriminator: string;
  avatar: string | null;
  bot: boolean;
  email: string | null;
  verified: boolean | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
}

export interface DiscordChannel {
  id: string;
  guildId: string;
  parentId: string | null;
  name: string;
  topic: string | null;
  position: number;
  type: number;
  nsfw: boolean;
  recipients?: DiscordGuildMember[];
}

export interface DiscordMessageAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  url: string;
}

export interface DiscordGuildMember {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
}

export interface DiscordMessageReply {
  messageId: string | null;
  authorId: string | null;
  authorDisplayName: string | null;
  timestamp: number | null;
  summary: string;
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  content: string;
  timestamp: number;
  editedTimestamp: number | null;
  author: {
    id: string;
    username: string;
    displayName: string;
    bot: boolean;
  };
  reply: DiscordMessageReply | null;
  attachments: DiscordMessageAttachment[];
  embedsCount: number;
}

export function formatDiscordDisplayName(user: DiscordIdentity): string {
  if (user.globalName) return `${user.globalName} (@${user.username})`;
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return `@${user.username}`;
}

export function isDirectMessageChannel(channel: DiscordChannel | null): boolean {
  return channel ? DIRECT_MESSAGE_CHANNEL_TYPES.has(channel.type) : false;
}

export function formatChannelName(channel: DiscordChannel | null): string {
  if (!channel) return "#unknown";
  return isDirectMessageChannel(channel) ? channel.name : `#${channel.name}`;
}

export async function validateToken(token: string): Promise<DiscordIdentity> {
  const me = await apiGetJson<DiscordMeResponse>(token, "/users/@me");
  return {
    id: me.id,
    username: me.username,
    globalName: me.global_name ?? null,
    discriminator: me.discriminator,
    avatar: me.avatar ?? null,
    bot: Boolean(me.bot),
    email: me.email ?? null,
    verified: typeof me.verified === "boolean" ? me.verified : null,
  };
}

export async function fetchCurrentUserPresenceStatus(token: string): Promise<DiscordPresenceStatus | null> {
  const settings = await apiGetJson<DiscordUserSettingsResponse>(token, "/users/@me/settings");
  switch (settings.status) {
    case "online":
    case "idle":
    case "dnd":
    case "offline":
      return settings.status;
    case "invisible":
      return "offline";
    default:
      return null;
  }
}

function compareSnowflakesDesc(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left ? BigInt(left) : 0n;
  const rightValue = right ? BigInt(right) : 0n;
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? -1 : 1;
}

function displayNameFromRecipient(recipient: DiscordDMRecipientResponse): string {
  return recipient.global_name ?? recipient.username;
}

function directMessageName(channel: DiscordChannelResponse): string {
  const recipients = channel.recipients ?? [];
  if (channel.name) return channel.name;
  if (channel.type === 3 && recipients.length > 0) {
    return recipients.map(displayNameFromRecipient).join(", ");
  }
  if (recipients[0]) return displayNameFromRecipient(recipients[0]);
  return "Unknown DM";
}

function summarizeMessageParts(
  content: string,
  attachments: Array<{ filename: string }> = [],
  embedsCount = 0,
): string[] {
  const parts: string[] = [];
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  if (/\S/.test(normalizedContent)) {
    parts.push(normalizedContent);
  }
  if (attachments.length > 0) {
    parts.push(`[attachments] ${attachments.map((attachment) => attachment.filename).join(", ")}`);
  }
  if (embedsCount > 0) {
    parts.push(`[embeds] ${embedsCount}`);
  }
  return parts;
}

function summarizeReplyPreview(
  content: string,
  attachments: DiscordAttachmentResponse[] = [],
  embedsCount = 0,
): string {
  const parts = summarizeMessageParts(content, attachments, embedsCount).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  return parts.join(" · ") || "(empty message)";
}

function mapReplyPreview(message: DiscordMessageResponse): DiscordMessageReply | null {
  if (message.referenced_message) {
    return {
      messageId: message.referenced_message.id,
      authorId: message.referenced_message.author.id,
      authorDisplayName: message.referenced_message.member?.nick
        ?? message.referenced_message.author.global_name
        ?? message.referenced_message.author.username,
      timestamp: Date.parse(message.referenced_message.timestamp),
      summary: summarizeReplyPreview(
        message.referenced_message.content,
        message.referenced_message.attachments ?? [],
        message.referenced_message.embeds?.length ?? 0,
      ),
    };
  }

  if (message.message_reference) {
    return {
      messageId: message.message_reference.message_id ?? null,
      authorId: null,
      authorDisplayName: null,
      timestamp: null,
      summary: "Deleted message",
    };
  }

  return null;
}

export async function fetchDirectMessages(token: string): Promise<DiscordChannel[]> {
  const channels = await apiGetJson<DiscordChannelResponse[]>(token, "/users/@me/channels");
  return channels
    .filter((channel) => DIRECT_MESSAGE_CHANNEL_TYPES.has(channel.type))
    .sort((a, b) => compareSnowflakesDesc(a.last_message_id, b.last_message_id))
    .map((channel, index) => ({
      id: channel.id,
      guildId: DIRECT_MESSAGES_GUILD_ID,
      parentId: null,
      name: directMessageName(channel),
      topic: null,
      position: index,
      type: channel.type,
      nsfw: false,
      recipients: (channel.recipients ?? []).map((recipient) => ({
        id: recipient.id,
        username: recipient.username,
        displayName: displayNameFromRecipient(recipient),
        bot: false,
      })),
    }));
}

export async function fetchGuilds(token: string): Promise<DiscordGuild[]> {
  const guilds: DiscordGuild[] = [];
  let before: string | null = null;

  while (true) {
    const query = new URLSearchParams({ limit: String(GUILD_PAGE_LIMIT) });
    if (before) query.set("before", before);

    const page = await apiGetJson<DiscordGuildResponse[]>(token, `/users/@me/guilds?${query.toString()}`);
    guilds.push(...page.map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon ?? null,
    })));

    if (page.length < GUILD_PAGE_LIMIT) break;
    before = page[page.length - 1]?.id ?? null;
    if (!before) break;
  }

  return guilds;
}

export async function fetchGuildChannels(token: string, guildId: string): Promise<DiscordChannel[]> {
  const channels = await apiGetJson<DiscordChannelResponse[]>(token, `/guilds/${guildId}/channels`);
  return channels
    .filter((channel) => SIDEBAR_GUILD_CHANNEL_TYPES.has(channel.type) && Boolean(channel.name))
    .map((channel) => ({
      id: channel.id,
      guildId: channel.guild_id ?? guildId,
      parentId: channel.parent_id ?? null,
      name: channel.name ?? "",
      topic: channel.topic ?? null,
      position: channel.position ?? 0,
      type: channel.type,
      nsfw: Boolean(channel.nsfw),
    }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export async function fetchChannelMessages(
  token: string,
  channelId: string,
  limit = 50,
  before?: string,
): Promise<DiscordMessage[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  const messages = await apiGetJson<DiscordMessageResponse[]>(token, `/channels/${channelId}/messages?${query.toString()}`);
  return messages
    .map((message) => ({
      id: message.id,
      channelId: message.channel_id,
      content: message.content,
      timestamp: Date.parse(message.timestamp),
      editedTimestamp: message.edited_timestamp ? Date.parse(message.edited_timestamp) : null,
      author: {
        id: message.author.id,
        username: message.author.username,
        displayName: message.member?.nick ?? message.author.global_name ?? message.author.username,
        bot: Boolean(message.author.bot),
      },
      reply: mapReplyPreview(message),
      attachments: (message.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type ?? null,
        size: attachment.size,
        url: attachment.url,
      })),
      embedsCount: message.embeds?.length ?? 0,
    }))
    .reverse();
}

async function apiGetJson<T>(token: string, path: string): Promise<T> {
  return requestJson<T>(token, path, { method: "GET" });
}

async function requestJson<T>(token: string, path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Accept": "application/json",
        "Authorization": token,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const body = bodyText ? tryParseJson(bodyText) : null;

    if (response.ok) {
      return body as T;
    }

    throw buildDiscordError(response.status, body as DiscordErrorResponse | null);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Discord request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildDiscordError(status: number, body: DiscordErrorResponse | null): Error {
  if (status === 401) {
    return new Error("Discord rejected the token.");
  }
  if (status === 403) {
    return new Error("Discord denied access to that resource.");
  }
  if (status === 404) {
    return new Error("Discord resource not found.");
  }
  if (status === 429) {
    return new Error("Discord rate-limited the request. Try again in a moment.");
  }

  const detail = body?.message ? ` ${body.message}` : "";
  return new Error(`Discord returned ${status}.${detail}`.trim());
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
