import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InlineImageCache, inlineImageCacheKey, InlinePreviewDiskCache } from "./inlineimagecache";

const preview = { pngBase64: "cG5n", pixelWidth: 100, pixelHeight: 50 };

describe("prepared inline image cache", () => {
  test("reuses prepared pixels across chats and refreshes LRU on reads", () => {
    const cache = new InlineImageCache(2);
    cache.set("chat-a", preview);
    cache.set("chat-b", preview);
    expect(cache.get("chat-a")).toBe(preview);
    cache.set("chat-c", preview);
    expect(cache.get("chat-b")).toBeUndefined();
    expect(cache.get("chat-a")).toBe(preview);
    expect(cache.get("chat-c")).toBe(preview);
  });

  test("bounds retained strings by bytes, replaces entries, and skips oversized previews", () => {
    const cache = new InlineImageCache(64, 20);
    cache.set("a", preview); // 10 bytes
    cache.set("b", preview);
    cache.set("a", preview); // replacement must not double-count
    expect(cache.get("b")).toBe(preview);
    cache.set("c", preview);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(preview);
    cache.set("b", { ...preview, pngBase64: "A".repeat(20) });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(preview);
  });

  test("isolates source changes, preview geometry, and full-resolution images", () => {
    const attachment = { id: "a", url: "https://example.com/a?version=1" };
    const bounds = { maxPixelWidth: 576, maxPixelHeight: 256 };
    const key = inlineImageCacheKey(attachment, bounds);
    expect(inlineImageCacheKey({ ...attachment }, { ...bounds })).toBe(key);
    expect(inlineImageCacheKey({ ...attachment, url: "https://example.com/a?version=2" }, bounds)).not.toBe(key);
    expect(inlineImageCacheKey({ ...attachment, id: "b" }, bounds)).not.toBe(key);
    expect(inlineImageCacheKey(attachment, { ...bounds, maxPixelWidth: 720 })).not.toBe(key);
    expect(inlineImageCacheKey(attachment, { preserveSourceResolution: true })).not.toBe(key);
  });

  test("repeated sticker occurrences can share a preview", () => {
    const source = { id: "first", cacheKey: "sticker:1", url: "https://example.com/1.png" };
    expect(inlineImageCacheKey(source, {})).toBe(inlineImageCacheKey({ ...source, id: "second" }, {}));
  });
});

describe("prepared previews on disk", () => {
  const png = (width: number, height: number) => {
    // A PNG header is all the disk cache reads besides the bytes.
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes.toString("base64");
  };

  test("survive the session: a later run gets the same preview without downloading or converting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-previews-"));
    try {
      const attachment = { id: "a1", url: "https://cdn.example/a1.jpg?ex=1&hm=2", filename: "a1.jpg" };
      const bounds = { maxPixelWidth: 576, maxPixelHeight: 256 };
      const first = new InlinePreviewDiskCache(dir);
      expect(await first.get(attachment, bounds)).toBeNull();
      const prepared = { pngBase64: png(120, 90), pixelWidth: 120, pixelHeight: 90, sourcePixelWidth: 120, sourcePixelHeight: 90 };
      await first.set(attachment, bounds, prepared);
      const later = new InlinePreviewDiskCache(dir);
      // Discord re-signs attachment URLs: only the path names the picture.
      expect(await later.get({ ...attachment, url: "https://cdn.example/a1.jpg?ex=9&hm=8" }, bounds)).toEqual(prepared);
      // Another cell size wants another preview.
      expect(await later.get(attachment, { maxPixelWidth: 1152, maxPixelHeight: 512 })).toBeNull();
      // A scaled-down preview does not claim to be the source size.
      const scaled = { pngBase64: png(60, 45), pixelWidth: 60, pixelHeight: 45 };
      await later.set({ ...attachment, id: "a2" }, bounds, scaled);
      expect(await later.get({ ...attachment, id: "a2" }, bounds)).toEqual(scaled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps within its byte budget, least recently used first out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-previews-"));
    try {
      const cache = new InlinePreviewDiskCache(dir, 100);
      const bounds = { maxPixelWidth: 576, maxPixelHeight: 256 };
      for (let index = 0; index < 5; index++) {
        await cache.set({ id: `a${index}`, url: "" }, bounds, { pngBase64: png(10, 10), pixelWidth: 10, pixelHeight: 10 });
      }
      // 33 bytes each: three fit in 100.
      expect(readdirSync(dir).filter((name) => name.endsWith(".png"))).toHaveLength(3);
      expect(await cache.get({ id: "a0", url: "" }, bounds)).toBeNull();
      expect(await cache.get({ id: "a4", url: "" }, bounds)).not.toBeNull();
      // Pruned ones are no longer known to come back from disk.
      expect(cache.has({ id: "a0", url: "" }, bounds)).toBe(false);
      expect(cache.has({ id: "a4", url: "" }, bounds)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("knows which previews come back from disk, and reads one at once for a picture in view", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-previews-"));
    try {
      const attachment = { id: "a1", url: "https://cdn.example/a1.jpg" };
      const bounds = { maxPixelWidth: 576, maxPixelHeight: 256 };
      const prepared = { pngBase64: png(64, 48), pixelWidth: 64, pixelHeight: 48 };
      const cache = new InlinePreviewDiskCache(dir);
      expect(cache.has(attachment, bounds)).toBe(false);
      expect(cache.getSync(attachment, bounds)).toBeNull();
      await cache.set(attachment, bounds, prepared);
      expect(cache.has(attachment, bounds)).toBe(true);
      expect(cache.getSync(attachment, bounds)).toEqual(prepared);
      // A later session learns it on its first read.
      const later = new InlinePreviewDiskCache(dir);
      expect(later.has(attachment, bounds)).toBe(false);
      expect(await later.get(attachment, bounds)).toEqual(prepared);
      expect(later.has(attachment, bounds)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
