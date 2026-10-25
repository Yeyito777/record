/**
 * Per-account stale-while-revalidate cache for read-only Discord data.
 */

import { randomUUID } from "crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFile, writeFileSync, type FSWatcher } from "fs";
import { basename, dirname, join } from "path";

import { configDir } from "./config";
import { DIRECT_MESSAGES_GUILD_ID, isThreadChannel, normalizeDiscordMessageForDisplay, type DiscordChannel, type DiscordGuild, type DiscordGuildMember, type DiscordRole } from "./discord";
import type { SidebarChannelLayout, SidebarChannelPlacement, SidebarFolderLayout } from "./sidebar";
import type { ChannelMessageCache, CachedChannelMessages } from "./messagecache";
import type { CachedChannelPins, ChannelPinCache } from "./pincache";
import type { NotificationState } from "./notifications";

interface AccountDataCache {
  savedAt: number;
  /** Channel to retain even when background gateway traffic fills the disk LRU. */
  activeChannelId?: string;
  guilds?: DiscordGuild[];
  directMessages?: DiscordChannel[];
  guildChannels?: Record<string, DiscordChannel[]>;
  memberLists?: Record<string, DiscordGuildMember[]>;
  channelMessages?: ChannelMessageCache;
  channelPins?: ChannelPinCache;
  guildRoles?: Record<string, DiscordRole[]>;
  memberRoles?: Record<string, Record<string, string[]>>;
  notifications?: NotificationState;
}

interface DataCacheFile {
  version: 1;
  accounts: Record<string, AccountDataCache>;
  /** Most recently active Discord account, used for pre-auth startup previews. */
  lastAccountId?: string;
}

interface GuildOrderCacheFile {
  version: 1;
  accountId: string;
  guildIds: string[];
  savedAt: number;
}

interface SidebarFoldersCacheFile {
  version: 1;
  accountId: string;
  layout: SidebarFolderLayout;
  savedAt: number;
}

interface SidebarChannelLayoutCacheFile {
  version: 1;
  accountId: string;
  layout: SidebarChannelLayout;
  savedAt: number;
}

const CACHE_VERSION = 1;
const CACHE_SAVE_DEBOUNCE_MS = 2_500;
/** Steady gateway traffic keeps re-arming the debounce; still save this often. */
const CACHE_SAVE_MAX_WAIT_MS = 15_000;
const MAX_PERSISTED_MESSAGE_CHANNELS = 30;
const MAX_PERSISTED_MESSAGES_PER_CHANNEL = 75;
const MAX_PERSISTED_PIN_CHANNELS = 30;
/**
 * Saved member lists per server (most recently saved first). One list was kept
 * for every channel ever opened; a saved list is only a placeholder until the
 * live list arrives, and a server's channels mostly share one list.
 */
const MAX_PERSISTED_MEMBER_LISTS_PER_GUILD = 3;

let cacheMemo: DataCacheFile | null = null;
let cacheMemoPath: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** When the oldest unsaved change was made, for the debounce's maximum wait. */
let firstUnsavedAt: number | null = null;
let saveInFlight = false;
let saveAgain = false;
/** cache.json itself (account metadata, guilds, DMs, notifications) needs a write. */
let cacheDirty = false;
/** `${accountId}\n${section}` section files that need a write. */
let dirtyShards = new Set<string>();
let beforeExitFlushRegistered = false;
/** Temp files of the async save in flight, so an exit mid-write can remove them. */
const inFlightTempPaths = new Set<string>();
let staleTempsSweptFor: string | null = null;
const STALE_TEMP_MS = 10 * 60_000;

/**
 * The large per-account maps live in their own files next to the account's
 * other cache files (accounts/<id>/cache.<section>.json), so a save rewrites
 * only the sections that changed instead of one 10-15 MB cache.json.
 */
const SHARD_SECTIONS = ["guildChannels", "memberLists", "channelMessages", "channelPins", "guildRoles", "memberRoles"] as const;
type ShardSection = typeof SHARD_SECTIONS[number];
const SHARD_SECTION_SET = new Set<string>(SHARD_SECTIONS);

interface CacheShardFile {
  version: 1;
  accountId: string;
  entries: Record<string, unknown>;
}

function cachePath(): string {
  return join(configDir(), "cache.json");
}

function accountScopedCacheDir(accountId: string): string {
  return join(configDir(), "accounts", encodeURIComponent(accountId));
}

function shardPath(cacheFile: string, accountId: string, section: ShardSection): string {
  return join(dirname(cacheFile), "accounts", encodeURIComponent(accountId), `cache.${section}.json`);
}

function guildOrderPath(accountId: string): string {
  return join(accountScopedCacheDir(accountId), "guild-order.json");
}

function sidebarFoldersPath(accountId: string): string {
  return join(accountScopedCacheDir(accountId), "server-folders.json");
}

function sidebarChannelLayoutPath(accountId: string): string {
  return join(accountScopedCacheDir(accountId), "private-channel-layout.json");
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

/** A temp name no other writer (async save, exit flush, another instance) can share. */
function atomicTempPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `<name>.json.<pid>.<uuid>.tmp`, as written by atomicTempPath. */
const ATOMIC_TEMP_NAME = /^(.+\.json)\.(\d+)\.[0-9a-f-]+\.tmp$/;

/**
 * Remove `cache.json.<pid>.<…>.tmp` files (and the account directories'
 * section/layout temp files) left by writes that a kill or crash interrupted.
 * Another live instance's recent in-flight temp file is left alone.
 */
export function sweepStaleCacheTemps(path = cachePath(), now = Date.now()): number {
  const directory = dirname(path);
  let removed = sweepTempsIn(directory, (base) => base === basename(path), now);
  const accountsDir = join(directory, "accounts");
  let accounts: string[] = [];
  try { accounts = readdirSync(accountsDir); } catch { /* no account files yet */ }
  for (const account of accounts) removed += sweepTempsIn(join(accountsDir, account), () => true, now);
  return removed;
}

function sweepTempsIn(directory: string, ownsBase: (base: string) => boolean, now: number): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  for (const name of names) {
    const match = ATOMIC_TEMP_NAME.exec(name);
    if (!match || !ownsBase(match[1]!)) continue;
    const pid = Number(match[2]);
    const file = join(directory, name);
    try {
      const age = now - statSync(file).mtimeMs;
      if (pid > 0 && processAlive(pid) && age < STALE_TEMP_MS) continue;
      if (inFlightTempPaths.has(file)) continue;
      rmSync(file, { force: true });
      removed++;
    } catch {
      // Raced with its writer finishing; nothing to clean.
    }
  }
  return removed;
}

function loadCacheFile(): DataCacheFile {
  const path = cachePath();
  if (cacheMemo && cacheMemoPath === path) return cacheMemo;
  if (staleTempsSweptFor !== path) {
    staleTempsSweptFor = path;
    sweepStaleCacheTemps(path);
  }

  cacheMemo = emptyCache();
  cacheMemoPath = path;
  cacheDirty = false;
  dirtyShards = new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DataCacheFile>;
    if (parsed.version !== CACHE_VERSION || typeof parsed.accounts !== "object" || parsed.accounts === null) return cacheMemo;
    cacheMemo = {
      version: CACHE_VERSION,
      accounts: parsed.accounts as Record<string, AccountDataCache>,
      ...(typeof parsed.lastAccountId === "string" ? { lastAccountId: parsed.lastAccountId } : {}),
    };
  } catch {
    return cacheMemo;
  }
  for (const [accountId, account] of Object.entries(cacheMemo.accounts)) {
    if (!account || typeof account !== "object") continue;
    for (const section of SHARD_SECTIONS) {
      if (account[section] && typeof account[section] === "object") {
        // Written inline by a build before section files (or a downgrade):
        // newest copy; move it to its section file on the next save.
        dirtyShards.add(shardKey(accountId, section));
        continue;
      }
      const entries = loadShard(path, accountId, section);
      if (entries) (account as unknown as Record<string, unknown>)[section] = entries;
    }
    if (account.memberLists) {
      const before = Object.keys(account.memberLists).length;
      pruneMemberLists(account.memberLists);
      if (Object.keys(account.memberLists).length !== before) dirtyShards.add(shardKey(accountId, "memberLists"));
    }
  }
  return cacheMemo;
}

function loadShard(cacheFile: string, accountId: string, section: ShardSection): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(shardPath(cacheFile, accountId, section), "utf8")) as Partial<CacheShardFile>;
    if (parsed.version !== CACHE_VERSION || parsed.accountId !== accountId) return null;
    return parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries) ? parsed.entries : null;
  } catch {
    return null;
  }
}

function shardKey(accountId: string, section: ShardSection): string {
  return `${accountId}\n${section}`;
}

function saveCacheFile(cache: DataCacheFile, accountId: string, ...sections: ShardSection[]): void {
  cacheMemo = cache;
  cacheMemoPath = cachePath();
  cacheDirty = true;
  for (const section of sections) dirtyShards.add(shardKey(accountId, section));
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

function scheduleCacheWrite(now = Date.now()): void {
  if (saveTimer) clearTimeout(saveTimer);
  firstUnsavedAt ??= now;
  const delay = Math.max(0, Math.min(CACHE_SAVE_DEBOUNCE_MS, firstUnsavedAt + CACHE_SAVE_MAX_WAIT_MS - now));
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushCacheFile();
  }, delay);
  saveTimer.unref?.();
}

/** Write pending changes now, off the UI thread (the debounce timer's job). */
export function flushDataCache(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return flushCacheFile();
}

async function flushCacheFile(): Promise<void> {
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  if (!cacheMemo || !cacheDirty) return;

  const cache = cacheMemo;
  const path = cacheMemoPath ?? cachePath();
  const shards = dirtyShards;
  dirtyShards = new Set();
  cacheDirty = false;
  firstUnsavedAt = null;
  saveInFlight = true;
  try {
    const writes = cacheWrites(cache, path, shards);
    await Promise.all(writes.map(([file, contents]) => writeJsonFileAtomic(file, contents)));
  } catch {
    // Cache persistence is opportunistic; UI responsiveness is more important.
    cacheDirty = true;
    for (const shard of shards) dirtyShards.add(shard);
  } finally {
    saveInFlight = false;
    if (saveAgain || cacheDirty) {
      saveAgain = false;
      scheduleCacheWrite();
    }
  }
}

/** [file, contents] for each dirty section file, then cache.json itself. */
function cacheWrites(cache: DataCacheFile, path: string, shards: Iterable<string>): Array<[string, string]> {
  const writes: Array<[string, string]> = [];
  for (const shard of shards) {
    const [accountId, section] = shard.split("\n") as [string, ShardSection];
    const account = cache.accounts[accountId];
    if (!account) continue;
    writes.push([shardPath(path, accountId, section), serializeShard(accountId, section, account)]);
  }
  writes.push([path, serializeCacheIndex(cache)]);
  return writes;
}

/**
 * Write off the UI thread, then rename into place. The temp file is created
 * synchronously so it always exists while inFlightTempPath names it: an exit
 * that takes over (flushDataCacheSync) can then remove it for certain, and
 * the late async write lands in an unlinked file and is never renamed over
 * the newer snapshot.
 */
async function writeJsonFileAtomic(path: string, contents: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = atomicTempPath(path);
  const fd = openSync(tempPath, "w", 0o600);
  inFlightTempPaths.add(tempPath);
  try {
    try {
      await new Promise<void>((resolve, reject) => writeFile(fd, contents, (error) => (error ? reject(error) : resolve())));
    } finally {
      closeSync(fd);
    }
    // An exit flush took over and already wrote a newer snapshot.
    if (!inFlightTempPaths.has(tempPath)) return;
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  } finally {
    inFlightTempPaths.delete(tempPath);
  }
}

export function flushDataCacheSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // An async save clears cacheDirty when it starts. If Record exits before that
  // write renames its temp file, the newest snapshot would be lost and the temp
  // file orphaned: write the in-memory snapshot synchronously instead.
  const interrupted = [...inFlightTempPaths];
  inFlightTempPaths.clear();
  for (const temp of interrupted) rmSync(temp, { force: true });
  if (!cacheMemo) return;
  if (interrupted.length > 0) {
    // Which of the interrupted section writes had landed is unknown: rewrite all.
    cacheDirty = true;
    for (const accountId of Object.keys(cacheMemo.accounts)) {
      for (const section of SHARD_SECTIONS) dirtyShards.add(shardKey(accountId, section));
    }
  }
  if (!cacheDirty && dirtyShards.size === 0) return;

  const path = cacheMemoPath ?? cachePath();
  try {
    for (const [file, contents] of cacheWrites(cacheMemo, path, dirtyShards)) writeJsonFileAtomicSync(file, contents);
    cacheDirty = false;
    dirtyShards = new Set();
    firstUnsavedAt = null;
    saveAgain = false;
  } catch {
    cacheDirty = true;
  }
}

/**
 * JSON text of each cached entry, keyed by the entry object. Saves replace an
 * entry with a new object (and forget the old text), so an unchanged entry is
 * never re-serialized: a flush after one new message stringifies one channel,
 * not the whole 10-15 MB file.
 */
let serializedEntries = new WeakMap<object, string>();

function forgetSerialized(entry: unknown): void {
  if (entry && typeof entry === "object") serializedEntries.delete(entry);
}

function entryJson<T>(entry: T, toDisk: (entry: T) => unknown = (value) => value): string | undefined {
  if (!entry || typeof entry !== "object") return JSON.stringify(entry);
  let json = serializedEntries.get(entry);
  if (json === undefined) {
    json = JSON.stringify(toDisk(entry));
    serializedEntries.set(entry, json);
  }
  return json;
}

function objectJson<T>(entries: Iterable<[string, T]>, toDisk?: (entry: T) => unknown): string {
  const parts: string[] = [];
  for (const [key, entry] of entries) {
    const json = entryJson(entry, toDisk);
    if (json !== undefined) parts.push(`${JSON.stringify(key)}:${json}`);
  }
  return `{${parts.join(",")}}`;
}

function serializeCacheIndex(cache: DataCacheFile): string {
  const accounts = Object.entries(cache.accounts).map(([accountId, account]) => {
    const fields: string[] = [];
    for (const [field, value] of Object.entries(account)) {
      if (SHARD_SECTION_SET.has(field)) continue;
      const json = entryJson(value);
      if (json !== undefined) fields.push(`${JSON.stringify(field)}:${json}`);
    }
    return `${JSON.stringify(accountId)}:{${fields.join(",")}}`;
  });
  const lastAccount = cache.lastAccountId ? `,"lastAccountId":${JSON.stringify(cache.lastAccountId)}` : "";
  return `{"version":${CACHE_VERSION}${lastAccount},"accounts":{${accounts.join(",")}}}\n`;
}

function serializeShard(accountId: string, section: ShardSection, account: AccountDataCache): string {
  let entries: string;
  if (section === "channelMessages") {
    entries = objectJson(persistedMessageChannels(account), (entry) => cloneCachedChannelMessages(entry, MAX_PERSISTED_MESSAGES_PER_CHANNEL));
  } else if (section === "channelPins") {
    const recentPins = Object.entries(account.channelPins ?? {})
      .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, MAX_PERSISTED_PIN_CHANNELS);
    entries = objectJson(recentPins, cloneCachedChannelPins);
  } else {
    entries = objectJson(Object.entries((account[section] ?? {}) as Record<string, unknown>));
  }
  return `{"version":${CACHE_VERSION},"accountId":${JSON.stringify(accountId)},"entries":${entries}}\n`;
}

function persistedMessageChannels(account: AccountDataCache): Array<[string, CachedChannelMessages]> {
  const recentMessageChannels = Object.entries(account.channelMessages ?? {})
    .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, MAX_PERSISTED_MESSAGE_CHANNELS);
  const activeChannelEntry = account.activeChannelId
    ? Object.entries(account.channelMessages ?? {}).find(([channelId]) => channelId === account.activeChannelId)
    : undefined;
  if (activeChannelEntry && !recentMessageChannels.some(([channelId]) => channelId === activeChannelEntry[0])) {
    // Gateway events update caches for channels that are not open. Keep those
    // useful, but never let them evict the conversation a restart must render.
    recentMessageChannels.splice(Math.max(0, recentMessageChannels.length - 1), 1, activeChannelEntry);
  }
  return recentMessageChannels;
}

function accountCache(cache: DataCacheFile, accountId: string): AccountDataCache {
  cache.lastAccountId = accountId;
  cache.accounts[accountId] ??= { savedAt: Date.now(), guildChannels: {}, memberLists: {}, channelMessages: {}, channelPins: {}, guildRoles: {}, memberRoles: {} };
  cache.accounts[accountId].guildChannels ??= {};
  cache.accounts[accountId].memberLists ??= {};
  cache.accounts[accountId].channelMessages ??= {};
  cache.accounts[accountId].channelPins ??= {};
  cache.accounts[accountId].guildRoles ??= {};
  cache.accounts[accountId].memberRoles ??= {};
  return cache.accounts[accountId];
}

/**
 * Resolve the account whose sidebar was used most recently. Older cache files
 * predate lastAccountId, so fall back to their newest account entry.
 */
export function loadLastCachedAccountId(): string | null {
  const cache = loadCacheFile();
  if (cache.lastAccountId && cache.accounts[cache.lastAccountId]) return cache.lastAccountId;

  let newest: { accountId: string; savedAt: number } | null = null;
  for (const [accountId, account] of Object.entries(cache.accounts)) {
    const savedAt = Number.isFinite(account.savedAt) ? account.savedAt : 0;
    if (!newest || savedAt > newest.savedAt) newest = { accountId, savedAt };
  }
  return newest?.accountId ?? null;
}

/** Record a successfully authenticated account before its REST refresh finishes. */
export function markCachedAccountActive(accountId: string): void {
  if (!accountId) return;
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId);
}

/** Pin the visible conversation in the bounded on-disk message cache. */
export function markCachedChannelActive(accountId: string, channelId: string): void {
  if (!accountId || !channelId) return;
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.activeChannelId = channelId;
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId, "channelMessages");
}

export function loadCachedGuilds(accountId: string): DiscordGuild[] | null {
  return loadCacheFile().accounts[accountId]?.guilds ?? null;
}

export function saveCachedGuilds(accountId: string, guilds: DiscordGuild[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  forgetSerialized(account.guilds);
  forgetSerialized(guilds);
  account.guilds = guilds;
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId);
}

function writeJsonFileAtomicSync(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = atomicTempPath(path);
  try {
    writeFileSync(tempPath, contents, { mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
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
  writeJsonFileAtomicSync(guildOrderPath(accountId), `${JSON.stringify(file)}\n`);
}

function parseSidebarFolderLayout(value: unknown): SidebarFolderLayout | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<SidebarFolderLayout>;
  const folders = Array.isArray(candidate.folders)
    ? candidate.folders.filter((folder): folder is SidebarFolderLayout["folders"][number] => (
      typeof folder === "object" && folder !== null
      && typeof folder.id === "string" && folder.id.length > 0
      && typeof folder.name === "string" && folder.name.length > 0
      && (typeof folder.parentId === "string" || folder.parentId === null || folder.parentId === undefined)
    )).map((folder, index) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId ?? null,
      pinned: Boolean(folder.pinned),
      sortOrder: typeof folder.sortOrder === "number" && Number.isFinite(folder.sortOrder) ? folder.sortOrder : index,
    }))
    : [];
  const guildPlacements: SidebarFolderLayout["guildPlacements"] = {};
  if (typeof candidate.guildPlacements === "object" && candidate.guildPlacements !== null) {
    for (const [guildId, placement] of Object.entries(candidate.guildPlacements)) {
      if (!placement || typeof placement !== "object") continue;
      const p = placement as Partial<SidebarFolderLayout["guildPlacements"][string]>;
      guildPlacements[guildId] = {
        folderId: typeof p.folderId === "string" ? p.folderId : null,
        pinned: Boolean(p.pinned),
        sortOrder: typeof p.sortOrder === "number" && Number.isFinite(p.sortOrder) ? p.sortOrder : 0,
      };
    }
  }
  const folderIds = new Set(folders.map((folder) => folder.id));
  const expandedFolderIds = Array.isArray(candidate.expandedFolderIds)
    ? uniqueStringList(candidate.expandedFolderIds).filter((id) => folderIds.has(id))
    : [];
  return { folders, guildPlacements, expandedFolderIds };
}

export function loadCachedSidebarFolders(accountId: string): SidebarFolderLayout | null {
  try {
    const parsed = JSON.parse(readFileSync(sidebarFoldersPath(accountId), "utf8")) as Partial<SidebarFoldersCacheFile>;
    if (parsed.version !== CACHE_VERSION || parsed.accountId !== accountId) return null;
    return parseSidebarFolderLayout(parsed.layout);
  } catch {
    return null;
  }
}

export function saveCachedSidebarFolders(accountId: string, layout: SidebarFolderLayout): void {
  const file: SidebarFoldersCacheFile = { version: CACHE_VERSION, accountId, layout, savedAt: Date.now() };
  writeJsonFileAtomicSync(sidebarFoldersPath(accountId), `${JSON.stringify(file)}\n`);
}

/**
 * Record which tree-view folders are expanded without touching anything else
 * in the saved layout. The file is rewritten only when it holds exactly the
 * folders the caller has loaded (so a sidebar that has not loaded this
 * account's layout yet never overwrites it), every other field kept as read.
 */
export function saveCachedSidebarFolderExpansion(
  accountId: string,
  loadedFolderIds: readonly string[],
  expandedFolderIds: readonly string[],
): void {
  let parsed: Partial<SidebarFoldersCacheFile>;
  try {
    parsed = JSON.parse(readFileSync(sidebarFoldersPath(accountId), "utf8")) as Partial<SidebarFoldersCacheFile>;
  } catch {
    return;
  }
  if (parsed.version !== CACHE_VERSION || parsed.accountId !== accountId || typeof parsed.layout !== "object" || parsed.layout === null) return;
  const layout = parseSidebarFolderLayout(parsed.layout);
  if (!layout) return;
  const folderIds = new Set(layout.folders.map((folder) => folder.id));
  const loaded = new Set(loadedFolderIds);
  if (loaded.size !== folderIds.size || [...loaded].some((id) => !folderIds.has(id))) return;
  const next = uniqueStringList(expandedFolderIds).filter((id) => folderIds.has(id));
  const current = layout.expandedFolderIds ?? [];
  if (next.length === current.length && next.every((id) => current.includes(id))) return;
  const file = { ...parsed, layout: { ...parsed.layout, expandedFolderIds: next }, savedAt: Date.now() };
  writeJsonFileAtomicSync(sidebarFoldersPath(accountId), `${JSON.stringify(file)}\n`);
}

function parseSidebarChannelLayout(value: unknown): SidebarChannelLayout | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const layout: SidebarChannelLayout = {};
  for (const [guildId, rawPlacements] of Object.entries(value)) {
    if (!guildId || typeof rawPlacements !== "object" || rawPlacements === null || Array.isArray(rawPlacements)) continue;
    const placements: Record<string, SidebarChannelPlacement> = {};
    for (const [channelId, rawPlacement] of Object.entries(rawPlacements)) {
      if (!channelId || typeof rawPlacement !== "object" || rawPlacement === null) continue;
      const placement = rawPlacement as Partial<SidebarChannelPlacement>;
      if (typeof placement.sortOrder !== "number" || !Number.isFinite(placement.sortOrder)) continue;
      placements[channelId] = { pinned: Boolean(placement.pinned), sortOrder: placement.sortOrder };
    }
    layout[guildId] = placements;
  }
  return layout;
}

export function loadCachedSidebarChannelLayout(accountId: string): SidebarChannelLayout | null {
  try {
    const parsed = JSON.parse(readFileSync(sidebarChannelLayoutPath(accountId), "utf8")) as Partial<SidebarChannelLayoutCacheFile>;
    if (parsed.version !== CACHE_VERSION || parsed.accountId !== accountId) return null;
    return parseSidebarChannelLayout(parsed.layout);
  } catch {
    return null;
  }
}

export function saveCachedSidebarChannelLayout(accountId: string, layout: SidebarChannelLayout): void {
  const file: SidebarChannelLayoutCacheFile = { version: CACHE_VERSION, accountId, layout, savedAt: Date.now() };
  writeJsonFileAtomicSync(sidebarChannelLayoutPath(accountId), `${JSON.stringify(file)}\n`);
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
  forgetSerialized(account.directMessages);
  account.directMessages = stripChannelsDisplayState(directMessages);
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId);
}

function cachedChannelsHavePermissionOverwrites(channels: DiscordChannel[]): boolean {
  // Discord thread objects inherit visibility overwrites from their parent and
  // therefore do not carry permission_overwrites themselves.
  return channels.every((channel) => channel.guildId === DIRECT_MESSAGES_GUILD_ID
    || isThreadChannel(channel)
    || Array.isArray(channel.permissionOverwrites));
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
  forgetSerialized(account.guildChannels[guildId]);
  account.guildChannels[guildId] = stripChannelsDisplayState(channels);
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId, "guildChannels");
}

function memberListCacheKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

/** Keep each server's (or only `guildId`'s) newest saved lists; keys are in save order. */
function pruneMemberLists(memberLists: Record<string, unknown>, guildId?: string): void {
  const keysByGuild = new Map<string, string[]>();
  for (const key of Object.keys(memberLists)) {
    const keyGuildId = key.slice(0, key.indexOf(":"));
    if (guildId !== undefined && keyGuildId !== guildId) continue;
    const keys = keysByGuild.get(keyGuildId) ?? [];
    keys.push(key);
    keysByGuild.set(keyGuildId, keys);
  }
  for (const keys of keysByGuild.values()) {
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PERSISTED_MEMBER_LISTS_PER_GUILD))) delete memberLists[key];
  }
}

export function loadCachedMemberList(accountId: string, guildId: string, channelId: string): DiscordGuildMember[] | null {
  return loadCacheFile().accounts[accountId]?.memberLists?.[memberListCacheKey(guildId, channelId)] ?? null;
}

export function loadCachedMemberLists(accountId: string): Record<string, DiscordGuildMember[]> {
  const cached = loadCacheFile().accounts[accountId]?.memberLists ?? {};
  return Object.fromEntries(
    Object.entries(cached).map(([key, members]) => [key, members.map((member) => ({ ...member }))]),
  );
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
  forgetSerialized(account.channelMessages[channelId]);
  account.channelMessages[channelId] = cloneCachedChannelMessages(entry);
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId, "channelMessages");
}

export function loadCachedChannelPins(accountId: string): ChannelPinCache {
  const cached = loadCacheFile().accounts[accountId]?.channelPins ?? {};
  return Object.fromEntries(
    Object.entries(cached).map(([channelId, entry]) => [channelId, cloneCachedChannelPins(entry)]),
  );
}

export function saveCachedChannelPins(accountId: string, channelId: string, entry: CachedChannelPins): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.channelPins ??= {};
  forgetSerialized(account.channelPins[channelId]);
  account.channelPins[channelId] = cloneCachedChannelPins(entry);
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId, "channelPins");
}

function cloneCachedChannelMessages(entry: CachedChannelMessages, maxMessages = Number.POSITIVE_INFINITY): CachedChannelMessages {
  const stored = entry as CachedChannelMessages & { latestFetchedAt?: number | null };
  return {
    channelId: entry.channelId,
    messages: entry.messages.slice(-maxMessages).map((message) => normalizeDiscordMessageForDisplay({ ...message })),
    hasOlder: entry.hasOlder,
    updatedAt: entry.updatedAt,
    latestFetchedAt: stored.latestFetchedAt ?? null,
  };
}

function cloneCachedChannelPins(entry: CachedChannelPins): CachedChannelPins {
  return {
    channelId: entry.channelId,
    messages: entry.messages.map((message) => normalizeDiscordMessageForDisplay({ ...message })),
    updatedAt: entry.updatedAt,
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
  const key = memberListCacheKey(guildId, channelId);
  forgetSerialized(account.memberLists[key]);
  forgetSerialized(members);
  // Re-insert so key order is save order, then drop this server's oldest lists.
  delete account.memberLists[key];
  account.memberLists[key] = members;
  pruneMemberLists(account.memberLists, guildId);
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId, "memberLists");
}

export function loadCachedGuildRoles(accountId: string): Record<string, DiscordRole[]> {
  return { ...(loadCacheFile().accounts[accountId]?.guildRoles ?? {}) };
}

export function saveCachedGuildRoles(accountId: string, guildId: string, roles: DiscordRole[]): void {
  const cache = loadCacheFile();
  const account = accountCache(cache, accountId);
  account.guildRoles ??= {};
  forgetSerialized(account.guildRoles[guildId]);
  forgetSerialized(roles);
  account.guildRoles[guildId] = roles;
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId, "guildRoles");
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
  forgetSerialized(account.memberRoles[guildId]);
  account.memberRoles[guildId] = { ...rolesByUserId };
  account.savedAt = Date.now();
  saveCacheFile(cache, accountId, "memberRoles");
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
  saveCacheFile(cache, accountId);
}
