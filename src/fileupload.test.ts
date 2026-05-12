import { mkdtempSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { describe, expect, test } from "bun:test";

import { formatUploadSize, mediaTypeForFilename, normalizeUploadPath, readLocalFileUpload } from "./fileupload";

describe("file uploads", () => {
  test("loads a local file as a Discord upload", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-upload-test-"));
    const path = join(dir, "note.txt");
    writeFileSync(path, "hello upload");

    const upload = readLocalFileUpload(path);

    expect(upload.path).toBe(path);
    expect(upload.filename).toBe("note.txt");
    expect(upload.mediaType).toBe("text/plain");
    expect(upload.sizeBytes).toBe("hello upload".length);
    expect(Buffer.from(upload.base64, "base64").toString("utf8")).toBe("hello upload");
  });

  test("normalizes common shell-style paths", () => {
    expect(normalizeUploadPath('"~/cat photo.png"')).toBe(join(homedir(), "cat photo.png"));
    expect(normalizeUploadPath("./cat\\ photo.png")).toContain("cat photo.png");
  });

  test("falls back to octet-stream for unknown extensions", () => {
    expect(mediaTypeForFilename("archive.weird")).toBe("application/octet-stream");
  });

  test("compresses files that exceed the upload limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-upload-test-"));
    const path = join(dir, "huge.png");
    writeFileSync(path, Buffer.alloc(16, 1));

    const upload = readLocalFileUpload(path, {
      maxBytes: 8,
      compressor: (input) => ({
        path: input.path,
        filename: "huge-compressed.webp",
        mediaType: "image/webp",
        buffer: Buffer.from("small"),
        compressed: true,
        originalFilename: input.filename,
        originalSizeBytes: input.sizeBytes,
      }),
    });

    expect(upload.filename).toBe("huge-compressed.webp");
    expect(upload.mediaType).toBe("image/webp");
    expect(upload.compressed).toBe(true);
    expect(upload.originalFilename).toBe("huge.png");
    expect(upload.originalSizeBytes).toBe(16);
    expect(upload.sizeBytes).toBe(5);
    expect(Buffer.from(upload.base64, "base64").toString("utf8")).toBe("small");
  });

  test("rejects oversized files when compression cannot get below the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-upload-test-"));
    const path = join(dir, "huge.bin");
    writeFileSync(path, Buffer.alloc(16, 1));

    expect(() => readLocalFileUpload(path, { maxBytes: 8, compressor: () => null })).toThrow("Could not compress huge.bin below 8 B.");
  });

  test("gzips oversized non-media files as a fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-upload-test-"));
    const path = join(dir, "huge.txt");
    writeFileSync(path, "a".repeat(200));

    const upload = readLocalFileUpload(path, { maxBytes: 40 });

    expect(upload.filename).toBe("huge.txt.gz");
    expect(upload.mediaType).toBe("application/gzip");
    expect(upload.compressed).toBe(true);
    expect(upload.sizeBytes).toBeLessThanOrEqual(40);
  });

  test("formats upload sizes", () => {
    expect(formatUploadSize(8 * 1024 * 1024)).toBe("8.0 MB");
  });
});
