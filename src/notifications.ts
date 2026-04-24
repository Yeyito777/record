/**
 * Ephemeral unread notification counts for gateway messages.
 */

import type { DiscordChannel } from "./discord";

export interface NotificationState {
  byChannelId: Record<string, number>;
  channelGuildIds: Record<string, string>;
}

export function createNotificationState(): NotificationState {
  return { byChannelId: {}, channelGuildIds: {} };
}

export function recordChannelNotification(
  notifications: NotificationState,
  channelId: string,
  guildId: string | null | undefined,
): void {
  notifications.byChannelId[channelId] = (notifications.byChannelId[channelId] ?? 0) + 1;
  if (guildId) {
    notifications.channelGuildIds[channelId] = guildId;
  }
}

export interface InitialNotificationEntry {
  channelId: string;
  guildId: string | null;
  count: number;
}

export function setChannelNotificationCount(
  notifications: NotificationState,
  channelId: string,
  guildId: string | null | undefined,
  count: number,
): void {
  if (count > 0) {
    notifications.byChannelId[channelId] = count;
    if (guildId) {
      notifications.channelGuildIds[channelId] = guildId;
    }
  } else {
    delete notifications.byChannelId[channelId];
  }
}

export function replaceNotifications(notifications: NotificationState, entries: InitialNotificationEntry[]): void {
  notifications.byChannelId = {};
  notifications.channelGuildIds = {};
  for (const entry of entries) {
    setChannelNotificationCount(notifications, entry.channelId, entry.guildId, entry.count);
  }
}

export function clearChannelNotifications(notifications: NotificationState, channelId: string): void {
  delete notifications.byChannelId[channelId];
}

export function channelNotificationCounts(notifications: NotificationState): ReadonlyMap<string, number> {
  return new Map(
    Object.entries(notifications.byChannelId)
      .filter(([, count]) => count > 0),
  );
}

export function guildNotificationCounts(
  notifications: NotificationState,
  visibleChannels: DiscordChannel[],
): ReadonlyMap<string, number> {
  const channelGuildIds = { ...notifications.channelGuildIds };
  for (const channel of visibleChannels) {
    channelGuildIds[channel.id] = channel.guildId;
  }

  const guildCounts = new Map<string, number>();
  for (const [channelId, count] of Object.entries(notifications.byChannelId)) {
    if (count <= 0) continue;
    const guildId = channelGuildIds[channelId];
    if (!guildId) continue;
    guildCounts.set(guildId, (guildCounts.get(guildId) ?? 0) + count);
  }
  return guildCounts;
}
