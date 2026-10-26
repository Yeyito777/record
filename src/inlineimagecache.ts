/**
 * Converted previews: a session-only LRU in memory, and one on disk that
 * outlives the session, independent of the active timeline.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DiscordMessageAttachment } from "./discord";
import { pngDimensions, type InlineImagePrepareOptions, type PreparedInlineImage } from "./inlineimage";

export function inlineImageCacheKey(
  attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">,
  options: InlineImagePrepareOptions,
): string {
  // Keep the exact source URL: replacing an attachment must not reuse old pixels.
  // Geometry is part of the key so a terminal cell-size change gets a fresh preview.
  return JSON.stringify([
    attachment.cacheKey ?? attachment.id,
    attachment.url,
    options.maxPixelWidth,
    options.maxPixelHeight,
    options.preserveSourceResolution ?? false,
  ]);
}

export class InlineImageCache {
  private readonly entries = new Map<string, PreparedInlineImage>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 64,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): PreparedInlineImage | undefined {
    const image = this.entries.get(key);
    if (image) {
      this.entries.delete(key);
      this.entries.set(key, image);
    }
    return image;
  }

  set(key: string, image: PreparedInlineImage): void {
    this.delete(key);
    // Conservatively charge two bytes per JS string character, including keys.
    const bytes = this.sizeOf(key, image);
    if (this.maxEntries <= 0 || bytes > this.maxBytes) return;
    this.entries.set(key, image);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!);
    }
  }

  private sizeOf(key: string, image: PreparedInlineImage): number {
    return (key.length + image.pngBase64.length) * 2;
  }

  private delete(key: string): void {
    const image = this.entries.get(key);
    if (!image) return;
    this.bytes -= this.sizeOf(key, image);
    this.entries.delete(key);
  }
}

/** Bump when previews are encoded differently, so old files are not reused. */
const PREVIEW_FORMAT = 2; // 2: palette previews of photos
export const PREVIEW_DISK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Prepared previews on disk (`image-cache/previews`): returning to a chat, or
 * starting Record again, shows its images without downloading or converting
 * them. Keyed by the attachment and the URL's path (Discord re-signs its
 * query) at one cell size; least recently used files go past the budget.
 */
export class InlinePreviewDiskCache {
  /** Bytes on disk as of the last scan plus what was written since; null until scanned. */
  private bytes: number | null = null;
  /** Previews written or read this session: known to load again from disk. */
  private readonly stored = new Set<string>();

  constructor(private readonly dir: string, private readonly maxBytes = PREVIEW_DISK_CACHE_MAX_BYTES) {}

  async get(
    attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">,
    options: InlineImagePrepareOptions,
  ): Promise<PreparedInlineImage | null> {
    return this.read(attachment, options, (path) => readFile(path).catch(() => null));
  }

  /**
   * The same, read at once: a picture already in view that was let go comes
   * back in the frame that shows it (a preview file reads in well under a
   * millisecond), instead of a frame of its empty box first.
   */
  getSync(
    attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">,
    options: InlineImagePrepareOptions,
  ): PreparedInlineImage | null {
    const base = this.base(attachment, options);
    for (const exact of [false, true]) {
      let png: Buffer;
      try {
        png = readFileSync(join(this.dir, `${base}${exact ? ".src" : ""}.png`));
      } catch {
        continue;
      }
      return this.loaded(base, join(this.dir, `${base}${exact ? ".src" : ""}.png`), png, exact);
    }
    return null;
  }

  private async read(
    attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">,
    options: InlineImagePrepareOptions,
    load: (path: string) => Promise<Buffer | null>,
  ): Promise<PreparedInlineImage | null> {
    const base = this.base(attachment, options);
    for (const exact of [false, true]) {
      const path = join(this.dir, `${base}${exact ? ".src" : ""}.png`);
      const png = await load(path);
      if (png) return this.loaded(base, path, png, exact);
    }
    return null;
  }

  private loaded(base: string, path: string, png: Buffer, exact: boolean): PreparedInlineImage | null {
    const dimensions = pngDimensions(png);
    if (!dimensions) return null;
    this.stored.add(base);
    const now = new Date();
    void utimes(path, now, now).catch(() => {});
    return {
      pngBase64: png.toString("base64"),
      pixelWidth: dimensions.width,
      pixelHeight: dimensions.height,
      ...(exact ? { sourcePixelWidth: dimensions.width, sourcePixelHeight: dimensions.height } : {}),
    };
  }

  async set(
    attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">,
    options: InlineImagePrepareOptions,
    prepared: PreparedInlineImage,
  ): Promise<void> {
    const exact = prepared.sourcePixelWidth === prepared.pixelWidth && prepared.sourcePixelHeight === prepared.pixelHeight;
    const base = this.base(attachment, options);
    const path = join(this.dir, `${base}${exact ? ".src" : ""}.png`);
    const png = Buffer.from(prepared.pngBase64, "base64");
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, png, { mode: 0o600 });
      await rename(temporary, path);
      this.stored.add(base);
      if (this.bytes !== null) this.bytes += png.length;
      if (this.bytes === null || this.bytes > this.maxBytes) await this.prune(path);
    } catch {
      // The disk cache is an optimization only.
    }
  }

  /** This preview was written or read this session, so it should load from disk again (it may since have been pruned). */
  has(attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">, options: InlineImagePrepareOptions): boolean {
    return this.stored.has(this.base(attachment, options));
  }

  private base(attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">, options: InlineImagePrepareOptions): string {
    return createHash("sha256").update(JSON.stringify([
      PREVIEW_FORMAT,
      attachment.cacheKey ?? attachment.id,
      attachment.url.split("?")[0],
      options.maxPixelWidth,
      options.maxPixelHeight,
      options.preserveSourceResolution ?? false,
    ])).digest("hex").slice(0, 32);
  }

  private async prune(keep: string): Promise<void> {
    const entries: { path: string; bytes: number; modifiedAtMs: number }[] = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith(".png")) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) entries.push({ path, bytes: info.size, modifiedAtMs: info.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    entries.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path));
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      if (entry.path === keep) continue;
      await unlink(entry.path).catch(() => {});
      this.stored.delete(entry.path.slice(this.dir.length + 1).replace(/(\.src)?\.png$/, ""));
      total -= entry.bytes;
    }
    this.bytes = total;
  }
}
