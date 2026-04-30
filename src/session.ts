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
  type DiscordPresenceStatus,
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
import { CallWidgetController, discordAvatarUrl, type CallWidgetParticipant } from "./callwidget";
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
import { playLoopingSoundEffect, playSoundEffect, type SoundEffectPlaybackHandle } from "./soundeffects";
import { focusPrompt, setNotice } from "./state";
import {
  applySidebarGuildMuteSettings,
  clearSidebarData,
  getSelectedSidebarEntry,
  isSidebarGuildMuted,
  moveSelectedSidebarGuild,
  setSidebarCachedChannels,
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
  markTimelineCallEnded,
  prependTimelineMessages,
  patchTimelineMessage,
  removeTimelineMessage,
  removeTimelineMessages,
  replaceTimelineMessage,
  resolvePrimaryRoleColor,
  setTimelineMessages,
} from "./timeline";
import { clearTypingUser, recordTypingStart } from "./typing";
import { VoiceCallController, type VoiceCallSession, type VoiceStateUpdate } from "./voice";

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
const callWidget = new CallWidgetController();
const recentIncomingCallRingtones = new Map<string, number>();
const knownCallParticipantsByChannelId = new Map<string, Set<string>>();
const speakingCallUserIds = new Set<string>();
const outboundCallRingtonesByChannelId = new Map<string, SoundEffectPlaybackHandle>();
const INCOMING_CALL_RINGTONE_DEDUPE_MS = 15_000;
const OUTBOUND_CALL_RINGTONE_MAX_MS = 15_000;
const OUTBOUND_CALL_RINGTONE_REPEAT_MS = 2_500;

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
  speakingCallUserIds.clear();
  callWidget.stop();
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

function directMessagesGuild(): DiscordGuild {
  return { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null };
}

function withDirectMessagesGuild(guilds: DiscordGuild[]): DiscordGuild[] {
  return [directMessagesGuild(), ...guilds.filter((guild) => guild.id !== DIRECT_MESSAGES_GUILD_ID)];
}

function ensureDirectMessagesGuild(state: AppState): void {
  if (state.sidebar.guilds.some((guild) => guild.id === DIRECT_MESSAGES_GUILD_ID)) return;
  state.sidebar.guilds = withDirectMessagesGuild(state.sidebar.guilds);
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

function avatarHashForUser(state: AppState, channelId: string, userId: string): string | null {
  if (state.auth.user?.id === userId) return state.auth.user.avatar;
  const activeChannel = state.channelList.channels.find((channel) => channel.id === channelId);
  const fromRecipients = activeChannel?.recipients?.find((recipient) => recipient.id === userId)?.avatar;
  if (fromRecipients) return fromRecipients;
  const fromAnyDirectMessageRecipient = state.channelList.channels
    .flatMap((channel) => channel.recipients ?? [])
    .find((recipient) => recipient.id === userId)?.avatar;
  if (fromAnyDirectMessageRecipient) return fromAnyDirectMessageRecipient;
  const fromActiveMemberList = state.memberList.channelId === channelId
    ? state.memberList.members.find((member) => member.id === userId)?.avatar
    : null;
  if (fromActiveMemberList) return fromActiveMemberList;
  for (const members of state.memberList.cache.values()) {
    const cached = members.find((member) => member.id === userId)?.avatar;
    if (cached) return cached;
  }
  return null;
}

function callWidgetRoleColorForUser(state: AppState, sessionGuildId: string | null, channelId: string, userId: string): string | null {
  const guildId = sessionGuildId ?? state.channelList.channels.find((channel) => channel.id === channelId)?.guildId ?? null;
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return null;
  const roleIds = roleIdsForUser(state, guildId, channelId, userId);
  const color = resolvePrimaryRoleColor(state.guildRolesByGuildId[guildId] ?? [], roleIds);
  return color === null ? null : `#${color.toString(16).padStart(6, "0")}`;
}

function roleIdsForUser(state: AppState, guildId: string, channelId: string, userId: string): readonly string[] {
  if (state.auth.user?.id === userId && state.roleIdsByGuildId[guildId]) return state.roleIdsByGuildId[guildId];

  const cachedRoleIds = state.memberRoleIdsByGuildId[guildId]?.[userId];
  if (cachedRoleIds) return cachedRoleIds;

  const fromActiveMemberList = (state.memberList.channelId === channelId || state.memberList.guildId === guildId)
    ? state.memberList.members.find((member) => member.id === userId)?.roleIds
    : undefined;
  if (fromActiveMemberList) return fromActiveMemberList;

  for (const [key, members] of state.memberList.cache.entries()) {
    if (!key.startsWith(`${guildId}:`)) continue;
    const roleIds = members.find((member) => member.id === userId)?.roleIds;
    if (roleIds) return roleIds;
  }

  const fromTimeline = state.timeline.channelId === channelId
    ? state.timeline.messages.find((message) => message.author.id === userId)?.author.roleIds
    : undefined;
  if (fromTimeline) return fromTimeline;

  const fromCachedChannelMessages = state.messageCacheByChannelId[channelId]?.messages
    .find((message) => message.author.id === userId)?.author.roleIds;
  if (fromCachedChannelMessages) return fromCachedChannelMessages;

  for (const entry of Object.values(state.messageCacheByChannelId)) {
    const roleIds = entry.messages.find((message) => message.author.id === userId && message.guildId === guildId)?.author.roleIds;
    if (roleIds) return roleIds;
  }

  return [];
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

function maybePlayIncomingCallRingtone(state: AppState, channelId: string): void {
  if (voiceCallController?.activeSession?.target.channelId === channelId) return;
  const now = Date.now();
  const last = recentIncomingCallRingtones.get(channelId) ?? 0;
  if (now - last < INCOMING_CALL_RINGTONE_DEDUPE_MS) return;
  recentIncomingCallRingtones.set(channelId, now);
  playSoundEffect("ringtone");
}

function handleCallGatewayEvent(state: AppState, channelId: string, ringingUserIds: readonly string[]): void {
  const selfUserId = state.auth.user?.id;
  if (!selfUserId || !ringingUserIds.includes(selfUserId)) return;
  maybePlayIncomingCallRingtone(state, channelId);
}

function callHasRemoteParticipants(state: AppState, channelId: string): boolean {
  const selfUserId = state.auth.user?.id;
  for (const userId of knownCallParticipantsByChannelId.get(channelId) ?? []) {
    if (userId && userId !== selfUserId) return true;
  }
  return false;
}

function startOutboundCallRingtone(channelId: string): void {
  stopOutboundCallRingtone(channelId, "restart");
  if ((knownCallParticipantsByChannelId.get(channelId)?.size ?? 0) > 0) {
    debugLog("call.outbound_ringtone.skipped", { channelId, reason: "participant_already_present" });
    return;
  }
  const handle = playLoopingSoundEffect("callCalling", {
    intervalMs: OUTBOUND_CALL_RINGTONE_REPEAT_MS,
    maxDurationMs: OUTBOUND_CALL_RINGTONE_MAX_MS,
  });
  outboundCallRingtonesByChannelId.set(channelId, handle);
  debugLog("call.outbound_ringtone.start", {
    channelId,
    intervalMs: OUTBOUND_CALL_RINGTONE_REPEAT_MS,
    maxDurationMs: OUTBOUND_CALL_RINGTONE_MAX_MS,
  });
  setTimeout(() => {
    if (outboundCallRingtonesByChannelId.get(channelId) === handle) {
      outboundCallRingtonesByChannelId.delete(channelId);
      debugLog("call.outbound_ringtone.expired", { channelId });
    }
  }, OUTBOUND_CALL_RINGTONE_MAX_MS + 50);
}

function stopOutboundCallRingtone(channelId: string, reason: string): void {
  const handle = outboundCallRingtonesByChannelId.get(channelId);
  if (!handle) return;
  outboundCallRingtonesByChannelId.delete(channelId);
  handle.stop();
  debugLog("call.outbound_ringtone.stop", { channelId, reason });
}

function stopAllOutboundCallRingtones(reason: string): void {
  for (const channelId of Array.from(outboundCallRingtonesByChannelId.keys())) {
    stopOutboundCallRingtone(channelId, reason);
  }
}

function syncCallParticipantSounds(state: AppState, channelId: string, voiceStateUserIds: readonly string[]): boolean {
  const activeSession = voiceCallController?.activeSession;
  const selfUserId = state.auth.user?.id;
  if (!activeSession || activeSession.target.channelId !== channelId || activeSession.state === "ended" || activeSession.state === "error") {
    const baseline = new Set(voiceStateUserIds.filter((userId) => userId && userId !== selfUserId));
    knownCallParticipantsByChannelId.set(channelId, baseline);
    debugLog("call.participants.baseline", {
      source: "call_gateway_inactive",
      channelId,
      activeChannelId: activeSession?.target.channelId ?? null,
      activeState: activeSession?.state ?? null,
      participants: Array.from(baseline),
      rawVoiceStateUserIds: voiceStateUserIds,
    });
    return false;
  }

  const next = new Set(voiceStateUserIds.filter((userId) => userId && userId !== selfUserId));
  const previous = knownCallParticipantsByChannelId.get(channelId);
  if (!previous) {
    knownCallParticipantsByChannelId.set(channelId, next);
    debugLog("call.participants.snapshot", {
      source: "call_gateway",
      channelId,
      activeState: activeSession.state,
      previous: null,
      next: Array.from(next),
      after: Array.from(next),
      rawVoiceStateUserIds: voiceStateUserIds,
      baseline: true,
    });
    return false;
  }

  // DM call CALL_UPDATE voice-state snapshots can be partial/empty during
  // startup. Use them to discover new participants, but do not infer leaves
  // from users missing in a snapshot; VOICE_STATE_UPDATE is the authoritative
  // path for join/leave removals.
  const after = new Set(previous);
  let changed = false;
  for (const userId of next) {
    if (!previous.has(userId)) {
      after.add(userId);
      stopOutboundCallRingtone(channelId, "participant_join_call_gateway");
      debugLog("call.participants.sound", { source: "call_gateway", channelId, userId, action: "join", effect: "callJoin" });
      playSoundEffect("callJoin");
      changed = true;
    }
  }
  knownCallParticipantsByChannelId.set(channelId, after);
  debugLog("call.participants.snapshot", {
    source: "call_gateway",
    channelId,
    activeState: activeSession.state,
    previous: Array.from(previous),
    next: Array.from(next),
    after: Array.from(after),
    retainedMissing: Array.from(previous).filter((userId) => !next.has(userId)),
    rawVoiceStateUserIds: voiceStateUserIds,
    changed,
  });
  return changed;
}

function handleActiveCallGatewayEvent(state: AppState, channelId: string, voiceStateUserIds: readonly string[]): boolean {
  const changed = syncCallParticipantSounds(state, channelId, voiceStateUserIds);
  const session = voiceCallController?.activeSession;
  if (session?.target.channelId === channelId) syncVoiceCallStatus(state, session);
  return changed;
}

function rememberActiveCallParticipants(state: AppState, channelId: string, voiceStateUserIds: readonly string[]): void {
  const selfUserId = state.auth.user?.id;
  const existing = knownCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const before = new Set(existing);
  for (const userId of voiceStateUserIds) {
    if (userId && userId !== selfUserId) existing.add(userId);
  }
  knownCallParticipantsByChannelId.set(channelId, existing);
  debugLog("call.participants.remember_active", {
    channelId,
    before: Array.from(before),
    voiceStateUserIds,
    after: Array.from(existing),
  });
}

function handleCallVoiceStateUpdate(state: AppState, update: VoiceStateUpdate): boolean {
  const activeSession = voiceCallController?.activeSession;
  const channelId = activeSession?.target.channelId;
  if (!activeSession || !channelId || activeSession.state === "ended" || activeSession.state === "error") {
    debugLog("call.participants.voice_state_ignored", {
      reason: "no_active_call",
      activeChannelId: channelId ?? null,
      activeState: activeSession?.state ?? null,
      update,
    });
    return false;
  }
  if (update.userId === state.auth.user?.id) {
    debugLog("call.participants.voice_state_ignored", { reason: "self", channelId, update });
    return false;
  }

  const participants = knownCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  debugLog("call.participants.voice_state", {
    channelId,
    activeState: activeSession.state,
    userId: update.userId,
    updateChannelId: update.channelId,
    before: Array.from(participants),
  });
  let changed = false;
  if (update.channelId === channelId) {
    if (!participants.has(update.userId)) {
      participants.add(update.userId);
      stopOutboundCallRingtone(channelId, "participant_join_voice_state");
      debugLog("call.participants.sound", { source: "voice_state", channelId, userId: update.userId, action: "join", effect: "callJoin" });
      playSoundEffect("callJoin");
      changed = true;
    }
  } else if (participants.delete(update.userId)) {
    speakingCallUserIds.delete(update.userId);
    debugLog("call.participants.sound", { source: "voice_state", channelId, userId: update.userId, action: "leave", effect: "callUserLeave" });
    playSoundEffect("callUserLeave");
    changed = true;
  }
  knownCallParticipantsByChannelId.set(channelId, participants);
  debugLog("call.participants.voice_state_after", {
    channelId,
    userId: update.userId,
    updateChannelId: update.channelId,
    after: Array.from(participants),
    changed,
  });
  if (changed) syncVoiceCallStatus(state, activeSession);
  return changed;
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
    if (cachedMessage.call || cachedMessage.type === 3) {
      maybePlayIncomingCallRingtone(state, cachedMessage.channelId);
    }
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

function markActiveCallEnded(state: AppState, channelId: string, endedTimestamp = Date.now()): boolean {
  let changed = false;
  const patchMessage = (message: DiscordMessage): DiscordMessage => {
    if (message.channelId !== channelId || !message.call || message.call.endedTimestamp !== null) return message;
    changed = true;
    return { ...message, call: { ...message.call, endedTimestamp } };
  };

  const cached = state.messageCacheByChannelId[channelId];
  if (cached) cached.messages = cached.messages.map(patchMessage);
  if (state.timeline.channelId === channelId) {
    const timelineChanged = markTimelineCallEnded(state.timeline, channelId, endedTimestamp);
    changed ||= timelineChanged;
  }
  if (changed) persistChannelMessageCache(state, channelId);
  return changed;
}

function handleGatewayChannelCreateOrUpdate(state: AppState, effects: SessionEffects, channel: DiscordChannel): void {
  if (channel.guildId === DIRECT_MESSAGES_GUILD_ID) {
    ensureDirectMessagesGuild(state);
  }

  if (state.channelList.guildId === channel.guildId) {
    upsertChannel(state.channelList, channel);
    refreshHiddenChannelFlags(state, channel.guildId);
    setSidebarCachedChannels(state.sidebar, channel.guildId, state.channelList.channels);
    if (state.memberList.open && state.channelList.activeChannelId === channel.id) {
      syncMemberListForCurrentChannel(state, effects);
    }
  }

  effects.scheduleRender();
}

function handleGatewayChannelDelete(state: AppState, effects: SessionEffects, channelId: string): void {
  const wasActive = state.channelList.activeChannelId === channelId;
  const removedGuildId = state.channelList.channels.find((channel) => channel.id === channelId)?.guildId ?? state.channelList.guildId;
  const removed = removeChannel(state.channelList, channelId);
  if (removed && removedGuildId) setSidebarCachedChannels(state.sidebar, removedGuildId, state.channelList.channels);
  clearCachedChannelMessages(state.messageCacheByChannelId, channelId);
  if (wasActive || state.timeline.channelId === channelId) {
    clearTimeline(state.timeline);
    setNotice(state, "Channel was deleted.", "warning");
    syncMemberListForCurrentChannel(state, effects);
  }
  if (removed || wasActive) effects.scheduleRender();
}

function cachedSidebarGuilds(_directMessages: DiscordChannel[], guilds: DiscordGuild[]): DiscordGuild[] {
  return withDirectMessagesGuild(guilds);
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

function withCurrentDirectMessagesGuild(_state: AppState, guilds: DiscordGuild[]): DiscordGuild[] {
  return withDirectMessagesGuild(guilds);
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

function buildCallWidgetParticipants(state: AppState, session: VoiceCallSession): CallWidgetParticipant[] {
  const channelId = session.target.channelId;
  const participants: CallWidgetParticipant[] = [];
  const seen = new Set<string>();
  const self = state.auth.user;
  if (self) {
    seen.add(self.id);
    participants.push({
      id: self.id,
      name: self.globalName ?? self.username,
      avatarUrl: discordAvatarUrl(self.id, self.avatar, self.discriminator),
      roleColor: callWidgetRoleColorForUser(state, session.target.guildId, channelId, self.id),
      speaking: speakingCallUserIds.has(self.id),
      self: true,
    });
  }

  for (const userId of knownCallParticipantsByChannelId.get(channelId) ?? []) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    participants.push({
      id: userId,
      name: displayNameForUser(state, channelId, userId, userId),
      avatarUrl: discordAvatarUrl(userId, avatarHashForUser(state, channelId, userId), null),
      roleColor: callWidgetRoleColorForUser(state, session.target.guildId, channelId, userId),
      speaking: speakingCallUserIds.has(userId),
      self: false,
    });
  }
  return participants;
}

function syncCallWidget(state: AppState, session: VoiceCallSession | null): void {
  if (!session || session.state !== "ready") {
    if (!session || session.state === "ended" || session.state === "error") speakingCallUserIds.clear();
    callWidget.stop();
    return;
  }
  callWidget.update(buildCallWidgetParticipants(state, session));
}

function syncVoiceCallStatus(state: AppState, session: VoiceCallSession | null): void {
  const hadActiveCall = Boolean(state.voiceCall);
  if (!session || session.state === "ended" || session.state === "error") {
    if (session?.target.channelId) stopOutboundCallRingtone(session.target.channelId, session.state);
    else stopAllOutboundCallRingtones("idle");
    state.voiceCall = null;
    syncCallWidget(state, session);
    if (hadActiveCall && session?.state === "ended") playSoundEffect("callLeave");
    return;
  }

  state.voiceCall = {
    displayName: callDisplayName(session),
    state: session.state,
    startedAt: session.startedAt,
    selfMute: session.selfMute,
    selfDeaf: session.selfDeaf,
    participantUserIds: Array.from(knownCallParticipantsByChannelId.get(session.target.channelId) ?? []),
  };
  syncCallWidget(state, session);
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
      if (session && session.state !== "ended" && session.state !== "error" && !knownCallParticipantsByChannelId.has(session.target.channelId)) {
        knownCallParticipantsByChannelId.set(session.target.channelId, new Set());
      }
      syncVoiceCallStatus(state, session);
      effects.scheduleRender();
    },
    onSpeakingChange: (userId, speaking) => {
      const activeSession = voiceCallController?.activeSession;
      if (!activeSession || activeSession.state === "ended" || activeSession.state === "error") return;
      if (speaking) speakingCallUserIds.add(userId);
      else speakingCallUserIds.delete(userId);
      debugLog("call.widget.speaking", {
        channelId: activeSession.target.channelId,
        userId,
        speaking,
      });
      syncVoiceCallStatus(state, activeSession);
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
  state.voiceCall = null;
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
      if (handleCallVoiceStateUpdate(state, update)) effects.scheduleRender();
    },
    onVoiceServerUpdate: (update) => {
      voiceCallController?.handleVoiceServerUpdate(update);
    },
    onCallCreate: (event) => {
      handleCallGatewayEvent(state, event.channelId, event.ringingUserIds);
      if (event.isActive) rememberActiveCallParticipants(state, event.channelId, event.voiceStateUserIds);
      handleActiveCallGatewayEvent(state, event.channelId, event.voiceStateUserIds);
      effects.scheduleRender();
    },
    onCallUpdate: (event) => {
      handleCallGatewayEvent(state, event.channelId, event.ringingUserIds);
      if (event.isActive) rememberActiveCallParticipants(state, event.channelId, event.voiceStateUserIds);
      handleActiveCallGatewayEvent(state, event.channelId, event.voiceStateUserIds);
      effects.scheduleRender();
    },
    onCallDelete: (channelId) => {
      recentIncomingCallRingtones.delete(channelId);
      knownCallParticipantsByChannelId.delete(channelId);
      speakingCallUserIds.clear();
      stopOutboundCallRingtone(channelId, "call_delete");
      markActiveCallEnded(state, channelId);
      syncCallWidget(state, null);
      effects.scheduleRender();
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
  }, state.auth.presenceStatus ?? "online");
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
  state.voiceCall = null;
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
  ensureDirectMessagesGuild(state);
  disconnectMemberListGateway();
  clearMemberListData(state.memberList);
  clearTimeline(state.timeline);
  setNotice(state, "", "muted");

  if (accountId) {
    ensureGuildOrderSync(state, effects);
    const cachedDirectMessages = loadCachedDirectMessages(accountId) ?? [];
    const cachedGuildOrder = loadCachedGuildOrder(accountId);
    const cachedGuilds = sortGuildsByOrder(loadCachedGuilds(accountId) ?? [], cachedGuildOrder);
    setSidebarCachedChannels(state.sidebar, DIRECT_MESSAGES_GUILD_ID, cachedDirectMessages);
    for (const guild of cachedGuilds) {
      const cachedChannels = loadCachedGuildChannels(accountId, guild.id) ?? [];
      if (cachedChannels.length > 0) setSidebarCachedChannels(state.sidebar, guild.id, cachedChannels);
    }
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

  startAppGateway(state, token, effects);

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
    setSidebarCachedChannels(state.sidebar, DIRECT_MESSAGES_GUILD_ID, directMessages);
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
      setSidebarCachedChannels(state.sidebar, guildId, state.channelList.channels);
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
    setSidebarCachedChannels(state.sidebar, guildId, state.channelList.channels);
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
    local: true,
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

  if (!appGateway || appGatewayToken !== token) startAppGateway(state, token, effects);
  const controller = ensureVoiceCallController(state, token, effects);
  if (!controller) {
    setNotice(state, "Discord gateway is still connecting; try again in a moment.", "warning");
    effects.scheduleRender();
    return;
  }

  const displayName = channel.name || "DM";
  const joiningExistingCall = callHasRemoteParticipants(state, channel.id);
  if (!knownCallParticipantsByChannelId.has(channel.id)) knownCallParticipantsByChannelId.set(channel.id, new Set());
  debugLog("call.command", {
    channelId: channel.id,
    joiningExistingCall,
    knownParticipants: Array.from(knownCallParticipantsByChannelId.get(channel.id) ?? []),
  });
  const activeSession = controller.activeSession;
  const replacingActiveCall = Boolean(
    activeSession
      && activeSession.state !== "ended"
      && activeSession.state !== "error"
      && activeSession.target.channelId !== channel.id,
  );

  setNotice(state, "", "muted");
  effects.scheduleRender();

  void controller.startCall({
    guildId: null,
    channelId: channel.id,
    recipientIds: recipients,
    displayName,
    ringRecipients: !joiningExistingCall,
  }, { replaceActive: replacingActiveCall }).then(({ warnings }) => {
    if (joiningExistingCall) {
      debugLog("call.outbound_ringtone.skipped", { channelId: channel.id, reason: "joining_existing_call" });
      if (callHasRemoteParticipants(state, channel.id)) {
        debugLog("call.participants.sound", { source: "existing_call_join", channelId: channel.id, action: "join", effect: "callJoin" });
        playSoundEffect("callJoin");
      }
    } else {
      startOutboundCallRingtone(channel.id);
    }
    if (warnings.length > 0) {
      setNotice(state, `Call connected, but ${warnings[0]}`, "warning", { chat: false });
    } else {
      setNotice(state, "", "muted");
    }
    effects.scheduleRender();
  }).catch((error) => {
    stopOutboundCallRingtone(channel.id, "start_failed");
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

  stopOutboundCallRingtone(voiceCallController.activeSession.target.channelId, "hangup");
  voiceCallController.leave();
  state.voiceCall = null;
  setNotice(state, "", "muted");
  effects.scheduleRender();
}

export function setCurrentCallMute(state: AppState, effects: SessionEffects, muted: boolean | null): void {
  const session = voiceCallController?.activeSession;
  if (!voiceCallController || !session) {
    setNotice(state, "No active call.", "muted", { chat: false });
    effects.scheduleRender();
    return;
  }

  const target = muted ?? !session.selfMute;
  if (!voiceCallController.setSelfMute(target)) {
    setNotice(state, "Discord gateway is not ready to update voice mute.", "warning", { chat: false });
  } else {
    playSoundEffect(target ? "mute" : "unmute");
    setNotice(state, "", "muted");
  }
  effects.scheduleRender();
}

export function setCurrentCallDeaf(state: AppState, effects: SessionEffects, deafened: boolean | null): void {
  const session = voiceCallController?.activeSession;
  if (!voiceCallController || !session) {
    setNotice(state, "No active call.", "muted", { chat: false });
    effects.scheduleRender();
    return;
  }

  const target = deafened ?? !session.selfDeaf;
  if (!voiceCallController.setSelfDeaf(target)) {
    setNotice(state, "Discord gateway is not ready to update voice deafen.", "warning", { chat: false });
  } else {
    playSoundEffect(target ? "deafen" : "undeafen");
    setNotice(state, "", "muted");
  }
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

export function setCurrentUserPresenceStatus(
  state: AppState,
  effects: SessionEffects,
  status: DiscordPresenceStatus,
  persistStatus: (token: string, status: DiscordPresenceStatus) => Promise<void>,
): void {
  const token = state.auth.savedToken;
  if (!token || !state.auth.user) {
    setNotice(state, "Login first with /login <token|username>.", "warning");
    effects.scheduleRender();
    return;
  }

  state.auth.presenceStatus = status;
  if (!appGateway || appGatewayToken !== token) startAppGateway(state, token, effects);
  appGateway?.updatePresenceStatus(status);
  effects.scheduleRender();

  void (async () => {
    try {
      await persistStatus(token, status);
    } catch (error) {
      setNotice(state, `Status changed for this session, but saving to Discord failed: ${(error as Error).message}`, "warning", { chat: false });
      effects.scheduleRender();
    }
  })();
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
