/**
 * Small pictures beside sidebar rows: Discord server icons (and, where the
 * data is already present, conversation avatars) drawn with Kitty graphics.
 *
 * Icons are 64 px PNGs straight from the CDN, cached in memory for the session
 * and on disk across restarts. Only rows on screen and about a screen above
 * and below are fetched, visible rows first; the terminal keeps the image data
 * (see terminalimage.ts), so scrolling back only places them again.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";

import { configDir } from "./config";
import type { InlineChatImageReady } from "./inlineimage";
import { termWidth, nextWidthClusterEnd } from "./textwidth";

/** Every icon is drawn in a two-cell box, one row tall (about square). */
export const SIDEBAR_ICON_COLUMNS = 2;
export const SIDEBAR_ICON_PIXELS = 64;

const IMAGE_ID_FIRST = 0x73000000;
const IMAGE_ID_LAST = 0x73ffffff;
const MAX_PNG_BYTES = 512 * 1024;
const DEFAULT_CONCURRENCY = 4;
/** A terminal that rejects an icon this often right after receiving it gets the tile instead. */
const MAX_TERMINAL_REJECTIONS = 3;
/** A failed download (offline, CDN error) is tried again after this long. */
const RETRY_FAILED_MS = 60_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface SidebarIconSource {
  /**
   * Stable identity of one picture version, safe as a file name. Discord
   * icon hashes change when the picture does, so a new hash is a new key.
   */
  key: string;
  /** Files sharing this prefix are older versions of the same entity's picture. */
  owner: string;
  url: string;
}

const SAFE_ID_RE = /^[A-Za-z0-9_]{1,128}$/;

function cdnSource(kind: string, id: string, hash: string, path: string): SidebarIconSource | null {
  if (!SAFE_ID_RE.test(id) || !SAFE_ID_RE.test(hash)) return null;
  return {
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
  | { status: "failed"; source: SidebarIconSource; at: number };

export interface SidebarIconStoreOptions {
  fetch?: typeof globalThis.fetch;
  /** Directory for the persistent cache; null disables it. */
  cacheDir?: string | null;
  /** Called (coalesced by the caller's render scheduler) when a wanted icon becomes ready. */
  onUpdate?: () => void;
  concurrency?: number;
}

export function defaultSidebarIconCacheDir(): string {
  return join(configDir(), "image-cache", "sidebar");
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
  private readonly concurrency: number;
  private active = 0;
  /** This frame's wanted sources, nearest first; replaced every frame. */
  private queue: SidebarIconSource[] = [];
  /** Keys drawn in the last frame; only their arrival needs a repaint. */
  private visible = new Set<string>();

  constructor(options: SidebarIconStoreOptions = {}) {
    this.fetchImpl = options.fetch;
    this.cacheDir = options.cacheDir;
    this.onUpdate = options.onUpdate ?? (() => {});
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  }

  configure(options: SidebarIconStoreOptions): void {
    if (options.fetch) this.fetchImpl = options.fetch;
    if (options.cacheDir !== undefined) this.cacheDir = options.cacheDir;
    if (options.onUpdate) this.onUpdate = options.onUpdate;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Ready pixels for a source, or null while loading, failed, or rejected. */
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

  /** Resolves once queued loads have settled (tests). */
  async idle(): Promise<void> {
    while (this.active > 0 || this.queue.some((source) => this.needsLoad(source))) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  private needsLoad(source: SidebarIconSource): boolean {
    const entry = this.entries.get(source.key);
    return !entry || (entry.status === "failed" && Date.now() - entry.at >= RETRY_FAILED_MS);
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const source = this.queue.shift();
      if (!source) return;
      if (!this.needsLoad(source)) continue;
      this.entries.set(source.key, { status: "loading", source });
      this.active += 1;
      void this.load(source).then((bytes) => {
        const imageId = this.nextImageId <= IMAGE_ID_LAST ? this.nextImageId++ : 0;
        if (!bytes || imageId === 0) {
          this.entries.set(source.key, { status: "failed", source, at: Date.now() });
          return;
        }
        const { width, height } = pngSize(bytes);
        this.byImageId.set(imageId, source.key);
        this.entries.set(source.key, {
          status: "ready",
          source,
          rejections: 0,
          image: {
            phase: "ready",
            attachmentId: source.key,
            filename: `${source.key}.png`,
            sourceUrl: source.url,
            requestId: 0,
            imageId,
            pngBase64: bytes.toString("base64"),
            pixelWidth: width,
            pixelHeight: height,
          },
        });
        if (this.enabled && this.visible.has(source.key)) this.onUpdate();
      }).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
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

  private async load(source: SidebarIconSource): Promise<Buffer | null> {
    const dir = this.dir();
    const path = dir ? join(dir, `${source.key}.png`) : null;
    if (path) {
      try {
        const bytes = await readFile(path);
        if (bytes.length <= MAX_PNG_BYTES && isPng(bytes)) return bytes;
        await unlink(path).catch(() => {});
      } catch {
        // Not cached yet.
      }
    }

    try {
      const response = await (this.fetchImpl ?? globalThis.fetch)(source.url, { headers: { Accept: "image/png" } });
      if (!response.ok) return null;
      if (Number(response.headers.get("content-length") ?? 0) > MAX_PNG_BYTES) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_PNG_BYTES || !isPng(bytes)) return null;
      if (dir && path) void this.store(dir, path, source, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  private async store(dir: string, path: string, source: SidebarIconSource, bytes: Buffer): Promise<void> {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, path);
      // Drop the entity's superseded pictures so the cache stays one file per row.
      for (const name of await readdir(dir)) {
        if (name.startsWith(source.owner) && name !== `${source.key}.png` && name.endsWith(".png")) {
          await unlink(join(dir, name)).catch(() => {});
        }
      }
    } catch {
      // The disk cache is an optimization only.
    }
  }
}

export const sidebarIcons = new SidebarIconStore();

/** Owner of the sidebar's terminal-resident images and placements (terminalimage.ts). */
export const sidebarIconTerminalOwner = {};

/** The sidebar's resident icons are small; keep a few hundred for scrolling back. */
export const SIDEBAR_ICON_MAX_IDLE_IMAGES = 256;
export const SIDEBAR_ICON_MAX_IDLE_BYTES = 16 * 1024 * 1024;
