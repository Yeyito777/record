/**
 * Per-channel pinned-message snapshots used for stale-while-revalidate views.
 */

import { applyDiscordMessagePatch, type DiscordMessage, type DiscordMessagePatch } from "./discord";

export interface CachedChannelPins {
  channelId: string;
  messages: DiscordMessage[];
  updatedAt: number;
}

export type ChannelPinCache = Record<string, CachedChannelPins>;

export function cachedChannelPins(cache: ChannelPinCache, channelId: string): CachedChannelPins | null {
  return cache[channelId] ?? null;
}

export function setCachedChannelPins(
  cache: ChannelPinCache,
  channelId: string,
  messages: readonly DiscordMessage[],
  updatedAt = Date.now(),
): CachedChannelPins {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const entry: CachedChannelPins = {
    channelId,
    messages: [...byId.values()].sort(compareMessagesAsc),
    updatedAt,
  };
  cache[channelId] = entry;
  return entry;
}

export function patchCachedChannelPin(cache: ChannelPinCache, patch: DiscordMessagePatch, updatedAt = Date.now()): boolean {
  const entry = cache[patch.channelId];
  if (!entry) return false;
  const index = entry.messages.findIndex((message) => message.id === patch.id);
  if (index < 0) return false;
  const message = entry.messages[index];
  if (!message) return false;
  entry.messages[index] = applyDiscordMessagePatch(message, patch);
  entry.updatedAt = updatedAt;
  return true;
}

export function removeCachedChannelPin(cache: ChannelPinCache, channelId: string, messageId: string, updatedAt = Date.now()): boolean {
  const entry = cache[channelId];
  if (!entry) return false;
  const before = entry.messages.length;
  entry.messages = entry.messages.filter((message) => message.id !== messageId);
  if (entry.messages.length === before) return false;
  entry.updatedAt = updatedAt;
  return true;
}

export function removeCachedChannelPins(cache: ChannelPinCache, channelId: string, messageIds: readonly string[], updatedAt = Date.now()): boolean {
  const entry = cache[channelId];
  if (!entry) return false;
  const ids = new Set(messageIds);
  const before = entry.messages.length;
  entry.messages = entry.messages.filter((message) => !ids.has(message.id));
  if (entry.messages.length === before) return false;
  entry.updatedAt = updatedAt;
  return true;
}

export function clearCachedChannelPins(cache: ChannelPinCache, channelId: string): void {
  delete cache[channelId];
}

function compareMessagesAsc(left: DiscordMessage, right: DiscordMessage): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}
