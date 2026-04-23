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
  fetchChannelMessages,
  fetchDirectMessages,
  fetchGuildChannels,
  fetchGuilds,
  sendChannelMessage,
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
  saveCachedDirectMessages,
  saveCachedGuildChannels,
  saveCachedGuilds,
} from "./datacache";
import { AppGatewayClient } from "./appgateway";
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
import { clearPrompt } from "./promptstate";
import { focusPrompt, setNotice } from "./state";
import { clearSidebarData, setSidebarGuilds } from "./sidebar";
import {
  appendTimelineMessage,
  clearTimeline,
  finishLoadingOlderMessages,
  markTimelineMessageFailed,
  prependTimelineMessages,
  patchTimelineMessage,
  removeTimelineMessage,
  removeTimelineMessages,
  replaceTimelineMessage,
  setTimelineMessages,
} from "./timeline";

export interface SessionEffects {
  scheduleRender: () => void;
}

interface LoadGuildChannelsOptions {
  openFirstChannel?: boolean;
}

const MESSAGE_PAGE_LIMIT = 50;
const MEMBER_LIST_SUBSCRIBE_TIMEOUT_MS = 7_000;

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
  return state.timeline.scrollOffset >= state.timeline.maxScroll;
}

function maybeResortDirectMessages(state: AppState, channelId: string): void {
  if (state.channelList.guildId !== DIRECT_MESSAGES_GUILD_ID) return;
  bumpDirectMessageChannel(state.channelList, channelId);
}

function handleGatewayMessageCreate(state: AppState, effects: SessionEffects, message: DiscordMessage): void {
  maybeResortDirectMessages(state, message.channelId);
  if (state.timeline.channelId === message.channelId) {
    const pinned = activeTimelineWasPinned(state);
    appendTimelineMessage(state.timeline, message);
    if (pinned) state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  }
  effects.scheduleRender();
}

function handleGatewayMessageUpdate(state: AppState, effects: SessionEffects, patch: DiscordMessagePatch): void {
  maybeResortDirectMessages(state, patch.channelId);
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

function startAppGateway(state: AppState, token: string, effects: SessionEffects): void {
  if (appGateway && appGatewayToken === token) return;
  disconnectAppGateway();
  appGatewayToken = token;
  appGateway = new AppGatewayClient(token, {
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
    onChannelCreate: (channel) => handleGatewayChannelCreateOrUpdate(state, effects, channel),
    onChannelUpdate: (channel) => handleGatewayChannelCreateOrUpdate(state, effects, channel),
    onChannelDelete: (channelId) => handleGatewayChannelDelete(state, effects, channelId),
    onError: (error) => {
      setNotice(state, error.message, "warning");
      effects.scheduleRender();
    },
  });
  appGateway.start();
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
  focusPrompt(state);
}

function loadMemberListPlaceholder(state: AppState, guildId: string | null, channelId: string | null): void {
  if (!state.memberList.open) return;

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

  const cached = getCachedMemberList(state.memberList, guildId, channelId);
  if (cached) {
    setMemberListMembers(state.memberList, guildId, channelId, cached, state.auth.user?.id ?? null);
    return;
  }

  setMemberListLoading(state.memberList, guildId, channelId);
}

export function syncMemberListForGuild(state: AppState, effects: SessionEffects, _guildId?: string | null): void {
  syncMemberListForCurrentChannel(state, effects);
}

export function syncMemberListForCurrentChannel(state: AppState, effects: SessionEffects): void {
  if (!state.memberList.open) return;

  const previousGuildId = state.memberList.guildId;
  const previousChannelId = state.memberList.channelId;
  const token = state.auth.savedToken;
  const activeChannel = state.channelList.activeChannel;
  const guildId = activeChannel?.guildId ?? state.channelList.guildId;
  const channelId = activeChannel?.id ?? null;
  const requestId = ++state.memberList.requestId;

  loadMemberListPlaceholder(state, guildId, channelId);
  effects.scheduleRender();

  if (!token || !guildId || !channelId || guildId === DIRECT_MESSAGES_GUILD_ID) {
    disconnectMemberListGateway();
    return;
  }

  const targetChanged = previousGuildId !== guildId || previousChannelId !== channelId;
  if (targetChanged) {
    disconnectMemberListGateway();
  }

  let settled = false;
  const clearPending = (): void => {
    settled = true;
    clearTimeout(timeoutId);
  };
  const timeoutId = setTimeout(() => {
    if (settled) return;
    if (requestId !== state.memberList.requestId) return;
    if (!state.memberList.open) return;
    if (state.channelList.activeChannelId !== channelId) return;
    if (!state.memberList.loading) return;
    settled = true;
    disconnectMemberListGateway();
    setMemberListMessage(state.memberList, guildId, channelId, "Timed out waiting for member list updates.");
    effects.scheduleRender();
  }, MEMBER_LIST_SUBSCRIBE_TIMEOUT_MS);

  const gateway = getMemberListGateway(token);
  void gateway.subscribe(guildId, channelId, {
    onMembers: (members) => {
      clearPending();
      if (requestId !== state.memberList.requestId) return;
      if (!state.memberList.open) return;
      if (state.channelList.activeChannelId !== channelId) return;
      cacheMemberList(state.memberList, guildId, channelId, members);
      setMemberListMembers(state.memberList, guildId, channelId, members, state.auth.user?.id ?? null);
      effects.scheduleRender();
    },
    onError: (error) => {
      clearPending();
      if (requestId !== state.memberList.requestId) return;
      if (!state.memberList.open) return;
      if (state.channelList.activeChannelId !== channelId) return;
      setMemberListMessage(state.memberList, guildId, channelId, error.message);
      effects.scheduleRender();
    },
  }).catch((error) => {
    clearPending();
    if (requestId !== state.memberList.requestId) return;
    if (!state.memberList.open) return;
    if (state.channelList.activeChannelId !== channelId) return;
    setMemberListMessage(state.memberList, guildId, channelId, error instanceof Error ? error.message : String(error));
    effects.scheduleRender();
  });
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
      syncMemberListForCurrentChannel(state, effects);
      effects.scheduleRender();
      return;
    }

    const channel = findBrowsableChannel(channels, state.channelList.activeChannelId)
      ?? findFirstBrowsableChannel(channels);
    if (!channel) {
      clearTimeline(state.timeline);
      syncMemberListForCurrentChannel(state, effects);
      setNotice(state, isDirectMessages ? "No direct messages available." : `No readable channels in ${guildName}.`, "warning");
      effects.scheduleRender();
      return;
    }

    setActiveChannelEntry(state.channelList, channel);
    state.sidebar.activeGuildId = channel.guildId;
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
  setActiveChannel(state.channelList, channelId);
  state.sidebar.activeGuildId = channel.guildId;
  state.timeline.loading = true;
  state.timeline.loadingOlder = false;
  setNotice(state, "", "muted");
  syncMemberListForCurrentChannel(state, effects);
  effects.scheduleRender();

  try {
    const messages = await fetchChannelMessages(token, channelId, MESSAGE_PAGE_LIMIT);
    if (requestId !== state.timeline.requestId) return;

    setTimelineMessages(state.timeline, channelId, messages, { hasOlder: messages.length >= MESSAGE_PAGE_LIMIT });
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
      maybeResortDirectMessages(state, channelId);
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

export function refreshReadOnlyClient(state: AppState, effects: SessionEffects): void {
  const token = state.auth.savedToken;
  if (!token) {
    setNotice(state, "Login first with /login <token|username>.", "warning");
    effects.scheduleRender();
    return;
  }

  void bootstrapReadOnlyClient(state, token, effects);
}
