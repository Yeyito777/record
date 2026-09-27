import { describe, expect, test } from "bun:test";
import { InlineImageCache, inlineImageCacheKey } from "./inlineimagecache";

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
