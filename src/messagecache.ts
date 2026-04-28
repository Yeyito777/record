/**
 * Per-channel message cache fed by REST and gateway events.
 */

import { applyDiscordMessagePatch, type DiscordMessage, type DiscordMessagePatch } from "./discord";

export interface CachedChannelMessages {
  channelId: string;
  messages: DiscordMessage[];
  hasOlder: boolean;
  updatedAt: number;
  latestFetchedAt: number | null;
}

export type ChannelMessageCache = Record<string, CachedChannelMessages>;

const MAX_CACHED_MESSAGES_PER_CHANNEL = 300;

interface StoreOptions {
  hasOlder?: boolean;
  updatedAt?: number;
  replace?: boolean;
  latestFetched?: boolean;
}

export function cachedChannelMessages(cache: ChannelMessageCache, channelId: string): CachedChannelMessages | null {
  return cache[channelId] ?? null;
}

export function cachedChannelMessagesAreFresh(entry: CachedChannelMessages, nowMs: number, maxAgeMs: number): boolean {
  return entry.latestFetchedAt !== null && nowMs - entry.latestFetchedAt <= maxAgeMs;
}

export function setCachedChannelMessages(
  cache: ChannelMessageCache,
  channelId: string,
  messages: readonly DiscordMessage[],
  options: StoreOptions = {},
): CachedChannelMessages {
  const existing = options.replace ? [] : (cache[channelId]?.messages ?? []);
  const merged = sortAndPruneMessages([...existing, ...messages]);
  const updatedAt = options.updatedAt ?? Date.now();
  const entry: CachedChannelMessages = {
    channelId,
    messages: merged,
    hasOlder: options.hasOlder ?? cache[channelId]?.hasOlder ?? messages.length > 0,
    updatedAt,
    latestFetchedAt: options.latestFetched === false ? (cache[channelId]?.latestFetchedAt ?? null) : updatedAt,
  };
  cache[channelId] = entry;
  return entry;
}

export function upsertCachedChannelMessage(
  cache: ChannelMessageCache,
  message: DiscordMessage,
  options: { updatedAt?: number } = {},
): CachedChannelMessages {
  const entry = cache[message.channelId] ?? {
    channelId: message.channelId,
    messages: [],
    hasOlder: true,
    updatedAt: options.updatedAt ?? Date.now(),
    latestFetchedAt: null,
  };
  const existingIndex = entry.messages.findIndex((existing) => existing.id === message.id);
  const pendingIndex = existingIndex >= 0 ? -1 : findMatchingPendingLocalMessageIndex(entry.messages, message);
  if (existingIndex >= 0) {
    entry.messages[existingIndex] = message;
  } else if (pendingIndex >= 0) {
    entry.messages[pendingIndex] = message;
  } else {
    entry.messages.push(message);
  }
  entry.messages = sortAndPruneMessages(entry.messages);
  entry.updatedAt = options.updatedAt ?? Date.now();
  if (!message.localStatus && entry.latestFetchedAt !== null && entry.latestFetchedAt > 0) {
    entry.latestFetchedAt = entry.updatedAt;
  }
  cache[message.channelId] = entry;
  return entry;
}

export function replaceCachedChannelMessage(
  cache: ChannelMessageCache,
  channelId: string,
  localMessageId: string,
  message: DiscordMessage,
  options: { updatedAt?: number } = {},
): CachedChannelMessages {
  const entry = cache[channelId] ?? {
    channelId,
    messages: [],
    hasOlder: true,
    updatedAt: options.updatedAt ?? Date.now(),
    latestFetchedAt: null,
  };
  const localIndex = entry.messages.findIndex((existing) => existing.id === localMessageId);
  const canonicalIndex = entry.messages.findIndex((existing) => existing.id === message.id);
  if (localIndex >= 0) {
    entry.messages[localIndex] = message;
    if (canonicalIndex >= 0 && canonicalIndex !== localIndex) {
      entry.messages.splice(canonicalIndex, 1);
    }
  } else if (canonicalIndex >= 0) {
    entry.messages[canonicalIndex] = message;
  } else {
    entry.messages.push(message);
  }
  entry.messages = sortAndPruneMessages(entry.messages);
  entry.updatedAt = options.updatedAt ?? Date.now();
  cache[channelId] = entry;
  return entry;
}

export function markCachedChannelMessageFailed(
  cache: ChannelMessageCache,
  channelId: string,
  localMessageId: string,
  error: string,
  options: { updatedAt?: number } = {},
): DiscordMessage | null {
  const entry = cache[channelId];
  if (!entry) return null;
  const index = entry.messages.findIndex((message) => message.id === localMessageId);
  if (index < 0) return null;
  const message = entry.messages[index];
  if (!message) return null;
  const failed = { ...message, localStatus: "failed" as const, localError: error };
  entry.messages[index] = failed;
  entry.updatedAt = options.updatedAt ?? Date.now();
  return failed;
}

export function patchCachedChannelMessage(cache: ChannelMessageCache, patch: DiscordMessagePatch, options: { updatedAt?: number } = {}): boolean {
  const entry = cache[patch.channelId];
  if (!entry) return false;
  const index = entry.messages.findIndex((message) => message.id === patch.id);
  if (index < 0) return false;
  const message = entry.messages[index];
  if (!message) return false;
  entry.messages[index] = applyDiscordMessagePatch(message, patch);
  entry.updatedAt = options.updatedAt ?? Date.now();
  return true;
}

export function removeCachedChannelMessage(cache: ChannelMessageCache, channelId: string, messageId: string, options: { updatedAt?: number } = {}): boolean {
  const entry = cache[channelId];
  if (!entry) return false;
  const before = entry.messages.length;
  entry.messages = entry.messages.filter((message) => message.id !== messageId);
  if (entry.messages.length === before) return false;
  entry.updatedAt = options.updatedAt ?? Date.now();
  return true;
}

export function removeCachedChannelMessages(cache: ChannelMessageCache, channelId: string, messageIds: readonly string[], options: { updatedAt?: number } = {}): boolean {
  const entry = cache[channelId];
  if (!entry) return false;
  const ids = new Set(messageIds);
  const before = entry.messages.length;
  entry.messages = entry.messages.filter((message) => !ids.has(message.id));
  if (entry.messages.length === before) return false;
  entry.updatedAt = options.updatedAt ?? Date.now();
  return true;
}

export function clearCachedChannelMessages(cache: ChannelMessageCache, channelId: string): void {
  delete cache[channelId];
}

function sortAndPruneMessages(messages: DiscordMessage[]): DiscordMessage[] {
  const byId = new Map<string, DiscordMessage>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  const sorted = [...byId.values()].sort(compareMessagesAsc);
  return sorted.slice(Math.max(0, sorted.length - MAX_CACHED_MESSAGES_PER_CHANNEL));
}

function compareMessagesAsc(left: DiscordMessage, right: DiscordMessage): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return compareIdsAsc(left.id, right.id);
}

function compareIdsAsc(left: string, right: string): number {
  const leftBig = snowflakeToBigInt(left);
  const rightBig = snowflakeToBigInt(right);
  if (leftBig !== null && rightBig !== null) {
    if (leftBig === rightBig) return 0;
    return leftBig < rightBig ? -1 : 1;
  }
  return left.localeCompare(right);
}

function snowflakeToBigInt(id: string): bigint | null {
  return /^\d+$/.test(id) ? BigInt(id) : null;
}

function findMatchingPendingLocalMessageIndex(messages: readonly DiscordMessage[], message: DiscordMessage): number {
  if (message.localStatus) return -1;
  return messages.findIndex((existing) => existing.localStatus === "pending"
    && existing.channelId === message.channelId
    && existing.author.id === message.author.id
    && (existing.content === message.content || existing.localSendContent === message.content)
    && attachmentsMatchPendingLocalEcho(existing, message));
}

function attachmentsMatchPendingLocalEcho(pending: DiscordMessage, message: DiscordMessage): boolean {
  if (pending.attachments.length !== message.attachments.length) return false;
  if (pending.attachments.length === 0) return true;

  return pending.attachments.every((attachment, index) => {
    const echoed = message.attachments[index];
    return Boolean(echoed)
      && attachment.filename === echoed.filename
      && attachment.size === echoed.size
      && (attachment.contentType === null || echoed.contentType === null || attachment.contentType === echoed.contentType);
  });
}
