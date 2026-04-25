/**
 * Per-account stale-while-revalidate cache for read-only Discord data.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { configDir } from "./config";
import type { DiscordChannel, DiscordGuild, DiscordGuildMember } from "./discord";
import type { NotificationState } from "./notifications";

interface AccountDataCache {
  savedAt: number;
  guilds?: DiscordGuild[];
  directMessages?: DiscordChannel[];
  guildChannels?: Record<string, DiscordChannel[]>;
  memberLists?: Record<string, DiscordGuildMember[]>;
  notifications?: NotificationState;
}

interface DataCacheFile {
  version: 1;
  accounts: Record<string, AccountDataCache>;
}

const CACHE_VERSION = 1;

function cachePath(): string {
  return join(configDir(), "cache.json");
}

function emptyCache(): DataCacheFile {
  return { version: CACHE_VERSION, accounts: {} };
}

function loadCacheFile(): DataCacheFile {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<DataCacheFile>;
    if (parsed.version !== CACHE_VERSION || typeof parsed.accounts !== "object" || parsed.accounts === null) {
      return emptyCache();
    }
    return { version: CACHE_VERSION, accounts: parsed.accounts as Record<string, AccountDataCache> };
  } catch {
    return emptyCache();
  }
}

function saveCacheFile(cache: DataCacheFile): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

function accountCache(cache: DataCacheFile, accountId: string): AccountDataCache {
  cache.accounts[accountId] ??= { savedAt: Date.now(), guildChannels: {}, memberLists: {} };
  cache.accounts[accountId].guildChannels ??= {};
  cache.accounts[accountId].memberLists ??= {};
  return cache.accounts[accountId];
}

export function loadCachedGuilds(accountId: string): DiscordGuild[] | null {
  return loadCacheFile().accounts[accountId]?.guilds ?? null;
}

export function saveCachedGuilds(accountId: string, guilds: DiscordGuild[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.guilds = guilds;
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

export function loadCachedDirectMessages(accountId: string): DiscordChannel[] | null {
  return loadCacheFile().accounts[accountId]?.directMessages ?? null;
}

export function saveCachedDirectMessages(accountId: string, directMessages: DiscordChannel[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.directMessages = directMessages;
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

export function loadCachedGuildChannels(accountId: string, guildId: string): DiscordChannel[] | null {
  return loadCacheFile().accounts[accountId]?.guildChannels?.[guildId] ?? null;
}

export function saveCachedGuildChannels(accountId: string, guildId: string, channels: DiscordChannel[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.guildChannels ??= {};
  account.guildChannels[guildId] = channels;
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

function memberListCacheKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

export function loadCachedMemberList(accountId: string, guildId: string, channelId: string): DiscordGuildMember[] | null {
  return loadCacheFile().accounts[accountId]?.memberLists?.[memberListCacheKey(guildId, channelId)] ?? null;
}

export function saveCachedMemberList(
  accountId: string,
  guildId: string,
  channelId: string,
  members: DiscordGuildMember[],
): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.memberLists ??= {};
  account.memberLists[memberListCacheKey(guildId, channelId)] = members;
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

export function loadCachedNotifications(accountId: string): NotificationState | null {
  const cached = loadCacheFile().accounts[accountId]?.notifications;
  if (!cached) return null;
  return {
    byChannelId: { ...(cached.byChannelId ?? {}) },
    channelGuildIds: { ...(cached.channelGuildIds ?? {}) },
  };
}

export function saveCachedNotifications(accountId: string, notifications: NotificationState): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.notifications = {
    byChannelId: { ...notifications.byChannelId },
    channelGuildIds: { ...notifications.channelGuildIds },
  };
  account.savedAt = Date.now();
  saveCacheFile(cache);
}
