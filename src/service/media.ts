/**
 * The bridge's media cache (docs/social-protocol.md §3.5): each picture or
 * file is downloaded once into `CACHE/media/`, root-only, under the hash of
 * its key, and handed to the app as a path. Fetches of one key share one
 * download; past the size budget the least recently used files go.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDir } from "./files";
import { BridgeError } from "./protocol";

export interface FetchedMedia {
  path: string;
  mime: string;
  w: number | null;
  h: number | null;
  bytes: number;
}

const BUDGET_BYTES = 512 * 1024 * 1024;
const TRIM_TO_BYTES = 400 * 1024 * 1024;
const SWEEP_EVERY = 64;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
};

/** The type and pixel size of an image from its first bytes (JPEG, PNG, GIF, WebP). */
export function sniffImage(head: Uint8Array): { mime: string; w: number | null; h: number | null } | null {
  const b = head;
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: "image/png", w: u32be(16), h: u32be(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { mime: "image/gif", w: u16le(6), h: u16le(8) };
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8X") return { mime: "image/webp", w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (chunk === "VP8 ") return { mime: "image/webp", w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { mime: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return { mime: "image/webp", w: null, h: null };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = u16be(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", w: u16be(i + 7), h: u16be(i + 5) };
      }
      i += 2 + length;
    }
    return { mime: "image/jpeg", w: null, h: null };
  }
  return null;
}

function describe(path: string, fallbackMime: string): FetchedMedia {
  const bytes = statSync(path).size;
  const head = new Uint8Array(65536);
  const fd = openSync(path, "r");
  let read = 0;
  try { read = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  const image = sniffImage(head.subarray(0, read));
  return { path, mime: image?.mime ?? fallbackMime, w: image?.w ?? null, h: image?.h ?? null, bytes };
}

export type Downloader = (temporaryPath: string) => Promise<{ mime?: string } | void>;

export class MediaCache {
  private readonly dir: string;
  private readonly inFlight = new Map<string, Promise<FetchedMedia>>();
  private downloads = 0;

  constructor(cacheDir: string, private readonly budget = BUDGET_BYTES) {
    this.dir = join(cacheDir, "media");
    ensurePrivateDir(this.dir);
  }

  /** Where `key` lives (whether or not it is there yet). */
  pathFor(key: string, mime = ""): string {
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 40);
    const extension = EXTENSIONS[mime] ?? "bin";
    return join(this.dir, `${hash}.${extension}`);
  }

  /**
   * The cached file for `key`, downloading it with `download` (which writes
   * the temporary path it is given) the first time.
   */
  fetch(key: string, mime: string, download: Downloader): Promise<FetchedMedia> {
    const path = this.pathFor(key, mime);
    try {
      const now = new Date();
      utimesSync(path, now, now);
      return Promise.resolve(describe(path, mime));
    } catch {
      // Not cached yet.
    }
    const running = this.inFlight.get(path);
    if (running) return running;
    const job = (async () => {
      const temporary = `${path}.part${process.pid}`;
      try {
        const result = await download(temporary);
        renameSync(temporary, path);
        if (++this.downloads % SWEEP_EVERY === 0) this.sweep();
        return describe(path, result?.mime ?? mime);
      } catch (error) {
        rmSync(temporary, { force: true });
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("unavailable", `media download failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      } finally {
        this.inFlight.delete(path);
      }
    })();
    this.inFlight.set(path, job);
    return job;
  }

  /** Drops the least recently used files once the cache is over budget. */
  sweep(): void {
    let total = 0;
    const files: { path: string; size: number; used: number }[] = [];
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      try {
        const stat = statSync(path);
        if (name.includes(".part") && Date.now() - stat.mtimeMs > 3600_000) { rmSync(path, { force: true }); continue; }
        total += stat.size;
        files.push({ path, size: stat.size, used: stat.mtimeMs });
      } catch {
        // Gone meanwhile.
      }
    }
    if (total <= this.budget) return;
    files.sort((a, b) => a.used - b.used);
    const target = Math.min(TRIM_TO_BYTES, Math.floor(this.budget * 0.8));
    for (const file of files) {
      if (total <= target) break;
      rmSync(file.path, { force: true });
      total -= file.size;
    }
  }
}

/** Downloads `url` into `path` with `fetch` (headers as the provider sends them), at most `maxBytes`. */
export async function downloadUrl(
  url: string,
  path: string,
  options: { headers?: Record<string, string>; maxBytes?: number; fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ mime?: string }> {
  const response = await (options.fetcher ?? fetch)(url, {
    headers: options.headers,
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (!response.ok) throw new BridgeError(response.status === 404 ? "not_found" : "unavailable", `media HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (declared > maxBytes) throw new BridgeError("invalid_argument", "media too large");
  const written = await Bun.write(path, response);
  if (written > maxBytes) throw new BridgeError("invalid_argument", "media too large");
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
  return mime ? { mime } : {};
}
