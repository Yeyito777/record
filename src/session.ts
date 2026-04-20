/**
 * Read-only Discord session bootstrap and data loading.
 */

import {
  clearChannelList,
  findBrowsableChannel,
  findFirstBrowsableChannel,
  setActiveChannel,
  setActiveChannelEntry,
  setChannelList,
} from "./channels";
import {
  DIRECT_MESSAGES_GUILD_ID,
  DIRECT_MESSAGES_GUILD_NAME,
  fetchChannelMessages,
  fetchDirectMessages,
  fetchGuildChannels,
  fetchGuilds,
  type DiscordGuildMember,
} from "./discord";
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
import { focusPrompt, setNotice } from "./state";
import { clearSidebarData, setSidebarGuilds } from "./sidebar";
import {
  clearTimeline,
  finishLoadingOlderMessages,
  prependTimelineMessages,
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

function getMemberListGateway(token: string): MemberListGatewayClient {
  if (!memberListGateway || memberListGatewayToken !== token) {
    disconnectMemberListGateway();
    memberListGateway = new MemberListGatewayClient(token);
    memberListGatewayToken = token;
  }

  return memberListGateway;
}

export function clearReadOnlyClient(state: AppState): void {
  disconnectMemberListGateway();
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
  state.sidebar.loading = true;
  state.sidebar.loadingGuildId = null;
  disconnectMemberListGateway();
  clearMemberListData(state.memberList);
  clearChannelList(state.channelList);
  clearTimeline(state.timeline);
  setNotice(state, "", "muted");
  effects.scheduleRender();

  try {
    const [directMessages, guilds] = await Promise.all([
      fetchDirectMessages(token),
      fetchGuilds(token),
    ]);
    if (requestId !== state.sidebar.requestId) return;

    state.sidebar.loading = false;
    setSidebarGuilds(
      state.sidebar,
      directMessages.length > 0
        ? [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }, ...guilds]
        : guilds,
    );

    if (state.sidebar.guilds.length === 0) {
      clearChannelList(state.channelList);
      clearTimeline(state.timeline);
      setNotice(state, "No servers or direct messages available for this account.", "warning");
      effects.scheduleRender();
      return;
    }

    clearChannelList(state.channelList);
    clearTimeline(state.timeline);
    setNotice(state, "", "muted");
    effects.scheduleRender();
    return;
  } catch (error) {
    if (requestId !== state.sidebar.requestId) return;
    state.sidebar.loading = false;
    clearReadOnlyClient(state);
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
  state.sidebar.expandedGuildId = guildId;
  state.sidebar.loadingGuildId = guildId;
  state.channelList.loading = true;

  const isDirectMessages = guildId === DIRECT_MESSAGES_GUILD_ID;
  const guildName = isDirectMessages
    ? DIRECT_MESSAGES_GUILD_NAME
    : state.sidebar.guilds.find((guild) => guild.id === guildId)?.name ?? "server";
  if (options.openFirstChannel) {
    clearTimeline(state.timeline);
    setNotice(state, "", "muted");
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

    if (options.openFirstChannel) {
      clearChannelList(state.channelList);
      clearTimeline(state.timeline);
      setNotice(state, error instanceof Error ? error.message : String(error), "error");
    }

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

export function refreshReadOnlyClient(state: AppState, effects: SessionEffects): void {
  const token = state.auth.savedToken;
  if (!token) {
    setNotice(state, "Login first with /login <token>.", "warning");
    effects.scheduleRender();
    return;
  }

  void bootstrapReadOnlyClient(state, token, effects);
}
