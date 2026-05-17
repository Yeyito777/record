/**
 * Discord REST client.
 */

import { summarizeInlineMessageParts, type DisplayAttachment, type DisplayEmbed } from "./messageparts";

const API_BASE = "https://discord.com/api/v9";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) record/0.1.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const GUILD_PAGE_LIMIT = 200;
const GUILD_TEXT_CHANNEL_TYPES = new Set([0, 5, 11, 12]);
const GUILD_VOICE_CHANNEL_TYPES = new Set([2, 13]);
const SIDEBAR_GUILD_CHANNEL_TYPES = new Set([...GUILD_TEXT_CHANNEL_TYPES, 4, ...GUILD_VOICE_CHANNEL_TYPES]);
const DIRECT_MESSAGE_CHANNEL_TYPES = new Set([1, 3]);
const MESSAGE_TYPE_CHANNEL_PINNED_MESSAGE = 6;

export const DIRECT_MESSAGES_GUILD_ID = "@me::dms";
export const DIRECT_MESSAGES_GUILD_NAME = "Direct Messages";

export const DISCORD_PRESENCE_STATUSES = ["online", "idle", "dnd", "invisible"] as const;
export type DiscordPresenceStatus = typeof DISCORD_PRESENCE_STATUSES[number];

interface DiscordErrorResponse {
  message?: string;
  code?: number;
  captcha_key?: unknown;
  captcha_sitekey?: unknown;
  errors?: unknown;
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

interface DiscordInviteGuildResponse {
  id?: string;
  name?: string | null;
  icon?: string | null;
}

interface DiscordInviteChannelResponse {
  id?: string;
  name?: string | null;
  type?: number;
}

interface DiscordInviteResponse {
  code?: string;
  guild?: DiscordInviteGuildResponse | null;
  channel?: DiscordInviteChannelResponse | null;
}

export interface DiscordInviteAcceptOptions {
  sessionId?: string | null;
}

export interface DiscordInviteJoinResult {
  code: string;
  guildId: string | null;
  guildName: string | null;
  channelId: string | null;
  channelName: string | null;
}

export class DiscordCaptchaRequiredError extends Error {
  constructor(message = "Captcha required to join this server.") {
    super(message);
    this.name = "DiscordCaptchaRequiredError";
  }
}

const DISCORD_CLIENT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.115 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";

interface DiscordUserSettingsResponse {
  status?: string | null;
}

interface DiscordSettingsProtoResponse {
  settings?: string | null;
}

interface DecodedUserSettingsStatus {
  status: DiscordPresenceStatus | null;
  customStatusBytes: Uint8Array | null;
}

export interface DiscordDMRecipientResponse {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordPermissionOverwriteResponse {
  id: string;
  type: number;
  allow?: string;
  deny?: string;
}

export interface DiscordChannelResponse {
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
  permission_overwrites?: DiscordPermissionOverwriteResponse[];
}

export interface DiscordMessageAuthorResponse {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

export interface DiscordMessageMentionResponse extends DiscordMessageAuthorResponse {
  member?: DiscordMessageMemberResponse;
}

export interface DiscordMessageMemberResponse {
  nick?: string | null;
  roles?: string[];
}

export interface DiscordAttachmentResponse {
  id: string;
  filename: string;
  content_type?: string | null;
  size: number;
  url: string;
}

export interface DiscordMessageReferenceResponse {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

export interface DiscordStickerItemResponse {
  id: string;
  name: string;
  format_type?: number;
}

export interface DiscordEmbedResponse {
  type?: string;
  title?: string;
  url?: string;
  description?: string;
  provider?: { name?: string | null; url?: string | null } | null;
  author?: { name?: string | null; url?: string | null } | null;
}

export interface DiscordReferencedMessageResponse {
  id: string;
  content: string;
  timestamp: string;
  author: DiscordMessageAuthorResponse;
  member?: DiscordMessageMemberResponse;
  mention_roles?: string[];
  mentions?: DiscordMessageMentionResponse[];
  attachments?: DiscordAttachmentResponse[];
  embeds?: DiscordEmbedResponse[];
  sticker_items?: DiscordStickerItemResponse[];
}

export interface DiscordCallResponse {
  ended_timestamp: string | null;
  participants?: string[];
}

export interface DiscordMessageResponse {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  type?: number;
  mention_everyone?: boolean;
  mention_roles?: string[];
  mentions?: DiscordMessageMentionResponse[];
  author: DiscordMessageAuthorResponse;
  member?: DiscordMessageMemberResponse;
  message_reference?: DiscordMessageReferenceResponse | null;
  referenced_message?: DiscordReferencedMessageResponse | null;
  call?: DiscordCallResponse | null;
  attachments?: DiscordAttachmentResponse[];
  embeds?: DiscordEmbedResponse[];
  sticker_items?: DiscordStickerItemResponse[];
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
  muted?: boolean;
}

export interface DiscordPermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
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
  lastMessageId?: string | null;
  recipients?: DiscordGuildMember[];
  permissionOverwrites?: DiscordPermissionOverwrite[];
  hidden?: boolean;
}

export interface DiscordMessageAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  url: string;
}

export interface DiscordMessageEmbed {
  type: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  providerName: string | null;
  authorName: string | null;
}

export interface DiscordRole {
  id: string;
  name?: string;
  color: number;
  position: number;
  permissions?: string;
}

export interface DiscordGuildMember {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  avatar?: string | null;
  roleIds?: string[];
}

export interface DiscordMessageReply {
  messageId: string | null;
  /** Channel that Discord says contains messageId. Missing on older local/cache entries. */
  channelId?: string | null;
  authorId: string | null;
  authorDisplayName: string | null;
  timestamp: number | null;
  summary: string;
  mentionRoleIds?: string[];
  mentionUsers?: DiscordGuildMember[];
}

export interface DiscordMessageCall {
  endedTimestamp: number | null;
  participantIds: string[];
}

export type DiscordMessageLocalStatus = "pending" | "failed";

export interface DiscordMessage {
  id: string;
  channelId: string;
  guildId?: string | null;
  type: number;
  content: string;
  mentionEveryone: boolean;
  mentionRoleIds: string[];
  mentionUserIds: string[];
  mentionUsers?: DiscordGuildMember[];
  timestamp: number;
  editedTimestamp: number | null;
  author: {
    id: string;
    username: string;
    displayName: string;
    bot: boolean;
    avatar?: string;
    roleIds?: string[];
  };
  reply: DiscordMessageReply | null;
  call: DiscordMessageCall | null;
  attachments: DiscordMessageAttachment[];
  stickerNames: string[];
  embedsCount: number;
  embeds?: DiscordMessageEmbed[];
  localStatus?: DiscordMessageLocalStatus;
  localError?: string;
  /** Actual content sent to Discord when it differs from the friendly local prompt text. */
  localSendContent?: string;
  /** Mention metadata for friendly local @name text before Discord echoes canonical mentions. */
  localMentionUsers?: DiscordGuildMember[];
}

export interface DiscordMessagePatch {
  id: string;
  channelId: string;
  /** Internal/local patch; false for gateway patches where undefined means absent. */
  local?: boolean;
  guildId?: string | null;
  type?: number;
  content?: string;
  mentionEveryone?: boolean;
  mentionRoleIds?: string[];
  mentionUserIds?: string[];
  mentionUsers?: DiscordGuildMember[];
  timestamp?: number;
  editedTimestamp?: number | null;
  author?: DiscordMessage["author"];
  reply?: DiscordMessageReply | null;
  call?: DiscordMessageCall | null;
  attachments?: DiscordMessageAttachment[];
  stickerNames?: string[];
  embedsCount?: number;
  embeds?: DiscordMessageEmbed[];
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

export function isGuildVoiceChannel(channel: DiscordChannel | null): boolean {
  return channel ? GUILD_VOICE_CHANNEL_TYPES.has(channel.type) : false;
}

export function isMessageChannel(channel: DiscordChannel | null): boolean {
  return Boolean(channel && (isDirectMessageChannel(channel) || GUILD_TEXT_CHANNEL_TYPES.has(channel.type)));
}

export function formatChannelName(channel: DiscordChannel | null): string {
  if (!channel) return "#unknown";
  if (isGuildVoiceChannel(channel)) return `🔊 ${channel.name}`;
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
  const protoStatus = await fetchCurrentUserSettingsProtoStatus(token).catch(() => null);
  if (protoStatus) return protoStatus;

  const settings = await apiGetJson<DiscordUserSettingsResponse>(token, "/users/@me/settings");
  return normalizePresenceStatus(settings.status);
}

export async function setCurrentUserSettingsProtoStatus(token: string, status: DiscordPresenceStatus): Promise<void> {
  const current = await fetchCurrentUserSettingsProto(token).catch(() => null);
  const decoded = current ? decodeUserSettingsStatus(current) : null;
  const settings = encodeUserSettingsStatus({
    status,
    customStatusBytes: decoded?.customStatusBytes ?? null,
  });

  await requestJson<unknown>(token, "/users/@me/settings-proto/1", {
    method: "PATCH",
    body: JSON.stringify({ settings: Buffer.from(settings).toString("base64") }),
  });
}

async function fetchCurrentUserSettingsProtoStatus(token: string): Promise<DiscordPresenceStatus | null> {
  const settings = await fetchCurrentUserSettingsProto(token);
  return decodeUserSettingsStatus(settings).status;
}

async function fetchCurrentUserSettingsProto(token: string): Promise<Uint8Array> {
  const response = await apiGetJson<DiscordSettingsProtoResponse>(token, "/users/@me/settings-proto/1");
  if (!response.settings) throw new Error("Discord settings proto response was empty.");
  return Buffer.from(response.settings, "base64");
}

function normalizePresenceStatus(status: string | null | undefined): DiscordPresenceStatus | null {
  switch (status) {
    case "online":
    case "idle":
    case "dnd":
    case "invisible":
      return status;
    case "offline":
      return "invisible";
    default:
      return null;
  }
}

export function compareSnowflakesDesc(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left ? BigInt(left) : 0n;
  const rightValue = right ? BigInt(right) : 0n;
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? -1 : 1;
}

function encodeUserSettingsStatus(status: DecodedUserSettingsStatus): Uint8Array {
  const statusFields = [
    encodeField(1, 2, encodeStringValue(status.status ?? "online")),
    ...(status.customStatusBytes ? [encodeField(2, 2, status.customStatusBytes)] : []),
    encodeField(3, 2, encodeBoolValue(true)),
  ];
  return encodeField(11, 2, concatBytes(statusFields));
}

function decodeUserSettingsStatus(bytes: Uint8Array): DecodedUserSettingsStatus {
  const out: DecodedUserSettingsStatus = { status: null, customStatusBytes: null };
  for (const field of readProtoFields(bytes)) {
    if (field.fieldNumber !== 11 || field.wireType !== 2 || !(field.value instanceof Uint8Array)) continue;
    for (const statusField of readProtoFields(field.value)) {
      if (statusField.fieldNumber === 1 && statusField.wireType === 2 && statusField.value instanceof Uint8Array) {
        out.status = normalizePresenceStatus(decodeStringValue(statusField.value));
      } else if (statusField.fieldNumber === 2 && statusField.wireType === 2 && statusField.value instanceof Uint8Array) {
        out.customStatusBytes = statusField.value;
      }
    }
  }
  return out;
}

interface ProtoField {
  fieldNumber: number;
  wireType: number;
  value: bigint | Uint8Array;
}

function readProtoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.next;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    switch (wireType) {
      case 0: {
        const value = readVarint(bytes, offset);
        offset = value.next;
        fields.push({ fieldNumber, wireType, value: value.value });
        break;
      }
      case 1:
        fields.push({ fieldNumber, wireType, value: bytes.subarray(offset, offset + 8) });
        offset += 8;
        break;
      case 2: {
        const length = readVarint(bytes, offset);
        offset = length.next;
        const end = offset + Number(length.value);
        fields.push({ fieldNumber, wireType, value: bytes.subarray(offset, end) });
        offset = end;
        break;
      }
      case 5:
        fields.push({ fieldNumber, wireType, value: bytes.subarray(offset, offset + 4) });
        offset += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }
  return fields;
}

function decodeStringValue(bytes: Uint8Array): string | null {
  for (const field of readProtoFields(bytes)) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      return new TextDecoder().decode(field.value);
    }
  }
  return null;
}

function encodeStringValue(value: string): Uint8Array {
  return encodeField(1, 2, new TextEncoder().encode(value));
}

function encodeBoolValue(value: boolean): Uint8Array {
  return encodeField(1, 0, encodeVarint(value ? 1n : 0n));
}

function encodeField(fieldNumber: number, wireType: number, value: Uint8Array): Uint8Array {
  const key = encodeVarint(BigInt((fieldNumber << 3) | wireType));
  if (wireType === 2) return concatBytes([key, encodeVarint(BigInt(value.length)), value]);
  return concatBytes([key, value]);
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
  }
  throw new Error("Truncated protobuf varint.");
}

function encodeVarint(value: bigint): Uint8Array {
  const out: number[] = [];
  let remaining = value;
  while (remaining >= 0x80n) {
    out.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  out.push(Number(remaining));
  return Uint8Array.from(out);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function userDisplayName(user: { username: string; global_name?: string | null }): string {
  return user.global_name ?? user.username;
}

export function displayNameFromRecipient(recipient: DiscordDMRecipientResponse): string {
  return userDisplayName(recipient);
}

export function directMessageName(channel: DiscordChannelResponse): string {
  const recipients = channel.recipients ?? [];
  if (channel.name) return channel.name;
  if (channel.type === 3 && recipients.length > 0) {
    return recipients.map(displayNameFromRecipient).join(", ");
  }
  if (recipients[0]) return displayNameFromRecipient(recipients[0]);
  return "Unknown DM";
}

function summarizeReplyPreview(
  content: string,
  attachments: readonly DisplayAttachment[] = [],
  embeds: readonly DisplayEmbed[] | number = [],
  stickerNames: readonly string[] = [],
): string {
  return summarizeInlineMessageParts(content, attachments, embeds, stickerNames);
}

function mapSystemMessageContent(message: Pick<DiscordMessageResponse, "type">): string | null {
  switch (message.type) {
    case MESSAGE_TYPE_CHANNEL_PINNED_MESSAGE:
      return "📌 Pinned a message to this channel.";
    default:
      return null;
  }
}

function mapDiscordMessageContent(message: Partial<DiscordMessageResponse>): string | undefined {
  if (typeof message.content !== "string") return undefined;
  return mapSystemMessageContent(message) ?? message.content;
}

function messageReferenceIsReply(message: DiscordMessageResponse): boolean {
  return message.type !== MESSAGE_TYPE_CHANNEL_PINNED_MESSAGE;
}

function mapDiscordEmbed(embed: DiscordEmbedResponse): DiscordMessageEmbed {
  return {
    type: embed.type ?? null,
    title: embed.title ?? null,
    url: embed.url ?? null,
    description: embed.description ?? null,
    providerName: embed.provider?.name ?? null,
    authorName: embed.author?.name ?? null,
  };
}

export function mapReplyPreview(message: DiscordMessageResponse): DiscordMessageReply | null {
  if (!messageReferenceIsReply(message)) return null;

  const referenceChannelId = message.message_reference?.channel_id ?? message.channel_id;

  if (message.referenced_message) {
    return {
      messageId: message.referenced_message.id,
      authorId: message.referenced_message.author.id,
      authorDisplayName: userDisplayName(message.referenced_message.author),
      timestamp: Date.parse(message.referenced_message.timestamp),
      summary: summarizeReplyPreview(
        message.referenced_message.content,
        message.referenced_message.attachments ?? [],
        message.referenced_message.embeds ?? [],
        (message.referenced_message.sticker_items ?? []).map((sticker) => sticker.name),
      ),
      ...(message.referenced_message.mention_roles ? { mentionRoleIds: message.referenced_message.mention_roles } : {}),
      ...(message.referenced_message.mentions ? { mentionUsers: message.referenced_message.mentions.map(mapMentionedUser) } : {}),
    };
  }

  if (message.message_reference) {
    return {
      messageId: message.message_reference.message_id ?? null,
      channelId: referenceChannelId,
      authorId: null,
      authorDisplayName: null,
      timestamp: null,
      summary: "Deleted message",
    };
  }

  return null;
}

export function replyPreviewFromMessage(message: DiscordMessage): DiscordMessageReply {
  return {
    messageId: message.id,
    authorId: message.author.id,
    authorDisplayName: message.author.displayName,
    timestamp: message.timestamp,
    summary: summarizeReplyPreview(
      message.content,
      message.attachments,
      message.embeds ?? message.embedsCount,
      message.stickerNames,
    ),
    ...(message.mentionRoleIds.length > 0 ? { mentionRoleIds: message.mentionRoleIds } : {}),
    ...(message.mentionUsers && message.mentionUsers.length > 0 ? { mentionUsers: message.mentionUsers } : {}),
  };
}

export function isMissingReplyPreview(reply: DiscordMessageReply | null | undefined): reply is DiscordMessageReply & { messageId: string } {
  return Boolean(reply
    && reply.messageId
    && reply.authorId === null
    && reply.authorDisplayName === null
    && reply.timestamp === null
    && reply.summary === "Deleted message");
}

export interface ReplyReferenceTarget {
  channelId: string;
  messageId: string;
}

export function replyReferenceTarget(message: DiscordMessage): ReplyReferenceTarget | null {
  if (!isMissingReplyPreview(message.reply)) return null;
  return {
    channelId: message.reply.channelId ?? message.channelId,
    messageId: message.reply.messageId,
  };
}

export function hydrateMissingReplyPreviewFromLookup(
  message: DiscordMessage,
  lookup: (target: ReplyReferenceTarget) => DiscordMessage | null | undefined,
): DiscordMessage {
  const target = replyReferenceTarget(message);
  if (!target) return message;
  const referenced = lookup(target);
  if (!referenced || referenced.id === message.id) return message;
  return { ...message, reply: replyPreviewFromMessage(referenced) };
}

export function mapDirectMessageChannel(channel: DiscordChannelResponse, position = 0): DiscordChannel {
  return {
    id: channel.id,
    guildId: DIRECT_MESSAGES_GUILD_ID,
    parentId: null,
    name: directMessageName(channel),
    topic: null,
    position,
    type: channel.type,
    nsfw: false,
    lastMessageId: channel.last_message_id ?? null,
    recipients: (channel.recipients ?? []).map((recipient) => ({
      id: recipient.id,
      username: recipient.username,
      displayName: displayNameFromRecipient(recipient),
      bot: false,
      ...(recipient.avatar ? { avatar: recipient.avatar } : {}),
    })),
  };
}

function mapPermissionOverwriteType(type: unknown): number | null {
  if (typeof type === "number") return type;
  if (typeof type === "string" && /^\d+$/.test(type)) return Number(type);
  return null;
}

function mapPermissionOverwrites(overwrites: unknown): DiscordPermissionOverwrite[] | undefined {
  if (!Array.isArray(overwrites)) return undefined;
  return overwrites
    .map((overwrite): DiscordPermissionOverwrite | null => {
      if (typeof overwrite !== "object" || overwrite === null || typeof overwrite.id !== "string") return null;
      const type = mapPermissionOverwriteType(overwrite.type);
      if (type === null) return null;
      return {
        id: overwrite.id,
        type,
        allow: typeof overwrite.allow === "string" ? overwrite.allow : "0",
        deny: typeof overwrite.deny === "string" ? overwrite.deny : "0",
      };
    })
    .filter((overwrite): overwrite is DiscordPermissionOverwrite => overwrite !== null);
}

export function mapGuildChannel(channel: DiscordChannelResponse, fallbackGuildId: string): DiscordChannel | null {
  if (!SIDEBAR_GUILD_CHANNEL_TYPES.has(channel.type) || !channel.name) return null;
  return {
    id: channel.id,
    guildId: channel.guild_id ?? fallbackGuildId,
    parentId: channel.parent_id ?? null,
    name: channel.name ?? "",
    topic: channel.topic ?? null,
    position: channel.position ?? 0,
    type: channel.type,
    nsfw: Boolean(channel.nsfw),
    permissionOverwrites: mapPermissionOverwrites(channel.permission_overwrites),
  };
}

export function sortDirectMessageChannels(channels: DiscordChannel[]): DiscordChannel[] {
  return channels
    .slice()
    .sort((a, b) => {
      const recency = compareSnowflakesDesc(a.lastMessageId, b.lastMessageId);
      return recency || a.position - b.position || a.name.localeCompare(b.name);
    })
    .map((channel, index) => ({ ...channel, position: index }));
}

export function sortGuildChannels(channels: DiscordChannel[]): DiscordChannel[] {
  return channels.slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export function sortGuildsByOrder(guilds: DiscordGuild[], guildOrder: readonly string[] | null | undefined): DiscordGuild[] {
  if (!guildOrder || guildOrder.length === 0) return guilds;
  const byGuildId = new Map(guilds.map((guild) => [guild.id, guild]));
  const ordered: DiscordGuild[] = [];
  const included = new Set<string>();

  for (const guildId of guildOrder) {
    const guild = byGuildId.get(guildId);
    if (!guild || included.has(guildId)) continue;
    ordered.push(guild);
    included.add(guildId);
  }

  for (const guild of guilds) {
    if (included.has(guild.id)) continue;
    ordered.push(guild);
  }
  return ordered;
}

export async function fetchDirectMessages(token: string): Promise<DiscordChannel[]> {
  const channels = await apiGetJson<DiscordChannelResponse[]>(token, "/users/@me/channels");
  return channels
    .filter((channel) => DIRECT_MESSAGE_CHANNEL_TYPES.has(channel.type))
    .sort((a, b) => compareSnowflakesDesc(a.last_message_id, b.last_message_id))
    .map((channel, index) => mapDirectMessageChannel(channel, index));
}

export async function fetchGuilds(
  token: string,
  options: { guildOrder?: readonly string[] | null } = {},
): Promise<DiscordGuild[]> {
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

  return sortGuildsByOrder(guilds, options.guildOrder ?? null);
}

export async function fetchGuildChannels(token: string, guildId: string): Promise<DiscordChannel[]> {
  const channels = await apiGetJson<DiscordChannelResponse[]>(token, `/guilds/${guildId}/channels`);
  return sortGuildChannels(
    channels
      .map((channel) => mapGuildChannel(channel, guildId))
      .filter((channel): channel is DiscordChannel => channel !== null),
  );
}

interface DiscordRoleResponse {
  id: string;
  name?: string;
  color?: number;
  position?: number;
  permissions?: string;
}

interface DiscordCurrentGuildMemberResponse {
  roles?: unknown;
}

export async function fetchCurrentUserGuildRoleIds(token: string, guildId: string): Promise<string[]> {
  const member = await apiGetJson<DiscordCurrentGuildMemberResponse>(token, `/users/@me/guilds/${guildId}/member`);
  return Array.isArray(member.roles) ? member.roles.filter((roleId): roleId is string => typeof roleId === "string") : [];
}

export async function fetchGuildRoles(token: string, guildId: string): Promise<DiscordRole[]> {
  const roles = await apiGetJson<DiscordRoleResponse[]>(token, `/guilds/${guildId}/roles`);
  return roles.map((role) => ({
    id: role.id,
    name: typeof role.name === "string" ? role.name : undefined,
    color: typeof role.color === "number" ? role.color : 0,
    position: typeof role.position === "number" ? role.position : 0,
    permissions: typeof role.permissions === "string" ? role.permissions : "0",
  }));
}

function mapMentionedUser(mention: DiscordMessageMentionResponse): DiscordGuildMember {
  return {
    id: mention.id,
    username: mention.username,
    displayName: userDisplayName(mention),
    bot: Boolean(mention.bot),
    ...(mention.avatar ? { avatar: mention.avatar } : {}),
    roleIds: mention.member?.roles?.filter((roleId): roleId is string => typeof roleId === "string"),
  };
}

export function mapDiscordMessagePatch(message: Partial<DiscordMessageResponse> & { id: string; channel_id: string }): DiscordMessagePatch {
  const hasReplyFields = message.referenced_message !== undefined || message.message_reference !== undefined;
  return {
    id: message.id,
    channelId: message.channel_id,
    guildId: message.guild_id,
    type: message.type,
    content: mapDiscordMessageContent(message),
    mentionEveryone: message.mention_everyone,
    mentionRoleIds: message.mention_roles,
    mentionUserIds: message.mentions?.map((mention) => mention.id),
    mentionUsers: message.mentions?.map(mapMentionedUser),
    timestamp: message.timestamp ? Date.parse(message.timestamp) : undefined,
    editedTimestamp: message.edited_timestamp === undefined
      ? undefined
      : message.edited_timestamp
        ? Date.parse(message.edited_timestamp)
        : null,
    author: message.author ? {
      id: message.author.id,
      username: message.author.username,
      displayName: userDisplayName(message.author),
      bot: Boolean(message.author.bot),
      ...(message.author.avatar ? { avatar: message.author.avatar } : {}),
      roleIds: message.member?.roles?.filter((roleId): roleId is string => typeof roleId === "string"),
    } : undefined,
    reply: hasReplyFields
      ? mapReplyPreview({
        id: message.id,
        channel_id: message.channel_id,
        type: message.type,
        content: message.content ?? "",
        timestamp: message.timestamp ?? new Date(0).toISOString(),
        edited_timestamp: message.edited_timestamp ?? null,
        author: message.author ?? { id: "unknown", username: "unknown" },
        member: message.member,
        message_reference: message.message_reference,
        referenced_message: message.referenced_message,
        call: message.call,
        attachments: message.attachments,
        embeds: message.embeds,
        sticker_items: message.sticker_items,
      })
      : undefined,
    call: message.call === undefined
      ? undefined
      : message.call
        ? {
          endedTimestamp: message.call.ended_timestamp ? Date.parse(message.call.ended_timestamp) : null,
          participantIds: message.call.participants ?? [],
        }
        : null,
    attachments: message.attachments?.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type ?? null,
      size: attachment.size,
      url: attachment.url,
    })),
    stickerNames: message.sticker_items?.map((sticker) => sticker.name),
    embedsCount: message.embeds?.length,
    embeds: message.embeds?.map(mapDiscordEmbed),
  };
}

export function applyDiscordMessagePatch(message: DiscordMessage, patch: DiscordMessagePatch): DiscordMessage {
  return {
    ...message,
    guildId: patch.guildId !== undefined ? patch.guildId : message.guildId,
    type: patch.type ?? message.type,
    content: patch.content ?? message.content,
    mentionEveryone: patch.mentionEveryone ?? message.mentionEveryone,
    mentionRoleIds: patch.mentionRoleIds ?? message.mentionRoleIds,
    mentionUserIds: patch.mentionUserIds ?? message.mentionUserIds,
    mentionUsers: patch.mentionUsers ?? message.mentionUsers,
    timestamp: patch.timestamp ?? message.timestamp,
    editedTimestamp: patch.editedTimestamp !== undefined ? patch.editedTimestamp : message.editedTimestamp,
    author: patch.author
      ? { ...patch.author, roleIds: patch.author.roleIds ?? message.author.roleIds }
      : message.author,
    reply: patch.reply !== undefined ? patch.reply : message.reply,
    call: patch.local
      ? patch.call !== undefined ? patch.call : message.call
      : patch.type === 3 && patch.call === undefined ? null : patch.call !== undefined ? patch.call : message.call,
    attachments: patch.attachments ?? message.attachments,
    stickerNames: patch.stickerNames ?? message.stickerNames,
    embedsCount: patch.embedsCount ?? message.embedsCount,
    embeds: patch.embeds ?? message.embeds,
  };
}

export function mapDiscordMessage(message: DiscordMessageResponse): DiscordMessage {
  const patch = mapDiscordMessagePatch(message);
  return {
    id: patch.id,
    channelId: patch.channelId,
    guildId: patch.guildId ?? null,
    type: patch.type ?? 0,
    content: patch.content ?? "",
    mentionEveryone: patch.mentionEveryone ?? false,
    mentionRoleIds: patch.mentionRoleIds ?? [],
    mentionUserIds: patch.mentionUserIds ?? [],
    mentionUsers: patch.mentionUsers ?? [],
    timestamp: patch.timestamp ?? 0,
    editedTimestamp: patch.editedTimestamp ?? null,
    author: patch.author ?? {
      id: "unknown",
      username: "unknown",
      displayName: "Unknown",
      bot: false,
      roleIds: undefined,
    },
    reply: patch.reply ?? null,
    call: patch.call ?? null,
    attachments: patch.attachments ?? [],
    stickerNames: patch.stickerNames ?? [],
    embedsCount: patch.embedsCount ?? 0,
    embeds: patch.embeds ?? [],
  };
}

function resolveReplyPreviewsFromMessages(messages: DiscordMessage[]): DiscordMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return messages.map((message) => hydrateMissingReplyPreviewFromLookup(message, (target) => byId.get(target.messageId)));
}

export async function fetchChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage> {
  const message = await apiGetJson<DiscordMessageResponse>(token, `/channels/${channelId}/messages/${messageId}`);
  return mapDiscordMessage(message);
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
  return resolveReplyPreviewsFromMessages(messages.map(mapDiscordMessage).reverse());
}

export interface SendMessageReplyOptions {
  messageId: string;
  channelId: string;
  guildId?: string | null;
  mention?: boolean;
}

export interface SendMessageUpload {
  filename: string;
  mediaType: string;
  base64: string;
}

export interface SendMessageOptions {
  reply?: SendMessageReplyOptions | null;
  uploads?: SendMessageUpload[];
}

export async function sendChannelMessage(
  token: string,
  channelId: string,
  content: string,
  options: SendMessageOptions = {},
): Promise<DiscordMessage> {
  const body = buildSendMessagePayload(content, options);
  const uploads = options.uploads ?? [];
  const requestBody = uploads.length > 0
    ? buildSendMessageMultipartBody(body, uploads)
    : JSON.stringify(body);

  const message = await requestJson<DiscordMessageResponse>(token, `/channels/${channelId}/messages`, {
    method: "POST",
    body: requestBody,
  });
  return mapDiscordMessage(message);
}

export async function editChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  content: string,
): Promise<DiscordMessage> {
  const message = await requestJson<DiscordMessageResponse>(token, `/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
  return mapDiscordMessage(message);
}

export async function deleteChannelMessage(token: string, channelId: string, messageId: string): Promise<void> {
  await requestJson<unknown>(token, `/channels/${channelId}/messages/${messageId}`, {
    method: "DELETE",
  });
}

function buildSendMessagePayload(content: string, options: SendMessageOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { content, tts: false };
  const reply = options.reply;
  if (reply) {
    const reference: Record<string, string> = {
      message_id: reply.messageId,
      channel_id: reply.channelId,
    };
    if (reply.guildId) reference.guild_id = reply.guildId;
    body.message_reference = reference;
    if (reply.mention === false) {
      body.allowed_mentions = {
        parse: ["users", "roles", "everyone"],
        replied_user: false,
      };
    }
  }

  const uploads = options.uploads ?? [];
  if (uploads.length > 0) {
    body.attachments = uploads.map((upload, index) => ({
      id: String(index),
      filename: upload.filename,
    }));
  }

  return body;
}

function buildSendMessageMultipartBody(payload: Record<string, unknown>, uploads: SendMessageUpload[]): FormData {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  uploads.forEach((upload, index) => {
    const bytes = Buffer.from(upload.base64, "base64");
    form.append(`files[${index}]`, new Blob([bytes], { type: upload.mediaType }), upload.filename);
  });
  return form;
}

export async function ackChannelMessage(token: string, channelId: string, messageId: string): Promise<void> {
  await requestJson<unknown>(token, `/channels/${channelId}/messages/${messageId}/ack`, {
    method: "POST",
    body: JSON.stringify({
      last_viewed: Math.ceil((Date.now() - 1_420_070_400_000) / 86_400_000),
      token: null,
    }),
  });
}

export async function ringDirectMessageCall(token: string, channelId: string, recipientIds: readonly string[]): Promise<void> {
  await requestJson<unknown>(token, `/channels/${channelId}/call/ring`, {
    method: "POST",
    body: JSON.stringify({ recipients: [...recipientIds] }),
  });
}

export async function setGuildMuted(token: string, guildId: string, muted: boolean): Promise<void> {
  const guildSettings: Record<string, unknown> = { muted };
  if (muted) {
    guildSettings.mute_config = {
      end_time: null,
      selected_time_window: -1,
    };
  }

  await requestJson<unknown>(token, "/users/@me/guilds/settings", {
    method: "PATCH",
    body: JSON.stringify({
      guilds: {
        [guildId]: guildSettings,
      },
    }),
  });
}

export function discordInviteCodeFromUrl(target: string): string | null {
  const trimmed = target.trim();
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  let code: string | undefined;

  if (hostname === "discord.gg") {
    code = parts[0];
  } else if (
    hostname === "discord.com"
    || hostname === "discordapp.com"
    || hostname === "canary.discord.com"
    || hostname === "ptb.discord.com"
  ) {
    if (parts[0] === "invite" || parts[0] === "invites") code = parts[1];
  }

  if (!code) return null;
  try {
    code = decodeURIComponent(code);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]+$/.test(code) ? code : null;
}

function base64Json(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function discordSuperProperties(): string {
  return base64Json({
    os: "Linux",
    browser: "Discord Client",
    device: "",
    system_locale: "en-US",
    browser_user_agent: DISCORD_CLIENT_USER_AGENT,
    browser_version: "138.0.7204.251",
    os_version: "",
    referrer: "",
    referring_domain: "",
    release_channel: "stable",
    client_build_number: 409090,
    client_event_source: null,
  });
}

function inviteContextProperties(invite: DiscordInviteResponse): string {
  return base64Json({
    location: "Accept Invite Page",
    location_guild_id: invite.guild?.id ?? null,
    location_channel_id: invite.channel?.id ?? null,
    location_channel_type: typeof invite.channel?.type === "number" ? invite.channel.type : null,
  });
}

function inviteRequestHeaders(code: string, inviteDetails: DiscordInviteResponse): Record<string, string> {
  return {
    "Origin": "https://discord.com",
    "Referer": `https://discord.com/invite/${code}`,
    "User-Agent": DISCORD_CLIENT_USER_AGENT,
    "X-Context-Properties": inviteContextProperties(inviteDetails),
    "X-Debug-Options": "bugReporterEnabled",
    "X-Discord-Locale": "en-US",
    "X-Discord-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "X-Super-Properties": discordSuperProperties(),
  };
}

export async function acceptDiscordInvite(token: string, invite: string, options: DiscordInviteAcceptOptions = {}): Promise<DiscordInviteJoinResult> {
  const code = discordInviteCodeFromUrl(invite);
  if (!code) throw new Error("Not a Discord invite link.");

  const inviteDetails = await apiGetJson<DiscordInviteResponse>(
    token,
    `/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`,
  );

  const response = await requestJson<DiscordInviteResponse>(token, `/invites/${encodeURIComponent(code)}`, {
    method: "POST",
    headers: inviteRequestHeaders(code, inviteDetails),
    body: JSON.stringify({ session_id: options.sessionId ?? null }),
  });

  return {
    code: response.code ?? code,
    guildId: response.guild?.id ?? inviteDetails.guild?.id ?? null,
    guildName: response.guild?.name ?? inviteDetails.guild?.name ?? null,
    channelId: response.channel?.id ?? inviteDetails.channel?.id ?? null,
    channelName: response.channel?.name ?? inviteDetails.channel?.name ?? null,
  };
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
      headers: requestHeaders(token, init),
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

function requestHeaders(token: string, init: RequestInit): HeadersInit {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Authorization": token,
    "User-Agent": USER_AGENT,
  };
  if (!(init.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  return {
    ...headers,
    ...(init.headers as Record<string, string> | undefined),
  };
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

  if (body?.captcha_key !== undefined || body?.captcha_sitekey !== undefined) {
    return new DiscordCaptchaRequiredError();
  }

  const detail = discordErrorDetail(body);
  return new Error(`Discord returned ${status}.${detail}`.trim());
}

function discordErrorDetail(body: DiscordErrorResponse | null): string {
  if (!body) return "";
  if (body.message) return ` ${body.message}`;
  const errorSummary = summarizeDiscordErrorObject(body.errors);
  if (errorSummary) return ` ${errorSummary}`;
  return "";
}

function summarizeDiscordErrorObject(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const messages: string[] = [];
  collectDiscordErrorMessages(value, messages, 0);
  return messages.length > 0 ? messages.slice(0, 3).join(" ") : null;
}

function collectDiscordErrorMessages(value: unknown, messages: string[], depth: number): void {
  if (messages.length >= 3 || depth > 5 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDiscordErrorMessages(item, messages, depth + 1);
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") messages.push(record.message);
  if (Array.isArray(record._errors)) collectDiscordErrorMessages(record._errors, messages, depth + 1);
  for (const [key, child] of Object.entries(record)) {
    if (key === "message" || key === "_errors") continue;
    collectDiscordErrorMessages(child, messages, depth + 1);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
