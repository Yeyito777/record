import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  INLINE_IMAGE_ID_FIRST,
  INLINE_IMAGE_ID_LAST,
  inlineImagesDrawable,
  nextInlineImageId,
  shouldLoadInlineImage,
  inlineImageSourcesNearView,
  inlineImageViewAnchor,
  inlineImageViewDistance,
  inlineImageViewMovedRows,
  inlineImageViewOffset,
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

test.skipIf(!Bun.which("ffmpeg"))("photo previews use a palette; pictures that may be transparent and the viewer keep full colour, the viewer at its box", async () => {
  const directory = mkdtempSync(join(tmpdir(), "record-palette-preview-"));
  tempDirs.push(directory);
  const make = (name: string, source: string) => {
    const path = join(directory, name);
    execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", source, "-frames:v", "1", path]);
    return path;
  };
  const colourType = (prepared: { pngBase64: string }) => Buffer.from(prepared.pngBase64, "base64")[25];
  const bounds = { maxPixelWidth: 320, maxPixelHeight: 240 };

  const jpeg = make("photo.jpg", "testsrc2=size=640x480");
  const preview = await prepareInlineImage(jpeg, bounds);
  expect(colourType(preview)).toBe(3);
  expect([preview.pixelWidth, preview.pixelHeight]).toEqual([320, 240]);
  expect(colourType(await prepareInlineImageBytes(readFileSync(jpeg), bounds))).toBe(3);
  expect(colourType(await prepareInlineImage(jpeg, { preserveSourceResolution: true }))).not.toBe(3);

  const transparent = make("alpha.png", "color=c=red@0.5:size=640x480,format=rgba");
  expect(colourType(await prepareInlineImage(transparent, bounds))).toBe(6);

  // Discord's media proxy sends JPEGs as lossy WebP: still a photo.
  const lossyWebp = join(directory, "photo.webp");
  execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", lossyWebp]);
  expect(colourType(await prepareInlineImage(lossyWebp, bounds))).toBe(3);
  const losslessWebp = join(directory, "alpha.webp");
  execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=red@0.5:size=640x480,format=rgba", "-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", losslessWebp]);
  expect(colourType(await prepareInlineImage(losslessWebp, bounds))).toBe(6);

  // The viewer: full colour, bounded to its box when one is given, else the source's pixels.
  const viewer = await prepareInlineImage(jpeg, { preserveSourceResolution: true, ...bounds });
  expect([viewer.pixelWidth, viewer.pixelHeight, colourType(viewer)]).toEqual([320, 240, 2]);
  const screenshot = make("screenshot.png", "testsrc2=size=640x480");
  const boxed = await prepareInlineImage(screenshot, { preserveSourceResolution: true, ...bounds });
  expect([boxed.pixelWidth, boxed.pixelHeight]).toEqual([320, 240]);
  const source = await prepareInlineImage(screenshot, { preserveSourceResolution: true });
  expect([source.pixelWidth, source.pixelHeight]).toEqual([640, 480]);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inline chat images", () => {
  test("retries waiting previews only after connection, including explicit requests in hide mode", () => {
    const waiting = { phase: "waiting" as const, attachmentId: "image", filename: "image.jpg", sourceUrl: "", requestId: 1 };
    for (const autoShow of [true, false]) {
      expect(shouldLoadInlineImage(waiting, "", autoShow, false, true)).toBe(false);
      expect(shouldLoadInlineImage(waiting, "", autoShow, true, true)).toBe(true);
      expect(shouldLoadInlineImage({ ...waiting, phase: "loading" }, "", autoShow, true, true)).toBe(false);
      expect(shouldLoadInlineImage({ ...waiting, phase: "error", error: "bad image" }, "", autoShow, true, true)).toBe(false);
    }
    // Cancelling a manually requested preview must not restart it in hide mode.
    expect(shouldLoadInlineImage(undefined, "", false, true, true)).toBe(false);
    expect(shouldLoadInlineImage(undefined, "", true, false, true)).toBe(true); // May already be cached.
  });

  test("nothing loads for display until the terminal confirms Kitty graphics", () => {
    const waiting = { phase: "waiting" as const, attachmentId: "image", filename: "image.jpg", sourceUrl: "", requestId: 1 };
    for (const graphics of [false, null]) {
      expect(inlineImagesDrawable(graphics)).toBe(false);
      expect(shouldLoadInlineImage(undefined, "", true, true, inlineImagesDrawable(graphics))).toBe(false);
      expect(shouldLoadInlineImage(waiting, "", true, true, inlineImagesDrawable(graphics))).toBe(false);
    }
    expect(inlineImagesDrawable(true)).toBe(true);
  });

  test("chat image ids never fall in the ranges custom emoji, sidebar icons and the graphics query use", () => {
    const reserved = (id: number) => (id >= 0x6ffffffe && id <= 0x6fffffff) // graphics query
      || (id >= 0x72000000 && id <= 0x72ffffff) // custom emoji
      || (id >= 0x73000000 && id <= 0x73ffffff); // sidebar icons
    for (let index = 0; index < 200_000; index++) {
      const id = inlineImageId({ id: `attachment-${index}`, url: `https://cdn.example/${index}.png` });
      expect(id >= INLINE_IMAGE_ID_FIRST && id <= INLINE_IMAGE_ID_LAST).toBe(true);
    }
    expect(reserved(INLINE_IMAGE_ID_FIRST) || reserved(INLINE_IMAGE_ID_LAST)).toBe(false);
    expect(INLINE_IMAGE_ID_LAST).toBeLessThan(0x6ffffffe);
    // Probing for a free id wraps within the range.
    expect(nextInlineImageId(INLINE_IMAGE_ID_LAST)).toBe(INLINE_IMAGE_ID_FIRST);
    expect(nextInlineImageId(INLINE_IMAGE_ID_FIRST)).toBe(INLINE_IMAGE_ID_FIRST + 1);
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
      // Unbounded pass-through pixels are the source size the viewer reuses.
      sourcePixelWidth: 1,
      sourcePixelHeight: 1,
    });
    expect(await prepareInlineImageBytes(PNG)).toEqual(prepared);
  });

  test("fits images using the terminal's real cell aspect ratio", () => {
    expect(inlineImageCellLayout({ pixelWidth: 1920, pixelHeight: 1080 }, 80, 8, 16)).toEqual({
      columns: 57,
      rows: 16,
    });
    expect(inlineImageCellLayout({ pixelWidth: 100, pixelHeight: 100 }, 80, 8, 16)).toEqual({
      columns: 12,
      rows: 6,
    });
    expect(inlineImagePreviewPixelBounds(9, 18)).toEqual({
      maxPixelWidth: 648,
      maxPixelHeight: 288,
    });
  });

  test("keeps the picture's shape: rounding to cells never stretches it more than a few percent", () => {
    const shapes = [[4000, 700], [1170, 6000], [1080, 566], [100, 100], [1920, 1080], [720, 1280], [3000, 400], [300, 10]] as const;
    for (const [cellWidth, cellHeight] of [[8, 20], [8, 16], [9, 18], [10, 22]] as const) {
      for (const [pixelWidth, pixelHeight] of shapes) {
        const layout = inlineImageCellLayout({ pixelWidth, pixelHeight }, 80, cellWidth, cellHeight);
        const drawn = (layout.columns * cellWidth) / (layout.rows * cellHeight);
        const error = Math.abs(drawn / (pixelWidth / pixelHeight) - 1);
        // Within half a cell (a one-row picture can only be as thin as one row).
        if (layout.rows > 1) expect({ pixelWidth, pixelHeight, cellWidth, cellHeight, error: error <= 0.05 }).toMatchObject({ error: true });
        expect(layout.columns).toBeLessThanOrEqual(72);
        expect(layout.rows).toBeLessThanOrEqual(16);
      }
    }
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

  test("looks ahead in pictures in the direction of travel, a few behind, nearest first", () => {
    const at = (index: number) => ({ id: `a${index}`, filename: `p${index}.png`, contentType: "image/png", size: 10, url: `p${index}` });
    // Forty messages of ten rows each, one image apiece; the view is rows 200-219 (m20, m21).
    const messages = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, attachments: [at(index)] }));
    const bounds = messages.map((message, index) => ({ messageId: message.id, start: index * 10, end: index * 10 + 10 }));
    const lookahead = { direction: "up" as const, aheadPictures: 6, aheadRows: 40, behindPictures: 2, maxRows: 1000 };
    const ids = (sources: { id: string }[]) => sources.map((source) => source.id);

    // Up: six pictures above (more than the 40 rows' four), two below, merged nearest first.
    const up = inlineImageSourcesNearView(messages, bounds, 200, 20, lookahead);
    expect(ids(up.visible)).toEqual(["a21", "a20"]);
    expect(ids(up.nearby)).toEqual(["a19", "a22", "a18", "a23", "a17", "a16", "a15", "a14"]);
    expect(up.reach).toEqual({ above: 51, below: 11 });
    expect(up.messageIds.get("a14")).toBe("m14");

    // Down: the same the other way.
    const down = inlineImageSourcesNearView(messages, bounds, 200, 20, { ...lookahead, direction: "down" });
    expect(ids(down.nearby)).toEqual(["a19", "a22", "a18", "a23", "a24", "a25", "a26", "a27"]);
    expect(down.reach).toEqual({ above: 11, below: 51 });

    // Rows win when they hold more pictures than the count.
    const rows = inlineImageSourcesNearView(messages, bounds, 200, 20, { ...lookahead, aheadPictures: 1, aheadRows: 60 });
    expect(rows.reach.above).toBe(51);

    // At the bottom nothing is below: ahead is up whatever the last move was.
    const bottom = inlineImageSourcesNearView(messages, bounds, 380, 20, { ...lookahead, direction: "down" });
    expect(ids(bottom.visible)).toEqual(["a39", "a38"]);
    expect(bottom.nearby).toHaveLength(6);
    expect(bottom.reach).toEqual({ above: 51, below: 0 });

    // Never past maxRows, however few pictures were found.
    const capped = inlineImageSourcesNearView(messages, bounds, 200, 20, { ...lookahead, maxRows: 15 });
    expect(ids(capped.nearby)).toEqual(["a19", "a22", "a18", "a23"]);

    // Messages without pictures cost rows, not pictures.
    const sparse = messages.map((message, index) => (index % 5 === 0 ? message : { id: message.id, attachments: [] }));
    const sparseNear = inlineImageSourcesNearView(sparse, bounds, 200, 20, { ...lookahead, aheadPictures: 2, behindPictures: 1 });
    expect(ids(sparseNear.visible)).toEqual(["a20"]);
    expect(ids(sparseNear.nearby)).toEqual(["a25", "a15", "a10"]);
  });

  test("tells which way the view moved through the content, not through the layout", () => {
    const bounds = Array.from({ length: 10 }, (_, index) => ({ messageId: `m${index}`, start: index * 10, end: index * 10 + 10 }));
    const anchor = inlineImageViewAnchor(bounds, 43)!;
    expect(anchor).toEqual({ messageId: "m4", row: 3 });
    expect(inlineImageViewMovedRows(bounds, anchor, 43)).toBe(0);
    expect(inlineImageViewMovedRows(bounds, anchor, 30)).toBe(-13);
    // Older messages loaded above shift every row; the view kept its place.
    const prepended = [{ messageId: "older", start: 0, end: 25 }, ...bounds.map((bound) => ({ ...bound, start: bound.start + 25, end: bound.end + 25 }))];
    expect(inlineImageViewMovedRows(prepended, anchor, 68)).toBe(0);
    // A picture below the view growing is not a move either.
    const grown = bounds.map((bound, index) => (index < 7 ? bound : { ...bound, start: bound.start + 1, end: bound.end + 1 }));
    expect(inlineImageViewMovedRows(grown, anchor, 43)).toBe(0);
    expect(inlineImageViewMovedRows(bounds.slice(5), anchor, 43)).toBeNull();
  });

  test("measures how far an image is from the view, signed by side", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, attachments: [] }));
    const bounds = messages.map((message, index) => ({ messageId: message.id, start: index * 10, end: index * 10 + 10 }));
    expect(inlineImageViewDistance(bounds, "m4", 40, 20)).toBe(0);
    expect(inlineImageViewDistance(bounds, "m6", 40, 20)).toBe(1);
    expect(inlineImageViewDistance(bounds, "m2", 40, 20)).toBe(11);
    expect(inlineImageViewOffset(bounds, "m2", 40, 20)).toBe(-11);
    expect(inlineImageViewOffset(bounds, "m7", 40, 20)).toBe(11);
    expect(inlineImageViewDistance(bounds, "gone", 40, 20)).toBe(Infinity);
});
});
