import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  inlineImageCellLayout,
  inlineImageId,
  isImageAttachment,
  pngDimensions,
  prepareInlineImage,
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
  });

  test("assigns stable namespaced image IDs", () => {
    const attachment = { id: "attachment-1", url: "https://cdn.example/cat.png" };
    expect(inlineImageId(attachment)).toBe(inlineImageId(attachment));
    expect(inlineImageId(attachment)).toBeGreaterThanOrEqual(0x40000000);
  });
});
