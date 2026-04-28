/**
 * Discord REST client.
 */

import { summarizeInlineMessageParts } from "./messageparts";

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
  guild_folders?: unknown;
  guild_positions?: unknown;
}

interface DiscordUserSettingsPatch {
  guild_folders?: unknown;
  guild_positions?: string[];
}

export interface DiscordDMRecipientResponse {
  id: string;
  username: string;
  global_name?: string | null;
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
  color: number;
  position: number;
}

export interface DiscordGuildMember {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  roleIds?: string[];
}

export interface DiscordMessageReply {
  messageId: string | null;
  authorId: string | null;
  authorDisplayName: string | null;
  timestamp: number | null;
  summary: string;
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
}

export interface DiscordMessagePatch {
  id: string;
  channelId: string;
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

export function compareSnowflakesDesc(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left ? BigInt(left) : 0n;
  const rightValue = right ? BigInt(right) : 0n;
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? -1 : 1;
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
  attachments: DiscordAttachmentResponse[] = [],
  embeds: DiscordEmbedResponse[] = [],
  stickerNames: string[] = [],
): string {
  return summarizeInlineMessageParts(content, attachments, embeds.map(mapDiscordEmbed), stickerNames);
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
    })),
  };
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

function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function extractGuildOrderFromUserSettings(settings: unknown): string[] | null {
  if (!isSettingsObject(settings)) return null;

  const folders = Array.isArray(settings.guild_folders)
    ? settings.guild_folders
    : Array.isArray(settings.guildFolders)
      ? settings.guildFolders
      : [];
  const folderOrder: string[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    if (!isSettingsObject(folder)) continue;
    const guildIds = uniqueStringList(folder.guild_ids ?? folder.guildIds);
    for (const guildId of guildIds) {
      if (seen.has(guildId)) continue;
      seen.add(guildId);
      folderOrder.push(guildId);
    }
  }
  if (folderOrder.length > 0) return folderOrder;

  const positionOrder = uniqueStringList(settings.guild_positions ?? settings.guildPositions);
  return positionOrder.length > 0 ? positionOrder : null;
}

export function sortGuildsByUserOrder(guilds: DiscordGuild[], guildOrder: readonly string[] | null | undefined): DiscordGuild[] {
  if (!guildOrder || guildOrder.length === 0) return guilds;
  const byGuildId = new Map(guilds.map((guild) => [guild.id, guild]));
  const ordered: DiscordGuild[] = [];
  const included = new Set<string>();
  const orderSet = new Set(guildOrder);

  // Newly joined guilds can be present in /users/@me/guilds before Discord's
  // sidebar settings include them. Keep those visible instead of burying them
  // after the full ordered list.
  for (const guild of guilds) {
    if (orderSet.has(guild.id)) continue;
    ordered.push(guild);
    included.add(guild.id);
  }

  for (const guildId of guildOrder) {
    const guild = byGuildId.get(guildId);
    if (!guild || included.has(guildId)) continue;
    ordered.push(guild);
    included.add(guildId);
  }

  return ordered;
}

async function fetchGuildOrder(token: string): Promise<string[] | null> {
  const settings = await apiGetJson<DiscordUserSettingsResponse>(token, "/users/@me/settings");
  return extractGuildOrderFromUserSettings(settings);
}

export function buildGuildOrderSettingsPatch(settings: unknown, guildOrder: readonly string[]): DiscordUserSettingsPatch {
  if (!isSettingsObject(settings)) return { guild_positions: [...guildOrder] };
  const folders = Array.isArray(settings.guild_folders) ? settings.guild_folders : null;
  if (!folders) return { guild_positions: [...guildOrder] };

  const slots: Array<{ folderIndex: number; guildIndex: number }> = [];
  for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
    const folder = folders[folderIndex];
    if (!isSettingsObject(folder) || !Array.isArray(folder.guild_ids)) continue;
    for (let guildIndex = 0; guildIndex < folder.guild_ids.length; guildIndex++) {
      slots.push({ folderIndex, guildIndex });
    }
  }

  const nextFolders = folders.map((folder) => {
    if (!isSettingsObject(folder)) return folder;
    const guildIds = Array.isArray(folder.guild_ids) ? folder.guild_ids.filter((id): id is string => typeof id === "string") : [];
    return { ...folder, guild_ids: guildIds };
  });

  for (const [index, guildId] of guildOrder.entries()) {
    const slot = slots[index];
    if (!slot) {
      nextFolders.push({ id: null, name: null, color: null, guild_ids: [guildId] });
      continue;
    }
    const folder = nextFolders[slot.folderIndex];
    if (isSettingsObject(folder) && Array.isArray(folder.guild_ids)) {
      folder.guild_ids[slot.guildIndex] = guildId;
    }
  }

  return { guild_folders: nextFolders };
}

export async function updateGuildSidebarOrder(token: string, guildOrder: readonly string[]): Promise<void> {
  const settings = await apiGetJson<DiscordUserSettingsResponse>(token, "/users/@me/settings");
  const patch = buildGuildOrderSettingsPatch(settings, guildOrder);
  await requestJson<unknown>(token, "/users/@me/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function fetchDirectMessages(token: string): Promise<DiscordChannel[]> {
  const channels = await apiGetJson<DiscordChannelResponse[]>(token, "/users/@me/channels");
  return channels
    .filter((channel) => DIRECT_MESSAGE_CHANNEL_TYPES.has(channel.type))
    .sort((a, b) => compareSnowflakesDesc(a.last_message_id, b.last_message_id))
    .map((channel, index) => mapDirectMessageChannel(channel, index));
}

export async function fetchGuilds(token: string): Promise<DiscordGuild[]> {
  const guildOrderPromise = fetchGuildOrder(token).catch(() => null);
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

  return sortGuildsByUserOrder(guilds, await guildOrderPromise);
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
  color?: number;
  position?: number;
}

export async function fetchGuildRoles(token: string, guildId: string): Promise<DiscordRole[]> {
  const roles = await apiGetJson<DiscordRoleResponse[]>(token, `/guilds/${guildId}/roles`);
  return roles.map((role) => ({
    id: role.id,
    color: typeof role.color === "number" ? role.color : 0,
    position: typeof role.position === "number" ? role.position : 0,
  }));
}

function mapMentionedUser(mention: DiscordMessageMentionResponse): DiscordGuildMember {
  return {
    id: mention.id,
    username: mention.username,
    displayName: userDisplayName(mention),
    bot: Boolean(mention.bot),
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
    content: typeof message.content === "string" ? message.content : undefined,
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
      roleIds: message.member?.roles?.filter((roleId): roleId is string => typeof roleId === "string"),
    } : undefined,
    reply: hasReplyFields
      ? mapReplyPreview({
        id: message.id,
        channel_id: message.channel_id,
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
    call: patch.call !== undefined ? patch.call : message.call,
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

export async function fetchChannelMessages(
  token: string,
  channelId: string,
  limit = 50,
  before?: string,
): Promise<DiscordMessage[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  const messages = await apiGetJson<DiscordMessageResponse[]>(token, `/channels/${channelId}/messages?${query.toString()}`);
  return messages.map(mapDiscordMessage).reverse();
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
