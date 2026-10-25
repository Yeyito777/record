/**
 * Clipboard photos and files as image attachments.
 *
 * Ported from the Exocortex TUI (tui/src/heic.ts, clipboard.ts): an iPhone
 * HEIC/HEIF photo is converted to JPEG locally (Discord does not preview HEIC),
 * and a copied image file (Finder, a Linux file manager's text/uri-list) is
 * attached as the file's own bytes instead of the generic file icon the
 * clipboard offers beside it. Only local file references are read; remote
 * URLs are never fetched.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "os";
import { basename, join } from "path";

import type { ClipboardImageAttachment, ImageMediaType } from "./imageclipboard";

/** Clipboard types that carry the original photo; preferred over a PNG preview offered alongside. */
export const HEIC_MIME_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"] as const;
/** Clipboard types that list copied files. */
export const FILE_LIST_MIME_TYPES = ["text/uri-list", "x-special/gnome-copied-files"] as const;
export const MAX_CLIPBOARD_FILE_BYTES = 50 * 1024 * 1024;

const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|hei[cf])$/i;

export interface ClipboardFileSystem {
  spawnSync: typeof spawnSync;
  readFileSync: typeof readFileSync;
  statSync: typeof statSync;
  platform: NodeJS.Platform;
}

const defaultFileSystem: ClipboardFileSystem = { spawnSync, readFileSync, statSync, platform: process.platform };
let fileSystem = defaultFileSystem;

export function setClipboardFileSystemForTest(overrides: Partial<ClipboardFileSystem> | null): void {
  fileSystem = overrides ? { ...defaultFileSystem, ...overrides } : defaultFileSystem;
}

export function isHeicPath(path: string): boolean {
  return /\.hei[cf]$/i.test(path);
}

export function isImageFilePath(path: string): boolean {
  return IMAGE_FILE_RE.test(path);
}

export function detectImageMediaType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 6).toString("ascii");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/** ISO-BMFF "ftyp" brands used by HEIC/HEIF photos. */
export function isHeicBytes(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  return /^(?:heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(bytes.subarray(8, 12).toString("ascii"));
}

function jpegAttachment(jpeg: Buffer, filename?: string): ClipboardImageAttachment {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
    || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
    throw new Error("HEIC conversion did not produce a JPEG");
  }
  return {
    mediaType: "image/jpeg",
    base64: jpeg.toString("base64"),
    sizeBytes: jpeg.length,
    ...(filename ? { filename } : {}),
  };
}

/**
 * Decode a HEIC/HEIF photo to JPEG: macOS's built-in sips, elsewhere
 * ImageMagick with libheif. Selects the primary image and honours the camera
 * orientation (ImageMagick caps very large photos at 4096 px on the long side).
 */
export function convertHeic(bytes: Buffer, filename?: string): ClipboardImageAttachment {
  if (bytes.length === 0 || bytes.length > MAX_CLIPBOARD_FILE_BYTES) {
    throw new Error("HEIC photo is empty or exceeds the 50 MB limit");
  }
  const jpegName = filename ? filename.replace(/\.hei[cf]$/i, "") + ".jpg" : undefined;

  if (fileSystem.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "record-heic-"));
    try {
      const input = join(dir, "photo.heic");
      const output = join(dir, "photo.jpg");
      writeFileSync(input, bytes, { mode: 0o600 });
      const result = fileSystem.spawnSync("sips", [
        "-s", "format", "jpeg", "-s", "formatOptions", "85", input, "--out", output,
      ], { timeout: 15_000 });
      if (result.error || result.status !== 0) throw new Error("Could not convert the HEIC photo with sips.");
      return jpegAttachment(fileSystem.readFileSync(output), jpegName);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const result = fileSystem.spawnSync("magick", [
    "heic:-[0]", "-auto-orient", "-resize", "4096x4096>",
    "-background", "white", "-alpha", "remove", "-strip", "-quality", "85", "jpeg:-",
  ], { input: bytes, timeout: 15_000, maxBuffer: MAX_CLIPBOARD_FILE_BYTES });
  if (result.error || result.status !== 0) {
    throw new Error("Could not decode the HEIC photo. ImageMagick with libheif support is required.");
  }
  return jpegAttachment(Buffer.from(result.stdout), jpegName);
}

/** A local image file as an attachment: PNG/JPEG/GIF/WebP as-is, HEIC converted. */
export function imageFromFile(path: string): ClipboardImageAttachment {
  const stat = fileSystem.statSync(path);
  if (!stat.isFile()) throw new Error(`${basename(path)} is not a regular file`);
  if (stat.size > MAX_CLIPBOARD_FILE_BYTES) throw new Error(`${basename(path)} exceeds the 50 MB limit`);
  const bytes = fileSystem.readFileSync(path);
  const name = basename(path);
  if (isHeicPath(path) || isHeicBytes(bytes)) return convertHeic(bytes, name);
  const mediaType = detectImageMediaType(bytes);
  if (!mediaType) throw new Error(`${name} is not a PNG, JPEG, GIF, WebP or HEIC image`);
  return { mediaType, base64: bytes.toString("base64"), sizeBytes: bytes.length, filename: name };
}

/** Local file paths from a text/uri-list or GNOME copied-files payload (non-file URLs are skipped). */
export function filePathsFromUriList(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/).map((entry) => entry.trim())) {
    if (!line || line.startsWith("#") || line === "copy" || line === "cut") continue;
    try {
      if (line.startsWith("file:")) paths.push(fileURLToPath(line));
    } catch {
      // Not a local file URL.
    }
  }
  return paths;
}

/**
 * Images for the copied files in a file-list payload, or null when it lists
 * no image file. `allowLocalFiles` is false over SSH, where the paths name
 * files on the client, not on this machine.
 */
export function imagesFromFileList(text: string, allowLocalFiles = true): ClipboardImageAttachment[] | null {
  const images = filePathsFromUriList(text).filter(isImageFilePath);
  if (images.length === 0) return null;
  if (!allowLocalFiles) {
    throw new Error("Cannot read a copied file from the computer running the terminal over SSH; copy the image itself or use /upload.");
  }
  return images.map((path) => imageFromFile(path));
}

/** Whether this process runs on the machine whose files a clipboard file list names. */
export function clipboardFilesAreLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.SSH_CONNECTION && !env.SSH_TTY;
}
