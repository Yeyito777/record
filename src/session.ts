/**
 * Read-only Discord session bootstrap and data loading.
 */

import {
  bumpDirectMessageChannel,
  clearChannelList,
  findBrowsableChannel,
  findFirstBrowsableChannel,
  removeChannel,
  setActiveChannel,
  setActiveChannelEntry,
  setChannelList,
  upsertChannel,
} from "./channels";
import {
  DIRECT_MESSAGES_GUILD_ID,
  DIRECT_MESSAGES_GUILD_NAME,
  ackChannelMessage,
  fetchChannelMessages,
  editChannelMessage,
  fetchDirectMessages,
  fetchGuildChannels,
  fetchCurrentUserGuildRoleIds,
  fetchGuildRoles,
  fetchGuilds,
  sendChannelMessage,
  setGuildMuted,
  sortGuildsByOrder,
  ringDirectMessageCall,
  isDirectMessageChannel,
  type DiscordMessageAttachment,
  type DiscordMessageReply,
  type SendMessageReplyOptions,
  type SendMessageUpload,
  sortDirectMessageChannels,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordGuildMember,
  type DiscordRole,
  type DiscordMessage,
  type DiscordMessagePatch,
} from "./discord";
import {
  loadCachedChannelMessages,
  loadCachedDirectMessages,
  loadCachedGuildChannels,
  loadCachedGuilds,
  loadCachedGuildOrder,
  loadCachedGuildRoles,
  loadCachedMemberList,
  loadCachedMemberRoles,
  loadCachedNotifications,
  saveCachedChannelMessages,
  saveCachedDirectMessages,
  saveCachedGuildChannels,
  saveCachedGuildOrder,
  saveCachedGuildRoles,
  saveCachedGuilds,
  saveCachedMemberList,
  saveCachedMemberRoles,
  saveCachedNotifications,
  watchCachedGuildOrder,
} from "./datacache";
import { AppGatewayClient } from "./appgateway";
import {
  cachedChannelMessages,
  cachedChannelMessagesAreFresh,
  clearCachedChannelMessages,
  markCachedChannelMessageFailed,
  patchCachedChannelMessage,
  removeCachedChannelMessage,
  removeCachedChannelMessages,
  replaceCachedChannelMessage,
  setCachedChannelMessages,
  upsertCachedChannelMessage,
} from "./messagecache";
import { debugLog } from "./debuglog";
import { MemberListGatewayClient } from "./membergateway";
import {
  cacheMemberList,
  clearMemberListData,
  getCachedMemberList,
  setMemberListLoading,
  setMemberListMembers,
  setMemberListMessage,
} from "./memberlist";
import type { AppState } from "./state";
import {
  clearChannelNotifications,
  clearGuildNotifications,
  recordChannelNotification,
  replaceNotifications,
  shouldNotifyForMessage as messageMatchesNotificationRules,
} from "./notifications";
import { clearPrompt } from "./promptstate";
import type { ClipboardImageAttachment } from "./imageclipboard";
import { focusPrompt, setNotice } from "./state";
import {
  applySidebarGuildMuteSettings,
  clearSidebarData,
  getSelectedSidebarEntry,
  isSidebarGuildMuted,
  moveSelectedSidebarGuild,
  setSidebarGuildMuted,
  setSidebarGuilds,
  sidebarCachedGuilds,
} from "./sidebar";
import {
  appendTimelineMessage,
  clearTimeline,
  finishLoadingOlderMessages,
  isTimelineNearBottom,
  markTimelineMessageFailed,
  prependTimelineMessages,
  patchTimelineMessage,
  removeTimelineMessage,
  removeTimelineMessages,
  replaceTimelineMessage,
  setTimelineMessages,
} from "./timeline";
import { clearTypingUser, recordTypingStart } from "./typing";
import { VoiceCallController, type VoiceCallSession } from "./voice";

export interface SessionEffects {
  scheduleRender: () => void;
}

interface LoadGuildChannelsOptions {
  openFirstChannel?: boolean;
}

const MESSAGE_PAGE_LIMIT = 50;
const MESSAGE_CACHE_FRESH_MS = 2 * 60 * 1000;
const MEMBER_LIST_SUBSCRIBE_TIMEOUT_MS = 7_000;
const MEMBER_LIST_SUBSCRIBE_RETRIES = 2;

let memberListGateway: MemberListGatewayClient | null = null;
let memberListGatewayToken: string | null = null;
let appGateway: AppGatewayClient | null = null;
let appGatewayToken: string | null = null;
let voiceCallController: VoiceCallController | null = null;
let guildOrderSync: { accountId: string; state: AppState; stop: () => void } | null = null;

function buildDirectMessageMemberList(state: AppState): DiscordGuildMember[] {
  const members: DiscordGuildMember[] = [];
  const viewer = state.auth.user;
  const channel = state.channelList.activeChannel;

  if (viewer) {
    members.push({
      id: viewer.id,
      username: viewer.username,
      displayName: viewer.globalName ?? viewer.username,
      bot: viewer.bot,
    });
  }

  for (const recipient of channel?.recipients ?? []) {
    if (viewer && recipient.id === viewer.id) continue;
    if (members.some((member) => member.id === recipient.id)) continue;
    members.push(recipient);
  }

  return members;
}

export function disconnectMemberListGateway(): void {
  memberListGateway?.disconnect();
  memberListGateway = null;
  memberListGatewayToken = null;
}

export function disconnectAppGateway(): void {
  voiceCallController?.disconnect();
  voiceCallController = null;
  appGateway?.disconnect();
  appGateway = null;
  appGatewayToken = null;
}

function getMemberListGateway(token: string): MemberListGatewayClient {
  if (!memberListGateway || memberListGatewayToken !== token) {
    disconnectMemberListGateway();
    memberListGateway = new MemberListGatewayClient(token);
    memberListGatewayToken = token;
  }

  return memberListGateway;
}

function ensureDirectMessagesGuild(state: AppState): void {
  if (state.sidebar.guilds.some((guild) => guild.id === DIRECT_MESSAGES_GUILD_ID)) return;
  state.sidebar.guilds = [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }, ...state.sidebar.guilds];
}

function activeTimelineWasPinned(state: AppState): boolean {
  return isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll);
}

function displayNameForUser(state: AppState, channelId: string, userId: string, fallback: string): string {
  const activeChannel = state.channelList.channels.find((channel) => channel.id === channelId);
  const guildId = activeChannel?.guildId ?? null;

  const fromActiveMemberList = state.memberList.channelId === channelId
    ? state.memberList.members.find((member) => member.id === userId)?.displayName
    : null;
  if (fromActiveMemberList) return fromActiveMemberList;

  const fromSameGuildMemberList = guildId && state.memberList.guildId === guildId
    ? state.memberList.members.find((member) => member.id === userId)?.displayName
    : null;
  if (fromSameGuildMemberList) return fromSameGuildMemberList;

  for (const [key, members] of state.memberList.cache.entries()) {
    if (guildId && !key.startsWith(`${guildId}:`)) continue;
    const fromCachedMemberList = members.find((member) => member.id === userId)?.displayName;
    if (fromCachedMemberList) return fromCachedMemberList;
  }

  const fromRecipients = activeChannel?.recipients?.find((recipient) => recipient.id === userId)?.displayName;
  if (fromRecipients) return fromRecipients;

  const fromAnyDirectMessageRecipient = state.channelList.channels
    .flatMap((channel) => channel.recipients ?? [])
    .find((recipient) => recipient.id === userId)?.displayName;
  if (fromAnyDirectMessageRecipient) return fromAnyDirectMessageRecipient;

  const fromTimeline = state.timeline.channelId === channelId
    ? state.timeline.messages.find((message) => message.author.id === userId)?.author.displayName
    : null;
  if (fromTimeline) return fromTimeline;

  const fromCachedChannelMessages = state.messageCacheByChannelId[channelId]?.messages
    .find((message) => message.author.id === userId)?.author.displayName;
  if (fromCachedChannelMessages) return fromCachedChannelMessages;

  for (const entry of Object.values(state.messageCacheByChannelId)) {
    const fromCachedMessage = entry.messages.find((message) => message.author.id === userId && (!guildId || message.guildId === guildId))?.author.displayName;
    if (fromCachedMessage) return fromCachedMessage;
  }

  return isRawUserIdDisplayName(fallback, userId) ? "Someone" : fallback;
}

function isRawUserIdDisplayName(displayName: string, userId: string): boolean {
  const trimmed = displayName.trim();
  return trimmed === userId || /^\d{15,25}$/.test(trimmed);
}

function maybeResortDirectMessages(state: AppState, channelId: string, messageId?: string): void {
  const accountId = currentAccountId(state);
  if (bumpDirectMessageChannel(state.channelList, channelId, messageId)) {
    if (accountId) saveCachedDirectMessages(accountId, state.channelList.channels);
    return;
  }

  if (!accountId || !messageId) return;
  const cachedDirectMessages = loadCachedDirectMessages(accountId);
  const channel = cachedDirectMessages?.find((entry) => entry.id === channelId);
  if (!cachedDirectMessages || !channel) return;
  channel.lastMessageId = messageId;
  channel.position = -1;
  saveCachedDirectMessages(accountId, sortDirectMessageChannels(cachedDirectMessages));
}

function guildIdForChannel(state: AppState, message: DiscordMessage): string | null {
  return message.guildId
    ?? state.channelList.channels.find((channel) => channel.id === message.channelId)?.guildId
    ?? null;
}

function shouldNotifyForIncomingMessage(state: AppState, message: DiscordMessage): boolean {
  if (state.timeline.channelId === message.channelId && isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) {
    return false;
  }
  const guildId = guildIdForChannel(state, message);
  if (isSidebarGuildMuted(state.sidebar, guildId)) return false;

  return messageMatchesNotificationRules(message, {
    viewerId: state.auth.user?.id ?? null,
    roleIdsByGuildId: state.roleIdsByGuildId,
    channels: state.channelList.channels,
  });
}

function handleGatewayMessageCreate(state: AppState, effects: SessionEffects, message: DiscordMessage): void {
  const guildId = guildIdForChannel(state, message);
  const cachedMessage = withMessageGuildId(message, guildId);
  recordMessageRoleIds(state, cachedMessage, guildId);
  upsertCachedChannelMessage(state.messageCacheByChannelId, cachedMessage);
  persistChannelMessageCache(state, cachedMessage.channelId);
  clearTypingUser(state.typing, message.channelId, message.author.id);
  const shouldNotify = shouldNotifyForIncomingMessage(state, cachedMessage);
  if (shouldNotify) {
    recordChannelNotification(state.notifications, cachedMessage.channelId, guildId);
    persistNotifications(state);
  }
  maybeResortDirectMessages(state, cachedMessage.channelId, cachedMessage.id);
  if (state.timeline.channelId === cachedMessage.channelId) {
    const pinned = activeTimelineWasPinned(state);
    appendTimelineMessage(state.timeline, cachedMessage);
    if (pinned) {
      state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      if (!shouldNotify) {
        markChannelRead(state, state.auth.savedToken, cachedMessage.channelId, cachedMessage.id);
      }
    }
  }
  effects.scheduleRender();
}

function handleGatewayMessageUpdate(state: AppState, effects: SessionEffects, patch: DiscordMessagePatch): void {
  const guildId = patch.guildId ?? state.channelList.channels.find((channel) => channel.id === patch.channelId)?.guildId ?? null;
  if (patch.author?.roleIds) {
    recordMemberRoleIds(state, guildId, patch.author.id, patch.author.roleIds);
  }
  for (const mention of patch.mentionUsers ?? []) {
    recordMemberRoleIds(state, guildId, mention.id, mention.roleIds);
  }
  maybeResortDirectMessages(state, patch.channelId, patch.id);
  if (patchCachedChannelMessage(state.messageCacheByChannelId, patch)) {
    persistChannelMessageCache(state, patch.channelId);
  }
  if (state.timeline.channelId === patch.channelId) {
    patchTimelineMessage(state.timeline, patch);
  }
  effects.scheduleRender();
}

function handleGatewayChannelCreateOrUpdate(state: AppState, effects: SessionEffects, channel: DiscordChannel): void {
  if (channel.guildId === DIRECT_MESSAGES_GUILD_ID) {
    ensureDirectMessagesGuild(state);
  }

  if (state.channelList.guildId === channel.guildId) {
    upsertChannel(state.channelList, channel);
    refreshHiddenChannelFlags(state, channel.guildId);
    if (state.memberList.open && state.channelList.activeChannelId === channel.id) {
      syncMemberListForCurrentChannel(state, effects);
    }
  }

  effects.scheduleRender();
}

function handleGatewayChannelDelete(state: AppState, effects: SessionEffects, channelId: string): void {
  const wasActive = state.channelList.activeChannelId === channelId;
  const removed = removeChannel(state.channelList, channelId);
  clearCachedChannelMessages(state.messageCacheByChannelId, channelId);
  if (wasActive || state.timeline.channelId === channelId) {
    clearTimeline(state.timeline);
    setNotice(state, "Channel was deleted.", "warning");
    syncMemberListForCurrentChannel(state, effects);
  }
  if (removed || wasActive) effects.scheduleRender();
}

function cachedSidebarGuilds(directMessages: DiscordChannel[], guilds: DiscordGuild[]): DiscordGuild[] {
  return directMessages.length > 0
    ? [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }, ...guilds]
    : guilds;
}

function currentAccountId(state: AppState): string | null {
  return state.auth.user?.id ?? null;
}

function applyLocalGuildOrder(state: AppState, guildOrder: readonly string[] | null | undefined): boolean {
  if (!guildOrder || guildOrder.length === 0) return false;
  const currentGuilds = sidebarCachedGuilds(state.sidebar);
  const nextGuilds = sortGuildsByOrder(currentGuilds, guildOrder);
  if (nextGuilds.length === currentGuilds.length && nextGuilds.every((guild, index) => guild.id === currentGuilds[index]?.id)) return false;
  setSidebarGuilds(state.sidebar, withCurrentDirectMessagesGuild(state, nextGuilds));
  return true;
}

function disconnectGuildOrderSync(): void {
  guildOrderSync?.stop();
  guildOrderSync = null;
}

function ensureGuildOrderSync(state: AppState, effects: SessionEffects): void {
  const accountId = currentAccountId(state);
  if (!accountId) {
    disconnectGuildOrderSync();
    return;
  }

  if (guildOrderSync?.accountId === accountId && guildOrderSync.state === state) return;
  disconnectGuildOrderSync();
  guildOrderSync = {
    accountId,
    state,
    stop: watchCachedGuildOrder(accountId, (guildOrder) => {
      if (currentAccountId(state) !== accountId) return;
      if (applyLocalGuildOrder(state, guildOrder)) effects.scheduleRender();
    }),
  };
}

function persistNotifications(state: AppState): void {
  const accountId = currentAccountId(state);
  if (accountId) {
    saveCachedNotifications(accountId, state.notifications);
  }
}

function recordMemberRoleIds(state: AppState, guildId: string | null | undefined, userId: string, roleIds: readonly string[] | undefined): boolean {
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID || !roleIds) return false;
  const byUserId = state.memberRoleIdsByGuildId[guildId] ??= {};
  const hadPrevious = Object.hasOwn(byUserId, userId);
  const previous = byUserId[userId] ?? [];
  if (hadPrevious && previous.length === roleIds.length && previous.every((roleId, index) => roleId === roleIds[index])) return false;
  byUserId[userId] = [...roleIds];
  state.memberRoleCacheVersion += 1;
  const accountId = currentAccountId(state);
  if (accountId) saveCachedMemberRoles(accountId, guildId, byUserId);
  return true;
}

function withMessageGuildId(message: DiscordMessage, guildId: string | null | undefined): DiscordMessage {
  return message.guildId || !guildId || guildId === DIRECT_MESSAGES_GUILD_ID ? message : { ...message, guildId };
}

function recordMessageRoleIds(state: AppState, message: DiscordMessage, fallbackGuildId: string | null | undefined): boolean {
  const guildId = message.guildId ?? fallbackGuildId;
  let changed = recordMemberRoleIds(state, guildId, message.author.id, message.author.roleIds);
  for (const mention of message.mentionUsers ?? []) {
    changed = recordMemberRoleIds(state, guildId, mention.id, mention.roleIds) || changed;
  }
  return changed;
}

function recordMessagesRoleIds(state: AppState, messages: readonly DiscordMessage[], fallbackGuildId: string | null | undefined): boolean {
  let changed = false;
  for (const message of messages) {
    changed = recordMessageRoleIds(state, message, fallbackGuildId) || changed;
  }
  return changed;
}

function recordMemberListRoleIds(state: AppState, guildId: string, members: readonly DiscordGuildMember[]): boolean {
  let changed = false;
  for (const member of members) {
    changed = recordMemberRoleIds(state, guildId, member.id, member.roleIds) || changed;
  }
  return changed;
}

function guildRolesIncludePermissions(roles: readonly DiscordRole[] | undefined): boolean {
  return Boolean(roles && roles.length > 0 && roles.every((role) => typeof role.permissions === "string"));
}

function guildRolesIncludeNamesAndPermissions(roles: readonly DiscordRole[] | undefined): boolean {
  return Boolean(roles
    && roles.length > 0
    && roles.every((role) => typeof role.permissions === "string")
    && roles.some((role) => typeof role.name === "string" && role.name.trim().length > 0));
}

export function loadGuildRolesInBackground(state: AppState, token: string, guildId: string, effects: SessionEffects): void {
  if (guildId === DIRECT_MESSAGES_GUILD_ID || guildRolesIncludeNamesAndPermissions(state.guildRolesByGuildId[guildId])) return;
  void fetchGuildRoles(token, guildId).then((roles) => {
    debugLog("guild_roles.fetched", {
      guildId,
      count: roles.length,
      withPermissions: roles.filter((role) => typeof role.permissions === "string").length,
      withNames: roles.filter((role) => typeof role.name === "string" && role.name.trim().length > 0).length,
    });
    state.guildRolesByGuildId[guildId] = roles;
    refreshHiddenChannelFlags(state, guildId);
    const accountId = currentAccountId(state);
    if (accountId) saveCachedGuildRoles(accountId, guildId, roles);
    state.memberRoleCacheVersion += 1;
    effects.scheduleRender();
  }).catch(() => {
    // Role colors are opportunistic. Missing role metadata should not disrupt chat.
  });
}

function currentGuildOrderNeedsSave(currentGuildIds: readonly string[], cachedGuildOrder: readonly string[] | null | undefined): boolean {
  if (currentGuildIds.length === 0) return false;
  if (!cachedGuildOrder || cachedGuildOrder.length === 0) return true;

  const currentGuildIdSet = new Set(currentGuildIds);
  if (cachedGuildOrder.some((guildId) => !currentGuildIdSet.has(guildId))) return true;

  const cachedExistingGuildIds = cachedGuildOrder.filter((guildId) => currentGuildIdSet.has(guildId));
  return cachedExistingGuildIds.length !== currentGuildIds.length
    || cachedExistingGuildIds.some((guildId, index) => guildId !== currentGuildIds[index]);
}

function persistSidebarGuilds(state: AppState, options: { order?: boolean } = {}): void {
  const accountId = currentAccountId(state);
  if (!accountId) return;
  const guilds = sidebarCachedGuilds(state.sidebar);
  saveCachedGuilds(accountId, guilds);
  if (options.order ?? true) saveCachedGuildOrder(accountId, guilds.map((guild) => guild.id));
}

const VIEW_CHANNEL_PERMISSION = 1n << 10n;
const ADMINISTRATOR_PERMISSION = 1n << 3n;

function permissionBits(value: string | number | null | undefined): bigint {
  try {
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string" && value.trim()) return BigInt(value);
  } catch {
    // Malformed permission bitfields should behave like missing permissions.
  }
  return 0n;
}

function applyOverwrite(permissions: bigint, overwrite: { allow: string; deny: string }): bigint {
  return (permissions & ~permissionBits(overwrite.deny)) | permissionBits(overwrite.allow);
}

function canViewGuildChannel(
  channel: DiscordChannel,
  guildId: string,
  roles: readonly DiscordRole[] | undefined,
  currentUserRoleIds: readonly string[] | undefined,
  currentUserId: string | null | undefined,
): boolean | null {
  if (channel.guildId === DIRECT_MESSAGES_GUILD_ID) return true;
  if (!guildRolesIncludePermissions(roles) || !currentUserRoleIds || !currentUserId) return null;

  const usableRoles = roles ?? [];
  const rolesById = new Map(usableRoles.map((role) => [role.id, role]));
  let permissions = permissionBits(rolesById.get(guildId)?.permissions);
  for (const roleId of currentUserRoleIds) {
    permissions |= permissionBits(rolesById.get(roleId)?.permissions);
  }

  if ((permissions & ADMINISTRATOR_PERMISSION) !== 0n) return true;

  const overwrites = channel.permissionOverwrites ?? [];
  const everyoneOverwrite = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyoneOverwrite) permissions = applyOverwrite(permissions, everyoneOverwrite);

  let roleAllow = 0n;
  let roleDeny = 0n;
  const currentRoleIds = new Set(currentUserRoleIds);
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !currentRoleIds.has(overwrite.id)) continue;
    roleAllow |= permissionBits(overwrite.allow);
    roleDeny |= permissionBits(overwrite.deny);
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === currentUserId);
  if (memberOverwrite) permissions = applyOverwrite(permissions, memberOverwrite);

  return (permissions & VIEW_CHANNEL_PERMISSION) !== 0n;
}

function refreshHiddenChannelFlags(state: AppState, guildId: string | null | undefined): void {
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return;
  const roles = state.guildRolesByGuildId[guildId];
  const currentUserId = state.auth.user?.id ?? null;
  const currentUserRoleIds = state.roleIdsByGuildId[guildId]
    ?? (currentUserId ? state.memberRoleIdsByGuildId[guildId]?.[currentUserId] : undefined);
  const hiddenBefore = state.channelList.channels.filter((channel) => channel.guildId === guildId && channel.hidden).length;
  let changed = false;
  let evaluated = 0;

  state.channelList.channels = state.channelList.channels.map((channel) => {
    if (channel.guildId !== guildId) return channel;
    const canView = canViewGuildChannel(channel, guildId, roles, currentUserRoleIds, currentUserId);
    if (canView === null) return channel;
    evaluated += 1;
    const hidden = !canView;
    if (channel.hidden === hidden) return channel;
    changed = true;
    return { ...channel, hidden };
  });

  if (changed) {
    state.channelList.activeChannel = state.channelList.activeChannelId
      ? state.channelList.channels.find((channel) => channel.id === state.channelList.activeChannelId) ?? state.channelList.activeChannel
      : state.channelList.activeChannel;
  }

  debugLog("channel_visibility.refresh", {
    guildId,
    total: state.channelList.channels.filter((channel) => channel.guildId === guildId).length,
    evaluated,
    hiddenBefore,
    hiddenAfter: state.channelList.channels.filter((channel) => channel.guildId === guildId && channel.hidden).length,
    changed,
    hasRoles: guildRolesIncludePermissions(roles),
    roleCount: roles?.length ?? 0,
    hasSelfRoles: Boolean(currentUserRoleIds),
    selfRoleCount: currentUserRoleIds?.length ?? 0,
    selfRoleSource: state.roleIdsByGuildId[guildId] ? "gateway" : currentUserRoleIds ? "member_cache" : "missing",
    channelOverwriteCount: state.channelList.channels.filter((channel) => channel.guildId === guildId && Array.isArray(channel.permissionOverwrites)).length,
  });
}

function withCurrentDirectMessagesGuild(state: AppState, guilds: DiscordGuild[]): DiscordGuild[] {
  return state.sidebar.guilds.some((guild) => guild.id === DIRECT_MESSAGES_GUILD_ID)
    ? [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }, ...guilds]
    : guilds;
}

function mergeGatewayGuilds(
  state: AppState,
  guilds: DiscordGuild[],
  options: { newGuilds?: "top" | "bottom" } = {},
): boolean {
  if (guilds.length === 0) return false;
  const newGuilds = options.newGuilds ?? "bottom";
  const byGuildId = new Map(sidebarCachedGuilds(state.sidebar).map((guild) => [guild.id, guild]));
  const order = sidebarCachedGuilds(state.sidebar).map((guild) => guild.id);
  const prepended: string[] = [];
  let changed = false;
  let orderChanged = false;

  for (const guild of guilds) {
    if (guild.id === DIRECT_MESSAGES_GUILD_ID) continue;
    const existing = byGuildId.get(guild.id);
    if (!existing) {
      byGuildId.set(guild.id, guild);
      if (newGuilds === "top") prepended.push(guild.id);
      else order.push(guild.id);
      changed = true;
      orderChanged = true;
      continue;
    }
    const merged = { ...existing, name: guild.name, icon: guild.icon };
    if (existing.name !== merged.name || existing.icon !== merged.icon) changed = true;
    byGuildId.set(guild.id, merged);
  }

  if (!changed) return false;
  const nextOrder = [...prepended, ...order.filter((guildId) => !prepended.includes(guildId))];
  setSidebarGuilds(state.sidebar, withCurrentDirectMessagesGuild(state, nextOrder.map((guildId) => byGuildId.get(guildId)!).filter(Boolean)));
  persistSidebarGuilds(state, { order: orderChanged });
  return true;
}

function mergeRestGuilds(
  state: AppState,
  directMessages: DiscordChannel[],
  guilds: DiscordGuild[],
  guildOrder: readonly string[] | null,
): void {
  const currentGuilds = sidebarCachedGuilds(state.sidebar);
  const restByGuildId = new Map(guilds.map((guild) => [guild.id, guild]));

  const existingGuilds = currentGuilds
    .filter((guild) => restByGuildId.has(guild.id))
    .map((guild) => {
      const fresh = restByGuildId.get(guild.id)!;
      return { ...guild, name: fresh.name, icon: fresh.icon };
    });
  const included = new Set(existingGuilds.map((guild) => guild.id));
  const newGuilds = guilds.filter((guild) => !included.has(guild.id));
  const orderedGuilds = sortGuildsByOrder([...existingGuilds, ...newGuilds], guildOrder);

  setSidebarGuilds(state.sidebar, cachedSidebarGuilds(directMessages, orderedGuilds));
}

function removeGatewayGuild(state: AppState, guildId: string): boolean {
  if (guildId === DIRECT_MESSAGES_GUILD_ID || !state.sidebar.guilds.some((guild) => guild.id === guildId)) return false;
  const nextGuilds = sidebarCachedGuilds(state.sidebar).filter((guild) => guild.id !== guildId);
  setSidebarGuilds(state.sidebar, withCurrentDirectMessagesGuild(state, nextGuilds));
  persistSidebarGuilds(state);
  clearGuildNotifications(state.notifications, guildId);
  persistNotifications(state);
  if (state.channelList.guildId === guildId) {
    clearChannelList(state.channelList);
    clearTimeline(state.timeline);
  }
  return true;
}

function applyGuildMuteSettings(state: AppState, mutedByGuildId: Record<string, boolean>): void {
  applySidebarGuildMuteSettings(state.sidebar, mutedByGuildId);
  for (const [guildId, muted] of Object.entries(mutedByGuildId)) {
    if (muted) clearGuildNotifications(state.notifications, guildId);
  }
  persistSidebarGuilds(state, { order: false });
  persistNotifications(state);
}

function applyCachedNotifications(state: AppState): void {
  const accountId = currentAccountId(state);
  if (!accountId) return;
  const cachedNotifications = loadCachedNotifications(accountId);
  if (!cachedNotifications) return;

  replaceNotifications(
    state.notifications,
    Object.entries(cachedNotifications.byChannelId)
      .filter(([channelId, count]) => count > 0
        && !isSidebarGuildMuted(state.sidebar, cachedNotifications.channelGuildIds[channelId]))
      .map(([channelId, count]) => ({
        channelId,
        guildId: cachedNotifications.channelGuildIds[channelId] ?? null,
        count,
      })),
  );
}

function clearNotificationsForChannel(state: AppState, channelId: string): void {
  clearChannelNotifications(state.notifications, channelId);
  persistNotifications(state);
}

function markChannelRead(state: AppState, token: string | null, channelId: string, messageId: string): void {
  clearNotificationsForChannel(state, channelId);
  if (!token) return;

  void ackChannelMessage(token, channelId, messageId).catch(() => {
    // Keep read acknowledgements best-effort; failing to ack should not disrupt chat.
  });
}

function persistChannelMessageCache(state: AppState, channelId: string): void {
  const accountId = currentAccountId(state);
  const entry = state.messageCacheByChannelId[channelId];
  if (accountId && entry) saveCachedChannelMessages(accountId, channelId, entry);
}

function latestTimelineMessageId(state: AppState, channelId: string): string | null {
  if (state.timeline.channelId !== channelId) return null;
  const latest = state.timeline.messages.at(-1);
  if (!latest || latest.localStatus) return null;
  return latest.id;
}

function subscribeAppGatewayToActiveChannel(state: AppState): void {
  const channel = state.channelList.activeChannel;
  appGateway?.subscribeToGuildChannel(channel?.guildId, channel?.id);
}

function callDisplayName(session: VoiceCallSession | null): string {
  return session?.target.displayName || "call";
}

function ensureVoiceCallController(state: AppState, token: string, effects: SessionEffects): VoiceCallController | null {
  const selfUserId = state.auth.user?.id;
  if (!selfUserId || !appGateway || appGatewayToken !== token) return null;
  if (voiceCallController) return voiceCallController;

  voiceCallController = new VoiceCallController({
    selfUserId,
    signaling: appGateway,
    ringRecipients: (channelId, recipientIds) => ringDirectMessageCall(token, channelId, recipientIds),
    onStateChange: (session) => {
      debugLog("voice.state", { state: session?.state ?? "idle", channelId: session?.target.channelId ?? null });
    },
    onError: (error) => {
      setNotice(state, `Voice call: ${error.message}`, "warning", { chat: false });
      effects.scheduleRender();
    },
  });
  return voiceCallController;
}

function startAppGateway(state: AppState, token: string, effects: SessionEffects): void {
  if (appGateway && appGatewayToken === token) return;
  disconnectAppGateway();
  appGatewayToken = token;
  appGateway = new AppGatewayClient(token, {
    onCurrentUserRoleIds: (roleIdsByGuildId) => {
      debugLog("gateway.self_roles.ready", {
        guilds: Object.keys(roleIdsByGuildId).length,
        currentGuildId: state.channelList.guildId,
        currentGuildRoles: state.channelList.guildId ? (roleIdsByGuildId[state.channelList.guildId]?.length ?? null) : null,
      });
      state.roleIdsByGuildId = roleIdsByGuildId;
      if (state.auth.user) {
        for (const [guildId, roleIds] of Object.entries(roleIdsByGuildId)) {
          recordMemberRoleIds(state, guildId, state.auth.user.id, roleIds);
          refreshHiddenChannelFlags(state, guildId);
        }
      }
      effects.scheduleRender();
    },
    onCurrentUserGuildRoles: (guildId, roleIds) => {
      debugLog("gateway.self_roles.update", { guildId, count: roleIds.length });
      state.roleIdsByGuildId[guildId] = roleIds;
      if (state.auth.user) recordMemberRoleIds(state, guildId, state.auth.user.id, roleIds);
      refreshHiddenChannelFlags(state, guildId);
      effects.scheduleRender();
    },
    onGuildMuteSettings: (mutedByGuildId) => {
      applyGuildMuteSettings(state, mutedByGuildId);
      effects.scheduleRender();
    },
    onGuildMuteSetting: (guildId, muted) => {
      applyGuildMuteSettings(state, { [guildId]: muted });
      effects.scheduleRender();
    },
    onReadyGuilds: (guilds) => {
      if (mergeGatewayGuilds(state, guilds)) {
        for (const guild of guilds) loadGuildRolesInBackground(state, token, guild.id, effects);
        effects.scheduleRender();
      }
    },
    onGuildCreate: (guild) => {
      if (mergeGatewayGuilds(state, [guild])) {
        loadGuildRolesInBackground(state, token, guild.id, effects);
        effects.scheduleRender();
      }
    },
    onGuildUpdate: (guild) => {
      if (mergeGatewayGuilds(state, [guild])) effects.scheduleRender();
    },
    onGuildDelete: (guildId) => {
      if (removeGatewayGuild(state, guildId)) effects.scheduleRender();
    },
    onInitialNotifications: (notifications) => {
      replaceNotifications(
        state.notifications,
        notifications.filter((notification) => notification.channelId !== state.timeline.channelId
          && !isSidebarGuildMuted(state.sidebar, notification.guildId)),
      );
      persistNotifications(state);
      const latestMessageId = state.timeline.channelId ? latestTimelineMessageId(state, state.timeline.channelId) : null;
      if (state.timeline.channelId && latestMessageId && isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) {
        markChannelRead(state, state.auth.savedToken, state.timeline.channelId, latestMessageId);
      }
      effects.scheduleRender();
    },
    onVoiceStateUpdate: (update) => {
      voiceCallController?.handleVoiceStateUpdate(update);
    },
    onVoiceServerUpdate: (update) => {
      voiceCallController?.handleVoiceServerUpdate(update);
    },
    onMessageCreate: (message) => handleGatewayMessageCreate(state, effects, message),
    onMessageUpdate: (message) => handleGatewayMessageUpdate(state, effects, message),
    onMessageDelete: (channelId, messageId) => {
      if (removeCachedChannelMessage(state.messageCacheByChannelId, channelId, messageId)) {
        persistChannelMessageCache(state, channelId);
      }
      removeTimelineMessage(state.timeline, messageId, channelId);
      effects.scheduleRender();
    },
    onMessageDeleteBulk: (channelId, messageIds) => {
      if (removeCachedChannelMessages(state.messageCacheByChannelId, channelId, messageIds)) {
        persistChannelMessageCache(state, channelId);
      }
      removeTimelineMessages(state.timeline, messageIds, channelId);
      effects.scheduleRender();
    },
    onMessageAck: (channelId) => {
      clearNotificationsForChannel(state, channelId);
      effects.scheduleRender();
    },
    onChannelCreate: (channel) => handleGatewayChannelCreateOrUpdate(state, effects, channel),
    onChannelUpdate: (channel) => handleGatewayChannelCreateOrUpdate(state, effects, channel),
    onChannelDelete: (channelId) => handleGatewayChannelDelete(state, effects, channelId),
    onTypingStart: (channelId, userId, displayName) => {
      recordTypingStart(state.typing, channelId, { id: userId, displayName: displayNameForUser(state, channelId, userId, displayName) });
      effects.scheduleRender();
    },
    onError: (error) => {
      setNotice(state, error.message, "warning");
      effects.scheduleRender();
    },
  });
  appGateway.start();
  subscribeAppGatewayToActiveChannel(state);
}

export function clearReadOnlyClient(state: AppState): void {
  disconnectMemberListGateway();
  disconnectAppGateway();
  disconnectGuildOrderSync();
  state.sidebar.requestId += 1;
  state.channelList.requestId += 1;
  state.timeline.requestId += 1;
  clearSidebarData(state.sidebar);
  clearMemberListData(state.memberList);
  clearChannelList(state.channelList);
  clearTimeline(state.timeline);
  replaceNotifications(state.notifications, []);
  state.roleIdsByGuildId = {};
  state.guildRolesByGuildId = {};
  state.memberRoleIdsByGuildId = {};
  state.messageCacheByChannelId = {};
  state.replyTarget = null;
  state.editTarget = null;
  state.memberRoleCacheVersion += 1;
  focusPrompt(state);
}

function loadMemberListPlaceholder(state: AppState, guildId: string | null, channelId: string | null): void {
  if (!state.memberList.open) {
    debugLog("member_list.placeholder_skipped", { guildId, channelId, reason: "sidebar_closed" });
    return;
  }

  if (!guildId) {
    setMemberListMessage(state.memberList, null, null, "No members.");
    return;
  }

  if (guildId === DIRECT_MESSAGES_GUILD_ID) {
    const members = buildDirectMessageMemberList(state);
    if (channelId && members.length > 0) {
      setMemberListMembers(state.memberList, guildId, channelId, members, state.auth.user?.id ?? null);
    } else {
      setMemberListMessage(state.memberList, guildId, channelId, "No members.");
    }
    return;
  }

  if (!channelId) {
    setMemberListMessage(state.memberList, guildId, null, "No members.");
    return;
  }

  const accountId = currentAccountId(state);
  const memoryCached = getCachedMemberList(state.memberList, guildId, channelId);
  const diskCached = memoryCached ? null : accountId ? loadCachedMemberList(accountId, guildId, channelId) : null;
  const cached = memoryCached ?? diskCached;
  debugLog("member_list.placeholder_cache", { guildId, channelId, source: memoryCached ? "memory" : diskCached ? "disk" : "miss", count: cached?.length ?? 0 });
  if (cached) {
    cacheMemberList(state.memberList, guildId, channelId, cached);
    setMemberListMembers(state.memberList, guildId, channelId, cached, state.auth.user?.id ?? null);
    return;
  }

  setMemberListLoading(state.memberList, guildId, channelId);
}

export function syncMemberListForGuild(state: AppState, effects: SessionEffects, _guildId?: string | null): void {
  syncMemberListForCurrentChannel(state, effects);
}

export function syncMemberListForCurrentChannel(state: AppState, effects: SessionEffects): void {
  const token = state.auth.savedToken;
  const activeChannel = state.channelList.activeChannel;
  const guildId = activeChannel?.guildId ?? state.channelList.guildId;
  const channelId = activeChannel?.id ?? null;
  const requestId = ++state.memberList.requestId;
  debugLog("member_list.sync", { guildId, channelId, requestId, sidebarOpen: state.memberList.open, activeChannelId: state.channelList.activeChannelId });

  loadMemberListPlaceholder(state, guildId, channelId);
  if (state.memberList.open) effects.scheduleRender();

  if (!token || !guildId || !channelId || guildId === DIRECT_MESSAGES_GUILD_ID) {
    debugLog("member_list.sync_skipped", { guildId, channelId, requestId, reason: !token ? "missing_token" : !guildId ? "missing_guild" : !channelId ? "missing_channel" : "direct_messages" });
    disconnectMemberListGateway();
    return;
  }

  const gateway = getMemberListGateway(token);
  const subscribe = (attempt: number): void => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const clearPending = (): void => {
      settled = true;
      clearTimeout(timeoutId);
    };
    const isCurrentTarget = (): boolean => (
      requestId === state.memberList.requestId
      && state.channelList.activeChannelId === channelId
    );
    const retryOrTimeout = (): void => {
      if (settled) return;
      if (!isCurrentTarget()) {
        debugLog("member_list.timeout_ignored", { guildId, channelId, requestId, attempt, activeChannelId: state.channelList.activeChannelId, currentRequestId: state.memberList.requestId });
        return;
      }
      settled = true;
      debugLog("member_list.timeout", { guildId, channelId, requestId, attempt });
      if (attempt < MEMBER_LIST_SUBSCRIBE_RETRIES) {
        debugLog("member_list.retry", { guildId, channelId, requestId, nextAttempt: attempt + 1, reason: "timeout" });
        subscribe(attempt + 1);
        return;
      }
      disconnectMemberListGateway();
      if (state.memberList.open && state.memberList.loading) {
        setMemberListMessage(state.memberList, guildId, channelId, "Timed out waiting for member list updates.");
        effects.scheduleRender();
      }
    };

    debugLog("member_list.subscribe_attempt", { guildId, channelId, requestId, attempt });
    timeoutId = setTimeout(retryOrTimeout, MEMBER_LIST_SUBSCRIBE_TIMEOUT_MS);
    void gateway.subscribe(guildId, channelId, {
      onMembers: (members) => {
        if (settled) {
          debugLog("member_list.members_ignored", { guildId, channelId, requestId, attempt, reason: "settled", count: members.length });
          return;
        }
        clearPending();
        if (!isCurrentTarget()) {
          debugLog("member_list.members_ignored", { guildId, channelId, requestId, attempt, reason: "stale_target", count: members.length, activeChannelId: state.channelList.activeChannelId, currentRequestId: state.memberList.requestId });
          return;
        }
        debugLog("member_list.members", { guildId, channelId, requestId, attempt, count: members.length });
        const roleIdsChanged = recordMemberListRoleIds(state, guildId, members);
        cacheMemberList(state.memberList, guildId, channelId, members);
        const accountId = currentAccountId(state);
        if (accountId) saveCachedMemberList(accountId, guildId, channelId, members);
        if (state.memberList.open) {
          setMemberListMembers(state.memberList, guildId, channelId, members, state.auth.user?.id ?? null);
          effects.scheduleRender();
        } else if (roleIdsChanged) {
          effects.scheduleRender();
        }
      },
      onError: (error) => {
        if (settled) {
          debugLog("member_list.error_ignored", { guildId, channelId, requestId, attempt, reason: "settled", error: error.message });
          return;
        }
        clearPending();
        if (!isCurrentTarget()) {
          debugLog("member_list.error_ignored", { guildId, channelId, requestId, attempt, reason: "stale_target", error: error.message, activeChannelId: state.channelList.activeChannelId, currentRequestId: state.memberList.requestId });
          return;
        }
        debugLog("member_list.error", { guildId, channelId, requestId, attempt, error: error.message });
        if (attempt < MEMBER_LIST_SUBSCRIBE_RETRIES) {
          debugLog("member_list.retry", { guildId, channelId, requestId, nextAttempt: attempt + 1, reason: "error" });
          subscribe(attempt + 1);
          return;
        }
        if (state.memberList.open && state.memberList.loading) {
          setMemberListMessage(state.memberList, guildId, channelId, error.message);
          effects.scheduleRender();
        }
      },
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (settled) {
        debugLog("member_list.subscribe_error_ignored", { guildId, channelId, requestId, attempt, reason: "settled", error: message });
        return;
      }
      clearPending();
      if (!isCurrentTarget()) {
        debugLog("member_list.subscribe_error_ignored", { guildId, channelId, requestId, attempt, reason: "stale_target", error: message, activeChannelId: state.channelList.activeChannelId, currentRequestId: state.memberList.requestId });
        return;
      }
      debugLog("member_list.subscribe_error", { guildId, channelId, requestId, attempt, error: message });
      if (attempt < MEMBER_LIST_SUBSCRIBE_RETRIES) {
        debugLog("member_list.retry", { guildId, channelId, requestId, nextAttempt: attempt + 1, reason: "subscribe_error" });
        subscribe(attempt + 1);
        return;
      }
      if (state.memberList.open && state.memberList.loading) {
        setMemberListMessage(state.memberList, guildId, channelId, message);
        effects.scheduleRender();
      }
    });
  };

  subscribe(0);
}

export async function bootstrapReadOnlyClient(
  state: AppState,
  token: string,
  effects: SessionEffects,
): Promise<void> {
  const requestId = ++state.sidebar.requestId;
  const accountId = currentAccountId(state);
  const previousExpandedGuildId = state.sidebar.expandedGuildId;
  const previousActiveGuildId = state.sidebar.activeGuildId;
  const previousChannelListGuildId = state.channelList.guildId;
  const previousChannels = state.channelList.channels;
  const previousActiveChannel = state.channelList.activeChannel;
  const previousActiveChannelId = state.channelList.activeChannelId;
  state.sidebar.loading = true;
  state.sidebar.loadingGuildId = null;
  disconnectMemberListGateway();
  clearMemberListData(state.memberList);
  clearTimeline(state.timeline);
  setNotice(state, "", "muted");

  if (accountId) {
    ensureGuildOrderSync(state, effects);
    const cachedDirectMessages = loadCachedDirectMessages(accountId) ?? [];
    const cachedGuildOrder = loadCachedGuildOrder(accountId);
    const cachedGuilds = sortGuildsByOrder(loadCachedGuilds(accountId) ?? [], cachedGuildOrder);
    state.guildRolesByGuildId = loadCachedGuildRoles(accountId);
    state.memberRoleIdsByGuildId = loadCachedMemberRoles(accountId);
    state.messageCacheByChannelId = loadCachedChannelMessages(accountId);
    state.memberRoleCacheVersion += 1;
    if (cachedDirectMessages.length > 0 || cachedGuilds.length > 0) {
      setSidebarGuilds(state.sidebar, cachedSidebarGuilds(cachedDirectMessages, cachedGuilds));
      applyCachedNotifications(state);
      state.sidebar.expandedGuildId = previousExpandedGuildId;
      state.sidebar.activeGuildId = previousActiveGuildId;
      if (previousChannelListGuildId && previousChannels.length > 0) {
        setChannelList(state.channelList, previousChannelListGuildId, previousChannels);
        refreshHiddenChannelFlags(state, previousChannelListGuildId);
        setActiveChannelEntry(state.channelList, previousActiveChannel ?? findBrowsableChannel(previousChannels, previousActiveChannelId));
      }
    }
  }
  effects.scheduleRender();

  try {
    const directMessages = await fetchDirectMessages(token);
    const guilds = await fetchGuilds(token);
    const guildOrder = accountId ? loadCachedGuildOrder(accountId) : null;
    if (requestId !== state.sidebar.requestId) return;

    const liveExpandedGuildId = state.sidebar.expandedGuildId;
    const liveActiveGuildId = state.sidebar.activeGuildId;
    const liveChannelListGuildId = state.channelList.guildId;
    const liveChannels = state.channelList.channels;
    const liveActiveChannel = state.channelList.activeChannel;
    const liveActiveChannelId = state.channelList.activeChannelId;

    state.sidebar.loading = false;
    mergeRestGuilds(state, directMessages, guilds, guildOrder);
    state.sidebar.expandedGuildId = liveExpandedGuildId;
    state.sidebar.activeGuildId = liveActiveGuildId;
    if (liveChannelListGuildId && liveChannels.length > 0) {
      setChannelList(state.channelList, liveChannelListGuildId, liveChannels);
      refreshHiddenChannelFlags(state, liveChannelListGuildId);
      setActiveChannelEntry(state.channelList, liveActiveChannel ?? findBrowsableChannel(liveChannels, liveActiveChannelId));
    }
    if (accountId) {
      saveCachedDirectMessages(accountId, directMessages);
      persistSidebarGuilds(state, { order: currentGuildOrderNeedsSave(sidebarCachedGuilds(state.sidebar).map((guild) => guild.id), guildOrder) });
    }
    for (const guild of guilds) {
      loadGuildRolesInBackground(state, token, guild.id, effects);
    }
    startAppGateway(state, token, effects);

    if (state.sidebar.guilds.length === 0) {
      clearChannelList(state.channelList);
      clearTimeline(state.timeline);
      setNotice(state, "No servers or direct messages available for this account.", "warning");
      effects.scheduleRender();
      return;
    }

    if (!liveChannelListGuildId || liveChannels.length === 0) {
      clearChannelList(state.channelList);
    }
    setNotice(state, "", "muted");
    effects.scheduleRender();
    return;
  } catch (error) {
    if (requestId !== state.sidebar.requestId) return;
    state.sidebar.loading = false;
    setNotice(state, error instanceof Error ? error.message : String(error), "error");
    effects.scheduleRender();
  }
}

export async function loadGuildChannels(
  state: AppState,
  token: string,
  guildId: string,
  effects: SessionEffects,
  options: LoadGuildChannelsOptions = {},
): Promise<void> {
  const requestId = ++state.channelList.requestId;
  const accountId = currentAccountId(state);
  state.sidebar.expandedGuildId = guildId;
  state.sidebar.loadingGuildId = guildId;
  state.channelList.loading = true;

  const isDirectMessages = guildId === DIRECT_MESSAGES_GUILD_ID;
  let showedCachedChannels = false;
  const guildName = isDirectMessages
    ? DIRECT_MESSAGES_GUILD_NAME
    : state.sidebar.guilds.find((guild) => guild.id === guildId)?.name ?? "server";
  if (options.openFirstChannel) {
    clearTimeline(state.timeline);
    setNotice(state, "", "muted");
  }
  if (accountId) {
    if (!isDirectMessages && !state.roleIdsByGuildId[guildId] && !state.memberRoleIdsByGuildId[guildId]?.[accountId]) {
      try {
        const roleIds = await fetchCurrentUserGuildRoleIds(token, guildId);
        debugLog("current_member_roles.fetched_before_cache", { guildId, count: roleIds.length });
        state.roleIdsByGuildId[guildId] = roleIds;
        recordMemberRoleIds(state, guildId, accountId, roleIds);
      } catch (error) {
        debugLog("current_member_roles.fetch_failed", { guildId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const cachedChannels = isDirectMessages
      ? loadCachedDirectMessages(accountId)
      : loadCachedGuildChannels(accountId, guildId);
    debugLog("channel_cache.load", {
      guildId,
      accountId,
      directMessages: isDirectMessages,
      hit: Boolean(cachedChannels?.length),
      count: cachedChannels?.length ?? 0,
      withOverwrites: cachedChannels?.filter((channel) => Array.isArray(channel.permissionOverwrites)).length ?? 0,
      roles: state.guildRolesByGuildId[guildId]?.length ?? 0,
      rolesWithPerms: state.guildRolesByGuildId[guildId]?.filter((role) => typeof role.permissions === "string").length ?? 0,
      cachedSelfRoles: state.auth.user?.id ? (state.memberRoleIdsByGuildId[guildId]?.[state.auth.user.id]?.length ?? null) : null,
      liveSelfRoles: state.roleIdsByGuildId[guildId]?.length ?? null,
    });
    if (cachedChannels && cachedChannels.length > 0) {
      showedCachedChannels = true;
      setChannelList(state.channelList, guildId, cachedChannels);
      refreshHiddenChannelFlags(state, guildId);
      state.channelList.loading = false;
      if (state.sidebar.loadingGuildId === guildId) {
        state.sidebar.loadingGuildId = null;
      }
      if (options.openFirstChannel) {
        const cachedChannel = findBrowsableChannel(cachedChannels, state.channelList.activeChannelId)
          ?? findFirstBrowsableChannel(cachedChannels);
        setActiveChannelEntry(state.channelList, cachedChannel);
        if (cachedChannel) state.sidebar.activeGuildId = cachedChannel.guildId;
        subscribeAppGatewayToActiveChannel(state);
      }
    }
  }
  effects.scheduleRender();

  try {
    const channels = isDirectMessages
      ? await fetchDirectMessages(token)
      : await fetchGuildChannels(token, guildId);
    if (requestId !== state.channelList.requestId) return;

    state.channelList.loading = false;
    if (state.sidebar.loadingGuildId === guildId) {
      state.sidebar.loadingGuildId = null;
    }
    setChannelList(state.channelList, guildId, channels);
    refreshHiddenChannelFlags(state, guildId);
    debugLog("channel_cache.rest", {
      guildId,
      directMessages: isDirectMessages,
      count: channels.length,
      withOverwrites: channels.filter((channel) => Array.isArray(channel.permissionOverwrites)).length,
      overwritesNonEmpty: channels.filter((channel) => Array.isArray(channel.permissionOverwrites) && channel.permissionOverwrites.length > 0).length,
    });
    if (accountId) {
      if (isDirectMessages) {
        saveCachedDirectMessages(accountId, channels);
      } else {
        saveCachedGuildChannels(accountId, guildId, channels);
      }
    }

    if (!options.openFirstChannel) {
      effects.scheduleRender();
      return;
    }

    const channel = findBrowsableChannel(channels, state.channelList.activeChannelId)
      ?? findFirstBrowsableChannel(channels);
    if (!channel) {
      clearTimeline(state.timeline);
      setNotice(state, isDirectMessages ? "No direct messages available." : `No readable channels in ${guildName}.`, "warning");
      effects.scheduleRender();
      return;
    }

    setActiveChannelEntry(state.channelList, channel);
    state.sidebar.activeGuildId = channel.guildId;
    subscribeAppGatewayToActiveChannel(state);
    effects.scheduleRender();
    await loadChannelMessages(state, token, channel.id, effects);
  } catch (error) {
    if (requestId !== state.channelList.requestId) return;
    state.channelList.loading = false;
    if (state.sidebar.loadingGuildId === guildId) {
      state.sidebar.loadingGuildId = null;
    }

    if (options.openFirstChannel && !showedCachedChannels) {
      clearChannelList(state.channelList);
      clearTimeline(state.timeline);
    }
    setNotice(state, error instanceof Error ? error.message : String(error), "error");

    effects.scheduleRender();
  }
}

export async function loadChannelMessages(
  state: AppState,
  token: string,
  channelId: string,
  effects: SessionEffects,
): Promise<void> {
  const channel = findBrowsableChannel(state.channelList.channels, channelId);
  if (!channel) {
    setNotice(state, "That channel is not loaded yet.", "warning");
    effects.scheduleRender();
    return;
  }

  const requestId = ++state.timeline.requestId;
  clearNotificationsForChannel(state, channelId);
  setActiveChannel(state.channelList, channelId);
  if (state.replyTarget && state.replyTarget.channelId !== channelId) {
    state.replyTarget = null;
  }
  if (state.editTarget && state.editTarget.channelId !== channelId) {
    state.editTarget = null;
  }
  state.sidebar.activeGuildId = channel.guildId;
  subscribeAppGatewayToActiveChannel(state);
  state.timeline.loadingOlder = false;
  setNotice(state, "", "muted");
  syncMemberListForCurrentChannel(state, effects);
  const guildId = state.channelList.activeChannel?.guildId ?? null;
  if (guildId) loadGuildRolesInBackground(state, token, guildId, effects);

  const cached = cachedChannelMessages(state.messageCacheByChannelId, channelId);
  if (cached) {
    recordMessagesRoleIds(state, cached.messages, guildId);
    setTimelineMessages(state.timeline, channelId, cached.messages, { hasOlder: cached.hasOlder });
    const latestMessage = cached.messages.at(-1);
    if (latestMessage) markChannelRead(state, token, channelId, latestMessage.id);
    effects.scheduleRender();

    if (cachedChannelMessagesAreFresh(cached, Date.now(), MESSAGE_CACHE_FRESH_MS)) {
      return;
    }

    if (cached.messages.length > 0) {
      if (cached.latestFetchedAt === null) {
        state.timeline.loading = true;
        effects.scheduleRender();
      }
      void refreshLatestChannelMessages(state, token, channelId, guildId, requestId, effects, { hadCachedMessages: true });
      return;
    }
  } else {
    setTimelineMessages(state.timeline, channelId, [], { hasOlder: false });
  }

  state.timeline.loading = true;
  effects.scheduleRender();
  await refreshLatestChannelMessages(state, token, channelId, guildId, requestId, effects, { hadCachedMessages: false });
}

async function refreshLatestChannelMessages(
  state: AppState,
  token: string,
  channelId: string,
  guildId: string | null,
  requestId: number,
  effects: SessionEffects,
  options: { hadCachedMessages: boolean },
): Promise<void> {
  try {
    const fetchedMessages = await fetchChannelMessages(token, channelId, MESSAGE_PAGE_LIMIT);
    const messages = fetchedMessages.map((message) => withMessageGuildId(message, guildId));
    recordMessagesRoleIds(state, messages, guildId);
    const cacheEntry = setCachedChannelMessages(state.messageCacheByChannelId, channelId, messages, {
      hasOlder: messages.length >= MESSAGE_PAGE_LIMIT,
      updatedAt: Date.now(),
      replace: false,
    });
    persistChannelMessageCache(state, channelId);

    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    setTimelineMessages(state.timeline, channelId, cacheEntry.messages, { hasOlder: cacheEntry.hasOlder });
    const latestMessage = cacheEntry.messages.at(-1);
    if (latestMessage) {
      markChannelRead(state, token, channelId, latestMessage.id);
    }
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    state.timeline.loading = false;
    if (!options.hadCachedMessages) {
      clearTimeline(state.timeline);
      setNotice(state, error instanceof Error ? error.message : String(error), "error");
    }
    effects.scheduleRender();
  }
}

export async function loadOlderChannelMessages(
  state: AppState,
  token: string,
  channelId: string,
  width: number,
  effects: SessionEffects,
): Promise<void> {
  const oldestMessageId = state.timeline.messages[0]?.id;
  if (!oldestMessageId || state.timeline.channelId !== channelId) {
    finishLoadingOlderMessages(state.timeline, false);
    effects.scheduleRender();
    return;
  }

  const existingIds = new Set(state.timeline.messages.map((message) => message.id));
  const requestId = ++state.timeline.requestId;

  try {
    const olderMessages = await fetchChannelMessages(token, channelId, MESSAGE_PAGE_LIMIT, oldestMessageId);
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;

    const guildId = state.channelList.activeChannel?.guildId ?? null;
    const deduped = olderMessages
      .filter((message) => !existingIds.has(message.id))
      .map((message) => withMessageGuildId(message, guildId));
    const hasOlder = olderMessages.length >= MESSAGE_PAGE_LIMIT;
    recordMessagesRoleIds(state, deduped, guildId);
    setCachedChannelMessages(state.messageCacheByChannelId, channelId, deduped, { hasOlder, updatedAt: Date.now(), replace: false, latestFetched: false });
    persistChannelMessageCache(state, channelId);
    prependTimelineMessages(state.timeline, deduped, width, { hasOlder });
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    finishLoadingOlderMessages(state.timeline, state.timeline.hasOlder);
    setNotice(state, error instanceof Error ? error.message : String(error), "error");
    effects.scheduleRender();
  }
}

function activeReplyForChannel(state: AppState, channelId: string): SendMessageReplyOptions | null {
  const target = state.replyTarget;
  if (!target || target.channelId !== channelId) return null;
  return {
    messageId: target.messageId,
    channelId: target.channelId,
    guildId: target.guildId === DIRECT_MESSAGES_GUILD_ID ? null : target.guildId,
    mention: target.mention,
  };
}

function localReplyPreview(state: AppState, channelId: string): DiscordMessageReply | null {
  const target = state.replyTarget;
  if (!target || target.channelId !== channelId) return null;
  return {
    messageId: target.messageId,
    authorId: target.authorId,
    authorDisplayName: target.authorDisplayName,
    timestamp: target.timestamp,
    summary: target.summary,
    ...(target.mentionRoleIds ? { mentionRoleIds: target.mentionRoleIds } : {}),
    ...(target.mentionUsers ? { mentionUsers: target.mentionUsers } : {}),
  };
}

function uploadOptionsForImages(images: ClipboardImageAttachment[]): SendMessageUpload[] {
  return images.map((image) => ({
    filename: image.filename ?? "image.png",
    mediaType: image.mediaType,
    base64: image.base64,
  }));
}

function localAttachmentsForImages(images: ClipboardImageAttachment[]): DiscordMessageAttachment[] {
  return images.map((image, index) => ({
    id: `local:${index}`,
    filename: image.filename ?? "image.png",
    contentType: image.mediaType,
    size: image.sizeBytes,
    url: "",
  }));
}

export function editCurrentMessage(
  state: AppState,
  token: string | null,
  content: string,
  effects: SessionEffects,
  options: { sendContent?: string } = {},
): void {
  const target = state.editTarget;
  if (!target) return;
  if (!token) {
    setNotice(state, "Login first with /login <token|username>.", "warning");
    effects.scheduleRender();
    return;
  }
  if (content.length > 2_000) {
    setNotice(state, "Discord messages cannot exceed 2000 characters.", "warning");
    effects.scheduleRender();
    return;
  }
  if (content === target.originalContent) {
    clearPrompt(state);
    state.editTarget = null;
    setNotice(state, "", "muted");
    effects.scheduleRender();
    return;
  }

  const channelId = target.channelId;
  const messageId = target.messageId;
  const originalCached = state.messageCacheByChannelId[channelId]?.messages.find((message) => message.id === messageId) ?? null;
  const originalTimeline = state.timeline.channelId === channelId
    ? state.timeline.messages.find((message) => message.id === messageId) ?? null
    : null;
  const originalMessage = originalTimeline ?? originalCached;

  clearPrompt(state);
  state.pendingImages = [];
  state.editTarget = null;
  state.replyTarget = null;
  setNotice(state, "", "muted");

  const optimisticPatch: DiscordMessagePatch = {
    id: messageId,
    channelId,
    content,
    editedTimestamp: Date.now(),
  };
  const patchedCache = patchCachedChannelMessage(state.messageCacheByChannelId, optimisticPatch);
  if (patchedCache) persistChannelMessageCache(state, channelId);
  if (state.timeline.channelId === channelId) {
    patchTimelineMessage(state.timeline, optimisticPatch);
  }
  effects.scheduleRender();

  void (async () => {
    try {
      const editedMessage = await editChannelMessage(token, channelId, messageId, options.sendContent ?? content);
      const message = withMessageGuildId(editedMessage, originalMessage?.guildId ?? state.channelList.activeChannel?.guildId ?? null);
      recordMemberRoleIds(state, message.guildId ?? state.channelList.activeChannel?.guildId, message.author.id, message.author.roleIds);
      replaceCachedChannelMessage(state.messageCacheByChannelId, channelId, messageId, message);
      persistChannelMessageCache(state, channelId);
      if (state.timeline.channelId === channelId) {
        replaceTimelineMessage(state.timeline, messageId, message);
      }
      effects.scheduleRender();
    } catch (error) {
      if (originalMessage) {
        replaceCachedChannelMessage(state.messageCacheByChannelId, channelId, messageId, originalMessage);
        persistChannelMessageCache(state, channelId);
        if (state.timeline.channelId === channelId) {
          replaceTimelineMessage(state.timeline, messageId, originalMessage);
        }
      }
      state.editTarget = target;
      state.editor.buffer = content;
      state.editor.cursor = state.editor.buffer.length;
      const message = error instanceof Error ? error.message : String(error);
      setNotice(state, `Edit failed: ${message}`, "warning");
      effects.scheduleRender();
    }
  })();
}

export function sendCurrentChannelMessage(
  state: AppState,
  token: string | null,
  content: string,
  effects: SessionEffects,
  options: { sendContent?: string; localMentionUsers?: DiscordGuildMember[] } = {},
): void {
  const channelId = state.channelList.activeChannelId ?? state.timeline.channelId;
  if (!token) {
    setNotice(state, "Login first with /login <token|username>.", "warning");
    effects.scheduleRender();
    return;
  }
  if (!channelId) {
    setNotice(state, "Open a channel before sending a message.", "warning");
    effects.scheduleRender();
    return;
  }
  if (content.length > 2_000) {
    setNotice(state, "Discord messages cannot exceed 2000 characters.", "warning");
    effects.scheduleRender();
    return;
  }

  const viewer = state.auth.user;
  const localMessageId = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const replyTarget = state.replyTarget?.channelId === channelId ? state.replyTarget : null;
  const replyOptions = activeReplyForChannel(state, channelId);
  const replyPreview = localReplyPreview(state, channelId);
  const pendingImages = [...state.pendingImages];
  const uploads = uploadOptionsForImages(pendingImages);
  const localAttachments = localAttachmentsForImages(pendingImages);
  const sendContent = options.sendContent ?? content;
  clearPrompt(state);
  state.pendingImages = [];
  state.replyTarget = null;
  setNotice(state, "", "muted");

  const localMessage: DiscordMessage = {
    id: localMessageId,
    channelId,
    guildId: state.channelList.activeChannel?.guildId ?? null,
    type: 0,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    mentionUsers: [],
    timestamp: Date.now(),
    editedTimestamp: null,
    author: {
      id: viewer?.id ?? "me",
      username: viewer?.username ?? "me",
      displayName: viewer?.globalName ?? viewer?.username ?? "Me",
      bot: viewer?.bot ?? false,
    },
    reply: replyPreview,
    call: null,
    attachments: localAttachments,
    stickerNames: [],
    embedsCount: 0,
    localStatus: "pending",
    localSendContent: sendContent !== content ? sendContent : undefined,
    localMentionUsers: options.localMentionUsers && options.localMentionUsers.length > 0 ? options.localMentionUsers : undefined,
  };
  upsertCachedChannelMessage(state.messageCacheByChannelId, localMessage);
  if (state.timeline.channelId === channelId) {
    appendTimelineMessage(state.timeline, localMessage);
    state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  }
  effects.scheduleRender();

  void (async () => {
    try {
      const sentMessage = await sendChannelMessage(token, channelId, sendContent, { reply: replyOptions, uploads });
      const message = withMessageGuildId(sentMessage, state.channelList.activeChannel?.guildId ?? null);
      recordMemberRoleIds(state, message.guildId ?? state.channelList.activeChannel?.guildId, message.author.id, message.author.roleIds);
      replaceCachedChannelMessage(state.messageCacheByChannelId, channelId, localMessageId, message);
      persistChannelMessageCache(state, channelId);
      if (state.timeline.channelId === channelId) {
        replaceTimelineMessage(state.timeline, localMessageId, message);
        state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
      maybeResortDirectMessages(state, channelId, message.id);
      effects.scheduleRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cachedFailed = markCachedChannelMessageFailed(state.messageCacheByChannelId, channelId, localMessageId, message);
      const failed = markTimelineMessageFailed(state.timeline, localMessageId, message) ?? cachedFailed;
      state.replyTarget = replyTarget;
      state.pendingImages = pendingImages;
      state.editor.buffer = failed?.content ?? content;
      state.editor.cursor = state.editor.buffer.length;
      if (state.timeline.channelId === channelId) {
        state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
      setNotice(state, "", "muted");
      effects.scheduleRender();
    }
  })();
}

export function startCurrentDirectMessageCall(state: AppState, effects: SessionEffects): void {
  const token = state.auth.savedToken;
  if (!token || !state.auth.user) {
    setNotice(state, "Login required to start a call.", "warning");
    effects.scheduleRender();
    return;
  }

  const channel = state.channelList.activeChannel;
  if (!channel || !isDirectMessageChannel(channel)) {
    setNotice(state, "Open a DM to start a call.", "warning");
    effects.scheduleRender();
    return;
  }

  const recipients = (channel.recipients ?? [])
    .filter((recipient) => recipient.id !== state.auth.user?.id)
    .map((recipient) => recipient.id);
  if (recipients.length === 0) {
    setNotice(state, "No call recipients in this DM.", "warning");
    effects.scheduleRender();
    return;
  }

  const controller = ensureVoiceCallController(state, token, effects);
  if (!controller) {
    setNotice(state, "Discord gateway is still connecting; try again in a moment.", "warning");
    effects.scheduleRender();
    return;
  }

  const displayName = channel.name || "DM";
  setNotice(state, `Calling ${displayName}…`, "muted", { loading: true, chat: false });
  effects.scheduleRender();

  void controller.startCall({
    guildId: null,
    channelId: channel.id,
    recipientIds: recipients,
    displayName,
  }).then(({ session, warnings }) => {
    const suffix = warnings.length > 0 ? ` (${warnings[0]})` : "";
    setNotice(state, `Connected to ${callDisplayName(session)}.${suffix}`, warnings.length > 0 ? "warning" : "success", { chat: false });
    effects.scheduleRender();
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Call cancelled.") return;
    setNotice(state, `Failed to start call: ${message}`, "error", { chat: false });
    effects.scheduleRender();
  });
}

export function hangUpCurrentCall(state: AppState, effects: SessionEffects): void {
  if (!voiceCallController?.activeSession) {
    setNotice(state, "No active call.", "muted", { chat: false });
    effects.scheduleRender();
    return;
  }

  const name = callDisplayName(voiceCallController.activeSession);
  voiceCallController.leave();
  setNotice(state, `Left ${name}.`, "muted", { chat: false });
  effects.scheduleRender();
}

export function toggleSelectedGuildMute(state: AppState, effects: SessionEffects): void {
  const token = state.auth.savedToken;
  if (!token) {
    setNotice(state, "Login required to mute servers.", "warning");
    effects.scheduleRender();
    return;
  }

  const entry = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, { showHiddenChannels: state.showHiddenChannels });
  if (entry.kind !== "guild" || !entry.guildId || entry.guildId === DIRECT_MESSAGES_GUILD_ID) {
    setNotice(state, "Select a server row to mute or unmute it.", "muted");
    effects.scheduleRender();
    return;
  }

  const guild = state.sidebar.guilds.find((item) => item.id === entry.guildId);
  const previousMuted = Boolean(guild?.muted);
  const nextMuted = !previousMuted;
  const previousNotifications = {
    byChannelId: { ...state.notifications.byChannelId },
    channelGuildIds: { ...state.notifications.channelGuildIds },
  };
  setSidebarGuildMuted(state.sidebar, entry.guildId, nextMuted);
  if (nextMuted) {
    clearGuildNotifications(state.notifications, entry.guildId);
    persistNotifications(state);
  }
  persistSidebarGuilds(state, { order: false });
  setNotice(state, "", "muted");
  effects.scheduleRender();

  void setGuildMuted(token, entry.guildId, nextMuted).catch((error) => {
    setSidebarGuildMuted(state.sidebar, entry.guildId, previousMuted);
    state.notifications.byChannelId = previousNotifications.byChannelId;
    state.notifications.channelGuildIds = previousNotifications.channelGuildIds;
    persistSidebarGuilds(state, { order: false });
    persistNotifications(state);
    setNotice(state, `Failed to ${nextMuted ? "mute" : "unmute"} ${guild?.name ?? "server"}: ${error instanceof Error ? error.message : String(error)}`, "error");
    effects.scheduleRender();
  });
}

export function moveSelectedGuildOrder(state: AppState, effects: SessionEffects, direction: "up" | "down"): void {
  if (!currentAccountId(state)) {
    setNotice(state, "Login required to reorder servers.", "warning");
    effects.scheduleRender();
    return;
  }

  const move = moveSelectedSidebarGuild(state.sidebar, state.channelList.channels, direction, { showHiddenChannels: state.showHiddenChannels });
  if (!move) {
    setNotice(state, "Select a server row that can move.", "muted");
    effects.scheduleRender();
    return;
  }

  persistSidebarGuilds(state);
  setNotice(state, "", "muted");
  effects.scheduleRender();
}

export function ackCurrentChannelIfAtBottom(state: AppState): void {
  const channelId = state.timeline.channelId;
  if (!channelId || !isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) return;
  const latestMessageId = latestTimelineMessageId(state, channelId);
  if (!latestMessageId) return;
  markChannelRead(state, state.auth.savedToken, channelId, latestMessageId);
}

export function refreshReadOnlyClient(state: AppState, effects: SessionEffects): void {
  const token = state.auth.savedToken;
  if (!token) {
    setNotice(state, "Login first with /login <token|username>.", "warning");
    effects.scheduleRender();
    return;
  }

  void bootstrapReadOnlyClient(state, token, effects);
}
