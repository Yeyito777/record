/**
 * Small pictures beside sidebar rows, drawn with Kitty graphics: Discord
 * server icons and DM avatars, WhatsApp chat pictures and Instagram avatars.
 *
 * Pictures are 64 px PNGs, cached in memory for the session and on disk across
 * restarts, including "has no picture" answers. Only rows on screen (plus a
 * little lookahead) are fetched, visible rows first, with a small per-platform
 * limit on requests in flight and a back-off after errors. The terminal keeps
 * the image data (see terminalimage.ts), so scrolling back only re-places it.
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

import { configDir } from "./config";
import { convertImageBytesToPng, type InlineChatImageReady } from "./inlineimage";
import { termWidth, nextWidthClusterEnd } from "./textwidth";

/** Every icon is drawn in a two-cell box, one row tall (about square). */
export const SIDEBAR_ICON_COLUMNS = 2;
export const SIDEBAR_ICON_PIXELS = 64;

const IMAGE_ID_FIRST = 0x73000000;
const IMAGE_ID_LAST = 0x73ffffff;
const MAX_DOWNLOAD_BYTES = 512 * 1024;
/** A terminal that rejects an icon this often right after receiving it gets the tile instead. */
const MAX_TERMINAL_REJECTIONS = 3;
/** After an error a platform pauses this long, doubling up to the maximum. */
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** "bundled": provider logos shipped in assets/sidebar/, read from disk, never fetched. */
export type SidebarIconPlatform = "discord" | "whatsapp" | "instagram" | "bundled";

export interface SidebarIconSource {
  platform: SidebarIconPlatform;
  /**
   * Stable identity of one picture, safe as a file name. Discord hashes
   * change with the picture, so a new hash is a new key; WhatsApp and
   * Instagram keys name the chat and expire by age instead.
   */
  key: string;
  /** Files sharing this prefix are older versions of the same entity's picture. */
  owner: string;
  /** Download URL; absent when the platform must be asked first (WhatsApp). */
  url?: string;
  /** What the platform resolver is asked about (a WhatsApp jid). */
  ref?: string;
  /** Local PNG for bundled icons. */
  file?: string;
}

interface PlatformPolicy {
  /** Requests in flight at once. */
  concurrency: number;
  /** How long a downloaded picture is trusted before asking again. */
  maxAgeMs: number;
  /** How long "no picture" is trusted before asking again. */
  noneMaxAgeMs: number;
  /** Rows beyond the screen, each way, worth fetching ahead (null: a screen). */
  lookaheadRows: number | null;
}

const POLICIES: Record<SidebarIconPlatform, PlatformPolicy> = {
  bundled: { concurrency: 3, maxAgeMs: Infinity, noneMaxAgeMs: Infinity, lookaheadRows: null },
  // Public, content-addressed CDN files: a hash never changes its picture.
  discord: { concurrency: 4, maxAgeMs: Infinity, noneMaxAgeMs: 7 * DAY_MS, lookaheadRows: null },
  // Queries through the logged-in session: one at a time, few rows ahead.
  whatsapp: { concurrency: 1, maxAgeMs: 7 * DAY_MS, noneMaxAgeMs: 3 * DAY_MS, lookaheadRows: 3 },
  instagram: { concurrency: 2, maxAgeMs: 7 * DAY_MS, noneMaxAgeMs: 7 * DAY_MS, lookaheadRows: 3 },
};

export function sidebarIconLookaheadRows(platform: SidebarIconPlatform, screenRows: number): number {
  return Math.max(1, POLICIES[platform].lookaheadRows ?? screenRows);
}

const SAFE_ID_RE = /^[A-Za-z0-9_]{1,128}$/;

function cdnSource(kind: string, id: string, hash: string, path: string): SidebarIconSource | null {
  if (!SAFE_ID_RE.test(id) || !SAFE_ID_RE.test(hash)) return null;
  return {
    platform: "discord",
    key: `${kind}-${id}-${hash}`,
    owner: `${kind}-${id}-`,
    // `.png` also returns a still frame for animated (`a_`) icons.
    url: `https://cdn.discordapp.com/${path}/${id}/${hash}.png?size=${SIDEBAR_ICON_PIXELS}`,
  };
}

export function discordGuildIconSource(guild: { id: string; icon?: string | null }): SidebarIconSource | null {
  return guild.icon ? cdnSource("guild", guild.id, guild.icon, "icons") : null;
}

export function discordUserAvatarSource(user: { id: string; avatar?: string | null }): SidebarIconSource | null {
  return user.avatar ? cdnSource("user", user.id, user.avatar, "avatars") : null;
}

export function discordGroupIconSource(channel: { id: string; icon?: string | null }): SidebarIconSource | null {
  return channel.icon ? cdnSource("group", channel.id, channel.icon, "channel-icons") : null;
}

/** File-name-safe stand-in for provider ids such as jids. */
function idDigest(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

const BUNDLED_DIR = fileURLToPath(new URL("../assets/sidebar/", import.meta.url));

/** Provider logo tile for a fixed root row (Direct Messages, WhatsApp, Instagram). */
export function bundledSidebarIconSource(name: "direct-messages" | "whatsapp" | "instagram"): SidebarIconSource {
  const key = `bundled-${name}`;
  return { platform: "bundled", key, owner: `${key}-`, file: join(BUNDLED_DIR, `${name}.png`) };
}

/** A WhatsApp chat's picture, asked for through the session when shown. */
export function whatsappChatPictureSource(jid: string): SidebarIconSource {
  const key = `wa-${idDigest(jid)}`;
  return { platform: "whatsapp", key, owner: `${key}-`, ref: jid };
}

/** An Instagram user's avatar from the URL the inbox payload already carries. */
export function instagramUserPictureSource(userId: string, url: string | null | undefined): SidebarIconSource | null {
  if (!url || !SAFE_ID_RE.test(userId)) return null;
  const key = `ig-${userId}`;
  return { platform: "instagram", key, owner: `${key}-`, url };
}

/**
 * Two terminal cells of initials for a picture-less row: the first letters of
 * the first two words (or of camel-case humps), else the first two letters.
 */
export function sidebarIconInitials(name: string): string {
  const words = name.match(/[\p{L}\p{N}][\p{Ll}\p{N}'’]*|[\p{Lu}]+(?![\p{Ll}])/gu) ?? [];
  const letters: string[] = [];
  for (const word of words) {
    const first = word.slice(0, nextWidthClusterEnd(word, 0));
    if (termWidth(first) === 1) letters.push(first.toLocaleUpperCase());
    if (letters.length === 2) break;
  }
  if (letters.length === 1) {
    const word = words[0]!;
    const firstEnd = nextWidthClusterEnd(word, 0);
    const second = word.slice(firstEnd, nextWidthClusterEnd(word, firstEnd));
    if (second && termWidth(second) === 1) letters.push(second.toLocaleLowerCase());
  }
  if (letters.length === 0) {
    // Emoji-only or symbol names: show the first wide or narrow cluster.
    const first = name.trim().slice(0, nextWidthClusterEnd(name.trim(), 0));
    const width = termWidth(first);
    if (width === 2) return first;
    if (width === 1) return `${first} `;
    return "  ";
  }
  return letters.join("").padEnd(2, " ");
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 24 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && bytes.toString("latin1", 12, 16) === "IHDR";
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

type IconEntry =
  | { status: "loading"; source: SidebarIconSource }
  | { status: "ready"; source: SidebarIconSource; image: InlineChatImageReady; rejections: number }
  /** Known to have no picture; never asked again this session. */
  | { status: "none"; source: SidebarIconSource }
  | { status: "failed"; source: SidebarIconSource; retryAt: number };

type LoadResult = { kind: "ready"; png: Buffer } | { kind: "none" } | { kind: "error" };

export type SidebarIconResolver = (source: SidebarIconSource) => Promise<string | null>;

export interface SidebarIconStoreOptions {
  fetch?: typeof globalThis.fetch;
  /** Directory for the persistent cache; null disables it. */
  cacheDir?: string | null;
  /** Called (coalesced by the caller's render scheduler) when a wanted icon becomes ready. */
  onUpdate?: () => void;
  /** Turns a source without a URL into one (null: no picture; throws: try later). */
  resolvers?: Partial<Record<SidebarIconPlatform, SidebarIconResolver>>;
  /** Re-encodes JPEG/WebP downloads as a small PNG. */
  convert?: (bytes: Buffer) => Promise<Buffer>;
  /** Per-platform requests in flight (tests). */
  concurrency?: Partial<Record<SidebarIconPlatform, number>>;
  now?: () => number;
}

export function defaultSidebarIconCacheDir(): string {
  return join(configDir(), "image-cache", "sidebar");
}

function defaultConvert(bytes: Buffer): Promise<Buffer> {
  return convertImageBytesToPng(bytes, { maxPixelWidth: SIDEBAR_ICON_PIXELS, maxPixelHeight: SIDEBAR_ICON_PIXELS });
}

interface PlatformState {
  active: number;
  backoffMs: number;
  pausedUntil: number;
}

export class SidebarIconStore {
  private readonly entries = new Map<string, IconEntry>();
  private readonly byImageId = new Map<number, string>();
  private nextImageId = IMAGE_ID_FIRST;
  private enabled = false;
  /** Unset uses the global fetch at call time (demo mode replaces it). */
  private fetchImpl: typeof globalThis.fetch | undefined;
  private cacheDir: string | null | undefined;
  private onUpdate: () => void;
  private resolvers: Partial<Record<SidebarIconPlatform, SidebarIconResolver>>;
  private convert: (bytes: Buffer) => Promise<Buffer>;
  private readonly concurrency: Partial<Record<SidebarIconPlatform, number>>;
  private readonly now: () => number;
  private readonly platforms: Record<SidebarIconPlatform, PlatformState> = {
    discord: { active: 0, backoffMs: 0, pausedUntil: 0 },
    whatsapp: { active: 0, backoffMs: 0, pausedUntil: 0 },
    instagram: { active: 0, backoffMs: 0, pausedUntil: 0 },
    bundled: { active: 0, backoffMs: 0, pausedUntil: 0 },
  };
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** This frame's wanted sources, nearest first; replaced every frame. */
  private queue: SidebarIconSource[] = [];
  /** Keys drawn in the last frame; only their arrival needs a repaint. */
  private visible = new Set<string>();

  constructor(options: SidebarIconStoreOptions = {}) {
    this.fetchImpl = options.fetch;
    this.cacheDir = options.cacheDir;
    this.onUpdate = options.onUpdate ?? (() => {});
    this.resolvers = { ...options.resolvers };
    this.convert = options.convert ?? defaultConvert;
    this.concurrency = { ...options.concurrency };
    this.now = options.now ?? Date.now;
  }

  configure(options: SidebarIconStoreOptions): void {
    if (options.fetch) this.fetchImpl = options.fetch;
    if (options.cacheDir !== undefined) this.cacheDir = options.cacheDir;
    if (options.onUpdate) this.onUpdate = options.onUpdate;
    if (options.resolvers) this.resolvers = { ...this.resolvers, ...options.resolvers };
    if (options.convert) this.convert = options.convert;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Ready pixels for a source, or null while loading, failed, absent, or rejected. */
  get(source: SidebarIconSource): InlineChatImageReady | null {
    const entry = this.entries.get(source.key);
    return entry?.status === "ready" && entry.rejections < MAX_TERMINAL_REJECTIONS ? entry.image : null;
  }

  /**
   * Record what one frame draws and what lies just beyond it. `visible` are
   * fetched first, then `nearby` in the given (nearest-first) order. Sources
   * that scrolled away before their turn are never fetched.
   */
  want(visible: readonly SidebarIconSource[], nearby: readonly SidebarIconSource[] = []): void {
    if (!this.enabled) return;
    this.visible = new Set(visible.map((source) => source.key));
    const seen = new Set<string>();
    this.queue = [...visible, ...nearby].filter((source) => {
      if (seen.has(source.key) || !this.needsLoad(source)) return false;
      seen.add(source.key);
      return true;
    });
    this.pump();
  }

  /**
   * Note a Kitty "image not found" reply for one of our images. Returns true
   * when the id is ours. After a few rejections the icon falls back to its tile.
   */
  noteTerminalRejection(imageId: number): boolean {
    const key = this.byImageId.get(imageId);
    if (key === undefined) return false;
    const entry = this.entries.get(key);
    if (entry?.status === "ready") entry.rejections += 1;
    return true;
  }

  ownsImageId(imageId: number): boolean {
    return imageId >= IMAGE_ID_FIRST && imageId <= IMAGE_ID_LAST;
  }

  /** Resolves once queued loads that can start now have settled (tests). */
  async idle(): Promise<void> {
    while (this.platformsActive() > 0 || this.queue.some((source) => this.canStart(source))) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  private platformsActive(): number {
    return Object.values(this.platforms).reduce((sum, platform) => sum + platform.active, 0);
  }

  private needsLoad(source: SidebarIconSource): boolean {
    if (!source.url && !source.file && !this.resolvers[source.platform]) return false;
    const entry = this.entries.get(source.key);
    return !entry || (entry.status === "failed" && this.now() >= entry.retryAt);
  }

  private canStart(source: SidebarIconSource): boolean {
    const platform = this.platforms[source.platform];
    return this.needsLoad(source)
      && platform.active < (this.concurrency[source.platform] ?? POLICIES[source.platform].concurrency)
      && this.now() >= platform.pausedUntil;
  }

  private pump(): void {
    const waiting: SidebarIconSource[] = [];
    for (const source of this.queue) {
      if (!this.needsLoad(source)) continue;
      if (!this.canStart(source)) {
        waiting.push(source);
        continue;
      }
      this.start(source);
    }
    this.queue = waiting;
    this.scheduleResume();
  }

  /** Wake when a paused platform with queued work may ask again. */
  private scheduleResume(): void {
    if (this.resumeTimer) return;
    const now = this.now();
    const resumeAt = Math.min(...this.queue
      .map((source) => this.platforms[source.platform].pausedUntil)
      .filter((until) => until > now));
    if (!Number.isFinite(resumeAt)) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.pump();
    }, resumeAt - now);
    this.resumeTimer.unref?.();
  }

  private start(source: SidebarIconSource): void {
    const platform = this.platforms[source.platform];
    this.entries.set(source.key, { status: "loading", source });
    platform.active += 1;
    void this.load(source).then((result) => {
      if (result.kind === "error") {
        platform.backoffMs = Math.min(BACKOFF_MAX_MS, platform.backoffMs ? platform.backoffMs * 2 : BACKOFF_FIRST_MS);
        platform.pausedUntil = this.now() + platform.backoffMs;
        this.entries.set(source.key, { status: "failed", source, retryAt: platform.pausedUntil });
        return;
      }
      platform.backoffMs = 0;
      const imageId = result.kind === "ready" && this.nextImageId <= IMAGE_ID_LAST ? this.nextImageId++ : 0;
      if (result.kind === "none" || imageId === 0) {
        this.entries.set(source.key, { status: "none", source });
        return;
      }
      const { width, height } = pngSize(result.png);
      this.byImageId.set(imageId, source.key);
      this.entries.set(source.key, {
        status: "ready",
        source,
        rejections: 0,
        image: {
          phase: "ready",
          attachmentId: source.key,
          filename: `${source.key}.png`,
          sourceUrl: source.url ?? source.key,
          requestId: 0,
          imageId,
          pngBase64: result.png.toString("base64"),
          pixelWidth: width,
          pixelHeight: height,
        },
      });
      if (this.enabled && this.visible.has(source.key)) this.onUpdate();
    }).finally(() => {
      platform.active -= 1;
      this.pump();
    });
  }

  private dir(): string | null {
    if (this.cacheDir === undefined) {
      try {
        this.cacheDir = defaultSidebarIconCacheDir();
      } catch {
        this.cacheDir = null;
      }
    }
    return this.cacheDir;
  }

  private async load(source: SidebarIconSource): Promise<LoadResult> {
    if (source.file) {
      const bytes = await readFile(source.file).catch(() => null);
      return bytes && isPng(bytes) ? { kind: "ready", png: bytes } : { kind: "none" };
    }
    const policy = POLICIES[source.platform];
    const dir = this.dir();
    const pngPath = dir ? join(dir, `${source.key}.png`) : null;
    const nonePath = dir ? join(dir, `${source.key}.none`) : null;
    let stale: Buffer | null = null;
    if (pngPath && nonePath) {
      const cached = await readCached(pngPath);
      if (cached && isPng(cached.bytes) && cached.bytes.length <= MAX_DOWNLOAD_BYTES) {
        if (this.now() - cached.mtimeMs < policy.maxAgeMs) return { kind: "ready", png: cached.bytes };
        stale = cached.bytes;
      }
      const none = await stat(nonePath).catch(() => null);
      if (!stale && none && this.now() - none.mtimeMs < policy.noneMaxAgeMs) return { kind: "none" };
    }

    const result = await this.download(source);
    if (result.kind === "error") {
      // Keep showing an expired picture rather than nothing.
      return stale ? { kind: "ready", png: stale } : result;
    }
    if (dir && pngPath && nonePath) void this.store(dir, source, pngPath, nonePath, result);
    return result;
  }

  private async download(source: SidebarIconSource): Promise<LoadResult> {
    let url = source.url ?? null;
    if (!url) {
      try {
        url = await this.resolvers[source.platform]!(source);
      } catch {
        return { kind: "error" };
      }
      if (!url) return { kind: "none" };
    }

    let bytes: Buffer;
    try {
      const response = await (this.fetchImpl ?? globalThis.fetch)(url, { headers: { Accept: "image/*" } });
      if (response.status === 404 || response.status === 410) return { kind: "none" };
      if (!response.ok) return { kind: "error" };
      if (Number(response.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) return { kind: "none" };
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return { kind: "error" };
    }
    if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) return { kind: "none" };
    if (isPng(bytes)) return { kind: "ready", png: bytes };
    try {
      const png = await this.convert(bytes);
      return isPng(png) && png.length <= MAX_DOWNLOAD_BYTES ? { kind: "ready", png } : { kind: "none" };
    } catch {
      // Not an image we can show; asking again would give the same bytes.
      return { kind: "none" };
    }
  }

  private async store(dir: string, source: SidebarIconSource, pngPath: string, nonePath: string, result: LoadResult): Promise<void> {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (result.kind === "ready") {
        const temp = `${pngPath}.${process.pid}.tmp`;
        await writeFile(temp, result.png, { mode: 0o600 });
        await rename(temp, pngPath);
        await unlink(nonePath).catch(() => {});
      } else {
        await writeFile(nonePath, "", { mode: 0o600 });
        await unlink(pngPath).catch(() => {});
      }
      // Drop the entity's superseded pictures so the cache stays one file per row.
      for (const name of await readdir(dir)) {
        if (name.startsWith(source.owner) && !name.startsWith(`${source.key}.`)) {
          await unlink(join(dir, name)).catch(() => {});
        }
      }
    } catch {
      // The disk cache is an optimization only.
    }
  }
}

async function readCached(path: string): Promise<{ bytes: Buffer; mtimeMs: number } | null> {
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    return { bytes, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

export const sidebarIcons = new SidebarIconStore();

/** Owner of the sidebar's terminal-resident images and placements (terminalimage.ts). */
export const sidebarIconTerminalOwner = {};

/** The sidebar's resident icons are small; keep a few hundred for scrolling back. */
export const SIDEBAR_ICON_MAX_IDLE_IMAGES = 256;
export const SIDEBAR_ICON_MAX_IDLE_BYTES = 16 * 1024 * 1024;
