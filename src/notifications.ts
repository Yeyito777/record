/**
 * Ephemeral unread notification counts for gateway messages.
 */

import { DIRECT_MESSAGES_GUILD_ID, isDirectMessageChannel, type DiscordChannel, type DiscordMessage } from "./discord";

export interface NotificationState {
  byChannelId: Record<string, number>;
  channelGuildIds: Record<string, string>;
}

export interface NotificationContext {
  viewerId: string | null;
  roleIdsByGuildId?: Readonly<Record<string, readonly string[]>>;
  channels?: readonly DiscordChannel[];
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

export function shouldNotifyForMessage(message: DiscordMessage, context: NotificationContext): boolean {
  if (message.author.id === context.viewerId) return false;
  if (message.mentionEveryone) return false;
  if (message.call) return true;

  const channel = context.channels?.find((entry) => entry.id === message.channelId) ?? null;
  if (channel && isDirectMessageChannel(channel)) return true;
  if (!channel && (!message.guildId || message.guildId === DIRECT_MESSAGES_GUILD_ID)) return true;

  if (context.viewerId && message.mentionUserIds.includes(context.viewerId)) return true;
  if (context.viewerId && message.content.includes(`<@${context.viewerId}>`)) return true;
  if (context.viewerId && message.content.includes(`<@!${context.viewerId}>`)) return true;
  if (message.reply?.authorId === context.viewerId) return true;

  const guildId = message.guildId ?? channel?.guildId ?? null;
  if (guildId && message.mentionRoleIds.length > 0) {
    const viewerRoles = new Set(context.roleIdsByGuildId?.[guildId] ?? []);
    if (message.mentionRoleIds.some((roleId) => viewerRoles.has(roleId))) return true;
  }

  return false;
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

export function clearGuildNotifications(notifications: NotificationState, guildId: string): void {
  for (const [channelId, channelGuildId] of Object.entries(notifications.channelGuildIds)) {
    if (channelGuildId === guildId) {
      delete notifications.byChannelId[channelId];
      delete notifications.channelGuildIds[channelId];
    }
  }
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
