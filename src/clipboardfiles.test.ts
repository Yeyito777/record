import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import {
  convertHeic,
  filePathsFromUriList,
  imageFromFile,
  imagesFromFileList,
  isHeicBytes,
  setClipboardFileSystemForTest,
} from "./clipboardfiles";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
const HEIC_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(12)]);
const magickHeic = (() => {
  const result = spawnSync("magick", ["-list", "format"], { timeout: 5000 });
  return result.status === 0 && /HEIC\s+HEIC\s+rw/.test(result.stdout.toString());
})();

function tempFiles(files: Record<string, Buffer>): { dir: string; path: (name: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "record-clipfiles-"));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return { dir, path: (name) => join(dir, name) };
}

afterEach(() => setClipboardFileSystemForTest(null));

describe("copied files", () => {
  test("file lists name local files only", () => {
    expect(filePathsFromUriList("copy\nfile:///tmp/a%20b.png\r\nhttps://x/y.png\n# comment\nfile:///tmp/c.jpg\n"))
      .toEqual(["/tmp/a b.png", "/tmp/c.jpg"]);
  });

  test("image files attach as their own bytes and names; other files are skipped", () => {
    const files = tempFiles({ "cat.png": PNG, "notes.pdf": Buffer.from("%PDF"), "dog.jpg": JPEG });
    try {
      const list = ["cat.png", "notes.pdf", "dog.jpg"].map((name) => pathToFileURL(files.path(name)).href).join("\n");
      expect(imagesFromFileList(list)).toEqual([
        { mediaType: "image/png", base64: PNG.toString("base64"), sizeBytes: PNG.length, filename: "cat.png" },
        { mediaType: "image/jpeg", base64: JPEG.toString("base64"), sizeBytes: JPEG.length, filename: "dog.jpg" },
      ]);
      expect(imagesFromFileList(pathToFileURL(files.path("notes.pdf")).href)).toBeNull();
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  test("a file named like an image that is not one is refused", () => {
    const files = tempFiles({ "fake.png": Buffer.from("hello") });
    try {
      expect(() => imageFromFile(files.path("fake.png"))).toThrow("not a PNG, JPEG, GIF, WebP or HEIC image");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  test("over SSH a copied file is on the other computer", () => {
    expect(() => imagesFromFileList("file:///Users/me/a.png", false)).toThrow("over SSH");
  });
});

describe("HEIC photos", () => {
  test("are recognised by their ftyp brand", () => {
    expect(isHeicBytes(HEIC_HEAD)).toBe(true);
    expect(isHeicBytes(PNG)).toBe(false);
  });

  test("convert to JPEG with ImageMagick off macOS", () => {
    const calls: string[][] = [];
    setClipboardFileSystemForTest({
      platform: "linux",
      spawnSync: ((command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 0, stdout: JPEG, stderr: Buffer.alloc(0) };
      }) as unknown as typeof spawnSync,
    });
    expect(convertHeic(HEIC_HEAD, "IMG_1.HEIC")).toEqual({
      mediaType: "image/jpeg", base64: JPEG.toString("base64"), sizeBytes: JPEG.length, filename: "IMG_1.jpg",
    });
    expect(calls[0]?.slice(0, 2)).toEqual(["magick", "heic:-[0]"]);
  });

  test("convert with the built-in sips on macOS", () => {
    setClipboardFileSystemForTest({
      platform: "darwin",
      spawnSync: ((command: string, args: string[]) => {
        expect(command).toBe("sips");
        writeFileSync(args[args.indexOf("--out") + 1]!, JPEG);
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }) as unknown as typeof spawnSync,
    });
    expect(convertHeic(HEIC_HEAD).mediaType).toBe("image/jpeg");
  });

  test("a failed decode says what is missing", () => {
    setClipboardFileSystemForTest({
      platform: "linux",
      spawnSync: (() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })) as unknown as typeof spawnSync,
    });
    expect(() => convertHeic(HEIC_HEAD)).toThrow("ImageMagick with libheif");
  });

  test.skipIf(!magickHeic)("a real HEIC file converts to a JPEG", () => {
    const files = tempFiles({});
    try {
      const heic = files.path("photo.heic");
      expect(spawnSync("magick", ["-size", "32x16", "xc:red", heic], { timeout: 15_000 }).status).toBe(0);
      const image = imageFromFile(heic);
      expect(image.mediaType).toBe("image/jpeg");
      expect(image.filename).toBe("photo.jpg");
      expect(Buffer.from(image.base64, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });
});
