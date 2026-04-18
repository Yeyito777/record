/**
 * Guild channel data and active chat tracking.
 */

import type { DiscordChannel } from "./discord";

export interface ChannelListState {
  guildId: string | null;
  channels: DiscordChannel[];
  activeChannelId: string | null;
  activeChannel: DiscordChannel | null;
  loading: boolean;
  requestId: number;
}

export function createChannelListState(): ChannelListState {
  return {
    guildId: null,
    channels: [],
    activeChannelId: null,
    activeChannel: null,
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
  channelList.activeChannel = null;
  channelList.loading = false;
}

export function setChannelList(channelList: ChannelListState, guildId: string, channels: DiscordChannel[]): void {
  channelList.guildId = guildId;
  channelList.channels = channels;

  if (channelList.activeChannelId) {
    const activeChannel = channels.find((channel) => channel.id === channelList.activeChannelId && isBrowsableChannel(channel)) ?? null;
    if (activeChannel) {
      channelList.activeChannel = activeChannel;
    }
  }
}

export function findBrowsableChannel(channels: DiscordChannel[], channelId: string | null): DiscordChannel | null {
  if (!channelId) return null;
  return channels.find((channel) => channel.id === channelId && isBrowsableChannel(channel)) ?? null;
}

export function findFirstBrowsableChannel(channels: DiscordChannel[]): DiscordChannel | null {
  return channels.find(isBrowsableChannel) ?? null;
}

export function getActiveChannel(channelList: ChannelListState): DiscordChannel | null {
  return channelList.activeChannel;
}

export function setActiveChannel(channelList: ChannelListState, channelId: string | null): void {
  const channel = findBrowsableChannel(channelList.channels, channelId);
  if (!channel) return;
  channelList.activeChannelId = channel.id;
  channelList.activeChannel = channel;
}

export function setActiveChannelEntry(channelList: ChannelListState, channel: DiscordChannel | null): void {
  channelList.activeChannelId = channel?.id ?? null;
  channelList.activeChannel = channel;
}
