/**
 * Active guild channel data.
 */

import type { DiscordChannel } from "./discord";

export interface ChannelListState {
  guildId: string | null;
  channels: DiscordChannel[];
  activeChannelId: string | null;
  loading: boolean;
  requestId: number;
}

export function createChannelListState(): ChannelListState {
  return {
    guildId: null,
    channels: [],
    activeChannelId: null,
    loading: false,
    requestId: 0,
  };
}

export function isBrowsableChannel(channel: DiscordChannel): boolean {
  return channel.type !== 4;
}

export function clearChannelList(channelList: ChannelListState): void {
  channelList.guildId = null;
  channelList.channels = [];
  channelList.activeChannelId = null;
  channelList.loading = false;
}

export function setChannelList(channelList: ChannelListState, guildId: string, channels: DiscordChannel[]): void {
  channelList.guildId = guildId;
  channelList.channels = channels;

  const activeStillPresent = channelList.activeChannelId
    && channels.some((channel) => channel.id === channelList.activeChannelId && isBrowsableChannel(channel));

  if (!activeStillPresent) {
    channelList.activeChannelId = channels.find(isBrowsableChannel)?.id ?? null;
  }
}

export function getActiveChannel(channelList: ChannelListState): DiscordChannel | null {
  return channelList.channels.find((channel) => channel.id === channelList.activeChannelId) ?? null;
}

export function setActiveChannel(channelList: ChannelListState, channelId: string | null): void {
  if (!channelId) {
    channelList.activeChannelId = null;
    return;
  }

  const exists = channelList.channels.some((channel) => channel.id === channelId && isBrowsableChannel(channel));
  if (exists) {
    channelList.activeChannelId = channelId;
  }
}
