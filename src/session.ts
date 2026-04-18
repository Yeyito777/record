/**
 * Read-only Discord session bootstrap and data loading.
 */

import { clearChannelList, getActiveChannel, setActiveChannel, setChannelList } from "./channels";
import { fetchChannelMessages, fetchGuildChannels, fetchGuilds } from "./discord";
import type { AppState } from "./state";
import { focusPrompt, setNotice } from "./state";
import { clearSidebarData, setSidebarGuilds } from "./sidebar";
import { clearTimeline, setTimelineMessages } from "./timeline";

export interface SessionEffects {
  scheduleRender: () => void;
}

export function clearReadOnlyClient(state: AppState): void {
  clearSidebarData(state.sidebar);
  clearChannelList(state.channelList);
  clearTimeline(state.timeline);
  focusPrompt(state);
}

export async function bootstrapReadOnlyClient(
  state: AppState,
  token: string,
  effects: SessionEffects,
): Promise<void> {
  const requestId = ++state.sidebar.requestId;
  state.sidebar.loading = true;
  clearChannelList(state.channelList);
  clearTimeline(state.timeline);
  setNotice(state, "Loading servers…", "muted");
  effects.scheduleRender();

  try {
    const guilds = await fetchGuilds(token);
    if (requestId !== state.sidebar.requestId) return;

    state.sidebar.loading = false;
    setSidebarGuilds(state.sidebar, guilds);

    const guildId = state.sidebar.activeGuildId;
    if (!guildId) {
      clearChannelList(state.channelList);
      clearTimeline(state.timeline);
      setNotice(state, "No servers available for this account.", "warning");
      effects.scheduleRender();
      return;
    }

    effects.scheduleRender();
    await loadGuildChannels(state, token, guildId, effects);
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
): Promise<void> {
  const requestId = ++state.channelList.requestId;
  state.sidebar.activeGuildId = guildId;
  state.sidebar.expandedGuildId = guildId;
  state.channelList.loading = true;
  clearTimeline(state.timeline);

  const guildName = state.sidebar.guilds.find((guild) => guild.id === guildId)?.name ?? "server";
  setNotice(state, `Loading channels for ${guildName}…`, "muted");
  effects.scheduleRender();

  try {
    const channels = await fetchGuildChannels(token, guildId);
    if (requestId !== state.channelList.requestId) return;

    state.channelList.loading = false;
    setChannelList(state.channelList, guildId, channels);

    const channel = getActiveChannel(state.channelList);
    if (!channel) {
      clearTimeline(state.timeline);
      setNotice(state, `No readable channels in ${guildName}.`, "warning");
      effects.scheduleRender();
      return;
    }

    effects.scheduleRender();
    await loadChannelMessages(state, token, channel.id, effects);
  } catch (error) {
    if (requestId !== state.channelList.requestId) return;
    state.channelList.loading = false;
    clearChannelList(state.channelList);
    clearTimeline(state.timeline);
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
  const requestId = ++state.timeline.requestId;
  setActiveChannel(state.channelList, channelId);
  state.timeline.loading = true;
  setNotice(state, "", "muted");
  effects.scheduleRender();

  try {
    const messages = await fetchChannelMessages(token, channelId);
    if (requestId !== state.timeline.requestId) return;

    setTimelineMessages(state.timeline, channelId, messages);
    effects.scheduleRender();
  } catch (error) {
    if (requestId !== state.timeline.requestId) return;
    state.timeline.loading = false;
    clearTimeline(state.timeline);
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
