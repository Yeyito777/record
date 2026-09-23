import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  discordStickerImageUrl,
  inlineImageCellLayout,
  inlineImageId,
  inlineImagePreviewPixelBounds,
  inlineImageSourcesForMessage,
  isImageAttachment,
  pngDimensions,
  prepareInlineImage,
  prepareInlineImageBytes,
  stickerImageAttachment,
  shouldLoadInlineImage,
  visibleInlineImageSources,
} from "./inlineimage";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
  "base64",
);
const tempDirs: string[] = [];

test.skipIf(!Bun.which("ffmpeg"))("previews static and animated WebP stickers from disk and bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "record-webp-preview-"));
  tempDirs.push(directory);
  const staticWebp = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADAAcQ9Y/+ByKi/wEA", "base64");
  const animatedWebp = Buffer.from("UklGRoQAAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAA8AAA8AAGQAAAJWUDhMDwAAAC8PwAMABxD1j/4HIqL/AQBBTk1GKAAAAAAAAAAAAA8AAA8AAGQAAABWUDhMDwAAAC8PwAMABxDR//4HIqL/AQA=", "base64");
  // Lossy VP8 + separate ALPH chunk, rather than the VP8L frames above.
  const alphaWebp = Buffer.from("UklGRtIAAABXRUJQVlA4WAoAAAASAAAADwAADwAAQU5JTQYAAAD/////AABBTk1GWgAAAAAAAAAAAA8AAA8AAGQAAAJBTFBICgAAAAEH0L+ICERE/wNWUDggMAAAANABAJ0BKhAAEAACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAADwAADwAAZAAAAFZQOCAsAAAAlAEAnQEqEAAQAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=", "base64");
  for (const [index, data] of [staticWebp, animatedWebp, alphaWebp].entries()) {
    const path = join(directory, `sticker-${index}.webp`);
    writeFileSync(path, data);
    const preview = await prepareInlineImage(path);
    expect(preview.pixelWidth).toBe(16);
    expect(preview.pixelHeight).toBe(16);
    expect(await prepareInlineImageBytes(data)).toEqual(preview);
    const bounded = await prepareInlineImageBytes(data, { maxPixelWidth: 8, maxPixelHeight: 8 });
    expect([bounded.pixelWidth, bounded.pixelHeight]).toEqual([8, 8]);
  }
  const partial = Buffer.from(animatedWebp);
  partial.writeUIntLE(19, 24, 3);
  partial.writeUIntLE(19, 27, 3);
  partial.writeUIntLE(1, 52, 3);
  partial.writeUIntLE(1, 55, 3);
  const preview = await prepareInlineImageBytes(partial);
  expect([preview.pixelWidth, preview.pixelHeight]).toEqual([20, 20]);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inline chat images", () => {
  test("retries waiting previews only after connection, including explicit requests in hide mode", () => {
    const waiting = { phase: "waiting" as const, attachmentId: "image", filename: "image.jpg", sourceUrl: "", requestId: 1 };
    for (const autoShow of [true, false]) {
      expect(shouldLoadInlineImage(waiting, "", autoShow, false)).toBe(false);
      expect(shouldLoadInlineImage(waiting, "", autoShow, true)).toBe(true);
      expect(shouldLoadInlineImage({ ...waiting, phase: "loading" }, "", autoShow, true)).toBe(false);
      expect(shouldLoadInlineImage({ ...waiting, phase: "error", error: "bad image" }, "", autoShow, true)).toBe(false);
    }
    // Cancelling a manually requested preview must not restart it in hide mode.
    expect(shouldLoadInlineImage(undefined, "", false, true)).toBe(false);
    expect(shouldLoadInlineImage(undefined, "", true, false)).toBe(true); // May already be cached.
  });

  test("recognizes image MIME types and filename fallbacks", () => {
    expect(isImageAttachment({ id: "1", filename: "photo.bin", contentType: "image/jpeg", size: 1, url: "u" })).toBe(true);
    expect(isImageAttachment({ id: "2", filename: "photo.WEBP", contentType: null, size: 1, url: "u" })).toBe(true);
    expect(isImageAttachment({ id: "3", filename: "sound.mp3", contentType: "audio/mpeg", size: 1, url: "u" })).toBe(false);
  });

  test("reads PNG geometry and preserves compatible PNG bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-inline-image-"));
    tempDirs.push(dir);
    const path = join(dir, "pixel.png");
    writeFileSync(path, PNG);

    expect(pngDimensions(PNG)).toEqual({ width: 1, height: 1 });
    const prepared = await prepareInlineImage(path);
    expect(prepared).toEqual({
      pngBase64: PNG.toString("base64"),
      pixelWidth: 1,
      pixelHeight: 1,
    });
    expect(await prepareInlineImageBytes(PNG)).toEqual(prepared);
  });

  test("fits images using the terminal's real cell aspect ratio", () => {
    expect(inlineImageCellLayout({ pixelWidth: 1920, pixelHeight: 1080 }, 80, 8, 16)).toEqual({
      columns: 57,
      rows: 16,
    });
    expect(inlineImageCellLayout({ pixelWidth: 100, pixelHeight: 100 }, 80, 8, 16)).toEqual({
      columns: 13,
      rows: 7,
    });
    expect(inlineImagePreviewPixelBounds(9, 18)).toEqual({
      maxPixelWidth: 648,
      maxPixelHeight: 288,
    });
  });

  test("assigns stable namespaced image IDs", () => {
    const attachment = { id: "attachment-1", url: "https://cdn.example/cat.png" };
    expect(inlineImageId(attachment)).toBe(inlineImageId(attachment));
    expect(inlineImageId(attachment)).toBeGreaterThanOrEqual(0x40000000);
  });

  test("adapts raster Discord sticker formats to isolated image occurrences", () => {
    expect(discordStickerImageUrl({ id: "sticker-1", formatType: 1 })).toBe(
      "https://cdn.discordapp.com/stickers/sticker-1.png",
    );
    expect(discordStickerImageUrl({ id: "sticker-2", formatType: 2 })).toBe(
      "https://cdn.discordapp.com/stickers/sticker-2.png",
    );
    expect(discordStickerImageUrl({ id: "sticker-4", formatType: 4 })).toBe(
      "https://media.discordapp.net/stickers/sticker-4.gif",
    );
    expect(discordStickerImageUrl({ id: "sticker-3", formatType: 3 })).toBeNull();

    expect(stickerImageAttachment({ id: "sticker-1", name: "catjam", formatType: 1 }, "message-1"))
      .toMatchObject({
        id: "sticker:message-1:sticker-1",
        filename: "catjam.png",
        contentType: "image/png",
        size: 0,
      });
    expect(stickerImageAttachment({ id: "sticker-3", name: "vector", formatType: 3 }, "message-1"))
      .toBeNull();
  });

  test("includes raster stickers beside ordinary message image sources", () => {
    const attachment = { id: "a1", filename: "cat.png", contentType: "image/png", size: 10, url: "cat" };
    const sources = inlineImageSourcesForMessage({
      id: "message-1",
      attachments: [attachment],
      stickers: [
        { id: "s1", name: "wave", formatType: 1 },
        { id: "s2", name: "vector", formatType: 3 },
      ],
      forwarded: null,
    });

    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe(attachment);
    expect(sources[1]).toMatchObject({ id: "sticker:message-1:s1", filename: "wave.png" });
  });

  test("finds image attachments and raster stickers in visible message bounds", () => {
    const image = { id: "a1", filename: "cat.png", contentType: "image/png", size: 10, url: "cat" };
    const pdf = { id: "a2", filename: "notes.pdf", contentType: "application/pdf", size: 10, url: "notes" };
    const secondImage = { id: "a4", filename: "bird.png", contentType: "image/png", size: 10, url: "bird" };
    const below = { id: "a3", filename: "dog.jpg", contentType: "image/jpeg", size: 10, url: "dog" };
    const messages = [
      {
        id: "m1",
        attachments: [image, pdf, secondImage],
        stickers: [{ id: "s1", name: "wave", formatType: 1 }],
      },
      { id: "m2", attachments: [below] },
    ];
    const bounds = [
      { messageId: "m1", start: 2, end: 5 },
      { messageId: "m2", start: 8, end: 10 },
    ];

    const sticker = stickerImageAttachment(messages[0]!.stickers![0]!, "m1")!;
    expect(visibleInlineImageSources(messages, bounds, 0, 6)).toEqual([sticker, secondImage, image]);
    expect(visibleInlineImageSources(messages, bounds, 6, 4)).toEqual([below]);
    expect(visibleInlineImageSources(messages, bounds, 0, 10)).toEqual([below, sticker, secondImage, image]);
  });
});
