/**
 * Read-only Discord session bootstrap and data loading.
 */

import {
  bumpDirectMessageChannel,
  clearChannelList,
  findBrowsableChannel,
  findFirstBrowsableChannel,
  findTimelineChannel,
  removeChannel,
  setActiveChannelEntry,
  setChannelList,
  upsertChannel,
} from "./channels";
import { saveConfig, saveSavedLogins } from "./config";
import { statSync } from "fs";
import { basename } from "path";
import {
  DIRECT_MESSAGES_GUILD_ID,
  DIRECT_MESSAGES_GUILD_NAME,
  DiscordResourceNotFoundError,
  ackChannelMessage,
  createChannelThread,
  createMessageThread,
  fetchChannel,
  fetchChannelMessage,
  fetchChannelMessages,
  fetchChannelMessagesAfter,
  fetchChannelMessagesAround,
  editChannelMessage,
  deleteChannelMessage,
  fetchDirectMessages,
  fetchGuildChannels,
  fetchCurrentUserGuildRoleIds,
  fetchGuildRoles,
  fetchGuilds,
  generateMessageNonce,
  sendChannelMessage,
  setDirectMessageChannelMuted,
  setGuildChannelMuted,
  setGuildMuted,
  sortGuildsByOrder,
  ringDirectMessageCall,
  isDirectMessageChannel,
  isGuildVoiceChannel,
  isMessageThreadParentChannel,
  isThreadChannel,
  joinThread,
  hydrateMissingReplyPreviewFromLookup,
  replyPreviewFromMessage,
  replyReferenceTarget,
  type DiscordMessageAttachment,
  type DiscordMessageReply,
  type SendMessageReplyOptions,
  type SendMessageUpload,
  sortDirectMessageChannels,
  sortGuildChannels,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordGuildMember,
  type DiscordRole,
  type DiscordMessage,
  type DiscordMessagePatch,
  type DiscordCustomStatus,
  type DiscordPresenceStatus,
} from "./discord";
import { isFixedTopLevelGuildId, isWhatsAppChannel, isWhatsAppChannelId, whatsappGuild, whatsappSidebarLayoutScope, WHATSAPP_GUILD_ID } from "./chatproviders";
import { whatsAppChannels, whatsAppTimelineMessages } from "./whatsapp/integration";
import {
  loadCachedChannelMessages,
  loadCachedDirectMessages,
  loadCachedGuildChannels,
  loadCachedGuilds,
  loadCachedGuildOrder,
  loadCachedGuildRoles,
  loadCachedSidebarChannelLayout,
  loadCachedSidebarFolders,
  loadCachedMemberList,
  loadCachedMemberLists,
  loadCachedMemberRoles,
  loadCachedNotifications,
  loadLastCachedAccountId,
  markCachedAccountActive,
  saveCachedChannelMessages,
  saveCachedDirectMessages,
  saveCachedGuildChannels,
  saveCachedGuildOrder,
  saveCachedGuildRoles,
  saveCachedSidebarChannelLayout,
  saveCachedSidebarFolders,
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
import { DISCORD_UPLOAD_LIMIT_BYTES, normalizeUploadPath, readLocalFileUploadInWorker, type LocalFileUpload } from "./fileupload";
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
import { VOICE_MESSAGE_FLAG, type VoiceMessageClip } from "./voice-message";
import {
  clearChannelNotifications,
  clearGuildNotifications,
  recordChannelNotification,
  replaceNotifications,
  shouldNotifyForMessage as messageMatchesNotificationRules,
} from "./notifications";
import { clearPrompt } from "./promptstate";
import type { ClipboardImageAttachment } from "./imageclipboard";
import { playLoopingSoundEffect, playSoundEffect, setSoundEffectVolume, type SoundEffectPlaybackHandle } from "./soundeffects";
import { focusPrompt, setNotice } from "./state";
import {
  applySidebarFolderLayout,
  applySidebarChannelLayoutForGuild,
  applySidebarChannelMuteSettings,
  applySidebarGuildMuteSettings,
  clearSidebarData,
  getSelectedSidebarEntry,
  isSidebarThreadRelevant,
  isSidebarChannelMuted,
  isSidebarGuildMuted,
  moveSelectedSidebarGuild,
  moveSelectedSidebarItem,
  moveSelectedPrivateConversation,
  revealSidebarChannel,
  setSidebarCachedChannels,
  setSidebarChannelMuted,
  setSidebarGuildMuted,
  setSidebarGuilds,
  sidebarChannelsForGuild,
  sidebarCachedGuilds,
  sidebarChannelLayoutForGuild,
  sidebarFolderLayout,
  toggleSelectedPrivateConversationPinned,
  type SidebarVoiceMember,
} from "./sidebar";
import {
  appendTimelineMessages,
  appendTimelineMessage,
  clearTimeline,
  finishLoadingNewerMessages,
  finishLoadingOlderMessages,
  insertTimelineMessageAt,
  isTimelineNearBottom,
  markTimelineMessageFailed,
  markTimelineCallEnded,
  prependTimelineMessages,
  patchTimelineMessage,
  pushTimelineSystemMessage,
  removeTimelineMessage,
  removeTimelineMessages,
  replaceTimelineMessage,
  resolvePrimaryRoleColor,
  setTimelineMessages,
} from "./timeline";
import { clearTypingUser, recordTypingStart } from "./typing";
import { ansiTrueColor, dmAuthorColor, theme } from "./theme";
import { ansiColorToRgb } from "./terminalcolors";
import { VoiceCallController, type VoiceCallSession, type VoiceStateUpdate } from "./voice";
import { ScreenStreamController } from "./streamcontroller";
import { WatchStreamController, buildStreamKeyForVoiceSession, parseStreamKey, streamKeyMatchesVoiceSession } from "./watchstreamcontroller";
import { createDefaultWatchStreamPlayback } from "./watchstreamplayback";
import { DEFAULT_REMOTE_USER_VOLUME_PERCENT, normalizeRemoteUserVolumePercent, formatGainDbWithUnit, normalizeGainDb, type NoiseSuppressionMode } from "./volume";
import { normalizeToken } from "./token";

export interface SessionEffects {
  scheduleRender: () => void;
}

export interface ChannelMessageLocationTarget {
  channelId: string;
  messageId: string;
  guildId?: string | null;
}

interface LoadGuildChannelsOptions {
  openFirstChannel?: boolean;
}

const MESSAGE_PAGE_LIMIT = 50;
const MESSAGE_CACHE_FRESH_MS = 2 * 60 * 1000;
const replyPreviewRestFetchKeys = new Set<string>();
const MEMBER_LIST_SUBSCRIBE_TIMEOUT_MS = 7_000;
const MEMBER_LIST_SUBSCRIBE_RETRIES = 2;
const VOICE_MEMBER_HYDRATION_RETRY_MS = 30_000;
const PRESENCE_STATUS_PERSIST_RETRIES = 3;
const PRESENCE_STATUS_PERSIST_RETRY_DELAY_MS = 3_000;

let memberListGateway: MemberListGatewayClient | null = null;
let memberListGatewayToken: string | null = null;
let appGateway: AppGatewayClient | null = null;
let appGatewayToken: string | null = null;
let voiceCallController: VoiceCallController | null = null;
let streamController: ScreenStreamController | null = null;
let watchStreamController: WatchStreamController | null = null;
let guildOrderSync: { accountId: string; state: AppState; stop: () => void } | null = null;
interface GuildRoleFetchState {
  pending: Set<string>;
  fresh: Set<string>;
  revisions: Map<string, number>;
}
const guildRoleFetchState = new WeakMap<AppState, GuildRoleFetchState>();
const deletedGuildChannelIds = new WeakMap<AppState, Set<string>>();

function deletedGuildChannelIdsFor(state: AppState): Set<string> {
  const existing = deletedGuildChannelIds.get(state);
  if (existing) return existing;
  const created = new Set<string>();
  deletedGuildChannelIds.set(state, created);
  return created;
}

function isDeletedGuildChannel(state: AppState, channel: DiscordChannel): boolean {
  const deletedIds = deletedGuildChannelIds.get(state);
  return Boolean(deletedIds
    && (deletedIds.has(channel.id)
      || (isThreadChannel(channel) && channel.parentId && deletedIds.has(channel.parentId))));
}

function withoutDeletedGuildChannels(state: AppState, channels: readonly DiscordChannel[]): DiscordChannel[] {
  const deletedIds = deletedGuildChannelIds.get(state);
  if (!deletedIds || deletedIds.size === 0) return channels.slice();
  return channels.filter((channel) => !isDeletedGuildChannel(state, channel));
}

function roleFetchStateFor(state: AppState): GuildRoleFetchState {
  const existing = guildRoleFetchState.get(state);
  if (existing) return existing;
  const created = { pending: new Set<string>(), fresh: new Set<string>(), revisions: new Map<string, number>() };
  guildRoleFetchState.set(state, created);
  return created;
}
interface TrackedStreamState {
  create: import("./appgateway").StreamCreateEvent;
  serverUpdate: import("./appgateway").StreamServerUpdateEvent | null;
}
const availableStreamsByKey = new Map<string, TrackedStreamState>();
const callWidget = new CallWidgetController();
const recentIncomingCallRingtones = new Map<string, number>();
const knownCallParticipantsByChannelId = new Map<string, Set<string>>();
const departedCallParticipantsByChannelId = new Map<string, Set<string>>();
interface TrackedCallVoiceState {
  displayName?: string;
  roleIds?: string[];
  sessionId?: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  streaming: boolean;
  cameraOn: boolean;
  mute: boolean;
  deaf: boolean;
}
const callVoiceStatesByChannelId = new Map<string, Map<string, TrackedCallVoiceState>>();
const callJoinSoundUserIdsByChannelId = new Map<string, Set<string>>();
const speakingCallUserIds = new Set<string>();
const locallyMutedCallUserIds = new Set<string>();
const remoteCallUserVolumes = new Map<string, number>();
const speakingCallTimersByUserId = new Map<string, ReturnType<typeof setTimeout>>();
const pendingVoiceMemberHydrationKeys = new Set<string>();
const pendingVoiceMemberHydrationTargets = new Map<string, Set<string>>();
const pendingVoiceMemberHydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const incomingCallRingtonesByChannelId = new Map<string, SoundEffectPlaybackHandle>();
const incomingCallRingtoneCleanupTimersByChannelId = new Map<string, ReturnType<typeof setTimeout>>();
const outboundCallRingtonesByChannelId = new Map<string, SoundEffectPlaybackHandle>();
const INCOMING_CALL_RINGTONE_MAX_MS = 30_000;
const INCOMING_CALL_RINGTONE_REPEAT_MS = 5_500;
const OUTBOUND_CALL_RINGTONE_MAX_MS = 15_000;
const OUTBOUND_CALL_RINGTONE_REPEAT_MS = 2_500;
const REMOTE_CALL_SPEAKING_IDLE_MS = 1_500;

interface LocalMessageUpload {
  filename: string;
  mediaType: string;
  base64: string;
  sizeBytes: number;
  durationSecs?: number;
  waveform?: string;
}

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
  streamController?.stop("gateway_disconnect");
  streamController = null;
  watchStreamController?.stop("gateway_disconnect");
  watchStreamController = null;
  availableStreamsByKey.clear();
  voiceCallController?.disconnect();
  voiceCallController = null;
  stopAllIncomingCallRingtones("gateway_disconnect");
  recentIncomingCallRingtones.clear();
  callVoiceStatesByChannelId.clear();
  departedCallParticipantsByChannelId.clear();
  callJoinSoundUserIdsByChannelId.clear();
  locallyMutedCallUserIds.clear();
  remoteCallUserVolumes.clear();
  clearAllSpeakingCallUsers();
  clearVoiceMemberHydrationState();
  callWidget.stop();
  appGateway?.disconnect();
  appGateway = null;
  appGatewayToken = null;
}

function currentAuthToken(state: AppState, fallback: string): string {
  return state.auth.savedToken ?? fallback;
}

function handleGatewayAuthTokenRefresh(state: AppState, effects: SessionEffects, token: string): void {
  const nextToken = normalizeToken(token);
  if (!nextToken) return;

  const previousToken = state.auth.savedToken ?? appGatewayToken ?? memberListGatewayToken;
  if (previousToken === nextToken) return;

  state.auth.savedToken = nextToken;
  appGateway?.updateAuthToken(nextToken);
  memberListGateway?.updateAuthToken(nextToken);
  if (appGateway) appGatewayToken = nextToken;
  if (memberListGateway) memberListGatewayToken = nextToken;

  persistRefreshedAuthToken(state, previousToken, nextToken);
  debugLog("auth.token_refresh", {
    hasPreviousToken: Boolean(previousToken),
    hasUser: Boolean(state.auth.user),
    savedLoginCount: Object.keys(state.auth.savedLogins).length,
  });
  effects.scheduleRender();
}

function persistRefreshedAuthToken(state: AppState, previousToken: string | null, nextToken: string): void {
  try {
    saveConfig({ token: nextToken });
  } catch (error) {
    debugLog("auth.token_refresh.save_config_failed", { error: error instanceof Error ? error.message : String(error) });
  }

  const username = state.auth.user?.username;
  const savedLogins = { ...state.auth.savedLogins };
  let changed = false;
  for (const [name, savedToken] of Object.entries(savedLogins)) {
    if ((previousToken && savedToken === previousToken) || (username && name === username)) {
      savedLogins[name] = nextToken;
      changed = true;
    }
  }
  if (username && !Object.prototype.hasOwnProperty.call(savedLogins, username)) {
    savedLogins[username] = nextToken;
    changed = true;
  }
  if (!changed) return;

  state.auth.savedLogins = savedLogins;
  try {
    saveSavedLogins(savedLogins);
  } catch (error) {
    debugLog("auth.token_refresh.save_logins_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function getMemberListGateway(state: AppState, token: string, effects: SessionEffects): MemberListGatewayClient {
  if (!memberListGateway || memberListGatewayToken !== token) {
    disconnectMemberListGateway();
    memberListGateway = new MemberListGatewayClient(token, {
      onAuthTokenRefresh: (refreshedToken) => handleGatewayAuthTokenRefresh(state, effects, refreshedToken),
    });
    memberListGatewayToken = token;
  }

  return memberListGateway;
}

function directMessagesGuild(): DiscordGuild {
  return { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null };
}

function withDirectMessagesGuild(guilds: DiscordGuild[]): DiscordGuild[] {
  return [
    directMessagesGuild(),
    whatsappGuild(),
    ...guilds.filter((guild) => !isFixedTopLevelGuildId(guild.id)),
  ];
}

function ensureDirectMessagesGuild(state: AppState): void {
  if (state.sidebar.guilds.some((guild) => guild.id === DIRECT_MESSAGES_GUILD_ID)
    && state.sidebar.guilds.some((guild) => guild.id === WHATSAPP_GUILD_ID)) return;
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

  if (state.auth.user?.id === userId) {
    return state.auth.user.globalName ?? state.auth.user.username;
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
  const fromTimeline = state.timeline.channelId === channelId
    ? state.timeline.messages.find((message) => message.author.id === userId)?.author.avatar
    : null;
  if (fromTimeline) return fromTimeline;
  const fromCachedChannelMessages = state.messageCacheByChannelId[channelId]?.messages
    .find((message) => message.author.id === userId)?.author.avatar;
  if (fromCachedChannelMessages) return fromCachedChannelMessages;
  for (const entry of Object.values(state.messageCacheByChannelId)) {
    const fromCachedMessage = entry.messages.find((message) => message.author.id === userId)?.author.avatar;
    if (fromCachedMessage) return fromCachedMessage;
  }
  return null;
}

function callWidgetTextColorForUser(state: AppState, sessionGuildId: string | null, channelId: string, userId: string): string | null {
  const guildId = sessionGuildId ?? state.channelList.channels.find((channel) => channel.id === channelId)?.guildId ?? null;
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) {
    return ansiTextColorToHex(userId === state.auth.user?.id ? theme.accent : dmAuthorColor(userId));
  }
  const roleIds = roleIdsForUser(state, guildId, channelId, userId);
  const color = resolvePrimaryRoleColor(state.guildRolesByGuildId[guildId] ?? [], roleIds);
  return color === null ? null : `#${color.toString(16).padStart(6, "0")}`;
}

function ansiTextColorToHex(color: string): string | null {
  const channels = ansiColorToRgb(color, 38);
  if (!channels) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function knownRoleIdsForUser(state: AppState, guildId: string, channelId: string, userId: string): readonly string[] | undefined {
  if (state.auth.user?.id === userId && state.roleIdsByGuildId[guildId]) return state.roleIdsByGuildId[guildId];

  const cachedRoleIds = state.memberRoleIdsByGuildId[guildId]?.[userId];
  if (cachedRoleIds) return cachedRoleIds;

  const fromVoiceState = callVoiceStatesByChannelId.get(channelId)?.get(userId)?.roleIds;
  if (fromVoiceState) return fromVoiceState;

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

  return undefined;
}

function roleIdsForUser(state: AppState, guildId: string, channelId: string, userId: string): readonly string[] {
  return knownRoleIdsForUser(state, guildId, channelId, userId) ?? [];
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
  // Discord omits guild_id on private-channel gateway messages. Those DMs may
  // arrive while the Direct Messages list is not the opened channel list yet,
  // so keep enough guild context for the top-level DM notification badge.
  return message.guildId
    ?? guildIdForChannelId(state, message.channelId)
    ?? DIRECT_MESSAGES_GUILD_ID;
}

function guildIdForChannelId(state: AppState, channelId: string): string | null {
  return state.channelList.channels.find((channel) => channel.id === channelId)?.guildId
    ?? Object.entries(state.sidebar.cachedChannelsByGuildId).find(([, channels]) => channels.some((channel) => channel.id === channelId))?.[0]
    ?? null;
}

function channelById(state: AppState, channelId: string | null | undefined): DiscordChannel | null {
  if (!channelId) return null;
  return state.channelList.channels.find((channel) => channel.id === channelId)
    ?? Object.values(state.sidebar.cachedChannelsByGuildId).flat().find((channel) => channel.id === channelId)
    ?? null;
}

function isChannelMuted(state: AppState, channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  const channel = channelById(state, channelId);
  const directlyMuted = Boolean(channel?.muted)
    || Boolean(state.channelList.activeChannel?.id === channelId && state.channelList.activeChannel.muted)
    || isSidebarChannelMuted(state.sidebar, channelId);
  if (directlyMuted) return true;
  const seen = new Set<string>();
  let parentId = channel?.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    if (state.channelMuteSettings[parentId] || isSidebarChannelMuted(state.sidebar, parentId)) return true;
    parentId = channelById(state, parentId)?.parentId ?? null;
  }
  return false;
}

function setChannelListChannelMuted(state: AppState, channelId: string, muted: boolean): void {
  state.channelMuteSettings[channelId] = muted;
  state.channelList.channels = state.channelList.channels.map((channel) => (
    channel.id === channelId ? { ...channel, muted } : channel
  ));
  if (state.channelList.activeChannel?.id === channelId) {
    state.channelList.activeChannel = { ...state.channelList.activeChannel, muted };
  }
}

function withChannelMuteSettings(state: AppState, channels: DiscordChannel[]): DiscordChannel[] {
  return channels.map((channel) => (
    Object.prototype.hasOwnProperty.call(state.channelMuteSettings, channel.id)
      ? { ...channel, muted: state.channelMuteSettings[channel.id] }
      : channel
  ));
}

function applyChannelMuteSettings(state: AppState, mutedByChannelId: Record<string, boolean>, options: { reset?: boolean } = {}): void {
  const nextMutedByChannelId = { ...mutedByChannelId };
  if (options.reset) {
    const knownChannels = [
      ...state.channelList.channels,
      ...Object.values(state.sidebar.cachedChannelsByGuildId).flat(),
    ];
    for (const channel of knownChannels) {
      if (!Object.prototype.hasOwnProperty.call(nextMutedByChannelId, channel.id)) nextMutedByChannelId[channel.id] = false;
    }
  }

  state.channelMuteSettings = options.reset ? { ...nextMutedByChannelId } : { ...state.channelMuteSettings, ...nextMutedByChannelId };
  applySidebarChannelMuteSettings(state.sidebar, nextMutedByChannelId);
  for (const [channelId, muted] of Object.entries(nextMutedByChannelId)) {
    setChannelListChannelMuted(state, channelId, muted);
    if (muted) clearChannelNotifications(state.notifications, channelId);
  }
  const accountId = currentAccountId(state);
  const directMessages = state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID];
  if (accountId && directMessages) saveCachedDirectMessages(accountId, directMessages);
  if (accountId) {
    for (const [guildId, channels] of Object.entries(state.sidebar.cachedChannelsByGuildId)) {
      if (guildId !== DIRECT_MESSAGES_GUILD_ID) saveCachedGuildChannels(accountId, guildId, channels);
    }
  }
  persistNotifications(state);
}

function shouldNotifyForIncomingMessage(state: AppState, message: DiscordMessage): boolean {
  if (state.timeline.channelId === message.channelId && isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) {
    return false;
  }
  const guildId = guildIdForChannel(state, message);
  if (isSidebarGuildMuted(state.sidebar, guildId)) return false;
  if (isChannelMuted(state, message.channelId)) return false;

  return messageMatchesNotificationRules(message, {
    viewerId: state.auth.user?.id ?? null,
    roleIdsByGuildId: state.roleIdsByGuildId,
    channels: state.channelList.channels,
  });
}

function maybePlayIncomingCallRingtone(state: AppState, channelId: string): void {
  if (voiceCallController?.activeSession?.target.channelId === channelId) {
    stopIncomingCallRingtone(channelId, "already_active");
    return;
  }
  if (incomingCallRingtonesByChannelId.has(channelId)) return;
  if (recentIncomingCallRingtones.has(channelId)) {
    debugLog("call.incoming_ringtone.skipped", { channelId, reason: "already_rang_for_call" });
    return;
  }
  const now = Date.now();
  recentIncomingCallRingtones.set(channelId, now);
  const handle = playLoopingSoundEffect("ringtone", {
    intervalMs: INCOMING_CALL_RINGTONE_REPEAT_MS,
    maxDurationMs: INCOMING_CALL_RINGTONE_MAX_MS,
  });
  incomingCallRingtonesByChannelId.set(channelId, handle);
  const cleanupTimer = setTimeout(() => {
    if (incomingCallRingtonesByChannelId.get(channelId) === handle) {
      incomingCallRingtonesByChannelId.delete(channelId);
      incomingCallRingtoneCleanupTimersByChannelId.delete(channelId);
      debugLog("call.incoming_ringtone.expired", { channelId });
    }
  }, INCOMING_CALL_RINGTONE_MAX_MS + 50);
  cleanupTimer.unref?.();
  incomingCallRingtoneCleanupTimersByChannelId.set(channelId, cleanupTimer);
  debugLog("call.incoming_ringtone.start", {
    channelId,
    intervalMs: INCOMING_CALL_RINGTONE_REPEAT_MS,
    maxDurationMs: INCOMING_CALL_RINGTONE_MAX_MS,
  });
}

function stopIncomingCallRingtone(channelId: string, reason: string): void {
  const handle = incomingCallRingtonesByChannelId.get(channelId);
  if (!handle) return;
  incomingCallRingtonesByChannelId.delete(channelId);
  const cleanupTimer = incomingCallRingtoneCleanupTimersByChannelId.get(channelId);
  if (cleanupTimer) clearTimeout(cleanupTimer);
  incomingCallRingtoneCleanupTimersByChannelId.delete(channelId);
  handle.stop();
  debugLog("call.incoming_ringtone.stop", { channelId, reason });
}

function stopAllIncomingCallRingtones(reason: string): void {
  for (const channelId of Array.from(incomingCallRingtonesByChannelId.keys())) {
    stopIncomingCallRingtone(channelId, reason);
  }
}

function handleCallGatewayEvent(state: AppState, channelId: string, ringingUserIds: readonly string[]): void {
  const selfUserId = state.auth.user?.id;
  if (!selfUserId || !ringingUserIds.includes(selfUserId)) return;
  if (isChannelMuted(state, channelId)) return;
  maybePlayIncomingCallRingtone(state, channelId);
}

export function activeCallMessageParticipantIds(state: AppState, channelId: string): string[] {
  const participantIds = new Set<string>();
  const addFromMessage = (message: DiscordMessage): void => {
    if (message.channelId !== channelId || !message.call || message.call.endedTimestamp !== null) return;
    for (const userId of message.call.participantIds) {
      if (userId) participantIds.add(userId);
    }
  };

  for (const message of state.messageCacheByChannelId[channelId]?.messages ?? []) addFromMessage(message);
  if (state.timeline.channelId === channelId) {
    for (const message of state.timeline.messages) addFromMessage(message);
  }
  return Array.from(participantIds);
}

function remoteCallParticipantIds(state: AppState, channelId: string): string[] {
  return resolveRemoteCallParticipantIds(
    state.auth.user?.id,
    activeCallMessageParticipantIds(state, channelId),
    Array.from(knownCallParticipantsByChannelId.get(channelId) ?? []),
    Array.from(departedCallParticipantsByChannelId.get(channelId) ?? []),
    Array.from(callVoiceStatesByChannelId.get(channelId)?.keys() ?? []),
  );
}

export function resolveRemoteCallParticipantIds(
  selfUserId: string | null | undefined,
  messageParticipantIds: readonly string[],
  knownParticipantIds: readonly string[],
  departedParticipantIds: readonly string[] = [],
  voiceStateParticipantIds: readonly string[] = [],
): string[] {
  const departed = new Set(departedParticipantIds.filter(Boolean));
  const participantIds = new Set<string>();
  const add = (userId: string): void => {
    if (!userId || userId === selfUserId || departed.has(userId)) return;
    participantIds.add(userId);
  };
  for (const userId of messageParticipantIds) add(userId);
  for (const userId of knownParticipantIds) add(userId);
  for (const userId of voiceStateParticipantIds) add(userId);
  return Array.from(participantIds);
}

export function newRemoteCallParticipantIds(
  selfUserId: string | null | undefined,
  beforeParticipantIds: readonly string[],
  afterParticipantIds: readonly string[],
): string[] {
  const before = new Set(beforeParticipantIds.filter((userId) => userId && userId !== selfUserId));
  const added: string[] = [];
  for (const userId of afterParticipantIds) {
    if (!userId || userId === selfUserId || before.has(userId) || added.includes(userId)) continue;
    added.push(userId);
  }
  return added;
}

function playCallJoinSoundOnce(channelId: string, userId: string, source: string): boolean {
  if (!userId) return false;
  if (!isActiveRecordCallChannel(channelId)) {
    debugLog("call.participants.sound_skipped", { source, channelId, userId, action: "join", reason: "not_active_record_call" });
    return false;
  }
  const played = callJoinSoundUserIdsByChannelId.get(channelId) ?? new Set<string>();
  if (played.has(userId)) {
    debugLog("call.participants.sound_skipped", { source, channelId, userId, action: "join", reason: "already_played" });
    return false;
  }
  played.add(userId);
  callJoinSoundUserIdsByChannelId.set(channelId, played);
  debugLog("call.participants.sound", { source, channelId, userId, action: "join", effect: "callJoin" });
  playSoundEffect("callJoin");
  return true;
}

function playCallJoinSoundForParticipants(channelId: string, userIds: readonly string[], source: string): boolean {
  let played = false;
  for (const userId of userIds) {
    played = playCallJoinSoundOnce(channelId, userId, source) || played;
  }
  return played;
}

function isActiveRecordCallChannel(channelId: string): boolean {
  const session = voiceCallController?.activeSession;
  return Boolean(session && session.target.channelId === channelId && session.state !== "ended" && session.state !== "error");
}

function forgetCallJoinSound(channelId: string, userId: string): void {
  const played = callJoinSoundUserIdsByChannelId.get(channelId);
  if (!played) return;
  played.delete(userId);
  if (played.size === 0) callJoinSoundUserIdsByChannelId.delete(channelId);
}

function rememberActiveCallMessageParticipants(state: AppState, channelId: string, participantIds: readonly string[], source: string): { changed: boolean; addedParticipantIds: string[] } {
  const selfUserId = state.auth.user?.id;
  const participants = knownCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const departed = departedCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const before = new Set(participants);
  const addedParticipantIds: string[] = [];
  for (const userId of participantIds) {
    if (!userId || userId === selfUserId || departed.has(userId)) continue;
    if (!participants.has(userId)) addedParticipantIds.push(userId);
    participants.add(userId);
  }
  const changed = participants.size !== before.size || Array.from(participants).some((userId) => !before.has(userId));
  knownCallParticipantsByChannelId.set(channelId, participants);
  debugLog("call.participants.message", {
    source,
    channelId,
    participantIds,
    departed: Array.from(departed),
    before: Array.from(before),
    after: Array.from(participants),
    addedParticipantIds,
    changed,
  });
  if (changed) stopOutboundCallRingtone(channelId, "participant_join_call_message");
  return { changed, addedParticipantIds };
}

function handleCallMessageParticipants(state: AppState, channelId: string, call: DiscordMessage["call"], source: string): void {
  if (!call || call.endedTimestamp !== null) return;
  const { changed, addedParticipantIds } = rememberActiveCallMessageParticipants(state, channelId, call.participantIds, source);
  const session = voiceCallController?.activeSession;
  if (changed && session?.target.channelId === channelId) {
    if (addedParticipantIds.length > 0) {
      playCallJoinSoundForParticipants(channelId, addedParticipantIds, "call_message");
    }
    syncVoiceCallStatus(state, session);
  }
}

function callHasRemoteParticipants(state: AppState, channelId: string): boolean {
  return remoteCallParticipantIds(state, channelId).length > 0;
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

function clearSpeakingCallTimer(userId: string): void {
  const timer = speakingCallTimersByUserId.get(userId);
  if (!timer) return;
  speakingCallTimersByUserId.delete(userId);
  clearTimeout(timer);
}

function clearSpeakingCallUser(userId: string): boolean {
  clearSpeakingCallTimer(userId);
  return speakingCallUserIds.delete(userId);
}

function clearAllSpeakingCallUsers(): void {
  for (const timer of speakingCallTimersByUserId.values()) clearTimeout(timer);
  speakingCallTimersByUserId.clear();
  speakingCallUserIds.clear();
}

function clearVoiceMemberHydrationState(): void {
  for (const timer of pendingVoiceMemberHydrationTimers.values()) clearTimeout(timer);
  pendingVoiceMemberHydrationTimers.clear();
  pendingVoiceMemberHydrationKeys.clear();
  pendingVoiceMemberHydrationTargets.clear();
}

function setCallUserSpeaking(state: AppState, effects: SessionEffects, session: VoiceCallSession, userId: string, speaking: boolean): boolean {
  if (speaking && locallyMutedCallUserIds.has(userId)) speaking = false;
  const wasSpeaking = speakingCallUserIds.has(userId);
  if (speaking) {
    speakingCallUserIds.add(userId);
    clearSpeakingCallTimer(userId);
    if (userId !== state.auth.user?.id) {
      const timer = setTimeout(() => {
        speakingCallTimersByUserId.delete(userId);
        if (!speakingCallUserIds.delete(userId)) return;
        const activeSession = voiceCallController?.activeSession;
        if (!activeSession || activeSession.state === "ended" || activeSession.state === "error") return;
        syncVoiceCallStatus(state, activeSession);
        effects.scheduleRender();
      }, REMOTE_CALL_SPEAKING_IDLE_MS);
      timer.unref?.();
      speakingCallTimersByUserId.set(userId, timer);
    }
  } else {
    clearSpeakingCallUser(userId);
  }
  if (wasSpeaking === speaking) return false;
  syncVoiceCallStatus(state, session);
  return true;
}

function sidebarVoiceMemberColor(state: AppState, channelId: string, userId: string, voiceState: TrackedCallVoiceState): string | undefined {
  const guildId = state.channelList.channels.find((channel) => channel.id === channelId)?.guildId
    ?? Object.entries(state.sidebar.cachedChannelsByGuildId).find(([, channels]) => channels.some((channel) => channel.id === channelId))?.[0]
    ?? null;
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return undefined;
  const roleIds = voiceState.roleIds ?? state.memberRoleIdsByGuildId[guildId]?.[userId] ?? [];
  const color = resolvePrimaryRoleColor(state.guildRolesByGuildId[guildId] ?? [], roleIds);
  return color ? ansiTrueColor(color) : undefined;
}

function voiceMemberHasTrackedStream(channelId: string, userId: string): boolean {
  for (const stream of availableStreamsByKey.values()) {
    const parsed = parseStreamKey(stream.create.streamKey);
    if (parsed?.channelId === channelId && parsed.ownerUserId === userId) return true;
  }
  return false;
}

function sidebarVoiceMemberFromState(state: AppState, channelId: string, userId: string, voiceState: TrackedCallVoiceState): SidebarVoiceMember {
  return {
    userId,
    displayName: voiceState.displayName ?? displayNameForUser(state, channelId, userId, userId),
    muted: voiceState.selfMute || voiceState.mute,
    selfMuted: voiceState.selfMute,
    deafened: voiceState.selfDeaf || voiceState.deaf,
    localMuted: locallyMutedCallUserIds.has(userId),
    streaming: voiceState.streaming || voiceMemberHasTrackedStream(channelId, userId),
    cameraOn: voiceState.cameraOn,
    self: userId === state.auth.user?.id,
    color: sidebarVoiceMemberColor(state, channelId, userId, voiceState),
  };
}

export function toggleVoiceMemberMute(state: AppState, effects: SessionEffects, userId: string): void {
  const isSelf = userId === state.auth.user?.id;
  if (isSelf) {
    setCurrentCallMute(state, effects, null);
    return;
  }

  const nextMuted = !locallyMutedCallUserIds.has(userId);
  if (nextMuted) locallyMutedCallUserIds.add(userId);
  else locallyMutedCallUserIds.delete(userId);
  voiceCallController?.setRemoteUserMuted(userId, nextMuted);
  if (nextMuted) clearSpeakingCallUser(userId);
  syncAllSidebarVoiceMembers(state);
  const activeSession = voiceCallController?.activeSession;
  if (activeSession) syncVoiceCallStatus(state, activeSession);
  setNotice(state, "", "muted");
  effects.scheduleRender();
}

export function voiceMemberVolume(userId: string): number {
  return remoteCallUserVolumes.get(userId) ?? DEFAULT_REMOTE_USER_VOLUME_PERCENT;
}

export function adjustVoiceMemberVolume(state: AppState, effects: SessionEffects, userId: string, deltaPercent: number): number {
  if (!userId || userId === state.auth.user?.id) return DEFAULT_REMOTE_USER_VOLUME_PERCENT;
  const next = normalizeRemoteUserVolumePercent(voiceMemberVolume(userId) + deltaPercent);
  if (next === DEFAULT_REMOTE_USER_VOLUME_PERCENT) remoteCallUserVolumes.delete(userId);
  else remoteCallUserVolumes.set(userId, next);
  voiceCallController?.setRemoteUserVolume(userId, next);
  effects.scheduleRender();
  return next;
}

export function adjustSelectedVoiceMemberVolume(state: AppState, effects: SessionEffects, deltaPercent: number): boolean {
  const entry = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  });
  if (entry.kind !== "voice-member" || !entry.userId || entry.userId === state.auth.user?.id) return false;
  adjustVoiceMemberVolume(state, effects, entry.userId, deltaPercent);
  return true;
}

function toggleSelectedVoiceMemberMute(state: AppState, effects: SessionEffects, entry: ReturnType<typeof getSelectedSidebarEntry>): boolean {
  if (entry.kind !== "voice-member" || !entry.userId) return false;
  toggleVoiceMemberMute(state, effects, entry.userId);
  return true;
}

function syncSidebarVoiceMembersForChannel(state: AppState, channelId: string): void {
  const voiceStates = callVoiceStatesByChannelId.get(channelId);
  if (!voiceStates || voiceStates.size === 0) {
    delete state.sidebar.voiceMembersByChannelId[channelId];
    return;
  }

  state.sidebar.voiceMembersByChannelId[channelId] = Array.from(voiceStates.entries())
    .map(([userId, voiceState]) => sidebarVoiceMemberFromState(state, channelId, userId, voiceState))
    .sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)) || a.displayName.localeCompare(b.displayName));
}

function syncSidebarVoiceMembersForChannels(state: AppState, channelIds: Iterable<string>): void {
  for (const channelId of channelIds) syncSidebarVoiceMembersForChannel(state, channelId);
}

function syncAllSidebarVoiceMembers(state: AppState): void {
  syncSidebarVoiceMembersForChannels(state, callVoiceStatesByChannelId.keys());
}

export function canWatchVoiceMemberStream(state: AppState, channelId: string, userId: string): boolean {
  if (userId === state.auth.user?.id) return false;
  const session = voiceCallController?.activeSession;
  if (!session || session.state !== "ready" || session.target.channelId !== channelId) return false;
  const voiceState = callVoiceStatesByChannelId.get(channelId)?.get(userId);
  return Boolean(voiceState?.streaming || voiceMemberHasTrackedStream(channelId, userId));
}

export function isWatchingVoiceMemberStream(channelId: string, userId: string): boolean {
  const parsed = watchStreamController ? parseStreamKey(watchStreamController.streamKey) : null;
  return parsed?.channelId === channelId && parsed.ownerUserId === userId;
}

function syncOpenVoiceMemberStreamAction(state: AppState, channelId: string, userId: string): void {
  const modal = state.sidebar.serverActionModal;
  if (modal?.targetKind !== "voice_member" || modal.channelId !== channelId || modal.targetId !== userId) return;
  const shouldOffer = canWatchVoiceMemberStream(state, channelId, userId);
  const actionIndex = modal.actions.indexOf("watch_stream");
  if (shouldOffer && actionIndex < 0) {
    const volumeIndex = modal.actions.indexOf("adjust_volume");
    const insertIndex = volumeIndex >= 0 ? volumeIndex + 1 : Math.min(1, modal.actions.length);
    modal.actions.splice(insertIndex, 0, "watch_stream");
  } else if (!shouldOffer && actionIndex >= 0) {
    modal.actions.splice(actionIndex, 1);
    if (modal.selection === "watch_stream") {
      modal.selection = modal.actions[Math.min(actionIndex, modal.actions.length - 1)] ?? "toggle_mute";
    }
  }
  modal.watchingStream = shouldOffer && isWatchingVoiceMemberStream(channelId, userId);
}

function warmCachedMemberLists(state: AppState, accountId: string): void {
  for (const [key, members] of Object.entries(loadCachedMemberLists(accountId))) {
    const separator = key.indexOf(":");
    if (separator <= 0 || separator >= key.length - 1) continue;
    const guildId = key.slice(0, separator);
    const channelId = key.slice(separator + 1);
    cacheMemberList(state.memberList, guildId, channelId, members);
  }
}

function voiceMemberHydrationKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function rememberVoiceMemberHydrationTarget(guildId: string, userId: string, channelId: string): void {
  const key = voiceMemberHydrationKey(guildId, userId);
  const targets = pendingVoiceMemberHydrationTargets.get(key) ?? new Set<string>();
  targets.add(channelId);
  pendingVoiceMemberHydrationTargets.set(key, targets);
}

function clearPendingVoiceMemberHydration(guildId: string, userId: string): void {
  const key = voiceMemberHydrationKey(guildId, userId);
  pendingVoiceMemberHydrationKeys.delete(key);
  pendingVoiceMemberHydrationTargets.delete(key);
  const timer = pendingVoiceMemberHydrationTimers.get(key);
  if (timer) clearTimeout(timer);
  pendingVoiceMemberHydrationTimers.delete(key);
}

function markVoiceMemberHydrationPending(guildId: string, userId: string): void {
  const key = voiceMemberHydrationKey(guildId, userId);
  pendingVoiceMemberHydrationKeys.add(key);
  if (pendingVoiceMemberHydrationTimers.has(key)) return;
  const timer = setTimeout(() => {
    pendingVoiceMemberHydrationKeys.delete(key);
    pendingVoiceMemberHydrationTimers.delete(key);
  }, VOICE_MEMBER_HYDRATION_RETRY_MS);
  timer.unref?.();
  pendingVoiceMemberHydrationTimers.set(key, timer);
}

function needsVoiceMemberHydration(state: AppState, channelId: string, userId: string): boolean {
  const voiceState = callVoiceStatesByChannelId.get(channelId)?.get(userId);
  const hasName = Boolean(voiceState?.displayName && !isRawUserIdDisplayName(voiceState.displayName, userId))
    || displayNameForUser(state, channelId, userId, userId) !== "Someone";
  const hasAvatar = Boolean(avatarHashForUser(state, channelId, userId));
  const hasHydratedMember = state.memberList.members.some((member) => member.id === userId)
    || Array.from(state.memberList.cache.values()).some((members) => members.some((member) => member.id === userId));
  return !hasName || (!hasAvatar && !hasHydratedMember);
}

function maybeRequestVoiceMemberHydration(state: AppState, guildId: string | null | undefined, channelId: string, userIds: readonly string[]): void {
  const token = state.auth.savedToken;
  if (!token || !guildId || guildId === DIRECT_MESSAGES_GUILD_ID || userIds.length === 0) return;
  const uniqueUnknownUserIds = Array.from(new Set(userIds.filter((userId) => userId && userId !== state.auth.user?.id)))
    .filter((userId) => needsVoiceMemberHydration(state, channelId, userId));
  if (uniqueUnknownUserIds.length === 0) return;

  const toRequest: string[] = [];
  for (const userId of uniqueUnknownUserIds) {
    rememberVoiceMemberHydrationTarget(guildId, userId, channelId);
    const key = voiceMemberHydrationKey(guildId, userId);
    if (!pendingVoiceMemberHydrationKeys.has(key)) toRequest.push(userId);
  }
  if (toRequest.length === 0) return;

  const requested = appGateway?.requestGuildMembers(guildId, toRequest) ?? false;
  debugLog("voice.member_hydration.request", { guildId, channelId, requested, count: toRequest.length });
  if (!requested) return;
  for (const userId of toRequest) markVoiceMemberHydrationPending(guildId, userId);
}

function mergeMemberIntoChannelMemberCache(state: AppState, guildId: string, channelId: string, member: DiscordGuildMember): boolean {
  const existing = getCachedMemberList(state.memberList, guildId, channelId) ?? [];
  const existingIndex = existing.findIndex((entry) => entry.id === member.id);
  const next = existingIndex >= 0 ? existing.map((entry, index) => index === existingIndex ? { ...entry, ...member } : entry) : [...existing, member];
  const changed = existingIndex < 0 || JSON.stringify(existing[existingIndex]) !== JSON.stringify(next[existingIndex]);
  if (!changed) return false;

  cacheMemberList(state.memberList, guildId, channelId, next);
  if (state.memberList.guildId === guildId && state.memberList.channelId === channelId) {
    state.memberList.members = next;
  }
  const accountId = currentAccountId(state);
  if (accountId) saveCachedMemberList(accountId, guildId, channelId, next);
  return true;
}

function channelIdsForHydratedVoiceMember(state: AppState, guildId: string, userId: string): string[] {
  const key = voiceMemberHydrationKey(guildId, userId);
  const targets = new Set(pendingVoiceMemberHydrationTargets.get(key) ?? []);
  for (const [channelId, voiceStates] of callVoiceStatesByChannelId.entries()) {
    if (!voiceStates.has(userId)) continue;
    if (guildIdForChannelId(state, channelId) === guildId) targets.add(channelId);
  }
  return Array.from(targets);
}

export function handleGuildMembersChunk(state: AppState, effects: SessionEffects, guildId: string, members: readonly DiscordGuildMember[]): void {
  let changed = false;
  for (const member of members) {
    const channelIds = channelIdsForHydratedVoiceMember(state, guildId, member.id);
    clearPendingVoiceMemberHydration(guildId, member.id);
    changed = recordMemberRoleIds(state, guildId, member.id, member.roleIds) || changed;

    for (const channelId of channelIds) {
      const voiceState = callVoiceStatesByChannelId.get(channelId)?.get(member.id);
      if (voiceState && (!voiceState.displayName || isRawUserIdDisplayName(voiceState.displayName, member.id))) {
        voiceState.displayName = member.displayName;
        changed = true;
      }
      if (voiceState && member.roleIds && JSON.stringify(voiceState.roleIds ?? []) !== JSON.stringify(member.roleIds)) {
        voiceState.roleIds = [...member.roleIds];
        changed = true;
      }
      changed = mergeMemberIntoChannelMemberCache(state, guildId, channelId, member) || changed;
    }
  }

  if (!changed) return;
  syncAllSidebarVoiceMembers(state);
  const activeSession = voiceCallController?.activeSession;
  if (activeSession && activeSession.target.guildId === guildId) syncVoiceCallStatus(state, activeSession);
  debugLog("voice.member_hydration.applied", { guildId, count: members.length });
  effects.scheduleRender();
}

function removeCallVoiceStateUser(state: AppState, userId: string, channelIds?: Iterable<string>): boolean {
  const affectedChannelIds = new Set<string>();
  const targets = channelIds ? Array.from(channelIds) : Array.from(callVoiceStatesByChannelId.keys());
  for (const channelId of targets) {
    const states = callVoiceStatesByChannelId.get(channelId);
    if (!states) continue;
    if (states.delete(userId)) affectedChannelIds.add(channelId);
    if (states.size === 0) callVoiceStatesByChannelId.delete(channelId);
  }
  if (affectedChannelIds.size === 0) return false;
  syncSidebarVoiceMembersForChannels(state, affectedChannelIds);
  return true;
}

function updateCallVoiceState(state: AppState, update: VoiceStateUpdate): boolean {
  const affectedChannelIds = new Set<string>();
  const channelId = update.channelId;
  if (!channelId) {
    for (const [existingChannelId, states] of callVoiceStatesByChannelId.entries()) {
      const existing = states.get(update.userId);
      if (!existing) continue;
      // Discord can send a delayed disconnect for an older client voice
      // session after the same user has already joined with a new session.
      // Do not let that stale event remove the current sidebar member.
      if (update.sessionId && existing.sessionId && update.sessionId !== existing.sessionId) {
        debugLog("voice.state_disconnect_stale", {
          userId: update.userId,
          channelId: existingChannelId,
          disconnectedSessionId: update.sessionId,
          activeSessionId: existing.sessionId,
        });
        continue;
      }
      states.delete(update.userId);
      affectedChannelIds.add(existingChannelId);
      if (states.size === 0) callVoiceStatesByChannelId.delete(existingChannelId);
    }
    if (affectedChannelIds.size === 0) return false;
    clearSpeakingCallUser(update.userId);
    syncSidebarVoiceMembersForChannels(state, affectedChannelIds);
    return true;
  }
  for (const [existingChannelId, states] of callVoiceStatesByChannelId.entries()) {
    if (existingChannelId === channelId) continue;
    if (states.delete(update.userId)) affectedChannelIds.add(existingChannelId);
    if (states.size === 0) callVoiceStatesByChannelId.delete(existingChannelId);
  }
  const states = callVoiceStatesByChannelId.get(channelId) ?? new Map<string, TrackedCallVoiceState>();
  const existing = states.get(update.userId);
  states.set(update.userId, {
    ...existing,
    ...(update.displayName ? { displayName: update.displayName } : {}),
    ...(update.roleIds ? { roleIds: update.roleIds } : {}),
    ...(update.sessionId ? { sessionId: update.sessionId } : {}),
    selfMute: update.selfMute,
    selfDeaf: update.selfDeaf,
    streaming: update.selfStream ?? false,
    cameraOn: update.selfVideo ?? false,
    mute: update.mute,
    deaf: update.deaf,
  });
  callVoiceStatesByChannelId.set(channelId, states);
  const rolesChanged = recordMemberRoleIds(state, update.guildId, update.userId, update.roleIds);
  if (update.selfMute || update.mute) clearSpeakingCallUser(update.userId);
  affectedChannelIds.add(channelId);
  syncSidebarVoiceMembersForChannels(state, affectedChannelIds);
  maybeRequestVoiceMemberHydration(state, update.guildId ?? guildIdForChannelId(state, channelId), channelId, [update.userId]);
  return affectedChannelIds.size > 0 || rolesChanged;
}

function rememberCallGatewayVoiceStates(state: AppState, event: { channelId: string; voiceStates: readonly { userId: string; selfMute: boolean; selfDeaf: boolean; selfStream?: boolean; selfVideo?: boolean; mute: boolean; deaf: boolean }[] }): void {
  if (event.voiceStates.length === 0) return;
  const states = callVoiceStatesByChannelId.get(event.channelId) ?? new Map<string, TrackedCallVoiceState>();
  for (const voiceState of event.voiceStates) {
    states.set(voiceState.userId, {
      ...states.get(voiceState.userId),
      selfMute: voiceState.selfMute,
      selfDeaf: voiceState.selfDeaf,
      streaming: voiceState.selfStream ?? false,
      cameraOn: voiceState.selfVideo ?? false,
      mute: voiceState.mute,
      deaf: voiceState.deaf,
    });
  }
  callVoiceStatesByChannelId.set(event.channelId, states);
  syncSidebarVoiceMembersForChannel(state, event.channelId);
  maybeRequestVoiceMemberHydration(state, guildIdForChannelId(state, event.channelId), event.channelId, event.voiceStates.map((voiceState) => voiceState.userId));
}

function syncCallParticipantSounds(state: AppState, channelId: string, voiceStateUserIds: readonly string[]): boolean {
  const activeSession = voiceCallController?.activeSession;
  const selfUserId = state.auth.user?.id;
  if (!activeSession || activeSession.target.channelId !== channelId || activeSession.state === "ended" || activeSession.state === "error") {
    const baseline = new Set(voiceStateUserIds.filter((userId) => userId && userId !== selfUserId));
    const departed = departedCallParticipantsByChannelId.get(channelId);
    if (departed) {
      for (const userId of baseline) departed.delete(userId);
      if (departed.size > 0) departedCallParticipantsByChannelId.set(channelId, departed);
      else departedCallParticipantsByChannelId.delete(channelId);
    }
    knownCallParticipantsByChannelId.set(channelId, baseline);
    debugLog("call.participants.baseline", {
      source: "call_gateway_inactive",
      channelId,
      activeChannelId: activeSession?.target.channelId ?? null,
      activeState: activeSession?.state ?? null,
      participants: Array.from(baseline),
      departed: Array.from(departed ?? []),
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
  const departed = departedCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  let changed = false;
  for (const userId of next) {
    const wasDeparted = departed.delete(userId);
    if (!previous.has(userId) || wasDeparted) {
      after.add(userId);
      stopOutboundCallRingtone(channelId, "participant_join_call_gateway");
      playCallJoinSoundOnce(channelId, userId, "call_gateway");
      changed = true;
    }
  }
  knownCallParticipantsByChannelId.set(channelId, after);
  if (departed.size > 0) departedCallParticipantsByChannelId.set(channelId, departed);
  else departedCallParticipantsByChannelId.delete(channelId);
  debugLog("call.participants.snapshot", {
    source: "call_gateway",
    channelId,
    activeState: activeSession.state,
    previous: Array.from(previous),
    next: Array.from(next),
    after: Array.from(after),
    departed: Array.from(departed),
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

export function rememberPresentCallParticipants(
  selfUserId: string | null | undefined,
  participants: Set<string>,
  departed: Set<string>,
  voiceStateUserIds: readonly string[],
): void {
  for (const userId of voiceStateUserIds) {
    if (!userId || userId === selfUserId) continue;
    participants.add(userId);
    departed.delete(userId);
  }
}

function rememberActiveCallParticipants(state: AppState, channelId: string, voiceStateUserIds: readonly string[]): void {
  const selfUserId = state.auth.user?.id;
  const existing = knownCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const departed = departedCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const before = new Set(existing);
  const departedBefore = new Set(departed);
  rememberPresentCallParticipants(selfUserId, existing, departed, voiceStateUserIds);
  knownCallParticipantsByChannelId.set(channelId, existing);
  if (departed.size > 0) departedCallParticipantsByChannelId.set(channelId, departed);
  else departedCallParticipantsByChannelId.delete(channelId);
  debugLog("call.participants.remember_active", {
    channelId,
    before: Array.from(before),
    voiceStateUserIds,
    after: Array.from(existing),
    departedBefore: Array.from(departedBefore),
    departedAfter: Array.from(departed),
  });
}

export function shouldRetainTrackedCallParticipant(
  activeChannelId: string,
  updateChannelId: string | null,
  stillTrackedInActiveChannel: boolean,
): boolean {
  return updateChannelId !== activeChannelId && stillTrackedInActiveChannel;
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

  // updateCallVoiceState() is the sole owner of the metadata map and protects
  // a current session from delayed disconnects for an older session. If that
  // map still contains this user after processing a departure, do not let this
  // second roster projection undo the protection.
  if (shouldRetainTrackedCallParticipant(
    channelId,
    update.channelId,
    Boolean(callVoiceStatesByChannelId.get(channelId)?.has(update.userId)),
  )) {
    debugLog("call.participants.voice_state_ignored", { reason: "stale_disconnect", channelId, update });
    return false;
  }

  const participants = knownCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const departed = departedCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  debugLog("call.participants.voice_state", {
    channelId,
    activeState: activeSession.state,
    userId: update.userId,
    updateChannelId: update.channelId,
    before: Array.from(participants),
    departedBefore: Array.from(departed),
  });
  let changed = false;
  if (update.channelId === channelId) {
    const wasDeparted = departed.delete(update.userId);
    if (!participants.has(update.userId) || wasDeparted) {
      participants.add(update.userId);
      stopOutboundCallRingtone(channelId, "participant_join_voice_state");
      playCallJoinSoundOnce(channelId, update.userId, "voice_state");
      changed = true;
    }
  } else {
    const wasKnown = participants.delete(update.userId);
    const wasFromCallMessage = activeCallMessageParticipantIds(state, channelId).includes(update.userId);
    const wasDeparted = departed.has(update.userId);
    // The application gateway reports voice-state changes for every subscribed
    // guild. An update for an unrelated channel is only a departure from this
    // call when the user was actually known here (or is retained by a stale
    // active-call message). Otherwise this set grows with unrelated guild voice
    // users and can hide them if they later join this call before we do.
    if (wasKnown || wasFromCallMessage) departed.add(update.userId);
    clearSpeakingCallUser(update.userId);
    forgetCallJoinSound(channelId, update.userId);
    if (!wasDeparted && (wasKnown || wasFromCallMessage)) {
      if (isActiveRecordCallChannel(channelId)) {
        debugLog("call.participants.sound", { source: "voice_state", channelId, userId: update.userId, action: "leave", effect: "callUserLeave", wasKnown, wasFromCallMessage });
        playSoundEffect("callUserLeave");
      } else {
        debugLog("call.participants.sound_skipped", { source: "voice_state", channelId, userId: update.userId, action: "leave", reason: "not_active_record_call", wasKnown, wasFromCallMessage });
      }
      changed = true;
    }
  }
  knownCallParticipantsByChannelId.set(channelId, participants);
  if (departed.size > 0) departedCallParticipantsByChannelId.set(channelId, departed);
  else departedCallParticipantsByChannelId.delete(channelId);
  debugLog("call.participants.voice_state_after", {
    channelId,
    userId: update.userId,
    updateChannelId: update.channelId,
    after: Array.from(participants),
    departedAfter: Array.from(departed),
    changed,
  });
  if (changed) syncVoiceCallStatus(state, activeSession);
  return changed;
}

function handleVoiceGatewayParticipantsConnect(
  state: AppState,
  effects: SessionEffects,
  session: VoiceCallSession,
  userIds: readonly string[],
): void {
  const channelId = session.target.channelId;
  const selfUserId = state.auth.user?.id;
  const participants = knownCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const departed = departedCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const voiceStates = callVoiceStatesByChannelId.get(channelId) ?? new Map<string, TrackedCallVoiceState>();
  const added: string[] = [];
  let metadataAdded = false;
  for (const userId of userIds) {
    if (!userId || userId === selfUserId) continue;
    const wasDeparted = departed.delete(userId);
    if (!participants.has(userId) || wasDeparted) added.push(userId);
    participants.add(userId);
    if (!voiceStates.has(userId)) {
      voiceStates.set(userId, {
        selfMute: false,
        selfDeaf: false,
        streaming: false,
        cameraOn: false,
        mute: false,
        deaf: false,
      });
      metadataAdded = true;
    }
  }
  knownCallParticipantsByChannelId.set(channelId, participants);
  if (voiceStates.size > 0) callVoiceStatesByChannelId.set(channelId, voiceStates);
  if (departed.size > 0) departedCallParticipantsByChannelId.set(channelId, departed);
  else departedCallParticipantsByChannelId.delete(channelId);
  if (added.length === 0 && !metadataAdded) return;

  if (added.length > 0) {
    stopOutboundCallRingtone(channelId, "participant_join_voice_gateway");
    playCallJoinSoundForParticipants(channelId, added, "voice_gateway");
  }
  maybeRequestVoiceMemberHydration(state, session.target.guildId, channelId, added);
  syncSidebarVoiceMembersForChannel(state, channelId);
  debugLog("call.participants.voice_gateway_connect", { channelId, addedCount: added.length });
  syncVoiceCallStatus(state, session);
  effects.scheduleRender();
}

function handleVoiceGatewayParticipantDisconnect(
  state: AppState,
  effects: SessionEffects,
  session: VoiceCallSession,
  userId: string,
): void {
  if (!userId || userId === state.auth.user?.id) return;
  const channelId = session.target.channelId;
  const participants = knownCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const departed = departedCallParticipantsByChannelId.get(channelId) ?? new Set<string>();
  const voiceStates = callVoiceStatesByChannelId.get(channelId);
  const wasKnown = participants.delete(userId);
  const wasFromCallMessage = activeCallMessageParticipantIds(state, channelId).includes(userId);
  const hadVoiceState = Boolean(voiceStates?.has(userId));
  const wasDeparted = departed.has(userId);
  if (wasKnown || wasFromCallMessage || hadVoiceState) departed.add(userId);
  knownCallParticipantsByChannelId.set(channelId, participants);
  if (departed.size > 0) departedCallParticipantsByChannelId.set(channelId, departed);
  else departedCallParticipantsByChannelId.delete(channelId);
  voiceStates?.delete(userId);
  if (voiceStates?.size === 0) callVoiceStatesByChannelId.delete(channelId);
  syncSidebarVoiceMembersForChannel(state, channelId);
  clearSpeakingCallUser(userId);
  forgetCallJoinSound(channelId, userId);
  if (wasDeparted || (!wasKnown && !wasFromCallMessage && !hadVoiceState)) return;

  debugLog("call.participants.voice_gateway_disconnect", { channelId, userId });
  playSoundEffect("callUserLeave");
  syncVoiceCallStatus(state, session);
  effects.scheduleRender();
}

export function handleVoiceStateUpdate(state: AppState, effects: SessionEffects, update: VoiceStateUpdate): void {
  const voiceMembersChanged = updateCallVoiceState(state, update);
  voiceCallController?.handleVoiceStateUpdate(update);
  const activeSession = voiceCallController?.activeSession;
  const changed = handleCallVoiceStateUpdate(state, update);
  if (!changed && activeSession?.target.channelId === update.channelId) syncVoiceCallStatus(state, activeSession);
  if (changed || voiceMembersChanged) effects.scheduleRender();
}

export function handleGatewayMessageCreate(state: AppState, effects: SessionEffects, message: DiscordMessage): void {
  const guildId = guildIdForChannel(state, message);
  const cachedMessage = hydrateMissingReplyPreviewFromKnownMessages(state, withMessageGuildId(message, guildId));
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
  handleCallMessageParticipants(state, cachedMessage.channelId, cachedMessage.call, "message_create");
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
  maybeHydrateMissingReplyPreviewFromRest(state, effects, cachedMessage);
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
  handleCallMessageParticipants(state, patch.channelId, patch.call ?? null, "message_update");
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

function upsertGuildChannelArray(channels: readonly DiscordChannel[], channel: DiscordChannel): DiscordChannel[] {
  const index = channels.findIndex((existing) => existing.id === channel.id);
  const next = channels.slice();
  if (index >= 0) {
    const existing = next[index]!;
    next[index] = {
      ...existing,
      ...channel,
      muted: channel.muted ?? existing.muted,
      ...(existing.thread && channel.thread
        ? { thread: { ...existing.thread, ...channel.thread, joined: channel.thread.joined ?? existing.thread.joined } }
        : {}),
    };
  } else {
    next.push(channel);
  }
  return channel.guildId === DIRECT_MESSAGES_GUILD_ID
    ? sortDirectMessageChannels(next)
    : sortGuildChannels(next);
}

function persistGatewayGuildChannels(state: AppState, guildId: string, channels: DiscordChannel[]): void {
  const accountId = currentAccountId(state);
  if (!accountId) return;
  if (guildId === DIRECT_MESSAGES_GUILD_ID) saveCachedDirectMessages(accountId, channels);
  else saveCachedGuildChannels(accountId, guildId, channels);
}

export function handleGatewayChannelCreateOrUpdate(state: AppState, effects: SessionEffects, channel: DiscordChannel): void {
  // REST loads and gateway snapshots can complete after a delete. Channel IDs
  // are never reused, so ignore late create/update data for this session.
  if (isDeletedGuildChannel(state, channel)) return;
  channel = withChannelMuteSettings(state, [channel])[0] ?? channel;
  if (channel.guildId === DIRECT_MESSAGES_GUILD_ID) {
    ensureDirectMessagesGuild(state);
  }

  // The live channel list and the sidebar cache can briefly contain different
  // snapshots during startup/refresh. Merge both before applying an event so a
  // regular CHANNEL_UPDATE cannot accidentally erase cached thread rows.
  const cachedChannels = sidebarChannelsForGuild(state.sidebar, state.channelList.channels, channel.guildId);
  const nextCachedChannels = upsertGuildChannelArray(cachedChannels, channel);
  setSidebarCachedChannels(state.sidebar, channel.guildId, nextCachedChannels);
  persistGatewayGuildChannels(state, channel.guildId, nextCachedChannels);

  if (state.channelList.guildId === channel.guildId) {
    upsertChannel(state.channelList, channel);
    refreshHiddenChannelFlags(state, channel.guildId);
    let mergedChannels = nextCachedChannels;
    for (const activeChannel of state.channelList.channels) {
      mergedChannels = upsertGuildChannelArray(mergedChannels, activeChannel);
    }
    setSidebarCachedChannels(state.sidebar, channel.guildId, mergedChannels);
    persistGatewayGuildChannels(state, channel.guildId, mergedChannels);
    if (state.memberList.open && state.channelList.activeChannelId === channel.id) {
      syncMemberListForCurrentChannel(state, effects);
    }
  }

  effects.scheduleRender();
}

export function removeSessionChannel(
  state: AppState,
  effects: SessionEffects,
  channelId: string,
  eventGuildId: string | null = null,
): void {
  const knownChannels = [
    ...state.channelList.channels,
    ...Object.values(state.sidebar.cachedChannelsByGuildId).flat(),
  ];
  const deletedChannel = knownChannels.find((channel) => channel.id === channelId);
  const removedChannelIds = new Set([channelId]);
  if (deletedChannel && !isThreadChannel(deletedChannel)) {
    for (const channel of knownChannels) {
      if (isThreadChannel(channel) && channel.parentId === channelId) removedChannelIds.add(channel.id);
    }
  }
  const wasActive = Boolean(state.channelList.activeChannelId && removedChannelIds.has(state.channelList.activeChannelId));
  const wasTimelineChannel = Boolean(state.timeline.channelId && removedChannelIds.has(state.timeline.channelId));
  const removedGuildId = eventGuildId
    ?? deletedChannel?.guildId
    ?? state.channelList.guildId;
  if (removedGuildId && removedGuildId !== DIRECT_MESSAGES_GUILD_ID && removedGuildId !== WHATSAPP_GUILD_ID) {
    const deletedIds = deletedGuildChannelIdsFor(state);
    for (const removedChannelId of removedChannelIds) deletedIds.add(removedChannelId);
  }
  let removed = false;
  for (const removedChannelId of removedChannelIds) {
    removed = removeChannel(state.channelList, removedChannelId) || removed;
  }
  let removedFromSidebar = false;
  if (removedGuildId) {
    const cached = state.sidebar.cachedChannelsByGuildId[removedGuildId] ?? [];
    const nextCached = cached.filter((channel) => !removedChannelIds.has(channel.id));
    removedFromSidebar = nextCached.length !== cached.length;
    if (state.channelList.guildId === removedGuildId && removed) {
      setSidebarCachedChannels(state.sidebar, removedGuildId, state.channelList.channels);
      persistGatewayGuildChannels(state, removedGuildId, state.channelList.channels);
    } else if (removedFromSidebar) {
      setSidebarCachedChannels(state.sidebar, removedGuildId, nextCached);
      persistGatewayGuildChannels(state, removedGuildId, nextCached);
    }
  }
  for (const removedChannelId of removedChannelIds) {
    clearCachedChannelMessages(state.messageCacheByChannelId, removedChannelId);
    clearChannelNotifications(state.notifications, removedChannelId);
    delete state.channelMuteSettings[removedChannelId];
  }
  persistNotifications(state);
  if (state.sidebar.serverActionModal && removedChannelIds.has(state.sidebar.serverActionModal.targetId)) {
    state.sidebar.serverActionModal = null;
  }
  if (wasActive || wasTimelineChannel) {
    clearTimeline(state.timeline);
    setNotice(state, "Channel or thread was deleted.", "warning", { statusLine: false, chat: true });
    syncMemberListForCurrentChannel(state, effects);
  }
  if (removed || removedFromSidebar || wasActive || wasTimelineChannel) effects.scheduleRender();
}

export function handleGatewayThreadListSync(
  state: AppState,
  effects: SessionEffects,
  event: import("./appgateway").ThreadListSyncEvent,
): void {
  // READY thread snapshots are deliberately non-authoritative and can be empty
  // while the persisted/sidebar cache already knows about active threads.
  // Always merge both snapshots before applying the gateway delta.
  const existing = withoutDeletedGuildChannels(
    state,
    sidebarChannelsForGuild(state.sidebar, state.channelList.channels, event.guildId),
  );
  const incomingThreads = event.threads.filter((thread) => !isDeletedGuildChannel(state, thread));
  const parentScope = event.parentChannelIds === null ? null : new Set(event.parentChannelIds);
  const syncedThreadIds = new Set(incomingThreads.map((thread) => thread.id));
  let next = event.authoritative
    ? existing.filter((channel) => {
        if (!isThreadChannel(channel)) return true;
        if (parentScope && (!channel.parentId || !parentScope.has(channel.parentId))) return true;
        return syncedThreadIds.has(channel.id);
      })
    : existing.slice();
  for (const thread of withChannelMuteSettings(state, incomingThreads)) {
    next = upsertGuildChannelArray(next, thread);
  }
  next = sortGuildChannels(next);

  if (state.channelList.guildId === event.guildId) {
    setChannelList(state.channelList, event.guildId, next);
    refreshHiddenChannelFlags(state, event.guildId);
    next = state.channelList.channels;
  }
  setSidebarCachedChannels(state.sidebar, event.guildId, next);
  persistGatewayGuildChannels(state, event.guildId, next);
  effects.scheduleRender();
}

function mergeKnownRelevantThreads(
  channels: readonly DiscordChannel[],
  knownChannels: readonly DiscordChannel[],
  currentUserId: string | null,
): DiscordChannel[] {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  for (const channel of knownChannels) {
    if (!isThreadChannel(channel)
      || channel.thread?.archived
      || !isSidebarThreadRelevant(channel, currentUserId)) continue;
    byId.set(channel.id, channel);
  }
  return sortGuildChannels(Array.from(byId.values()));
}

function setThreadJoinedState(state: AppState, threadId: string, joined: boolean): boolean {
  let changed = false;
  const update = (channel: DiscordChannel): DiscordChannel => {
    if (channel.id !== threadId || !channel.thread || channel.thread.joined === joined) return channel;
    changed = true;
    return { ...channel, thread: { ...channel.thread, joined } };
  };
  state.channelList.channels = state.channelList.channels.map(update);
  if (state.channelList.activeChannel?.id === threadId) state.channelList.activeChannel = update(state.channelList.activeChannel);
  for (const [guildId, channels] of Object.entries(state.sidebar.cachedChannelsByGuildId)) {
    const next = channels.map(update);
    if (next.some((channel, index) => channel !== channels[index])) {
      setSidebarCachedChannels(state.sidebar, guildId, next);
      persistGatewayGuildChannels(state, guildId, next);
    }
  }
  return changed;
}

function cachedSidebarGuilds(_directMessages: DiscordChannel[], guilds: DiscordGuild[]): DiscordGuild[] {
  return withDirectMessagesGuild(guilds);
}

/**
 * Populate the Discord sidebar from the most recently active account before a
 * saved token has finished validating. The account marker lets auth either
 * confirm this preview or discard it if the token belongs to someone else.
 */
export function restoreCachedSidebarPreview(state: AppState): boolean {
  const accountId = loadLastCachedAccountId();
  if (!accountId) return false;

  const cachedDirectMessages = loadCachedDirectMessages(accountId) ?? [];
  const cachedGuildOrder = loadCachedGuildOrder(accountId);
  const cachedGuilds = sortGuildsByOrder(loadCachedGuilds(accountId) ?? [], cachedGuildOrder);
  if (cachedDirectMessages.length === 0 && cachedGuilds.length === 0) return false;

  const cachedChannelLayout = loadCachedSidebarChannelLayout(accountId);
  for (const channel of cachedDirectMessages) {
    if (channel.muted !== undefined) state.channelMuteSettings[channel.id] = channel.muted;
  }
  setSidebarCachedChannels(state.sidebar, DIRECT_MESSAGES_GUILD_ID, cachedDirectMessages);
  applySidebarChannelLayoutForGuild(
    state.sidebar,
    DIRECT_MESSAGES_GUILD_ID,
    cachedChannelLayout?.[DIRECT_MESSAGES_GUILD_ID],
  );
  for (const guild of cachedGuilds) {
    const cachedChannels = loadCachedGuildChannels(accountId, guild.id) ?? [];
    for (const channel of cachedChannels) {
      if (channel.muted !== undefined) state.channelMuteSettings[channel.id] = channel.muted;
    }
    if (cachedChannels.length > 0) setSidebarCachedChannels(state.sidebar, guild.id, cachedChannels);
  }

  setSidebarGuilds(state.sidebar, cachedSidebarGuilds(cachedDirectMessages, cachedGuilds));
  applySidebarFolderLayout(state.sidebar, loadCachedSidebarFolders(accountId));
  state.auth.cachedSidebarPreviewAccountId = accountId;
  return true;
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
    const byChannelId: Record<string, number> = {};
    const channelGuildIds: Record<string, string> = {};
    for (const [channelId, count] of Object.entries(state.notifications.byChannelId)) {
      const guildId = state.notifications.channelGuildIds[channelId];
      if (guildId === WHATSAPP_GUILD_ID || isWhatsAppChannelId(channelId)) continue;
      byChannelId[channelId] = count;
      if (guildId) channelGuildIds[channelId] = guildId;
    }
    saveCachedNotifications(accountId, { byChannelId, channelGuildIds });
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

function hydrateMissingReplyPreviewFromKnownMessages(state: AppState, message: DiscordMessage): DiscordMessage {
  const target = replyReferenceTarget(message);
  if (!target) return message;
  const hydrated = hydrateMissingReplyPreviewFromLookup(message, (reference) => findKnownMessage(state, reference.channelId, reference.messageId));
  debugLog(hydrated === message ? "reply.preview.cache_miss" : "reply.preview.cache_hydrated", {
    channelId: message.channelId,
    messageId: message.id,
    referenceChannelId: target.channelId,
    referenceMessageId: target.messageId,
  });
  return hydrated;
}

function hydrateMissingReplyPreviewsFromKnownMessages(state: AppState, messages: readonly DiscordMessage[]): { messages: DiscordMessage[]; changed: boolean } {
  let changed = false;
  const hydrated = messages.map((message) => {
    const next = hydrateMissingReplyPreviewFromKnownMessages(state, message);
    changed ||= next !== message;
    return next;
  });
  return { messages: hydrated, changed };
}

function findKnownMessage(state: AppState, channelId: string, messageId: string): DiscordMessage | null {
  const cached = state.messageCacheByChannelId[channelId]?.messages.find((message) => message.id === messageId);
  if (cached) return cached;
  if (state.timeline.channelId === channelId) {
    return state.timeline.messages.find((message) => message.id === messageId) ?? null;
  }
  return null;
}

function maybeHydrateMissingReplyPreviewFromRest(state: AppState, effects: SessionEffects, message: DiscordMessage): void {
  const target = replyReferenceTarget(message);
  if (!target) return;
  const token = state.auth.savedToken;
  if (!token) return;

  const referenceChannelId = target.channelId;
  const referenceMessageId = target.messageId;
  const fetchKey = `${message.channelId}:${message.id}:${referenceChannelId}:${referenceMessageId}`;
  if (replyPreviewRestFetchKeys.has(fetchKey)) return;
  replyPreviewRestFetchKeys.add(fetchKey);
  debugLog("reply.preview.rest_fetch", {
    channelId: message.channelId,
    messageId: message.id,
    referenceChannelId,
    referenceMessageId,
  });

  void (async () => {
    try {
      const referenced = await fetchChannelMessage(token, referenceChannelId, referenceMessageId);
      if (state.auth.savedToken !== token) return;
      const patch: DiscordMessagePatch = {
        id: message.id,
        channelId: message.channelId,
        reply: replyPreviewFromMessage(withMessageGuildId(referenced, guildIdForChannel(state, referenced))),
      };
      let changed = false;
      if (patchCachedChannelMessage(state.messageCacheByChannelId, patch)) {
        persistChannelMessageCache(state, patch.channelId);
        changed = true;
      }
      if (state.timeline.channelId === patch.channelId) {
        patchTimelineMessage(state.timeline, patch);
        changed = true;
      }
      debugLog("reply.preview.rest_hydrated", {
        channelId: message.channelId,
        messageId: message.id,
        referenceChannelId,
        referenceMessageId,
        changed,
      });
      if (changed) effects.scheduleRender();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!/Discord resource not found|Discord denied access/.test(errorMessage)) {
        replyPreviewRestFetchKeys.delete(fetchKey);
      }
      debugLog("reply.preview.rest_failed", {
        channelId: message.channelId,
        messageId: message.id,
        referenceChannelId,
        referenceMessageId,
        error: errorMessage,
      });
    }
  })();
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

export function loadGuildRolesInBackground(
  state: AppState,
  token: string,
  guildId: string,
  effects: SessionEffects,
  options: { revalidate?: boolean } = {},
): void {
  const fetchState = roleFetchStateFor(state);
  if (guildId === DIRECT_MESSAGES_GUILD_ID || fetchState.pending.has(guildId) || fetchState.fresh.has(guildId)) return;
  if (!options.revalidate && guildRolesIncludeNamesAndPermissions(state.guildRolesByGuildId[guildId])) return;
  fetchState.pending.add(guildId);
  const revision = fetchState.revisions.get(guildId) ?? 0;
  void fetchGuildRoles(token, guildId).then((roles) => {
    debugLog("guild_roles.fetched", {
      guildId,
      count: roles.length,
      withPermissions: roles.filter((role) => typeof role.permissions === "string").length,
      withNames: roles.filter((role) => typeof role.name === "string" && role.name.trim().length > 0).length,
    });
    if (guildRoleFetchState.get(state) !== fetchState || (fetchState.revisions.get(guildId) ?? 0) !== revision) return;
    fetchState.fresh.add(guildId);
    state.guildRolesByGuildId[guildId] = roles;
    refreshHiddenChannelFlags(state, guildId);
    const accountId = currentAccountId(state);
    if (accountId) saveCachedGuildRoles(accountId, guildId, roles);
    state.memberRoleCacheVersion += 1;
    syncAllSidebarVoiceMembers(state);
    effects.scheduleRender();
  }).catch(() => {
    // Role colors are opportunistic. Missing role metadata should not disrupt chat.
  }).finally(() => {
    if (guildRoleFetchState.get(state) !== fetchState) return;
    fetchState.pending.delete(guildId);
    if ((fetchState.revisions.get(guildId) ?? 0) !== revision) {
      fetchState.fresh.delete(guildId);
      loadGuildRolesInBackground(state, token, guildId, effects, { revalidate: true });
    }
  });
}

function applyGatewayGuildRoleUpdate(
  state: AppState,
  effects: SessionEffects,
  guildId: string,
  update: { role: DiscordRole } | { deletedRoleId: string },
): void {
  const fetchState = roleFetchStateFor(state);
  fetchState.revisions.set(guildId, (fetchState.revisions.get(guildId) ?? 0) + 1);
  const current = state.guildRolesByGuildId[guildId] ?? [];
  const next = "role" in update
    ? current.some((role) => role.id === update.role.id)
      ? current.map((role) => role.id === update.role.id ? update.role : role)
      : [...current, update.role]
    : current.filter((role) => role.id !== update.deletedRoleId);
  state.guildRolesByGuildId[guildId] = next;
  refreshHiddenChannelFlags(state, guildId);
  const accountId = currentAccountId(state);
  if (accountId) saveCachedGuildRoles(accountId, guildId, next);
  state.memberRoleCacheVersion += 1;
  syncAllSidebarVoiceMembers(state);
  effects.scheduleRender();
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
  const layout = sidebarFolderLayout(state.sidebar);
  const cachedLayout = layout.folders.length === 0 ? loadCachedSidebarFolders(accountId) : null;
  if (cachedLayout && cachedLayout.folders.length > 0) return;
  saveCachedSidebarFolders(accountId, layout);
}

export function persistSidebarFolders(state: AppState): void {
  const accountId = currentAccountId(state);
  if (!accountId) return;
  saveCachedSidebarFolders(accountId, sidebarFolderLayout(state.sidebar));
}

function privateConversationLayoutScope(state: AppState, guildId: string): string | null {
  if (guildId === DIRECT_MESSAGES_GUILD_ID) return currentAccountId(state);
  if (guildId === WHATSAPP_GUILD_ID && state.whatsapp.account?.id) {
    return whatsappSidebarLayoutScope(state.whatsapp.account.id, state.whatsapp.account.phoneId);
  }
  return null;
}

function persistPrivateConversationLayout(state: AppState, guildId: string): void {
  const scope = privateConversationLayoutScope(state, guildId);
  if (!scope) return;
  try {
    saveCachedSidebarChannelLayout(scope, {
      [guildId]: sidebarChannelLayoutForGuild(state.sidebar, guildId),
    });
  } catch {
    // Local layout persistence is opportunistic; never interrupt navigation.
  }
}

const KICK_MEMBERS_PERMISSION = 1n << 1n;
const BAN_MEMBERS_PERMISSION = 1n << 2n;
const ADMINISTRATOR_PERMISSION = 1n << 3n;
const MANAGE_CHANNELS_PERMISSION = 1n << 4n;
const VIEW_CHANNEL_PERMISSION = 1n << 10n;
const MUTE_MEMBERS_PERMISSION = 1n << 22n;
const DEAFEN_MEMBERS_PERMISSION = 1n << 23n;
const MOVE_MEMBERS_PERMISSION = 1n << 24n;
const MANAGE_THREADS_PERMISSION = 1n << 34n;

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

function currentGuildPermissionBits(
  state: AppState,
  guildId: string,
  currentUserRoleIds: readonly string[],
): bigint | null {
  const roles = state.guildRolesByGuildId[guildId];
  if (guildRolesIncludePermissions(roles)) {
    const rolesById = new Map((roles ?? []).map((role) => [role.id, role]));
    let permissions = permissionBits(rolesById.get(guildId)?.permissions);
    for (const roleId of currentUserRoleIds) permissions |= permissionBits(rolesById.get(roleId)?.permissions);
    return permissions;
  }

  const guild = state.sidebar.guilds.find((candidate) => candidate.id === guildId);
  return typeof guild?.permissions === "string" ? permissionBits(guild.permissions) : null;
}

function applyGuildChannelOverwrites(
  permissions: bigint,
  channel: DiscordChannel,
  guildId: string,
  roleIds: readonly string[],
  userId: string,
): bigint {
  if ((permissions & ADMINISTRATOR_PERMISSION) !== 0n) return permissions;
  const overwrites = channel.permissionOverwrites ?? [];
  const everyoneOverwrite = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyoneOverwrite) permissions = applyOverwrite(permissions, everyoneOverwrite);

  let roleAllow = 0n;
  let roleDeny = 0n;
  const roleIdSet = new Set(roleIds);
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !roleIdSet.has(overwrite.id)) continue;
    roleAllow |= permissionBits(overwrite.allow);
    roleDeny |= permissionBits(overwrite.deny);
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === userId);
  return memberOverwrite ? applyOverwrite(permissions, memberOverwrite) : permissions;
}

function currentUserChannelPermissionBits(
  state: AppState,
  guildId: string,
  channelId: string,
  currentUserRoleIds: readonly string[],
  currentUserId: string,
): bigint | null {
  const channel = channelById(state, channelId);
  const permissions = currentGuildPermissionBits(state, guildId, currentUserRoleIds);
  if (!channel || permissions === null) return null;
  // Discord threads inherit channel permissions from their parent and do not
  // carry permission_overwrites in thread payloads.
  const permissionChannel = isThreadChannel(channel) && channel.parentId
    ? channelById(state, channel.parentId) ?? channel
    : channel;
  return applyGuildChannelOverwrites(permissions, permissionChannel, guildId, currentUserRoleIds, currentUserId);
}

/** Whether the authenticated user may delete this guild channel or thread. */
export function canDeleteGuildChannel(state: AppState, guildId: string, channelId: string): boolean {
  if (guildId === DIRECT_MESSAGES_GUILD_ID || guildId === WHATSAPP_GUILD_ID) return false;
  const channel = channelById(state, channelId);
  const currentUserId = state.auth.user?.id;
  if (!channel || channel.guildId !== guildId || !currentUserId) return false;

  const guild = state.sidebar.guilds.find((candidate) => candidate.id === guildId);
  const currentUserIsOwner = guild?.owner === true || guild?.ownerId === currentUserId;
  if (currentUserIsOwner) return true;
  const currentUserRoleIds = state.roleIdsByGuildId[guildId]
    ?? state.memberRoleIdsByGuildId[guildId]?.[currentUserId];
  if (!currentUserRoleIds) return false;

  const permissions = currentUserChannelPermissionBits(
    state,
    guildId,
    channelId,
    currentUserRoleIds,
    currentUserId,
  );
  if (permissions === null) return false;
  if ((permissions & ADMINISTRATOR_PERMISSION) !== 0n) return true;
  if ((permissions & VIEW_CHANNEL_PERMISSION) === 0n) return false;
  const requiredPermission = isThreadChannel(channel)
    ? MANAGE_THREADS_PERMISSION
    : MANAGE_CHANNELS_PERMISSION;
  return (permissions & requiredPermission) !== 0n;
}

function highestGuildRolePosition(roles: readonly DiscordRole[], roleIds: readonly string[]): number {
  const selectedRoleIds = new Set(roleIds);
  return roles.reduce((highest, role) => selectedRoleIds.has(role.id) ? Math.max(highest, role.position) : highest, 0);
}

function guildMemberIsManageable(
  state: AppState,
  guildId: string,
  channelId: string,
  userId: string,
  currentUserRoleIds: readonly string[],
): boolean {
  const currentUserId = state.auth.user?.id;
  if (!currentUserId || currentUserId === userId) return false;
  const guild = state.sidebar.guilds.find((candidate) => candidate.id === guildId);
  const currentUserIsOwner = guild?.owner === true || guild?.ownerId === currentUserId;
  if (currentUserIsOwner) return true;
  if (guild?.ownerId === userId) return false;

  const roles = state.guildRolesByGuildId[guildId];
  if (!roles || roles.length === 0) return false;
  const targetRoleIds = knownRoleIdsForUser(state, guildId, channelId, userId);
  if (!targetRoleIds) return false;
  return highestGuildRolePosition(roles, currentUserRoleIds) > highestGuildRolePosition(roles, targetRoleIds);
}

export interface VoiceMemberModerationContext {
  serverMuted: boolean;
  serverDeafened: boolean;
  canServerMute: boolean;
  canServerDeafen: boolean;
  canKickFromVc: boolean;
  canKickFromServer: boolean;
  canBanFromServer: boolean;
}

export function voiceMemberModerationContext(
  state: AppState,
  guildId: string,
  channelId: string,
  userId: string,
): VoiceMemberModerationContext {
  const voiceState = callVoiceStatesByChannelId.get(channelId)?.get(userId);
  const unavailable = {
    serverMuted: voiceState?.mute ?? false,
    serverDeafened: voiceState?.deaf ?? false,
    canServerMute: false,
    canServerDeafen: false,
    canKickFromVc: false,
    canKickFromServer: false,
    canBanFromServer: false,
  };
  if (guildId === DIRECT_MESSAGES_GUILD_ID) return unavailable;

  const currentUserId = state.auth.user?.id;
  if (!currentUserId || currentUserId === userId) return unavailable;
  const guild = state.sidebar.guilds.find((candidate) => candidate.id === guildId);
  const currentUserIsOwner = guild?.owner === true || guild?.ownerId === currentUserId;
  const currentUserRoleIds = state.roleIdsByGuildId[guildId]
    ?? state.memberRoleIdsByGuildId[guildId]?.[currentUserId]
    ?? (currentUserIsOwner ? [] : undefined);
  if (!currentUserRoleIds) return unavailable;
  const guildPermissions = currentGuildPermissionBits(state, guildId, currentUserRoleIds);
  const channelPermissions = currentUserChannelPermissionBits(state, guildId, channelId, currentUserRoleIds, currentUserId);
  if (guildPermissions === null && !currentUserIsOwner) return unavailable;
  const guildAdministrator = currentUserIsOwner || (guildPermissions !== null && (guildPermissions & ADMINISTRATOR_PERMISSION) !== 0n);
  const hasGuildPermission = (permission: bigint): boolean => guildAdministrator
    || (guildPermissions !== null && (guildPermissions & permission) !== 0n);
  const hasChannelPermission = (permission: bigint): boolean => guildAdministrator
    || (channelPermissions !== null && (channelPermissions & permission) !== 0n);
  const canManageTarget = guildMemberIsManageable(state, guildId, channelId, userId, currentUserRoleIds);
  const channel = channelById(state, channelId);
  return {
    ...unavailable,
    canServerMute: hasChannelPermission(MUTE_MEMBERS_PERMISSION),
    canServerDeafen: channel?.type === 2 && hasChannelPermission(DEAFEN_MEMBERS_PERMISSION),
    canKickFromVc: hasChannelPermission(MOVE_MEMBERS_PERMISSION),
    canKickFromServer: canManageTarget && hasGuildPermission(KICK_MEMBERS_PERMISSION),
    canBanFromServer: canManageTarget && hasGuildPermission(BAN_MEMBERS_PERMISSION),
  };
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
    // Threads inherit VIEW_CHANNEL overwrites from their parent channel and do
    // not include permission_overwrites in Discord's thread objects.
    const permissionChannel = isThreadChannel(channel) && channel.parentId
      ? state.channelList.channels.find((candidate) => candidate.id === channel.parentId) ?? channel
      : channel;
    const canView = canViewGuildChannel(permissionChannel, guildId, roles, currentUserRoleIds, currentUserId);
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
    const merged = { ...existing, ...guild, muted: guild.muted ?? existing.muted };
    if (JSON.stringify(existing) !== JSON.stringify(merged)) changed = true;
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
      return { ...guild, ...fresh, muted: fresh.muted ?? guild.muted };
    });
  const included = new Set(existingGuilds.map((guild) => guild.id));
  const newGuilds = guilds.filter((guild) => !included.has(guild.id));
  const orderedGuilds = sortGuildsByOrder([...existingGuilds, ...newGuilds], guildOrder);

  setSidebarGuilds(state.sidebar, cachedSidebarGuilds(directMessages, orderedGuilds));
}

export function removeSessionGuild(state: AppState, guildId: string): boolean {
  if (isFixedTopLevelGuildId(guildId) || !state.sidebar.guilds.some((guild) => guild.id === guildId)) return false;
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

  const whatsAppNotifications = currentWhatsAppNotifications(state);
  replaceNotifications(
    state.notifications,
    [
      ...whatsAppNotifications,
      ...Object.entries(cachedNotifications.byChannelId)
      .filter(([channelId, count]) => count > 0
        && !isWhatsAppChannelId(channelId)
        && cachedNotifications.channelGuildIds[channelId] !== WHATSAPP_GUILD_ID
        && !isSidebarGuildMuted(state.sidebar, cachedNotifications.channelGuildIds[channelId])
        && !isChannelMuted(state, channelId))
      .map(([channelId, count]) => ({
        channelId,
        guildId: cachedNotifications.channelGuildIds[channelId] ?? null,
        count,
      })),
    ],
  );
}

function currentWhatsAppNotifications(state: AppState): Array<{ channelId: string; guildId: string; count: number }> {
  return Object.entries(state.notifications.byChannelId)
    .filter(([channelId]) => state.notifications.channelGuildIds[channelId] === WHATSAPP_GUILD_ID
      || isWhatsAppChannelId(channelId))
    .map(([channelId, count]) => ({ channelId, guildId: WHATSAPP_GUILD_ID, count }));
}

function clearNotificationsForChannel(state: AppState, channelId: string): void {
  clearChannelNotifications(state.notifications, channelId);
  persistNotifications(state);
}

function markChannelRead(state: AppState, token: string | null, channelId: string, messageId: string): void {
  clearNotificationsForChannel(state, channelId);
  if (!token || isWhatsAppChannelId(channelId)) return;

  void ackChannelMessage(token, channelId, messageId).catch(() => {
    // Keep read acknowledgements best-effort; failing to ack should not disrupt chat.
  });
}

function newestSnowflakeId(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  try {
    return BigInt(left) >= BigInt(right) ? left : right;
  } catch {
    return left;
  }
}

function knownChannelLastMessageId(state: AppState, channelId: string): string | null {
  const activeChannel = state.channelList.channels.find((channel) => channel.id === channelId);
  if (activeChannel?.lastMessageId) return activeChannel.lastMessageId;

  for (const channels of Object.values(state.sidebar.cachedChannelsByGuildId)) {
    const channel = channels.find((entry) => entry.id === channelId);
    if (channel?.lastMessageId) return channel.lastMessageId;
  }
  return null;
}

function channelAckMessageId(state: AppState, channelId: string, visibleLatestMessageId: string | null | undefined): string | null {
  // Discord's READY/private-channel `last_message_id` can point at the unread
  // read-state frontier even when the message is missing from our local cache or
  // from the current REST page (for example a deleted/system DM tail message).
  // Ack the newest id we know for the channel, not just the newest message we
  // happened to render, or that DM will be re-created as unread on every login.
  return newestSnowflakeId(knownChannelLastMessageId(state, channelId), visibleLatestMessageId);
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
  if (isWhatsAppChannel(channel)) return;
  appGateway?.subscribeToGuildChannel(channel?.guildId, channel?.id);
}

function subscribeAppGatewayToGuild(guildId: string | null | undefined): void {
  if (guildId === WHATSAPP_GUILD_ID) return;
  appGateway?.subscribeToGuild(guildId);
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
      textColor: callWidgetTextColorForUser(state, session.target.guildId, channelId, self.id),
      speaking: speakingCallUserIds.has(self.id),
      muted: session.selfMute,
      deafened: session.selfDeaf,
      self: true,
    });
  }

  const voiceStates = callVoiceStatesByChannelId.get(channelId);
  for (const userId of remoteCallParticipantIds(state, channelId)) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    const voiceState = voiceStates?.get(userId);
    participants.push({
      id: userId,
      name: voiceState?.displayName ?? displayNameForUser(state, channelId, userId, userId),
      avatarUrl: discordAvatarUrl(userId, avatarHashForUser(state, channelId, userId), null),
      textColor: callWidgetTextColorForUser(state, session.target.guildId, channelId, userId),
      speaking: locallyMutedCallUserIds.has(userId) ? false : speakingCallUserIds.has(userId),
      muted: voiceState ? voiceState.selfMute || voiceState.mute : false,
      localMuted: locallyMutedCallUserIds.has(userId),
      deafened: voiceState ? voiceState.selfDeaf || voiceState.deaf : false,
      self: false,
    });
  }
  return participants;
}

function syncCallWidget(state: AppState, session: VoiceCallSession | null): void {
  if (!session || session.state !== "ready") {
    if (!session || session.state === "ended" || session.state === "error") {
      clearAllSpeakingCallUsers();
    }
    callWidget.stop();
    return;
  }
  callWidget.update(buildCallWidgetParticipants(state, session));
}

function syncVoiceCallStatus(state: AppState, session: VoiceCallSession | null): void {
  const hadActiveCall = Boolean(state.voiceCall);
  if (!session || session.state === "ended" || session.state === "error") {
    if (session?.target.channelId) {
      const selfUserId = state.auth.user?.id;
      if (selfUserId) removeCallVoiceStateUser(state, selfUserId, [session.target.channelId]);
      stopOutboundCallRingtone(session.target.channelId, session.state);
      callJoinSoundUserIdsByChannelId.delete(session.target.channelId);
    } else {
      stopAllOutboundCallRingtones("idle");
      callJoinSoundUserIdsByChannelId.clear();
    }
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
    participantUserIds: remoteCallParticipantIds(state, session.target.channelId),
  };
  stopIncomingCallRingtone(session.target.channelId, "joined_call");
  syncCallWidget(state, session);
}

function ensureVoiceCallController(state: AppState, token: string, effects: SessionEffects): VoiceCallController | null {
  const selfUserId = state.auth.user?.id;
  if (!selfUserId || !appGateway || appGatewayToken !== token) return null;
  if (voiceCallController) return voiceCallController;

  voiceCallController = new VoiceCallController({
    selfUserId,
    signaling: appGateway,
    localVolumes: state.audio,
    noiseSuppression: state.noiseSuppression,
    ringRecipients: (channelId, recipientIds) => ringDirectMessageCall(currentAuthToken(state, token), channelId, recipientIds),
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
      if (speaking && userId !== state.auth.user?.id) {
        // SPEAKING itself is active-session presence evidence and heals a roster
        // if Discord omitted or reordered CLIENTS_CONNECT.
        handleVoiceGatewayParticipantsConnect(state, effects, activeSession, [userId]);
      }
      const changed = setCallUserSpeaking(state, effects, activeSession, userId, speaking);
      if (changed) {
        debugLog("call.widget.speaking", {
          channelId: activeSession.target.channelId,
          userId,
          speaking,
        });
        effects.scheduleRender();
      }
    },
    onParticipantsConnect: (userIds) => {
      const activeSession = voiceCallController?.activeSession;
      if (!activeSession || activeSession.state === "ended" || activeSession.state === "error") return;
      handleVoiceGatewayParticipantsConnect(state, effects, activeSession, userIds);
    },
    onParticipantDisconnect: (userId) => {
      const activeSession = voiceCallController?.activeSession;
      if (!activeSession || activeSession.state === "ended" || activeSession.state === "error") return;
      handleVoiceGatewayParticipantDisconnect(state, effects, activeSession, userId);
    },
    onError: (error) => {
      setNotice(state, `Voice call: ${error.message}`, "warning", { chat: false });
      effects.scheduleRender();
    },
  });
  for (const userId of locallyMutedCallUserIds) voiceCallController.setRemoteUserMuted(userId, true);
  for (const [userId, volumePercent] of remoteCallUserVolumes) voiceCallController.setRemoteUserVolume(userId, volumePercent);
  return voiceCallController;
}

function rememberStreamCreate(event: import("./appgateway").StreamCreateEvent): void {
  const current = availableStreamsByKey.get(event.streamKey);
  availableStreamsByKey.set(event.streamKey, { create: event, serverUpdate: current?.serverUpdate ?? null });
}

function rememberStreamServerUpdate(event: import("./appgateway").StreamServerUpdateEvent): void {
  const current = availableStreamsByKey.get(event.streamKey);
  if (!current) return;
  availableStreamsByKey.set(event.streamKey, { ...current, serverUpdate: event });
}

function forgetTrackedStream(streamKey: string): void {
  availableStreamsByKey.delete(streamKey);
}

function trackedStreamsForSession(session: VoiceCallSession, selfUserId: string | null | undefined): TrackedStreamState[] {
  return Array.from(availableStreamsByKey.values()).filter((stream) => {
    const parsed = parseStreamKey(stream.create.streamKey);
    if (!parsed || parsed.ownerUserId === selfUserId) return false;
    return streamKeyMatchesVoiceSession(stream.create.streamKey, session);
  });
}

function normalizeWatchTarget(target: string | null | undefined): string | null {
  const trimmed = target?.trim();
  if (!trimmed) return null;
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  return mention?.[1] ?? trimmed;
}

function resolveWatchTargetUserId(state: AppState, session: VoiceCallSession, target: string): string | null {
  if (/^\d{5,25}$/.test(target)) return target;
  const needle = target.toLowerCase();
  for (const stream of trackedStreamsForSession(session, state.auth.user?.id)) {
    const parsed = parseStreamKey(stream.create.streamKey);
    if (!parsed) continue;
    const displayName = displayNameForUser(state, session.target.channelId, parsed.ownerUserId, parsed.ownerUserId).toLowerCase();
    if (displayName === needle || displayName.includes(needle)) return parsed.ownerUserId;
  }
  const activeChannel = channelById(state, session.target.channelId);
  for (const recipient of activeChannel?.recipients ?? []) {
    if (recipient.displayName.toLowerCase() === needle || recipient.username.toLowerCase() === needle) return recipient.id;
  }
  for (const member of state.memberList.members) {
    if (member.displayName.toLowerCase() === needle || member.username.toLowerCase() === needle) return member.id;
  }
  return null;
}

function resolveWatchStreamKey(state: AppState, session: VoiceCallSession, target: string | null | undefined): { streamKey: string; ownerUserId: string | null } | null {
  const normalizedTarget = normalizeWatchTarget(target);
  if (normalizedTarget && parseStreamKey(normalizedTarget)) {
    if (!streamKeyMatchesVoiceSession(normalizedTarget, session)) return null;
    return { streamKey: normalizedTarget, ownerUserId: parseStreamKey(normalizedTarget)?.ownerUserId ?? null };
  }

  if (!normalizedTarget) {
    const streams = trackedStreamsForSession(session, state.auth.user?.id);
    if (streams.length !== 1) return null;
    const streamKey = streams[0]?.create.streamKey;
    return streamKey ? { streamKey, ownerUserId: parseStreamKey(streamKey)?.ownerUserId ?? null } : null;
  }

  const ownerUserId = resolveWatchTargetUserId(state, session, normalizedTarget);
  if (!ownerUserId) return null;
  return { streamKey: buildStreamKeyForVoiceSession(session, ownerUserId), ownerUserId };
}

function watchStreamAmbiguityNotice(state: AppState, session: VoiceCallSession, target: string | null | undefined): string {
  const normalizedTarget = normalizeWatchTarget(target);
  if (normalizedTarget) {
    if (parseStreamKey(normalizedTarget)) return "That stream is not in the current call.";
    return "Use /watch with a user id, @mention, exact stream_key, or a visible streamer name.";
  }
  const streams = trackedStreamsForSession(session, state.auth.user?.id);
  if (streams.length === 0) return "No active streams found in this call yet.";
  const labels = streams.slice(0, 5).map((stream) => {
    const owner = parseStreamKey(stream.create.streamKey)?.ownerUserId ?? "unknown";
    return `${displayNameForUser(state, session.target.channelId, owner, owner)} (${stream.create.streamKey})`;
  });
  const suffix = streams.length > labels.length ? `, and ${streams.length - labels.length} more` : "";
  return `Multiple streams are live; use /watch <user_id|stream_key>. Streams: ${labels.join(", ")}${suffix}`;
}

function startAppGateway(state: AppState, token: string, effects: SessionEffects): void {
  if (appGateway && appGatewayToken === token) return;
  state.voiceCall = null;
  state.sidebar.voiceMembersByChannelId = {};
  disconnectAppGateway();
  appGatewayToken = token;
  appGateway = new AppGatewayClient(token, {
    onAuthTokenRefresh: (refreshedToken) => handleGatewayAuthTokenRefresh(state, effects, refreshedToken),
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
    onChannelMuteSettings: (mutedByChannelId, options) => {
      applyChannelMuteSettings(state, mutedByChannelId, options);
      effects.scheduleRender();
    },
    onGuildMuteSetting: (guildId, muted) => {
      applyGuildMuteSettings(state, { [guildId]: muted });
      effects.scheduleRender();
    },
    onReadyGuilds: (guilds) => {
      if (mergeGatewayGuilds(state, guilds)) {
        for (const guild of guilds) loadGuildRolesInBackground(state, currentAuthToken(state, token), guild.id, effects);
        effects.scheduleRender();
      }
    },
    onGuildCreate: (guild) => {
      if (mergeGatewayGuilds(state, [guild])) {
        loadGuildRolesInBackground(state, currentAuthToken(state, token), guild.id, effects);
        effects.scheduleRender();
      }
    },
    onGuildUpdate: (guild) => {
      if (mergeGatewayGuilds(state, [guild])) effects.scheduleRender();
    },
    onGuildDelete: (guildId) => {
      if (removeSessionGuild(state, guildId)) effects.scheduleRender();
    },
    onInitialNotifications: (notifications) => {
      const whatsAppNotifications = currentWhatsAppNotifications(state);
      replaceNotifications(
        state.notifications,
        [
          ...whatsAppNotifications,
          ...notifications.filter((notification) => !isWhatsAppChannelId(notification.channelId)
            && notification.guildId !== WHATSAPP_GUILD_ID
            && notification.channelId !== state.timeline.channelId
            && !isSidebarGuildMuted(state.sidebar, notification.guildId)
            && !isChannelMuted(state, notification.channelId)),
        ],
      );
      persistNotifications(state);
      const latestMessageId = state.timeline.channelId
        ? channelAckMessageId(state, state.timeline.channelId, latestTimelineMessageId(state, state.timeline.channelId))
        : null;
      if (state.timeline.channelId && !isWhatsAppChannelId(state.timeline.channelId)
        && latestMessageId && isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) {
        markChannelRead(state, state.auth.savedToken, state.timeline.channelId, latestMessageId);
      }
      effects.scheduleRender();
    },
    onVoiceStateUpdate: (update) => handleVoiceStateUpdate(state, effects, update),
    onVoiceServerUpdate: (update) => {
      voiceCallController?.handleVoiceServerUpdate(update);
    },
    onGuildMemberUpdate: (guildId, member) => handleGuildMembersChunk(state, effects, guildId, [member]),
    onGuildMembersChunk: (guildId, members) => handleGuildMembersChunk(state, effects, guildId, members),
    onGuildRoleUpdate: (guildId, role) => applyGatewayGuildRoleUpdate(state, effects, guildId, { role }),
    onGuildRoleDelete: (guildId, deletedRoleId) => applyGatewayGuildRoleUpdate(state, effects, guildId, { deletedRoleId }),
    onCallCreate: (event) => {
      handleCallGatewayEvent(state, event.channelId, event.ringingUserIds);
      rememberCallGatewayVoiceStates(state, event);
      if (event.isActive) rememberActiveCallParticipants(state, event.channelId, event.voiceStateUserIds);
      handleActiveCallGatewayEvent(state, event.channelId, event.voiceStateUserIds);
      effects.scheduleRender();
    },
    onCallUpdate: (event) => {
      handleCallGatewayEvent(state, event.channelId, event.ringingUserIds);
      rememberCallGatewayVoiceStates(state, event);
      if (event.isActive) rememberActiveCallParticipants(state, event.channelId, event.voiceStateUserIds);
      handleActiveCallGatewayEvent(state, event.channelId, event.voiceStateUserIds);
      effects.scheduleRender();
    },
    onCallDelete: (channelId) => {
      recentIncomingCallRingtones.delete(channelId);
      stopIncomingCallRingtone(channelId, "call_delete");
      knownCallParticipantsByChannelId.delete(channelId);
      departedCallParticipantsByChannelId.delete(channelId);
      callVoiceStatesByChannelId.delete(channelId);
      delete state.sidebar.voiceMembersByChannelId[channelId];
      stopOutboundCallRingtone(channelId, "call_delete");
      markActiveCallEnded(state, channelId);
      const activeSession = voiceCallController?.activeSession;
      if (activeSession?.target.channelId === channelId) {
        clearAllSpeakingCallUsers();
        voiceCallController?.leave("call_delete");
      }
      effects.scheduleRender();
    },
    onStreamCreate: (event) => {
      rememberStreamCreate(event);
      streamController?.handleCreate(event);
      watchStreamController?.handleCreate(event);
      const parsed = parseStreamKey(event.streamKey);
      if (parsed) {
        syncSidebarVoiceMembersForChannel(state, parsed.channelId);
        syncOpenVoiceMemberStreamAction(state, parsed.channelId, parsed.ownerUserId);
      }
      effects.scheduleRender();
    },
    onStreamServerUpdate: (event) => {
      rememberStreamServerUpdate(event);
      streamController?.handleServerUpdate(event);
      watchStreamController?.handleServerUpdate(event);
    },
    onStreamDelete: (event) => {
      const parsed = parseStreamKey(event.streamKey);
      streamController?.handleDelete(event);
      if (streamController?.streamKey === event.streamKey) streamController = null;
      watchStreamController?.handleDelete(event);
      if (watchStreamController?.streamKey === event.streamKey && !watchStreamController.active) watchStreamController = null;
      forgetTrackedStream(event.streamKey);
      if (parsed) {
        const voiceState = callVoiceStatesByChannelId.get(parsed.channelId)?.get(parsed.ownerUserId);
        if (voiceState) voiceState.streaming = false;
        syncSidebarVoiceMembersForChannel(state, parsed.channelId);
        syncOpenVoiceMemberStreamAction(state, parsed.channelId, parsed.ownerUserId);
      }
      effects.scheduleRender();
    },
    onMessageCreate: (message) => handleGatewayMessageCreate(state, effects, message),
    onMessageUpdate: (message) => handleGatewayMessageUpdate(state, effects, message),
    onMessageDelete: (channelId, messageId) => {
      if (removeCachedChannelMessage(state.messageCacheByChannelId, channelId, messageId)) {
        persistChannelMessageCache(state, channelId);
      }
      if (state.messageDeletePending?.channelId === channelId && state.messageDeletePending.messageId === messageId) {
        state.messageDeletePending = null;
      }
      clearMessageTargetsForDeletedMessage(state, channelId, messageId);
      removeTimelineMessage(state.timeline, messageId, channelId);
      effects.scheduleRender();
    },
    onMessageDeleteBulk: (channelId, messageIds) => {
      if (removeCachedChannelMessages(state.messageCacheByChannelId, channelId, messageIds)) {
        persistChannelMessageCache(state, channelId);
      }
      if (state.messageDeletePending?.channelId === channelId && messageIds.includes(state.messageDeletePending.messageId)) {
        state.messageDeletePending = null;
      }
      for (const messageId of messageIds) {
        clearMessageTargetsForDeletedMessage(state, channelId, messageId);
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
    onChannelDelete: (channelId, guildId) => removeSessionChannel(state, effects, channelId, guildId),
    onThreadListSync: (event) => handleGatewayThreadListSync(state, effects, event),
    onThreadMembershipUpdate: (threadId, joined) => {
      if (setThreadJoinedState(state, threadId, joined)) effects.scheduleRender();
    },
    onTypingStart: (channelId, userId, displayName) => {
      recordTypingStart(state.typing, channelId, { id: userId, displayName: displayNameForUser(state, channelId, userId, displayName) });
      effects.scheduleRender();
    },
    onError: (error) => {
      setNotice(state, error.message, "warning");
      effects.scheduleRender();
    },
  // If both settings endpoints were unavailable during login, fail closed so
  // a previously invisible user is never exposed as online by this client.
  }, state.auth.presenceStatus ?? "invisible", state.auth.customStatus);
  appGateway.start();
  subscribeAppGatewayToActiveChannel(state);
}

export function currentAppGatewaySessionId(token: string | null | undefined): string | null {
  if (!token || !appGateway || appGatewayToken !== token) return null;
  return appGateway.getSessionId();
}

export function clearReadOnlyClient(state: AppState): void {
  guildRoleFetchState.delete(state);
  deletedGuildChannelIds.delete(state);
  const whatsAppChannelsBeforeClear = whatsAppChannels(state.whatsapp);
  const whatsAppChannelLayoutBeforeClear = sidebarChannelLayoutForGuild(state.sidebar, WHATSAPP_GUILD_ID);
  const activeWhatsAppChannelId = state.channelList.guildId === WHATSAPP_GUILD_ID
    ? state.channelList.activeChannelId
    : null;
  const whatsAppNotifications = currentWhatsAppNotifications(state);
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
  state.channelMuteSettings = {};
  state.messageCacheByChannelId = {};
  state.replyTarget = null;
  state.editTarget = null;
  state.messageDeletePending = null;
  state.voiceCall = null;
  state.auth.cachedSidebarPreviewAccountId = null;
  state.memberRoleCacheVersion += 1;
  setSidebarGuilds(state.sidebar, withDirectMessagesGuild([]));
  applySidebarChannelLayoutForGuild(state.sidebar, WHATSAPP_GUILD_ID, whatsAppChannelLayoutBeforeClear);
  setSidebarCachedChannels(state.sidebar, WHATSAPP_GUILD_ID, whatsAppChannelsBeforeClear);
  replaceNotifications(state.notifications, whatsAppNotifications);
  if (activeWhatsAppChannelId) {
    const activeChannel = whatsAppChannelsBeforeClear.find((channel) => channel.id === activeWhatsAppChannelId) ?? null;
    if (activeChannel) {
      setChannelList(state.channelList, WHATSAPP_GUILD_ID, whatsAppChannelsBeforeClear);
      setActiveChannelEntry(state.channelList, activeChannel);
      state.sidebar.focusedGuildId = WHATSAPP_GUILD_ID;
      state.sidebar.activeGuildId = WHATSAPP_GUILD_ID;
      setTimelineMessages(state.timeline, activeWhatsAppChannelId, whatsAppTimelineMessages(state.whatsapp, activeWhatsAppChannelId), { hasOlder: false });
    }
  }
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
    syncAllSidebarVoiceMembers(state);
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

  if (guildId === WHATSAPP_GUILD_ID) {
    disconnectMemberListGateway();
    if (state.memberList.open) {
      setMemberListMessage(state.memberList, guildId, channelId, "WhatsApp group members are not loaded yet.");
      effects.scheduleRender();
    }
    return;
  }

  if (!token || !guildId || !channelId || guildId === DIRECT_MESSAGES_GUILD_ID) {
    debugLog("member_list.sync_skipped", { guildId, channelId, requestId, reason: !token ? "missing_token" : !guildId ? "missing_guild" : !channelId ? "missing_channel" : "direct_messages" });
    disconnectMemberListGateway();
    return;
  }

  const gateway = getMemberListGateway(state, token, effects);
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
        syncAllSidebarVoiceMembers(state);
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
  const accountId = currentAccountId(state);
  const previewAccountId = state.auth.cachedSidebarPreviewAccountId;
  if (previewAccountId && accountId && previewAccountId !== accountId) {
    clearReadOnlyClient(state);
  }
  state.auth.cachedSidebarPreviewAccountId = null;
  if (accountId) markCachedAccountActive(accountId);

  const requestId = ++state.sidebar.requestId;
  let cachedSidebarFolders: ReturnType<typeof loadCachedSidebarFolders> = null;
  let appliedCachedSidebarFolders = false;
  const previousExpandedGuildId = state.sidebar.expandedGuildId;
  const previousFocusedGuildId = state.sidebar.focusedGuildId;
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
    for (const channel of cachedDirectMessages) {
      if (channel.muted !== undefined) state.channelMuteSettings[channel.id] = channel.muted;
    }
    const cachedGuildOrder = loadCachedGuildOrder(accountId);
    const cachedChannelLayout = loadCachedSidebarChannelLayout(accountId);
    cachedSidebarFolders = loadCachedSidebarFolders(accountId);
    const cachedGuilds = sortGuildsByOrder(loadCachedGuilds(accountId) ?? [], cachedGuildOrder);
    setSidebarCachedChannels(state.sidebar, DIRECT_MESSAGES_GUILD_ID, cachedDirectMessages);
    applySidebarChannelLayoutForGuild(
      state.sidebar,
      DIRECT_MESSAGES_GUILD_ID,
      cachedChannelLayout?.[DIRECT_MESSAGES_GUILD_ID],
    );
    for (const guild of cachedGuilds) {
      const cachedChannels = loadCachedGuildChannels(accountId, guild.id) ?? [];
      if (cachedChannels.length > 0) setSidebarCachedChannels(state.sidebar, guild.id, cachedChannels);
    }
    state.guildRolesByGuildId = loadCachedGuildRoles(accountId);
    state.memberRoleIdsByGuildId = loadCachedMemberRoles(accountId);
    state.messageCacheByChannelId = loadCachedChannelMessages(accountId);
    warmCachedMemberLists(state, accountId);
    state.memberRoleCacheVersion += 1;
    syncAllSidebarVoiceMembers(state);
    if (cachedDirectMessages.length > 0 || cachedGuilds.length > 0) {
      setSidebarGuilds(state.sidebar, cachedSidebarGuilds(cachedDirectMessages, cachedGuilds));
      applySidebarFolderLayout(state.sidebar, cachedSidebarFolders);
      appliedCachedSidebarFolders = true;
      applyCachedNotifications(state);
      state.sidebar.expandedGuildId = previousExpandedGuildId;
      state.sidebar.focusedGuildId = previousFocusedGuildId;
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
    const directMessages = withChannelMuteSettings(state, await fetchDirectMessages(currentAuthToken(state, token)));
    const guilds = await fetchGuilds(currentAuthToken(state, token));
    const guildOrder = accountId ? loadCachedGuildOrder(accountId) : null;
    if (requestId !== state.sidebar.requestId) return;

    const liveExpandedGuildId = state.sidebar.expandedGuildId;
    const liveFocusedGuildId = state.sidebar.focusedGuildId;
    const liveActiveGuildId = state.sidebar.activeGuildId;
    const liveChannelListGuildId = state.channelList.guildId;
    const liveChannels = state.channelList.channels;
    const liveActiveChannel = state.channelList.activeChannel;
    const liveActiveChannelId = state.channelList.activeChannelId;

    state.sidebar.loading = false;
    mergeRestGuilds(state, directMessages, guilds, guildOrder);
    if (cachedSidebarFolders && !appliedCachedSidebarFolders) {
      applySidebarFolderLayout(state.sidebar, cachedSidebarFolders);
      appliedCachedSidebarFolders = true;
    }
    setSidebarCachedChannels(state.sidebar, DIRECT_MESSAGES_GUILD_ID, directMessages);
    state.sidebar.expandedGuildId = liveExpandedGuildId;
    state.sidebar.focusedGuildId = liveFocusedGuildId;
    state.sidebar.activeGuildId = liveActiveGuildId;
    if (liveChannelListGuildId && liveChannels.length > 0) {
      setChannelList(state.channelList, liveChannelListGuildId, liveChannels);
      refreshHiddenChannelFlags(state, liveChannelListGuildId);
      setActiveChannelEntry(state.channelList, liveActiveChannel ?? findBrowsableChannel(liveChannels, liveActiveChannelId));
    }
    if (accountId) {
      saveCachedDirectMessages(accountId, state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID] ?? directMessages);
      persistSidebarGuilds(state, { order: currentGuildOrderNeedsSave(sidebarCachedGuilds(state.sidebar).map((guild) => guild.id), guildOrder) });
    }
    for (const guild of guilds) {
      loadGuildRolesInBackground(state, currentAuthToken(state, token), guild.id, effects, { revalidate: true });
    }
    startAppGateway(state, currentAuthToken(state, token), effects);

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
  state.sidebar.focusedGuildId = guildId;
  state.sidebar.expandedGuildId = guildId;
  state.sidebar.loadingGuildId = guildId;
  state.channelList.loading = true;
  subscribeAppGatewayToGuild(guildId);

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

    const loadedCachedChannels = isDirectMessages
      ? loadCachedDirectMessages(accountId)
      : loadCachedGuildChannels(accountId, guildId);
    const cachedChannels = loadedCachedChannels
      ? withoutDeletedGuildChannels(state, loadedCachedChannels)
      : null;
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
      if (isDirectMessages) {
        for (const channel of cachedChannels) {
          if (channel.muted !== undefined) state.channelMuteSettings[channel.id] = channel.muted;
        }
      }
      showedCachedChannels = true;
      setChannelList(state.channelList, guildId, isDirectMessages ? withChannelMuteSettings(state, cachedChannels) : cachedChannels);
      refreshHiddenChannelFlags(state, guildId);
      setSidebarCachedChannels(state.sidebar, guildId, state.channelList.channels);
      state.channelList.loading = false;
      if (state.sidebar.loadingGuildId === guildId) {
        state.sidebar.loadingGuildId = null;
      }
      if (options.openFirstChannel) {
        const visibleCachedChannels = cachedChannels.filter((channel) => isSidebarThreadRelevant(channel, accountId));
        const cachedChannel = findBrowsableChannel(visibleCachedChannels, state.channelList.activeChannelId)
          ?? findFirstBrowsableChannel(visibleCachedChannels);
        setActiveChannelEntry(state.channelList, cachedChannel);
        if (cachedChannel) state.sidebar.activeGuildId = cachedChannel.guildId;
        subscribeAppGatewayToActiveChannel(state);
      }
    }
  }
  effects.scheduleRender();

  try {
    let channels = isDirectMessages
      ? withChannelMuteSettings(state, await fetchDirectMessages(token))
      // READY and guild subscriptions already deliver the active threads that
      // matter to this user. Searching every text/forum parent here made an
      // uncached server open perform one serial REST request per channel.
      : await fetchGuildChannels(token, guildId, { includeThreads: false });
    if (requestId !== state.channelList.requestId) return;
    channels = withoutDeletedGuildChannels(state, channels);

    if (!isDirectMessages) {
      const latestKnownChannels = withoutDeletedGuildChannels(
        state,
        sidebarChannelsForGuild(state.sidebar, state.channelList.channels, guildId),
      );
      channels = mergeKnownRelevantThreads(channels, latestKnownChannels, accountId);
    }

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
        saveCachedDirectMessages(accountId, state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID] ?? channels);
      } else {
        saveCachedGuildChannels(accountId, guildId, channels);
      }
    }

    if (!options.openFirstChannel) {
      effects.scheduleRender();
      return;
    }

    const visibleChannels = channels.filter((channel) => isSidebarThreadRelevant(channel, accountId));
    const channel = findBrowsableChannel(visibleChannels, state.channelList.activeChannelId)
      ?? findFirstBrowsableChannel(visibleChannels);
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

function showThreadCommandError(state: AppState, effects: SessionEffects, message: string): void {
  pushTimelineSystemMessage(state.timeline, message);
  setNotice(state, "", "muted", { statusLine: false, chat: false });
  effects.scheduleRender();
}

export function createCurrentChannelThread(
  state: AppState,
  token: string | null,
  name: string,
  effects: SessionEffects,
): void {
  if (!token) {
    showThreadCommandError(state, effects, "Login first with /login <token|username> to create a thread.");
    return;
  }

  const parentChannelId = state.timeline.channelId;
  const parentChannel = channelById(state, parentChannelId);
  const replyTarget = state.replyTarget?.channelId === parentChannelId
    ? state.replyTarget
    : null;
  const parentSupportsThread = replyTarget
    ? isMessageThreadParentChannel(parentChannel)
    : parentChannel?.type === 0;
  if (!parentChannel || parentChannel.guildId === DIRECT_MESSAGES_GUILD_ID || !parentSupportsThread) {
    showThreadCommandError(
      state,
      effects,
      replyTarget
        ? "Open a server text or announcement channel before creating a thread from a message."
        : "Open a server text channel before creating a thread.",
    );
    return;
  }

  if (replyTarget) {
    const selectedMessage = state.timeline.messages.find((message) => message.id === replyTarget.messageId);
    if (replyTarget.messageId.startsWith("local:") || selectedMessage?.localStatus) {
      showThreadCommandError(state, effects, "Wait for that message to finish sending before creating a thread from it.");
      return;
    }
  }

  const parentId = parentChannel.id;
  if (replyTarget && state.replyTarget === replyTarget) {
    state.replyTarget = null;
  }
  setNotice(state, "", "muted", { statusLine: false, chat: false });
  effects.scheduleRender();

  const createThread = replyTarget
    ? createMessageThread(token, parentId, replyTarget.messageId, name)
    : createChannelThread(token, parentId, name);
  void createThread.then(async (thread) => {
    handleGatewayChannelCreateOrUpdate(state, effects, thread);
    if (state.timeline.channelId !== parentId) return;
    revealSidebarChannel(state.sidebar, state.channelList.channels, thread.guildId, thread.id, {
      showHiddenChannels: state.showHiddenChannels,
      currentUserId: state.auth.user?.id ?? null,
    });
    await loadChannelMessages(state, token, thread.id, effects);
    if (!replyTarget && state.timeline.channelId === thread.id && state.timeline.messages.length === 0) {
      pushTimelineSystemMessage(state.timeline, `Created thread “${thread.name}”. Send the first message below.`);
      effects.scheduleRender();
    }
  }).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (state.timeline.channelId === parentId && state.editor.buffer.length === 0) {
      state.editor.buffer = `/thread ${name}`;
      state.editor.cursor = state.editor.buffer.length;
    }
    if (replyTarget && state.timeline.channelId === parentId && state.replyTarget === null) {
      state.replyTarget = replyTarget;
    }
    showThreadCommandError(state, effects, `Could not create thread: ${detail}`);
  });
}

export async function focusThreadChannel(
  state: AppState,
  token: string,
  threadId: string,
  effects: SessionEffects,
  fallbackGuildId?: string | null,
): Promise<boolean> {
  let thread = channelById(state, threadId);
  if (!isThreadChannel(thread)) {
    try {
      const fetched = await fetchChannel(token, threadId, fallbackGuildId);
      if (!isThreadChannel(fetched)) throw new Error("That channel is not a thread.");
      handleGatewayChannelCreateOrUpdate(state, effects, fetched);
      thread = fetched;
    } catch (error) {
      showThreadCommandError(state, effects, `Could not open thread: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  if (!thread || !isThreadChannel(thread)) return false;

  if (state.channelList.guildId !== thread.guildId) {
    setChannelList(
      state.channelList,
      thread.guildId,
      state.sidebar.cachedChannelsByGuildId[thread.guildId] ?? [thread],
    );
  }
  if (!state.channelList.channels.some((channel) => channel.id === thread.id)) {
    upsertChannel(state.channelList, thread);
  }
  revealSidebarChannel(state.sidebar, state.channelList.channels, thread.guildId, thread.id, {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  });
  await loadChannelMessages(state, token, thread.id, effects);
  return state.timeline.channelId === thread.id;
}

export async function loadChannelMessages(
  state: AppState,
  token: string,
  channelId: string,
  effects: SessionEffects,
): Promise<void> {
  const channel = findTimelineChannel(state.channelList.channels, channelId);
  if (!channel) {
    setNotice(state, "That channel is not loaded yet.", "warning");
    effects.scheduleRender();
    return;
  }
  const emptyText = isThreadChannel(channel) ? "No messages in this thread yet. Send the first message below." : null;

  const requestId = ++state.timeline.requestId;
  clearNotificationsForChannel(state, channelId);
  setActiveChannelEntry(state.channelList, channel);
  if (state.replyTarget && state.replyTarget.channelId !== channelId) {
    state.replyTarget = null;
  }
  if (state.editTarget && state.editTarget.channelId !== channelId) {
    state.editTarget = null;
  }
  if (state.messageDeletePending && state.messageDeletePending.channelId !== channelId) {
    state.messageDeletePending = null;
  }
  state.sidebar.focusedGuildId = channel.guildId;
  state.sidebar.activeGuildId = channel.guildId;
  subscribeAppGatewayToActiveChannel(state);
  state.timeline.loadingOlder = false;
  setNotice(state, "", "muted");
  syncMemberListForCurrentChannel(state, effects);
  const guildId = state.channelList.activeChannel?.guildId ?? null;
  if (guildId) loadGuildRolesInBackground(state, currentAuthToken(state, token), guildId, effects);

  const cached = cachedChannelMessages(state.messageCacheByChannelId, channelId);
  if (cached) {
    const hydrated = hydrateMissingReplyPreviewsFromKnownMessages(state, cached.messages);
    if (hydrated.changed) {
      cached.messages = hydrated.messages;
      persistChannelMessageCache(state, channelId);
    }
    recordMessagesRoleIds(state, cached.messages, guildId);
    setTimelineMessages(state.timeline, channelId, cached.messages, { hasOlder: cached.hasOlder, emptyText });
    const latestMessage = cached.messages.at(-1);
    const ackMessageId = channelAckMessageId(state, channelId, latestMessage?.id ?? null);
    if (ackMessageId) markChannelRead(state, token, channelId, ackMessageId);
    cached.messages.forEach((message) => maybeHydrateMissingReplyPreviewFromRest(state, effects, message));
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
    setTimelineMessages(state.timeline, channelId, [], { hasOlder: false, emptyText });
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
    const withGuildIds = fetchedMessages.map((message) => withMessageGuildId(message, guildId));
    const { messages } = hydrateMissingReplyPreviewsFromKnownMessages(state, withGuildIds);
    recordMessagesRoleIds(state, messages, guildId);
    const cacheEntry = setCachedChannelMessages(state.messageCacheByChannelId, channelId, messages, {
      hasOlder: messages.length >= MESSAGE_PAGE_LIMIT,
      updatedAt: Date.now(),
      replace: false,
    });
    persistChannelMessageCache(state, channelId);

    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    const preserveScroll = !isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll);
    setTimelineMessages(state.timeline, channelId, cacheEntry.messages, { hasOlder: cacheEntry.hasOlder, preserveScroll });
    const latestMessage = cacheEntry.messages.at(-1);
    const ackMessageId = channelAckMessageId(state, channelId, latestMessage?.id ?? null);
    if (ackMessageId) markChannelRead(state, token, channelId, ackMessageId);
    cacheEntry.messages.forEach((message) => maybeHydrateMissingReplyPreviewFromRest(state, effects, message));
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    if (error instanceof DiscordResourceNotFoundError
      && guildId
      && guildId !== DIRECT_MESSAGES_GUILD_ID
      && guildId !== WHATSAPP_GUILD_ID) {
      // A stale cached channel/thread should self-heal instead of remaining in
      // the sidebar as an entry that can only produce repeated 404s.
      removeSessionChannel(state, effects, channelId, guildId);
      return;
    }
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
    const dedupedWithGuildIds = olderMessages
      .filter((message) => !existingIds.has(message.id))
      .map((message) => withMessageGuildId(message, guildId));
    const { messages: deduped } = hydrateMissingReplyPreviewsFromKnownMessages(state, dedupedWithGuildIds);
    const hasOlder = olderMessages.length >= MESSAGE_PAGE_LIMIT;
    recordMessagesRoleIds(state, deduped, guildId);
    setCachedChannelMessages(state.messageCacheByChannelId, channelId, deduped, { hasOlder, updatedAt: Date.now(), replace: false, latestFetched: false });
    persistChannelMessageCache(state, channelId);
    prependTimelineMessages(state.timeline, deduped, width, { hasOlder });
    deduped.forEach((message) => maybeHydrateMissingReplyPreviewFromRest(state, effects, message));
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    finishLoadingOlderMessages(state.timeline, state.timeline.hasOlder);
    setNotice(state, error instanceof Error ? error.message : String(error), "error");
    effects.scheduleRender();
  }
}

export async function loadNewerChannelMessages(
  state: AppState,
  token: string,
  channelId: string,
  effects: SessionEffects,
): Promise<void> {
  const newestMessageId = state.timeline.messages.at(-1)?.id;
  if (!newestMessageId || state.timeline.channelId !== channelId) {
    finishLoadingNewerMessages(state.timeline, false);
    effects.scheduleRender();
    return;
  }

  const existingIds = new Set(state.timeline.messages.map((message) => message.id));
  const requestId = ++state.timeline.requestId;

  try {
    const newerMessages = await fetchChannelMessagesAfter(token, channelId, MESSAGE_PAGE_LIMIT, newestMessageId);
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;

    const guildId = state.channelList.activeChannel?.guildId ?? null;
    const dedupedWithGuildIds = newerMessages
      .filter((message) => !existingIds.has(message.id))
      .map((message) => withMessageGuildId(message, guildId));
    const { messages: deduped } = hydrateMissingReplyPreviewsFromKnownMessages(state, dedupedWithGuildIds);
    const hasNewer = newerMessages.length >= MESSAGE_PAGE_LIMIT;
    recordMessagesRoleIds(state, deduped, guildId);
    setCachedChannelMessages(state.messageCacheByChannelId, channelId, deduped, { updatedAt: Date.now(), replace: false, latestFetched: false });
    persistChannelMessageCache(state, channelId);
    appendTimelineMessages(state.timeline, deduped, { hasNewer });
    deduped.forEach((message) => maybeHydrateMissingReplyPreviewFromRest(state, effects, message));
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    finishLoadingNewerMessages(state.timeline, state.timeline.hasNewer);
    setNotice(state, error instanceof Error ? error.message : String(error), "error");
    effects.scheduleRender();
  }
}

export async function loadLatestChannelMessages(
  state: AppState,
  token: string,
  channelId: string,
  effects: SessionEffects,
): Promise<boolean> {
  if (state.timeline.channelId !== channelId) return false;

  const requestId = ++state.timeline.requestId;
  state.timeline.loading = true;
  state.timeline.loadingNewer = false;
  effects.scheduleRender();

  try {
    const fetchedMessages = await fetchChannelMessages(token, channelId, MESSAGE_PAGE_LIMIT);
    const guildId = state.channelList.activeChannel?.guildId ?? null;
    const withGuildIds = fetchedMessages.map((message) => withMessageGuildId(message, guildId));
    const { messages } = hydrateMissingReplyPreviewsFromKnownMessages(state, withGuildIds);
    recordMessagesRoleIds(state, messages, guildId);
    const cacheEntry = setCachedChannelMessages(state.messageCacheByChannelId, channelId, messages, {
      hasOlder: messages.length >= MESSAGE_PAGE_LIMIT,
      updatedAt: Date.now(),
      replace: false,
    });
    persistChannelMessageCache(state, channelId);

    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return false;
    setTimelineMessages(state.timeline, channelId, cacheEntry.messages, { hasOlder: cacheEntry.hasOlder, hasNewer: false });
    const latestMessage = cacheEntry.messages.at(-1);
    const ackMessageId = channelAckMessageId(state, channelId, latestMessage?.id ?? null);
    if (ackMessageId) markChannelRead(state, token, channelId, ackMessageId);
    cacheEntry.messages.forEach((message) => maybeHydrateMissingReplyPreviewFromRest(state, effects, message));
    return true;
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return false;
    state.timeline.loading = false;
    setNotice(state, error instanceof Error ? error.message : String(error), "error");
    return false;
  } finally {
    if (requestId === state.timeline.requestId && state.timeline.channelId === channelId) {
      effects.scheduleRender();
    }
  }
}

export async function loadChannelMessagesAround(
  state: AppState,
  token: string,
  channelId: string,
  messageId: string,
  effects: SessionEffects,
): Promise<boolean> {
  if (state.timeline.channelId !== channelId) return false;

  const requestId = ++state.timeline.requestId;
  state.timeline.loading = true;
  effects.scheduleRender();

  try {
    const fetchedMessages = await fetchChannelMessagesAround(token, channelId, messageId, MESSAGE_PAGE_LIMIT);
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return false;

    const guildId = state.channelList.activeChannel?.guildId ?? null;
    const withGuildIds = fetchedMessages.map((message) => withMessageGuildId(message, guildId));
    const { messages } = hydrateMissingReplyPreviewsFromKnownMessages(state, withGuildIds);
    const hasOlder = messages.length >= MESSAGE_PAGE_LIMIT;
    const hasNewer = messages.length >= MESSAGE_PAGE_LIMIT;
    recordMessagesRoleIds(state, messages, guildId);
    setCachedChannelMessages(state.messageCacheByChannelId, channelId, messages, { hasOlder, updatedAt: Date.now(), replace: false, latestFetched: false });
    persistChannelMessageCache(state, channelId);
    setTimelineMessages(state.timeline, channelId, messages, { hasOlder, hasNewer });
    messages.forEach((message) => maybeHydrateMissingReplyPreviewFromRest(state, effects, message));
    return messages.some((message) => message.id === messageId);
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return false;
    state.timeline.loading = false;
    setNotice(state, error instanceof Error ? error.message : String(error), "error", { statusLine: false, chat: true });
    return false;
  } finally {
    if (requestId === state.timeline.requestId && state.timeline.channelId === channelId) {
      effects.scheduleRender();
    }
  }
}

function cachedGuildIdForChannel(state: AppState, channelId: string): string | null {
  for (const [guildId, channels] of Object.entries(state.sidebar.cachedChannelsByGuildId)) {
    if (channels.some((channel) => channel.id === channelId)) return guildId;
  }
  return null;
}

function accessibleTimelineChannel(state: AppState, channelId: string): DiscordChannel | null {
  const channel = findTimelineChannel(state.channelList.channels, channelId);
  return channel && !channel.hidden ? channel : null;
}

export async function loadChannelMessageLocation(
  state: AppState,
  token: string,
  target: ChannelMessageLocationTarget,
  effects: SessionEffects,
): Promise<boolean> {
  let channel = accessibleTimelineChannel(state, target.channelId);
  const guildId = target.guildId ?? channel?.guildId ?? cachedGuildIdForChannel(state, target.channelId);

  if (!channel && guildId) {
    await loadGuildChannels(state, token, guildId, effects, { openFirstChannel: false });
    channel = accessibleTimelineChannel(state, target.channelId);
  }

  if (!channel) {
    setNotice(state, "You do not have access to that forwarded message's channel, or it is not loaded yet.", "warning");
    effects.scheduleRender();
    return false;
  }

  if (state.timeline.channelId !== channel.id) {
    await loadChannelMessages(state, token, channel.id, effects);
  }
  if (state.timeline.channelId !== channel.id) return false;

  return loadChannelMessagesAround(state, token, channel.id, target.messageId, effects);
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

function uploadFromClipboardImage(image: ClipboardImageAttachment): LocalMessageUpload {
  return {
    filename: image.filename ?? "image.png",
    mediaType: image.mediaType,
    base64: image.base64,
    sizeBytes: image.sizeBytes,
  };
}

function uploadOptionsForFiles(files: LocalMessageUpload[]): SendMessageUpload[] {
  return files.map((file) => ({
    filename: file.filename,
    mediaType: file.mediaType,
    base64: file.base64,
    durationSecs: file.durationSecs,
    waveform: file.waveform,
  }));
}

function localAttachmentsForFiles(files: LocalMessageUpload[]): DiscordMessageAttachment[] {
  return files.map((file, index) => ({
    id: `local:${index}`,
    filename: file.filename,
    contentType: file.mediaType,
    size: file.sizeBytes,
    url: "",
    durationSecs: file.durationSecs,
    waveform: file.waveform,
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
  if (isWhatsAppChannelId(target.channelId)) {
    setNotice(state, "Editing WhatsApp messages is not supported yet.", "warning", { statusLine: false, chat: true });
    effects.scheduleRender();
    return;
  }
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

export function deleteMessage(
  state: AppState,
  token: string | null,
  message: DiscordMessage,
  effects: SessionEffects,
): void {
  const channelId = message.channelId;
  const messageId = message.id;
  if (isWhatsAppChannelId(channelId)) {
    state.messageDeletePending = null;
    setNotice(state, "Deleting WhatsApp messages is not supported yet.", "warning", { statusLine: false, chat: true });
    effects.scheduleRender();
    return;
  }
  const timelineIndex = state.timeline.channelId === channelId
    ? state.timeline.messages.findIndex((entry) => entry.id === messageId)
    : -1;

  if (message.localStatus === "pending") {
    state.messageDeletePending = null;
    effects.scheduleRender();
    return;
  }

  if (messageId.startsWith("local:")) {
    state.messageDeletePending = null;
    if (removeCachedChannelMessage(state.messageCacheByChannelId, channelId, messageId)) {
      persistChannelMessageCache(state, channelId);
    }
    removeTimelineMessage(state.timeline, messageId, channelId);
    clearMessageTargetsForDeletedMessage(state, channelId, messageId);
    effects.scheduleRender();
    return;
  }

  if (!token) {
    state.messageDeletePending = null;
    effects.scheduleRender();
    return;
  }

  state.messageDeletePending = null;
  if (removeCachedChannelMessage(state.messageCacheByChannelId, channelId, messageId)) {
    persistChannelMessageCache(state, channelId);
  }
  removeTimelineMessage(state.timeline, messageId, channelId);
  clearMessageTargetsForDeletedMessage(state, channelId, messageId);
  effects.scheduleRender();

  void (async () => {
    try {
      await deleteChannelMessage(token, channelId, messageId);
    } catch {
      upsertCachedChannelMessage(state.messageCacheByChannelId, message);
      persistChannelMessageCache(state, channelId);
      if (timelineIndex >= 0) {
        insertTimelineMessageAt(state.timeline, message, timelineIndex, channelId);
      }
      effects.scheduleRender();
    }
  })();
}

function clearMessageTargetsForDeletedMessage(state: AppState, channelId: string, messageId: string): void {
  if (state.replyTarget?.channelId === channelId && state.replyTarget.messageId === messageId) {
    state.replyTarget = null;
  }
  if (state.editTarget?.channelId === channelId && state.editTarget.messageId === messageId) {
    state.editTarget = null;
  }
}

export function sendCurrentChannelMessage(
  state: AppState,
  token: string | null,
  content: string,
  effects: SessionEffects,
  options: { sendContent?: string; localMentionUsers?: DiscordGuildMember[]; uploads?: LocalMessageUpload[]; failureBuffer?: string; loadingNotice?: string; failureNoticePrefix?: string; messageFlags?: number } = {},
): void {
  const channelId = state.channelList.activeChannelId ?? state.timeline.channelId;
  if (isWhatsAppChannelId(channelId)) {
    setNotice(state, "WhatsApp messages must be sent through the WhatsApp provider.", "warning", { statusLine: false, chat: true });
    effects.scheduleRender();
    return;
  }
  if (!token) {
    setNotice(state, "Login first with /login <token|username>.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }
  if (!channelId) {
    setNotice(state, "Open a channel before sending a message.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }
  const targetChannel = channelById(state, channelId);
  const shouldJoinThread = Boolean(targetChannel && isThreadChannel(targetChannel) && targetChannel.thread?.joined === false);
  if (content.length > 2_000) {
    setNotice(state, "Discord messages cannot exceed 2000 characters.", "warning");
    effects.scheduleRender();
    return;
  }

  const viewer = state.auth.user;
  const messageNonce = generateMessageNonce();
  const localMessageId = `local:${messageNonce}`;
  const replyTarget = state.replyTarget?.channelId === channelId ? state.replyTarget : null;
  const replyOptions = activeReplyForChannel(state, channelId);
  const replyPreview = localReplyPreview(state, channelId);
  const pendingImages = [...state.pendingImages];
  const messageUploads = [
    ...pendingImages.map(uploadFromClipboardImage),
    ...(options.uploads ?? []),
  ];
  const uploads = uploadOptionsForFiles(messageUploads);
  const localAttachments = localAttachmentsForFiles(messageUploads);
  const sendContent = options.sendContent ?? content;
  clearPrompt(state);
  state.pendingImages = [];
  state.replyTarget = null;
  if (options.loadingNotice) {
    setNotice(state, options.loadingNotice, "muted", { loading: true, chat: false });
  } else {
    setNotice(state, "", "muted");
  }

  const localMessage: DiscordMessage = {
    id: localMessageId,
    channelId,
    guildId: state.channelList.activeChannel?.guildId ?? null,
    nonce: messageNonce,
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
      if (shouldJoinThread) {
        await joinThread(token, channelId);
        setThreadJoinedState(state, channelId, true);
      }
      const sentMessage = await sendChannelMessage(token, channelId, sendContent, {
        reply: replyOptions,
        uploads,
        flags: options.messageFlags,
        nonce: messageNonce,
      });
      const message = withMessageGuildId(sentMessage, state.channelList.activeChannel?.guildId ?? null);
      recordMemberRoleIds(state, message.guildId ?? state.channelList.activeChannel?.guildId, message.author.id, message.author.roleIds);
      replaceCachedChannelMessage(state.messageCacheByChannelId, channelId, localMessageId, message);
      persistChannelMessageCache(state, channelId);
      if (state.timeline.channelId === channelId) {
        replaceTimelineMessage(state.timeline, localMessageId, message);
        state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
      if (options.loadingNotice && state.notice.text === options.loadingNotice) {
        setNotice(state, "", "muted");
      }
      maybeResortDirectMessages(state, channelId, message.id);
      effects.scheduleRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cachedFailed = markCachedChannelMessageFailed(state.messageCacheByChannelId, channelId, localMessageId, message);
      const failed = markTimelineMessageFailed(state.timeline, localMessageId, message) ?? cachedFailed;
      state.replyTarget = replyTarget;
      state.pendingImages = pendingImages;
      state.editor.buffer = options.failureBuffer ?? failed?.content ?? content;
      state.editor.cursor = state.editor.buffer.length;
      if (state.timeline.channelId === channelId) {
        state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
      if (options.failureNoticePrefix) {
        setNotice(state, `${options.failureNoticePrefix}: ${message}`, "warning", { statusLine: true, chat: false });
      } else {
        setNotice(state, "", "muted");
      }
      effects.scheduleRender();
    }
  })();
}

function setUploadFailureNotice(state: AppState, effects: SessionEffects, message: string): void {
  setNotice(state, `Upload failed: ${message}`, "warning", { statusLine: true, chat: false });
  effects.scheduleRender();
}

function uploadFileInfo(path: string): { filename: string; needsCompression: boolean } {
  const normalizedPath = normalizeUploadPath(path);
  const stats = statSync(normalizedPath);
  if (!stats.isFile()) throw new Error("Not a file.");
  return {
    filename: basename(normalizedPath),
    needsCompression: stats.size > DISCORD_UPLOAD_LIMIT_BYTES,
  };
}

export function uploadCurrentChannelFile(
  state: AppState,
  token: string | null,
  path: string,
  effects: SessionEffects,
): void {
  const channelId = state.channelList.activeChannelId ?? state.timeline.channelId;
  if (isWhatsAppChannelId(channelId)) {
    setUploadFailureNotice(state, effects, "WhatsApp file uploads are not supported yet.");
    return;
  }
  if (!token) {
    setUploadFailureNotice(state, effects, "Login first with /login <token|username>.");
    return;
  }
  if (!channelId) {
    setUploadFailureNotice(state, effects, "Open a channel before sending a message.");
    return;
  }

  let info: { filename: string; needsCompression: boolean };
  try {
    info = uploadFileInfo(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setUploadFailureNotice(state, effects, message);
    return;
  }

  const prepareAndSend = async (): Promise<void> => {
    let upload: LocalFileUpload;
    try {
      upload = await readLocalFileUploadInWorker(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUploadFailureNotice(state, effects, message);
      return;
    }

    sendCurrentChannelMessage(state, token, "", effects, {
      uploads: [upload],
      failureBuffer: `/upload ${path}`,
      loadingNotice: `Uploading ${upload.filename}…`,
      failureNoticePrefix: "Upload failed",
    });
  };

  if (info.needsCompression) {
    setNotice(state, `Compressing ${info.filename}…`, "muted", { loading: true, chat: false });
    effects.scheduleRender();
    void prepareAndSend();
    return;
  }

  setNotice(state, `Uploading ${info.filename}…`, "muted", { loading: true, chat: false });
  effects.scheduleRender();
  void prepareAndSend();
}

export function sendCurrentChannelVoiceMessage(
  state: AppState,
  token: string | null,
  clip: VoiceMessageClip,
  effects: SessionEffects,
): void {
  sendCurrentChannelMessage(state, token, "", effects, {
    uploads: [clip],
    messageFlags: VOICE_MESSAGE_FLAG,
    failureBuffer: "",
  });
}

function selectedGuildVoiceChannel(state: AppState): DiscordChannel | null {
  const entry = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  });
  if (entry.kind !== "channel") return null;
  const channel = state.channelList.channels.find((candidate) => candidate.id === entry.id)
    ?? state.sidebar.cachedChannelsByGuildId[entry.guildId]?.find((candidate) => candidate.id === entry.id)
    ?? null;
  return isGuildVoiceChannel(channel) ? channel : null;
}

function rememberVoiceStateParticipants(state: AppState, channelId: string): void {
  const voiceStates = callVoiceStatesByChannelId.get(channelId);
  if (!voiceStates || voiceStates.size === 0) return;
  rememberActiveCallParticipants(state, channelId, Array.from(voiceStates.keys()));
}

function startGuildVoiceChannelCall(state: AppState, token: string, channel: DiscordChannel, effects: SessionEffects): void {
  if (!isGuildVoiceChannel(channel) || channel.guildId === DIRECT_MESSAGES_GUILD_ID) {
    setNotice(state, "Select a server voice channel to join.", "warning");
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

  if (!knownCallParticipantsByChannelId.has(channel.id)) knownCallParticipantsByChannelId.set(channel.id, new Set());
  rememberVoiceStateParticipants(state, channel.id);

  const activeSession = controller.activeSession;
  if (activeSession && activeSession.state !== "ended" && activeSession.state !== "error" && activeSession.target.channelId === channel.id) {
    debugLog("voice_channel.command.noop", {
      guildId: channel.guildId,
      channelId: channel.id,
      activeState: activeSession.state,
      knownParticipants: Array.from(knownCallParticipantsByChannelId.get(channel.id) ?? []),
    });
    syncVoiceCallStatus(state, activeSession);
    setNotice(state, "", "muted");
    effects.scheduleRender();
    return;
  }

  const guildName = state.sidebar.guilds.find((guild) => guild.id === channel.guildId)?.name;
  const displayName = guildName ? `${guildName} / ${channel.name}` : channel.name;
  const replacingActiveCall = Boolean(
    activeSession
      && activeSession.state !== "ended"
      && activeSession.state !== "error"
      && activeSession.target.channelId !== channel.id,
  );

  debugLog("voice_channel.command", {
    guildId: channel.guildId,
    channelId: channel.id,
    replacingActiveCall,
    knownParticipants: Array.from(knownCallParticipantsByChannelId.get(channel.id) ?? []),
  });
  setNotice(state, "", "muted");
  effects.scheduleRender();

  void controller.startCall({
    guildId: channel.guildId,
    channelId: channel.id,
    recipientIds: [],
    displayName,
    ringRecipients: false,
  }, { replaceActive: replacingActiveCall }).then(({ warnings }) => {
    playSoundEffect("callJoin");
    if (warnings.length > 0) {
      setNotice(state, `Voice connected, but ${warnings[0]}`, "warning", { chat: false });
    } else {
      setNotice(state, "", "muted");
    }
    effects.scheduleRender();
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Call cancelled.") return;
    setNotice(state, `Failed to join voice channel: ${message}`, "error", { chat: false });
    effects.scheduleRender();
  });
}

export function startCurrentVoiceCall(
  state: AppState,
  effects: SessionEffects,
  options: { voiceChannel?: DiscordChannel | null } = {},
): void {
  if (isWhatsAppChannel(options.voiceChannel ?? state.channelList.activeChannel)) {
    setNotice(state, "WhatsApp calls are not supported in Record.", "warning", { statusLine: false, chat: true });
    effects.scheduleRender();
    return;
  }
  const token = state.auth.savedToken;
  if (!token || !state.auth.user) {
    setNotice(state, "Login required to start a call.", "warning");
    effects.scheduleRender();
    return;
  }

  const explicitVoiceChannel = options.voiceChannel && isGuildVoiceChannel(options.voiceChannel) ? options.voiceChannel : null;
  if (explicitVoiceChannel) {
    startGuildVoiceChannelCall(state, token, explicitVoiceChannel, effects);
    return;
  }

  const channel = state.channelList.activeChannel;
  if (!channel || !isDirectMessageChannel(channel)) {
    const selectedVoice = selectedGuildVoiceChannel(state);
    if (selectedVoice) {
      startGuildVoiceChannelCall(state, token, selectedVoice, effects);
      return;
    }
    setNotice(state, "Open a DM or select a server voice channel to start a call.", "warning");
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
  if (!knownCallParticipantsByChannelId.has(channel.id)) knownCallParticipantsByChannelId.set(channel.id, new Set());
  const activeCallMessageParticipants = activeCallMessageParticipantIds(state, channel.id);
  if (activeCallMessageParticipants.length > 0) {
    rememberActiveCallMessageParticipants(state, channel.id, activeCallMessageParticipants, "call_command_active_message");
  }
  const joiningExistingCall = callHasRemoteParticipants(state, channel.id);
  const activeSession = controller.activeSession;
  if (activeSession && activeSession.state !== "ended" && activeSession.state !== "error" && activeSession.target.channelId === channel.id) {
    debugLog("call.command.noop", {
      channelId: channel.id,
      activeState: activeSession.state,
      knownParticipants: Array.from(knownCallParticipantsByChannelId.get(channel.id) ?? []),
      activeCallMessageParticipants,
    });
    stopOutboundCallRingtone(channel.id, "already_active");
    syncVoiceCallStatus(state, activeSession);
    setNotice(state, "", "muted");
    effects.scheduleRender();
    return;
  }
  debugLog("call.command", {
    channelId: channel.id,
    joiningExistingCall,
    knownParticipants: Array.from(knownCallParticipantsByChannelId.get(channel.id) ?? []),
    activeCallMessageParticipants,
  });
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
    const hasRemoteParticipants = callHasRemoteParticipants(state, channel.id);
    if (joiningExistingCall || hasRemoteParticipants) {
      debugLog("call.outbound_ringtone.skipped", {
        channelId: channel.id,
        reason: joiningExistingCall ? "joining_existing_call" : "participant_discovered_before_ringtone",
        remoteParticipants: remoteCallParticipantIds(state, channel.id),
      });
      if (hasRemoteParticipants) {
        playCallJoinSoundForParticipants(channel.id, remoteCallParticipantIds(state, channel.id), "existing_call_join");
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

export function startCurrentDirectMessageCall(state: AppState, effects: SessionEffects): void {
  startCurrentVoiceCall(state, effects);
}

export function hangUpCurrentCall(state: AppState, effects: SessionEffects): void {
  if (!voiceCallController?.activeSession) {
    setNotice(state, "No active call.", "muted", { chat: false });
    effects.scheduleRender();
    return;
  }

  stopCurrentStream(state, effects, { silent: true });
  stopCurrentWatchedStream(state, effects, { silent: true });
  stopOutboundCallRingtone(voiceCallController.activeSession.target.channelId, "hangup");
  debugLog("call.command.hangup", { channelId: voiceCallController.activeSession.target.channelId });
  voiceCallController.leave("hangup");
  state.voiceCall = null;
  setNotice(state, "", "muted");
  effects.scheduleRender();
}

export function toggleCurrentStream(state: AppState, effects: SessionEffects): void {
  if (streamController) {
    stopCurrentStream(state, effects);
    return;
  }
  startCurrentStream(state, effects);
}

export function startCurrentStream(state: AppState, effects: SessionEffects): void {
  const token = state.auth.savedToken;
  const selfUserId = state.auth.user?.id;
  if (!token || !selfUserId) {
    setNotice(state, "Login required to stream.", "warning");
    effects.scheduleRender();
    return;
  }
  const session = voiceCallController?.activeSession;
  if (!session || session.state !== "ready") {
    setNotice(state, "Join a call before starting /stream.", "warning", { chat: false });
    effects.scheduleRender();
    return;
  }
  if (!session.sessionId) {
    setNotice(state, "Discord voice session is still connecting; try /stream again in a moment.", "warning", { chat: false });
    effects.scheduleRender();
    return;
  }
  if (!appGateway || appGatewayToken !== token || !appGateway.isReady()) {
    setNotice(state, "Discord gateway is still connecting; try again in a moment.", "warning", { chat: false });
    effects.scheduleRender();
    return;
  }

  const type = session.target.guildId ? "guild" : "call";
  const streamKey = session.target.guildId
    ? `guild:${session.target.guildId}:${session.target.channelId}:${selfUserId}`
    : `call:${session.target.channelId}:${selfUserId}`;
  const controller = new ScreenStreamController(streamKey, session, selfUserId, {
    scheduleRender: effects.scheduleRender,
    pingStreamServer: (key) => appGateway?.pingStreamServer(key) ?? false,
    refreshStreamServer: (key, reason, attempt) => {
      const gateway = appGateway;
      if (!gateway || appGatewayToken !== token || !gateway.isReady()) return false;

      const pinged = gateway.pingStreamServer(key);
      // A plain STREAM_PING is enough for a transient bad stream server, but a
      // 4006 invalid session or a parent voice reconnect usually means the old
      // stream allocation is stale.  Re-sending CREATE_STREAM asks Discord to
      // give us fresh STREAM_CREATE / STREAM_SERVER_UPDATE data for the same
      // stream key without making the user manually stop/start sharing.
      const shouldRecreate = reason === "invalid_session"
        || reason === "voice_session_not_ready"
        || reason === "awaiting_fresh_stream_server"
        || reason === "stream_delete"
        || reason === "gateway_close"
        || reason === "connect_failed"
        || attempt >= 3;
      let recreated = false;
      if (shouldRecreate) {
        recreated = gateway.createStream({
          type,
          guildId: session.target.guildId,
          channelId: session.target.channelId,
          preferredRegion: session.target.preferredRegions?.[0] ?? null,
        });
        if (recreated) gateway.setStreamPaused(key, false);
      }
      debugLog("stream.refresh.request", { streamKey: key, reason, attempt, pinged, recreated });
      return pinged || recreated;
    },
  }, (error) => {
    setNotice(state, `Stream: ${error.message}`, "warning", { chat: false });
  });
  streamController = controller;
  setNotice(state, "Starting screen stream…", "muted", { loading: true, chat: false });
  effects.scheduleRender();

  if (!appGateway.createStream({
    type,
    guildId: session.target.guildId,
    channelId: session.target.channelId,
    preferredRegion: session.target.preferredRegions?.[0] ?? null,
  })) {
    streamController = null;
    setNotice(state, "Discord gateway is not ready to create a stream.", "warning", { chat: false });
    effects.scheduleRender();
    return;
  }
  appGateway.setStreamPaused(streamKey, false);

  void controller.start().then(() => {
    if (streamController !== controller) return;
    playSoundEffect("streamStarted");
    setNotice(state, "Streaming first monitor with desktop audio.", "success", { chat: false });
    effects.scheduleRender();
  }).catch((error) => {
    if (streamController === controller) streamController = null;
    appGateway?.deleteStream(streamKey);
    const message = error instanceof Error ? error.message : String(error);
    setNotice(state, `Failed to start stream: ${message}`, "error", { chat: false });
    effects.scheduleRender();
  });
}

export function stopCurrentStream(state: AppState, effects: SessionEffects, options: { silent?: boolean } = {}): void {
  const controller = streamController;
  if (!controller) {
    if (!options.silent) {
      setNotice(state, "No active stream.", "muted", { chat: false });
      effects.scheduleRender();
    }
    return;
  }
  streamController = null;
  controller.stop("command");
  appGateway?.deleteStream(controller.streamKey);
  if (!options.silent) {
    playSoundEffect("streamEnded");
    setNotice(state, "Stream stopped.", "muted", { chat: false });
    effects.scheduleRender();
  }
}

export function watchCurrentStream(state: AppState, effects: SessionEffects, target: string | null = null): void {
  const normalizedTarget = normalizeWatchTarget(target);
  if (normalizedTarget && watchStreamController?.streamKey === normalizedTarget) {
    stopCurrentWatchedStream(state, effects);
    return;
  }
  const token = state.auth.savedToken;
  const selfUserId = state.auth.user?.id;
  if (!token || !selfUserId) {
    setNotice(state, "Login required to watch a stream.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }
  const session = voiceCallController?.activeSession;
  if (!session || session.state !== "ready") {
    setNotice(state, "Join a call before using /watch.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }
  if (!session.sessionId) {
    setNotice(state, "Discord voice session is still connecting; try /watch again in a moment.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }
  if (!appGateway || appGatewayToken !== token || !appGateway.isReady()) {
    setNotice(state, "Discord gateway is still connecting; try again in a moment.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }

  const resolved = resolveWatchStreamKey(state, session, target);
  if (!resolved) {
    setNotice(state, watchStreamAmbiguityNotice(state, session, target), "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }
  if (resolved.ownerUserId === selfUserId) {
    setNotice(state, "Use /stream to control your own stream; /watch is for other users' streams.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }

  if (watchStreamController?.streamKey === resolved.streamKey) {
    stopCurrentWatchedStream(state, effects);
    return;
  }
  stopCurrentWatchedStream(state, effects, { silent: true });

  const ownerLabel = resolved.ownerUserId
    ? displayNameForUser(state, session.target.channelId, resolved.ownerUserId, resolved.ownerUserId)
    : "stream";
  const playback = createDefaultWatchStreamPlayback({
    title: `record stream — ${ownerLabel}`,
    onEnded: (error) => {
      if (watchStreamController !== controller) return;
      watchStreamController = null;
      controller.stop("playback_ended");
      const parsed = parseStreamKey(controller.streamKey);
      if (parsed) syncOpenVoiceMemberStreamAction(state, parsed.channelId, parsed.ownerUserId);
      if (error) setNotice(state, `Stream playback ended: ${error.message}`, "warning", { statusLine: false });
      else setNotice(state, `Stopped watching ${ownerLabel}'s stream.`, "muted", { statusLine: false });
      effects.scheduleRender();
    },
  });
  const controller = new WatchStreamController(resolved.streamKey, session, selfUserId, {
    scheduleRender: effects.scheduleRender,
    watchStream: (streamKey) => appGateway?.watchStream(streamKey) ?? false,
    pingStreamServer: (streamKey) => appGateway?.pingStreamServer(streamKey) ?? false,
  }, (error) => {
    setNotice(state, `Stream watch: ${error.message}`, "warning", { statusLine: false });
  }, undefined, playback);
  watchStreamController = controller;

  const tracked = availableStreamsByKey.get(resolved.streamKey);
  if (tracked) {
    controller.handleCreate(tracked.create);
    if (tracked.serverUpdate) controller.handleServerUpdate(tracked.serverUpdate);
  }

  setNotice(state, `Joining ${ownerLabel}'s stream…`, "muted", { loading: true, statusLine: false });
  effects.scheduleRender();

  void controller.start().then(() => {
    if (watchStreamController !== controller) return;
    setNotice(state, `Watching ${ownerLabel}'s stream.`, "success", { statusLine: false });
    effects.scheduleRender();
  }).catch((error) => {
    if (watchStreamController === controller) watchStreamController = null;
    const parsed = parseStreamKey(controller.streamKey);
    if (parsed) syncOpenVoiceMemberStreamAction(state, parsed.channelId, parsed.ownerUserId);
    const message = error instanceof Error ? error.message : String(error);
    setNotice(state, `Failed to watch stream: ${message}`, "error", { statusLine: false });
    effects.scheduleRender();
  });
}

export function stopCurrentWatchedStream(state: AppState, effects: SessionEffects, options: { silent?: boolean } = {}): void {
  const controller = watchStreamController;
  if (!controller) {
    if (!options.silent) {
      setNotice(state, "No active watched stream.", "muted", { statusLine: false });
      effects.scheduleRender();
    }
    return;
  }
  watchStreamController = null;
  controller.stop("command");
  const parsed = parseStreamKey(controller.streamKey);
  if (parsed) syncOpenVoiceMemberStreamAction(state, parsed.channelId, parsed.ownerUserId);
  if (!options.silent) {
    setNotice(state, "Stopped watching stream.", "muted", { statusLine: false });
    effects.scheduleRender();
  } else if (parsed) {
    effects.scheduleRender();
  }
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

export function setLocalMicVolume(state: AppState, effects: SessionEffects, volume: number): void {
  const next = normalizeGainDb(volume);
  state.audio.micVolume = next;
  voiceCallController?.setLocalVolumes({ micVolume: next, speakerVolume: state.audio.speakerVolume });
  try {
    saveConfig({ audio: { micGainDb: next } });
    setNotice(state, `Microphone record gain set to ${formatGainDbWithUnit(next)}.`, "muted", { statusLine: false });
  } catch (error) {
    setNotice(state, `Microphone record gain set to ${formatGainDbWithUnit(next)}, but saving failed: ${(error as Error).message}`, "warning", { statusLine: false });
  }
  effects.scheduleRender();
}

export function setLocalSpeakerVolume(state: AppState, effects: SessionEffects, volume: number): void {
  const next = normalizeGainDb(volume);
  state.audio.speakerVolume = next;
  setSoundEffectVolume(next);
  voiceCallController?.setLocalVolumes({ micVolume: state.audio.micVolume, speakerVolume: next });
  setNotice(state, `Speaker playback gain set to ${formatGainDbWithUnit(next)}.`, "muted", { statusLine: false });
  effects.scheduleRender();
}

export function setLocalNoiseSuppression(state: AppState, effects: SessionEffects, mode: NoiseSuppressionMode): void {
  state.noiseSuppression = mode;
  voiceCallController?.setNoiseSuppression(mode);
  try {
    saveConfig({ audio: { noiseSuppression: mode } });
    setNotice(state, `Noise suppression set to ${mode}.`, "muted", { statusLine: false });
  } catch (error) {
    setNotice(state, `Noise suppression set to ${mode}, but saving failed: ${(error as Error).message}`, "warning", { statusLine: false });
  }
  effects.scheduleRender();
}

export function toggleSelectedGuildMute(state: AppState, effects: SessionEffects): void {
  const entry = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  });
  if (toggleSelectedVoiceMemberMute(state, effects, entry)) return;

  const token = state.auth.savedToken;
  if (!token) {
    setNotice(state, "Login required to mute servers or direct messages.", "warning");
    effects.scheduleRender();
    return;
  }

  if (entry.kind === "channel" && entry.guildId === DIRECT_MESSAGES_GUILD_ID) {
    const channel = channelById(state, entry.id);
    const previousMuted = isChannelMuted(state, entry.id);
    const nextMuted = !previousMuted;
    const previousNotifications = {
      byChannelId: { ...state.notifications.byChannelId },
      channelGuildIds: { ...state.notifications.channelGuildIds },
    };

    setChannelListChannelMuted(state, entry.id, nextMuted);
    setSidebarChannelMuted(state.sidebar, entry.id, nextMuted);
    if (state.channelList.guildId === DIRECT_MESSAGES_GUILD_ID) {
      setSidebarCachedChannels(state.sidebar, DIRECT_MESSAGES_GUILD_ID, state.channelList.channels);
    }
    if (nextMuted) {
      clearChannelNotifications(state.notifications, entry.id);
      persistNotifications(state);
    }
    const accountId = currentAccountId(state);
    const directMessages = state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID];
    if (accountId && directMessages) saveCachedDirectMessages(accountId, directMessages);
    setNotice(state, "", "muted");
    effects.scheduleRender();

    void setDirectMessageChannelMuted(token, entry.id, nextMuted).catch((error) => {
      setChannelListChannelMuted(state, entry.id, previousMuted);
      setSidebarChannelMuted(state.sidebar, entry.id, previousMuted);
      if (state.channelList.guildId === DIRECT_MESSAGES_GUILD_ID) {
        setSidebarCachedChannels(state.sidebar, DIRECT_MESSAGES_GUILD_ID, state.channelList.channels);
      }
      state.notifications.byChannelId = previousNotifications.byChannelId;
      state.notifications.channelGuildIds = previousNotifications.channelGuildIds;
      const rollbackDirectMessages = state.sidebar.cachedChannelsByGuildId[DIRECT_MESSAGES_GUILD_ID];
      if (accountId && rollbackDirectMessages) saveCachedDirectMessages(accountId, rollbackDirectMessages);
      persistNotifications(state);
      setNotice(state, `Failed to ${nextMuted ? "mute" : "unmute"} ${channel?.name ?? "direct message"}: ${error instanceof Error ? error.message : String(error)}`, "error");
      effects.scheduleRender();
    });
    return;
  }

  if ((entry.kind === "category" || entry.kind === "channel") && entry.guildId !== DIRECT_MESSAGES_GUILD_ID) {
    const channel = channelById(state, entry.id);
    if (!channel) {
      setNotice(state, "Could not find that channel or category.", "warning");
      effects.scheduleRender();
      return;
    }

    const previousMuted = Boolean(channel.muted || state.channelMuteSettings[entry.id]);
    const nextMuted = !previousMuted;
    const previousNotifications = {
      byChannelId: { ...state.notifications.byChannelId },
      channelGuildIds: { ...state.notifications.channelGuildIds },
    };
    setChannelListChannelMuted(state, entry.id, nextMuted);
    setSidebarChannelMuted(state.sidebar, entry.id, nextMuted);
    if (nextMuted) {
      const mutedChannelIds = [entry.id];
      if (entry.kind === "category") {
        const allChannels = [
          ...state.channelList.channels,
          ...Object.values(state.sidebar.cachedChannelsByGuildId).flat(),
        ];
        const descendants = new Set<string>([entry.id]);
        let added = true;
        while (added) {
          added = false;
          for (const candidate of allChannels) {
            if (!candidate.parentId || !descendants.has(candidate.parentId) || descendants.has(candidate.id)) continue;
            descendants.add(candidate.id);
            mutedChannelIds.push(candidate.id);
            added = true;
          }
        }
      }
      for (const channelId of mutedChannelIds) clearChannelNotifications(state.notifications, channelId);
      persistNotifications(state);
    }
    const accountId = currentAccountId(state);
    const cachedChannels = state.sidebar.cachedChannelsByGuildId[entry.guildId];
    if (accountId && cachedChannels) saveCachedGuildChannels(accountId, entry.guildId, cachedChannels);
    setNotice(state, "", "muted");
    effects.scheduleRender();

    void setGuildChannelMuted(token, entry.guildId, entry.id, nextMuted).catch((error) => {
      setChannelListChannelMuted(state, entry.id, previousMuted);
      setSidebarChannelMuted(state.sidebar, entry.id, previousMuted);
      state.notifications.byChannelId = previousNotifications.byChannelId;
      state.notifications.channelGuildIds = previousNotifications.channelGuildIds;
      const rollbackChannels = state.sidebar.cachedChannelsByGuildId[entry.guildId];
      if (accountId && rollbackChannels) saveCachedGuildChannels(accountId, entry.guildId, rollbackChannels);
      persistNotifications(state);
      setNotice(state, `Failed to ${nextMuted ? "mute" : "unmute"} ${channel.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
      effects.scheduleRender();
    });
    return;
  }

  if (entry.kind !== "guild" || !entry.guildId || entry.guildId === DIRECT_MESSAGES_GUILD_ID) {
    setNotice(state, "Select a server, category, channel, DM, or group chat to mute or unmute it.", "muted");
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
  const selected = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  });
  if (selected.kind === "channel" && isFixedTopLevelGuildId(selected.guildId)) {
    const movedGuildId = moveSelectedPrivateConversation(
      state.sidebar,
      state.channelList.channels,
      direction,
      { showHiddenChannels: state.showHiddenChannels, currentUserId: state.auth.user?.id ?? null },
    );
    if (movedGuildId) persistPrivateConversationLayout(state, movedGuildId);
    effects.scheduleRender();
    return;
  }

  if (!currentAccountId(state)) {
    setNotice(state, "Login required to reorder servers.", "warning");
    effects.scheduleRender();
    return;
  }

  const moved = moveSelectedSidebarItem(state.sidebar, state.channelList.channels, direction, {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  });
  if (!moved) {
    setNotice(state, "Select a server or folder row that can move.", "muted");
    effects.scheduleRender();
    return;
  }

  persistSidebarGuilds(state);
  setNotice(state, "", "muted");
  effects.scheduleRender();
}

export function toggleSelectedPrivateConversationPin(state: AppState, effects: SessionEffects): void {
  const guildId = toggleSelectedPrivateConversationPinned(
    state.sidebar,
    state.channelList.channels,
    { showHiddenChannels: state.showHiddenChannels, currentUserId: state.auth.user?.id ?? null },
  );
  if (guildId) persistPrivateConversationLayout(state, guildId);
  effects.scheduleRender();
}

export function ackCurrentChannelIfAtBottom(state: AppState): void {
  const channelId = state.timeline.channelId;
  if (!channelId || isWhatsAppChannelId(channelId) || !isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) return;
  const latestMessageId = channelAckMessageId(state, channelId, latestTimelineMessageId(state, channelId));
  if (!latestMessageId) return;
  markChannelRead(state, state.auth.savedToken, channelId, latestMessageId);
}

interface PresenceStatusPersistRetryOptions {
  retries?: number;
  delayMs?: number;
  shouldContinue?: () => boolean;
}

export async function persistPresenceStatusWithRetries(
  token: string,
  status: DiscordPresenceStatus,
  persistStatus: (token: string, status: DiscordPresenceStatus) => Promise<void>,
  options: PresenceStatusPersistRetryOptions = {},
): Promise<boolean> {
  const retries = options.retries ?? PRESENCE_STATUS_PERSIST_RETRIES;
  const delayMs = options.delayMs ?? PRESENCE_STATUS_PERSIST_RETRY_DELAY_MS;
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.shouldContinue?.() === false) {
      debugLog("presence_status.persist_cancelled", { status, attempt, retries });
      return false;
    }

    try {
      await persistStatus(token, status);
      if (attempt > 1) debugLog("presence_status.persist_succeeded_after_retry", { status, attempt, retries });
      return true;
    } catch (error) {
      const finalAttempt = attempt >= maxAttempts;
      debugLog(finalAttempt ? "presence_status.persist_error" : "presence_status.persist_retry", {
        status,
        attempt,
        retries,
        retryInMs: finalAttempt ? null : delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      if (finalAttempt) return false;
      await waitForPresenceStatusRetry(delayMs);
    }
  }

  return false;
}

function waitForPresenceStatusRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function setCurrentUserPresenceStatus(
  state: AppState,
  effects: SessionEffects,
  status: DiscordPresenceStatus,
  persistStatus: (token: string, status: DiscordPresenceStatus) => Promise<void>,
): void {
  const token = state.auth.savedToken;
  if (!token || !state.auth.user) {
    setNotice(state, "Login first with /login <token|username>.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }

  state.auth.presenceStatus = status;
  if (!appGateway || appGatewayToken !== token) startAppGateway(state, token, effects);
  appGateway?.updatePresenceStatus(status);
  effects.scheduleRender();

  void persistPresenceStatusWithRetries(token, status, persistStatus, {
    shouldContinue: () => state.auth.savedToken === token && state.auth.presenceStatus === status,
  }).then((persisted) => {
    if (persisted || state.auth.savedToken !== token || state.auth.presenceStatus !== status) return;
    setNotice(state, "Failed to save your presence status with Discord.", "warning", { statusLine: false });
    effects.scheduleRender();
  });
}

export function setCurrentUserCustomStatus(
  state: AppState,
  effects: SessionEffects,
  text: string | null,
  persistStatus: (token: string, text: string | null) => Promise<void>,
): void {
  const token = state.auth.savedToken;
  if (!token || !state.auth.user) {
    setNotice(state, "Login first with /login <token|username>.", "warning", { statusLine: false });
    effects.scheduleRender();
    return;
  }

  const previous = state.auth.customStatus;
  const customStatus: DiscordCustomStatus | null = text === null
    ? null
    : {
        text,
        emojiId: previous?.emojiId ?? null,
        emojiName: previous?.emojiName ?? null,
      };
  state.auth.customStatus = customStatus;
  if (!appGateway || appGatewayToken !== token) startAppGateway(state, token, effects);
  appGateway?.updateCustomStatus(customStatus);
  setNotice(state, text === null ? "Custom status cleared." : "Custom status set.", "success", { statusLine: false });
  effects.scheduleRender();

  void persistStatus(token, text).catch((error) => {
    if (state.auth.savedToken !== token || state.auth.customStatus?.text !== customStatus?.text) return;
    debugLog("custom_status.persist_error", {
      textLength: text === null ? 0 : Array.from(text).length,
      error: error instanceof Error ? error.message : String(error),
    });
    setNotice(state, "Failed to save your custom status with Discord.", "warning", { statusLine: false });
    effects.scheduleRender();
  });
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
