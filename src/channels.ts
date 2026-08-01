/**
 * Guild channel data and active chat tracking.
 */

import { DIRECT_MESSAGES_GUILD_ID, isGuildVoiceChannel, isMessageChannel, sortDirectMessageChannels, sortGuildChannels, type DiscordChannel } from "./discord";

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
  return isMessageChannel(channel);
}

export function isTimelineChannel(channel: DiscordChannel): boolean {
  return isMessageChannel(channel) || isGuildVoiceChannel(channel);
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

export function findTimelineChannel(channels: DiscordChannel[], channelId: string | null): DiscordChannel | null {
  if (!channelId) return null;
  return channels.find((channel) => channel.id === channelId && isTimelineChannel(channel)) ?? null;
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

export function upsertChannel(channelList: ChannelListState, channel: DiscordChannel): void {
  const index = channelList.channels.findIndex((existing) => existing.id === channel.id);
  if (index >= 0) {
    const existing = channelList.channels[index]!;
    channelList.channels[index] = {
      ...existing,
      ...channel,
      muted: channel.muted ?? existing.muted,
      ...(existing.thread && channel.thread
        ? { thread: { ...existing.thread, ...channel.thread, joined: channel.thread.joined ?? existing.thread.joined } }
        : {}),
    };
  } else {
    channelList.channels.push(channel);
  }

  channelList.channels = channel.guildId === DIRECT_MESSAGES_GUILD_ID
    ? sortDirectMessageChannels(channelList.channels)
    : sortGuildChannels(channelList.channels);

  if (channelList.activeChannelId === channel.id) {
    channelList.activeChannel = findBrowsableChannel(channelList.channels, channel.id);
  }
}

export function removeChannel(channelList: ChannelListState, channelId: string): boolean {
  const before = channelList.channels.length;
  channelList.channels = channelList.channels.filter((channel) => channel.id !== channelId);
  const removed = channelList.channels.length !== before;
  if (channelList.activeChannelId === channelId) {
    channelList.activeChannelId = null;
    channelList.activeChannel = null;
  }
  return removed;
}

export function bumpDirectMessageChannel(channelList: ChannelListState, channelId: string, messageId?: string): boolean {
  if (channelList.guildId !== DIRECT_MESSAGES_GUILD_ID) return false;
  const channel = channelList.channels.find((entry) => entry.id === channelId);
  if (!channel) return false;
  channel.lastMessageId = messageId ?? channel.lastMessageId ?? null;
  channel.position = -1;
  channelList.channels = sortDirectMessageChannels(channelList.channels);
  if (channelList.activeChannelId === channelId) {
    channelList.activeChannel = findBrowsableChannel(channelList.channels, channelId);
  }
  return true;
}
