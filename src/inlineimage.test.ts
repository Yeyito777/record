import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  inlineImageCellLayout,
  inlineImageId,
  inlineImagePreviewPixelBounds,
  isImageAttachment,
  pngDimensions,
  prepareInlineImage,
  prepareInlineImageBytes,
  visibleImageAttachments,
} from "./inlineimage";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
  "base64",
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inline chat images", () => {
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

  test("finds only image attachments in visible message bounds", () => {
    const image = { id: "a1", filename: "cat.png", contentType: "image/png", size: 10, url: "cat" };
    const pdf = { id: "a2", filename: "notes.pdf", contentType: "application/pdf", size: 10, url: "notes" };
    const below = { id: "a3", filename: "dog.jpg", contentType: "image/jpeg", size: 10, url: "dog" };
    const messages = [
      { id: "m1", attachments: [image, pdf] },
      { id: "m2", attachments: [below] },
    ];
    const bounds = [
      { messageId: "m1", start: 2, end: 5 },
      { messageId: "m2", start: 8, end: 10 },
    ];

    expect(visibleImageAttachments(messages, bounds, 0, 6)).toEqual([image]);
    expect(visibleImageAttachments(messages, bounds, 6, 4)).toEqual([below]);
  });
});
