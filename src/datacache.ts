/**
 * Per-account stale-while-revalidate cache for read-only Discord data.
 */

import { mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "fs";
import { writeFile } from "fs/promises";
import { dirname, join } from "path";

import { configDir } from "./config";
import { DIRECT_MESSAGES_GUILD_ID, type DiscordChannel, type DiscordGuild, type DiscordGuildMember, type DiscordRole } from "./discord";
import type { ChannelMessageCache, CachedChannelMessages } from "./messagecache";
import type { NotificationState } from "./notifications";

interface AccountDataCache {
  savedAt: number;
  guilds?: DiscordGuild[];
  directMessages?: DiscordChannel[];
  guildChannels?: Record<string, DiscordChannel[]>;
  memberLists?: Record<string, DiscordGuildMember[]>;
  channelMessages?: ChannelMessageCache;
  guildRoles?: Record<string, DiscordRole[]>;
  memberRoles?: Record<string, Record<string, string[]>>;
  notifications?: NotificationState;
}

interface DataCacheFile {
  version: 1;
  accounts: Record<string, AccountDataCache>;
}

interface GuildOrderCacheFile {
  version: 1;
  accountId: string;
  guildIds: string[];
  savedAt: number;
}

const CACHE_VERSION = 1;
const CACHE_SAVE_DEBOUNCE_MS = 2_500;
const MAX_PERSISTED_MESSAGE_CHANNELS = 30;
const MAX_PERSISTED_MESSAGES_PER_CHANNEL = 75;

let cacheMemo: DataCacheFile | null = null;
let cacheMemoPath: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight = false;
let saveAgain = false;
let cacheDirty = false;
let beforeExitFlushRegistered = false;

function cachePath(): string {
  return join(configDir(), "cache.json");
}

function accountScopedCacheDir(accountId: string): string {
  return join(configDir(), "accounts", encodeURIComponent(accountId));
}

function guildOrderPath(accountId: string): string {
  return join(accountScopedCacheDir(accountId), "guild-order.json");
}

function uniqueStringList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function emptyCache(): DataCacheFile {
  return { version: CACHE_VERSION, accounts: {} };
}

function loadCacheFile(): DataCacheFile {
  const path = cachePath();
  if (cacheMemo && cacheMemoPath === path) return cacheMemo;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DataCacheFile>;
    if (parsed.version !== CACHE_VERSION || typeof parsed.accounts !== "object" || parsed.accounts === null) {
      cacheMemo = emptyCache();
      cacheMemoPath = path;
      return cacheMemo;
    }
    cacheMemo = { version: CACHE_VERSION, accounts: parsed.accounts as Record<string, AccountDataCache> };
    cacheMemoPath = path;
    return cacheMemo;
  } catch {
    cacheMemo = emptyCache();
    cacheMemoPath = path;
    return cacheMemo;
  }
}

function saveCacheFile(cache: DataCacheFile): void {
  cacheMemo = cache;
  cacheMemoPath = cachePath();
  cacheDirty = true;
  registerBeforeExitFlush();
  scheduleCacheWrite();
}

function registerBeforeExitFlush(): void {
  if (beforeExitFlushRegistered) return;
  beforeExitFlushRegistered = true;
  process.once("beforeExit", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void flushCacheFile();
  });
  process.once("exit", () => {
    flushDataCacheSync();
  });
}

function scheduleCacheWrite(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushCacheFile();
  }, CACHE_SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

async function flushCacheFile(): Promise<void> {
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  if (!cacheMemo || !cacheDirty) return;

  const cache = cacheMemo;
  const path = cacheMemoPath ?? cachePath();
  cacheDirty = false;
  saveInFlight = true;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const compact = compactCacheForDisk(cache);
    await writeFile(path, `${JSON.stringify(compact)}\n`, { mode: 0o600 });
  } catch {
    // Cache persistence is opportunistic; UI responsiveness is more important.
    cacheDirty = true;
  } finally {
    saveInFlight = false;
    if (saveAgain || cacheDirty) {
      saveAgain = false;
      scheduleCacheWrite();
    }
  }
}

export function flushDataCacheSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!cacheMemo || !cacheDirty) return;

  const path = cacheMemoPath ?? cachePath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const compact = compactCacheForDisk(cacheMemo);
    writeFileSync(path, `${JSON.stringify(compact)}\n`, { mode: 0o600 });
    cacheDirty = false;
    saveAgain = false;
  } catch {
    cacheDirty = true;
  }
}

function compactCacheForDisk(cache: DataCacheFile): DataCacheFile {
  return {
    version: CACHE_VERSION,
    accounts: Object.fromEntries(Object.entries(cache.accounts).map(([accountId, account]) => [
      accountId,
      compactAccountCache(account),
    ])),
  };
}

function compactAccountCache(account: AccountDataCache): AccountDataCache {
  const channelMessages = Object.fromEntries(
    Object.entries(account.channelMessages ?? {})
      .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, MAX_PERSISTED_MESSAGE_CHANNELS)
      .map(([channelId, entry]) => [channelId, cloneCachedChannelMessages(entry, MAX_PERSISTED_MESSAGES_PER_CHANNEL)]),
  );

  return {
    ...account,
    channelMessages,
  };
}

function accountCache(cache: DataCacheFile, accountId: string): AccountDataCache {
  cache.accounts[accountId] ??= { savedAt: Date.now(), guildChannels: {}, memberLists: {}, channelMessages: {}, guildRoles: {}, memberRoles: {} };
  cache.accounts[accountId].guildChannels ??= {};
  cache.accounts[accountId].memberLists ??= {};
  cache.accounts[accountId].channelMessages ??= {};
  cache.accounts[accountId].guildRoles ??= {};
  cache.accounts[accountId].memberRoles ??= {};
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

function writeJsonFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, contents, { mode: 0o600 });
  renameSync(tempPath, path);
}

export function loadCachedGuildOrder(accountId: string): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(guildOrderPath(accountId), "utf8")) as Partial<GuildOrderCacheFile>;
    if (parsed.version !== CACHE_VERSION || parsed.accountId !== accountId || !Array.isArray(parsed.guildIds)) return null;
    const guildIds = uniqueStringList(parsed.guildIds);
    return guildIds.length > 0 ? guildIds : null;
  } catch {
    return null;
  }
}

export function saveCachedGuildOrder(accountId: string, guildIds: readonly string[]): void {
  const file: GuildOrderCacheFile = {
    version: CACHE_VERSION,
    accountId,
    guildIds: uniqueStringList(guildIds),
    savedAt: Date.now(),
  };
  writeJsonFileAtomic(guildOrderPath(accountId), `${JSON.stringify(file)}\n`);
}

export function watchCachedGuildOrder(accountId: string, onChange: (guildOrder: string[] | null) => void): () => void {
  const dir = accountScopedCacheDir(accountId);
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function emitChange(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange(loadCachedGuildOrder(accountId));
    }, 50);
    timer.unref?.();
  }

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    watcher = watch(dir, { persistent: false }, emitChange);
    watcher.unref?.();
  } catch {
    return () => {};
  }

  return () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    watcher?.close();
  };
}

function normalizeCachedPermissionOverwrites(channel: DiscordChannel): DiscordChannel {
  if (!Array.isArray(channel.permissionOverwrites)) return channel;
  return {
    ...channel,
    permissionOverwrites: channel.permissionOverwrites
      .map((overwrite) => {
        const rawType = (overwrite as { type: unknown }).type;
        return {
          ...overwrite,
          type: typeof rawType === "string" ? Number(rawType) : overwrite.type,
        };
      })
      .filter((overwrite) => Number.isFinite(overwrite.type)),
  };
}

function stripChannelDisplayState(channel: DiscordChannel): DiscordChannel {
  const { hidden: _hidden, ...cachedChannel } = normalizeCachedPermissionOverwrites(channel);
  return { ...cachedChannel };
}

function stripChannelsDisplayState(channels: DiscordChannel[]): DiscordChannel[] {
  return channels.map(stripChannelDisplayState);
}

export function loadCachedDirectMessages(accountId: string): DiscordChannel[] | null {
  const cached = loadCacheFile().accounts[accountId]?.directMessages ?? null;
  return cached ? stripChannelsDisplayState(cached) : null;
}

export function saveCachedDirectMessages(accountId: string, directMessages: DiscordChannel[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.directMessages = stripChannelsDisplayState(directMessages);
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

function cachedChannelsHavePermissionOverwrites(channels: DiscordChannel[]): boolean {
  return channels.every((channel) => channel.guildId === DIRECT_MESSAGES_GUILD_ID || Array.isArray(channel.permissionOverwrites));
}

export function loadCachedGuildChannels(accountId: string, guildId: string): DiscordChannel[] | null {
  const cached = loadCacheFile().accounts[accountId]?.guildChannels?.[guildId] ?? null;
  if (!cached || !cachedChannelsHavePermissionOverwrites(cached)) return null;
  return stripChannelsDisplayState(cached);
}

export function saveCachedGuildChannels(accountId: string, guildId: string, channels: DiscordChannel[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.guildChannels ??= {};
  account.guildChannels[guildId] = stripChannelsDisplayState(channels);
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

function memberListCacheKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

export function loadCachedMemberList(accountId: string, guildId: string, channelId: string): DiscordGuildMember[] | null {
  return loadCacheFile().accounts[accountId]?.memberLists?.[memberListCacheKey(guildId, channelId)] ?? null;
}

export function loadCachedChannelMessages(accountId: string): ChannelMessageCache {
  const cached = loadCacheFile().accounts[accountId]?.channelMessages ?? {};
  return Object.fromEntries(Object.entries(cached).map(([channelId, entry]) => {
    const cloned = cloneCachedChannelMessages(entry);
    return [
      channelId,
      { ...cloned, latestFetchedAt: cloned.latestFetchedAt === null ? null : 0 },
    ];
  }));
}

export function saveCachedChannelMessages(accountId: string, channelId: string, entry: CachedChannelMessages): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.channelMessages ??= {};
  account.channelMessages[channelId] = cloneCachedChannelMessages(entry);
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

function cloneCachedChannelMessages(entry: CachedChannelMessages, maxMessages = Number.POSITIVE_INFINITY): CachedChannelMessages {
  const stored = entry as CachedChannelMessages & { latestFetchedAt?: number | null };
  return {
    channelId: entry.channelId,
    messages: entry.messages.slice(-maxMessages).map((message) => ({ ...message })),
    hasOlder: entry.hasOlder,
    updatedAt: entry.updatedAt,
    latestFetchedAt: stored.latestFetchedAt ?? null,
  };
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

export function loadCachedGuildRoles(accountId: string): Record<string, DiscordRole[]> {
  return { ...(loadCacheFile().accounts[accountId]?.guildRoles ?? {}) };
}

export function saveCachedGuildRoles(accountId: string, guildId: string, roles: DiscordRole[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.guildRoles ??= {};
  account.guildRoles[guildId] = roles;
  account.savedAt = Date.now();
  saveCacheFile(cache);
}

export function loadCachedMemberRoles(accountId: string): Record<string, Record<string, string[]>> {
  const cached = loadCacheFile().accounts[accountId]?.memberRoles ?? {};
  return Object.fromEntries(
    Object.entries(cached).map(([guildId, members]) => [guildId, { ...members }]),
  );
}

export function saveCachedMemberRoles(accountId: string, guildId: string, rolesByUserId: Record<string, string[]>): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.memberRoles ??= {};
  account.memberRoles[guildId] = { ...rolesByUserId };
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
