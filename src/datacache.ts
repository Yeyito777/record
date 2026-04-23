/**
 * Per-account stale-while-revalidate cache for read-only Discord data.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { configDir } from "./config";
import type { DiscordChannel, DiscordGuild } from "./discord";

interface AccountDataCache {
  savedAt: number;
  guilds?: DiscordGuild[];
  directMessages?: DiscordChannel[];
  guildChannels?: Record<string, DiscordChannel[]>;
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
  cache.accounts[accountId] ??= { savedAt: Date.now(), guildChannels: {} };
  cache.accounts[accountId].guildChannels ??= {};
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
