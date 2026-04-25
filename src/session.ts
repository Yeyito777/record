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
  fetchDirectMessages,
  fetchGuildChannels,
  fetchGuilds,
  sendChannelMessage,
  sortDirectMessageChannels,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordGuildMember,
  type DiscordMessage,
  type DiscordMessagePatch,
} from "./discord";
import {
  loadCachedDirectMessages,
  loadCachedGuildChannels,
  loadCachedGuilds,
  loadCachedMemberList,
  loadCachedNotifications,
  saveCachedDirectMessages,
  saveCachedGuildChannels,
  saveCachedGuilds,
  saveCachedMemberList,
  saveCachedNotifications,
} from "./datacache";
import { AppGatewayClient } from "./appgateway";
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
  recordChannelNotification,
  replaceNotifications,
  shouldNotifyForMessage as messageMatchesNotificationRules,
} from "./notifications";
import { clearPrompt } from "./promptstate";
import { focusPrompt, setNotice } from "./state";
import { clearSidebarData, setSidebarGuilds } from "./sidebar";
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

export interface SessionEffects {
  scheduleRender: () => void;
}

interface LoadGuildChannelsOptions {
  openFirstChannel?: boolean;
}

const MESSAGE_PAGE_LIMIT = 50;
const MEMBER_LIST_SUBSCRIBE_TIMEOUT_MS = 7_000;
const MEMBER_LIST_SUBSCRIBE_RETRIES = 2;

let memberListGateway: MemberListGatewayClient | null = null;
let memberListGatewayToken: string | null = null;
let appGateway: AppGatewayClient | null = null;
let appGatewayToken: string | null = null;

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
  const fromMemberList = state.memberList.channelId === channelId
    ? state.memberList.members.find((member) => member.id === userId)?.displayName
    : null;
  if (fromMemberList) return fromMemberList;

  const activeChannel = state.channelList.channels.find((channel) => channel.id === channelId);
  const fromRecipients = activeChannel?.recipients?.find((recipient) => recipient.id === userId)?.displayName;
  if (fromRecipients) return fromRecipients;

  const fromTimeline = state.timeline.channelId === channelId
    ? state.timeline.messages.find((message) => message.author.id === userId)?.author.displayName
    : null;
  if (fromTimeline) return fromTimeline;

  return fallback;
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

  return messageMatchesNotificationRules(message, {
    viewerId: state.auth.user?.id ?? null,
    roleIdsByGuildId: state.roleIdsByGuildId,
    channels: state.channelList.channels,
  });
}

function handleGatewayMessageCreate(state: AppState, effects: SessionEffects, message: DiscordMessage): void {
  clearTypingUser(state.typing, message.channelId, message.author.id);
  const shouldNotify = shouldNotifyForIncomingMessage(state, message);
  if (shouldNotify) {
    recordChannelNotification(state.notifications, message.channelId, guildIdForChannel(state, message));
    persistNotifications(state);
  }
  maybeResortDirectMessages(state, message.channelId, message.id);
  if (state.timeline.channelId === message.channelId) {
    const pinned = activeTimelineWasPinned(state);
    appendTimelineMessage(state.timeline, message);
    if (pinned) {
      state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      if (!shouldNotify) {
        markChannelRead(state, state.auth.savedToken, message.channelId, message.id);
      }
    }
  }
  effects.scheduleRender();
}

function handleGatewayMessageUpdate(state: AppState, effects: SessionEffects, patch: DiscordMessagePatch): void {
  maybeResortDirectMessages(state, patch.channelId, patch.id);
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
    if (state.memberList.open && state.channelList.activeChannelId === channel.id) {
      syncMemberListForCurrentChannel(state, effects);
    }
  }

  effects.scheduleRender();
}

function handleGatewayChannelDelete(state: AppState, effects: SessionEffects, channelId: string): void {
  const wasActive = state.channelList.activeChannelId === channelId;
  const removed = removeChannel(state.channelList, channelId);
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

function persistNotifications(state: AppState): void {
  const accountId = currentAccountId(state);
  if (accountId) {
    saveCachedNotifications(accountId, state.notifications);
  }
}

function applyCachedNotifications(state: AppState): void {
  const accountId = currentAccountId(state);
  if (!accountId) return;
  const cachedNotifications = loadCachedNotifications(accountId);
  if (!cachedNotifications) return;

  replaceNotifications(
    state.notifications,
    Object.entries(cachedNotifications.byChannelId)
      .filter(([, count]) => count > 0)
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

function startAppGateway(state: AppState, token: string, effects: SessionEffects): void {
  if (appGateway && appGatewayToken === token) return;
  disconnectAppGateway();
  appGatewayToken = token;
  appGateway = new AppGatewayClient(token, {
    onCurrentUserRoleIds: (roleIdsByGuildId) => {
      state.roleIdsByGuildId = roleIdsByGuildId;
    },
    onCurrentUserGuildRoles: (guildId, roleIds) => {
      state.roleIdsByGuildId[guildId] = roleIds;
    },
    onInitialNotifications: (notifications) => {
      replaceNotifications(
        state.notifications,
        notifications.filter((notification) => notification.channelId !== state.timeline.channelId),
      );
      persistNotifications(state);
      const latestMessageId = state.timeline.channelId ? latestTimelineMessageId(state, state.timeline.channelId) : null;
      if (state.timeline.channelId && latestMessageId && isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) {
        markChannelRead(state, state.auth.savedToken, state.timeline.channelId, latestMessageId);
      }
      effects.scheduleRender();
    },
    onMessageCreate: (message) => handleGatewayMessageCreate(state, effects, message),
    onMessageUpdate: (message) => handleGatewayMessageUpdate(state, effects, message),
    onMessageDelete: (channelId, messageId) => {
      removeTimelineMessage(state.timeline, messageId, channelId);
      effects.scheduleRender();
    },
    onMessageDeleteBulk: (channelId, messageIds) => {
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
  state.sidebar.requestId += 1;
  state.channelList.requestId += 1;
  state.timeline.requestId += 1;
  clearSidebarData(state.sidebar);
  clearMemberListData(state.memberList);
  clearChannelList(state.channelList);
  clearTimeline(state.timeline);
  replaceNotifications(state.notifications, []);
  state.roleIdsByGuildId = {};
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
        cacheMemberList(state.memberList, guildId, channelId, members);
        const accountId = currentAccountId(state);
        if (accountId) saveCachedMemberList(accountId, guildId, channelId, members);
        if (state.memberList.open) {
          setMemberListMembers(state.memberList, guildId, channelId, members, state.auth.user?.id ?? null);
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
    applyCachedNotifications(state);
    const cachedDirectMessages = loadCachedDirectMessages(accountId) ?? [];
    const cachedGuilds = loadCachedGuilds(accountId) ?? [];
    if (cachedDirectMessages.length > 0 || cachedGuilds.length > 0) {
      setSidebarGuilds(state.sidebar, cachedSidebarGuilds(cachedDirectMessages, cachedGuilds));
      state.sidebar.expandedGuildId = previousExpandedGuildId;
      state.sidebar.activeGuildId = previousActiveGuildId;
      if (previousChannelListGuildId && previousChannels.length > 0) {
        setChannelList(state.channelList, previousChannelListGuildId, previousChannels);
        setActiveChannelEntry(state.channelList, previousActiveChannel ?? findBrowsableChannel(previousChannels, previousActiveChannelId));
      }
    }
  }
  effects.scheduleRender();

  try {
    const [directMessages, guilds] = await Promise.all([
      fetchDirectMessages(token),
      fetchGuilds(token),
    ]);
    if (requestId !== state.sidebar.requestId) return;

    const liveExpandedGuildId = state.sidebar.expandedGuildId;
    const liveActiveGuildId = state.sidebar.activeGuildId;
    const liveChannelListGuildId = state.channelList.guildId;
    const liveChannels = state.channelList.channels;
    const liveActiveChannel = state.channelList.activeChannel;
    const liveActiveChannelId = state.channelList.activeChannelId;

    state.sidebar.loading = false;
    setSidebarGuilds(state.sidebar, cachedSidebarGuilds(directMessages, guilds));
    state.sidebar.expandedGuildId = liveExpandedGuildId;
    state.sidebar.activeGuildId = liveActiveGuildId;
    if (liveChannelListGuildId && liveChannels.length > 0) {
      setChannelList(state.channelList, liveChannelListGuildId, liveChannels);
      setActiveChannelEntry(state.channelList, liveActiveChannel ?? findBrowsableChannel(liveChannels, liveActiveChannelId));
    }
    if (accountId) {
      saveCachedDirectMessages(accountId, directMessages);
      saveCachedGuilds(accountId, guilds);
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
    const cachedChannels = isDirectMessages
      ? loadCachedDirectMessages(accountId)
      : loadCachedGuildChannels(accountId, guildId);
    if (cachedChannels && cachedChannels.length > 0) {
      showedCachedChannels = true;
      setChannelList(state.channelList, guildId, cachedChannels);
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
  state.sidebar.activeGuildId = channel.guildId;
  subscribeAppGatewayToActiveChannel(state);
  state.timeline.loading = true;
  state.timeline.loadingOlder = false;
  setNotice(state, "", "muted");
  syncMemberListForCurrentChannel(state, effects);
  effects.scheduleRender();

  try {
    const messages = await fetchChannelMessages(token, channelId, MESSAGE_PAGE_LIMIT);
    if (requestId !== state.timeline.requestId) return;

    setTimelineMessages(state.timeline, channelId, messages, { hasOlder: messages.length >= MESSAGE_PAGE_LIMIT });
    const latestMessage = messages.at(-1);
    if (latestMessage) {
      markChannelRead(state, token, channelId, latestMessage.id);
    }
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId) return;
    state.timeline.loading = false;
    clearTimeline(state.timeline);
    setNotice(state, error instanceof Error ? error.message : String(error), "error");
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

    const deduped = olderMessages.filter((message) => !existingIds.has(message.id));
    prependTimelineMessages(state.timeline, deduped, width, { hasOlder: olderMessages.length >= MESSAGE_PAGE_LIMIT });
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId || state.timeline.channelId !== channelId) return;
    finishLoadingOlderMessages(state.timeline, state.timeline.hasOlder);
    setNotice(state, error instanceof Error ? error.message : String(error), "error");
    effects.scheduleRender();
  }
}

export function sendCurrentChannelMessage(state: AppState, token: string | null, content: string, effects: SessionEffects): void {
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
  clearPrompt(state);
  setNotice(state, "", "muted");

  if (state.timeline.channelId === channelId) {
    appendTimelineMessage(state.timeline, {
      id: localMessageId,
      channelId,
      type: 0,
      content,
      mentionEveryone: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      timestamp: Date.now(),
      editedTimestamp: null,
      author: {
        id: viewer?.id ?? "me",
        username: viewer?.username ?? "me",
        displayName: viewer?.globalName ?? viewer?.username ?? "Me",
        bot: viewer?.bot ?? false,
      },
      reply: null,
      call: null,
      attachments: [],
      embedsCount: 0,
      localStatus: "pending",
    });
    state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  }
  effects.scheduleRender();

  void (async () => {
    try {
      const message = await sendChannelMessage(token, channelId, content);
      if (state.timeline.channelId === channelId) {
        replaceTimelineMessage(state.timeline, localMessageId, message);
        state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      }
      maybeResortDirectMessages(state, channelId, message.id);
      effects.scheduleRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = markTimelineMessageFailed(state.timeline, localMessageId, message);
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
