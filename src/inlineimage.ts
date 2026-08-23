/** Inline chat-image loading and terminal-cell layout helpers. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { DiscordMessageAttachment } from "./discord";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TERMINAL_IMAGE_DIMENSION = 8192;
const MAX_TERMINAL_IMAGE_RGBA_BYTES = 64 * 1024 * 1024;
const MAX_TERMINAL_IMAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CONVERTED_PNG_BYTES = 64 * 1024 * 1024;
const CONVERTED_IMAGE_MAX_DIMENSION = 2048;
const INLINE_IMAGE_MAX_COLUMNS = 72;
const INLINE_IMAGE_MAX_ROWS = 16;
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

interface InlineChatImageBase {
  attachmentId: string;
  filename: string;
  sourceUrl: string;
  requestId: number;
}

export interface InlineChatImageLoading extends InlineChatImageBase {
  phase: "loading";
}

export interface InlineChatImageError extends InlineChatImageBase {
  phase: "error";
  error: string;
}

export interface InlineChatImageReady extends InlineChatImageBase {
  phase: "ready";
  imageId: number;
  pngBase64: string;
  pixelWidth: number;
  pixelHeight: number;
}

export type InlineChatImageState = InlineChatImageLoading | InlineChatImageError | InlineChatImageReady;

export interface InlineImageCellLayout {
  columns: number;
  rows: number;
}

export interface PreparedInlineImage {
  pngBase64: string;
  pixelWidth: number;
  pixelHeight: number;
}

export interface InlineImagePrepareOptions {
  /** Bound the encoded preview to the largest size it can occupy in chat. */
  maxPixelWidth?: number;
  maxPixelHeight?: number;
}

export function isImageAttachment(attachment: DiscordMessageAttachment): boolean {
  if (attachment.contentType?.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(extname(attachment.filename).slice(1).toLowerCase());
}

export function visibleImageAttachments(
  messages: readonly { id: string; attachments: DiscordMessageAttachment[]; forwarded?: { attachments: DiscordMessageAttachment[] } | null }[],
  bounds: readonly { messageId: string; start: number; end: number }[],
  viewStart: number,
  viewRows: number,
): DiscordMessageAttachment[] {
  const viewEnd = viewStart + Math.max(0, viewRows);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const visible: DiscordMessageAttachment[] = [];
  for (const bound of bounds) {
    if (bound.end <= viewStart || bound.start >= viewEnd) continue;
    const message = messagesById.get(bound.messageId);
    if (!message) continue;
    for (const attachment of [...message.attachments, ...(message.forwarded?.attachments ?? [])]) {
      if (seen.has(attachment.id) || !isImageAttachment(attachment)) continue;
      seen.add(attachment.id);
      visible.push(attachment);
    }
  }
  return visible;
}

export function pngDimensions(data: Uint8Array): { width: number; height: number } | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 24 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngFitsTerminal(data: Buffer, dimensions: { width: number; height: number }): boolean {
  return data.length <= MAX_TERMINAL_IMAGE_FILE_BYTES
    && dimensions.width <= MAX_TERMINAL_IMAGE_DIMENSION
    && dimensions.height <= MAX_TERMINAL_IMAGE_DIMENSION
    && dimensions.width * dimensions.height * 4 <= MAX_TERMINAL_IMAGE_RGBA_BYTES;
}

function ffmpegError(stderr: string, code: number | null, signal: NodeJS.Signals | null): Error {
  const detail = stderr.trim();
  if (detail) return new Error(detail);
  if (signal) return new Error(`Image conversion stopped by ${signal}.`);
  return new Error(`Image conversion failed${code === null ? "" : ` (ffmpeg exit ${code})`}.`);
}

function normalizedPreviewBounds(options: InlineImagePrepareOptions): { width: number; height: number } {
  const normalize = (value: number | undefined): number => Number.isFinite(value)
    ? Math.max(1, Math.min(CONVERTED_IMAGE_MAX_DIMENSION, Math.floor(value!)))
    : CONVERTED_IMAGE_MAX_DIMENSION;
  return { width: normalize(options.maxPixelWidth), height: normalize(options.maxPixelHeight) };
}

function convertImageInputToPng(inputArgs: string[], input?: Buffer, options: InlineImagePrepareOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bounds = normalizedPreviewBounds(options);
    const scale = `scale='min(iw,${bounds.width})':'min(ih,${bounds.height})':force_original_aspect_ratio=decrease`;
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-nostdin",
      ...inputArgs,
      "-map", "0:v:0",
      "-vf", scale,
      "-frames:v", "1",
      "-f", "image2pipe",
      "-vcodec", "png",
      "pipe:1",
    ], { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let rejectedForSize = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (rejectedForSize) return;
      size += chunk.length;
      if (size > MAX_CONVERTED_PNG_BYTES) {
        rejectedForSize = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr = `${stderr}${chunk}`.slice(0, 8192);
    });
    if (input) {
      child.stdin?.on("error", () => {
        // The close/error path below reports conversion failures.
      });
      child.stdin?.end(input);
    }
    child.once("error", (error) => reject(new Error(`Could not start ffmpeg: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (rejectedForSize) {
        reject(new Error("Converted image exceeds the 64 MB inline-image limit."));
        return;
      }
      if (code !== 0) {
        reject(ffmpegError(stderr, code, signal));
        return;
      }
      const png = Buffer.concat(chunks, size);
      if (png.length === 0) {
        reject(new Error("Image conversion produced no PNG data."));
        return;
      }
      resolve(png);
    });
  });
}

/** Convert the first frame of any ffmpeg-supported image to a bounded PNG. */
export function convertImageToPng(path: string, options: InlineImagePrepareOptions = {}): Promise<Buffer> {
  return convertImageInputToPng(["-i", path], undefined, options);
}

export function convertImageBytesToPng(data: Buffer, options: InlineImagePrepareOptions = {}): Promise<Buffer> {
  return convertImageInputToPng(["-i", "pipe:0"], data, options);
}

function preparedPng(png: Buffer, dimensions: { width: number; height: number } | null): PreparedInlineImage {
  if (!dimensions || !pngFitsTerminal(png, dimensions)) {
    throw new Error("Image could not be converted to a terminal-compatible PNG.");
  }
  return {
    pngBase64: png.toString("base64"),
    pixelWidth: dimensions.width,
    pixelHeight: dimensions.height,
  };
}

function exceedsPreviewBounds(dimensions: { width: number; height: number }, options: InlineImagePrepareOptions): boolean {
  const bounds = normalizedPreviewBounds(options);
  return dimensions.width > bounds.width || dimensions.height > bounds.height;
}

export async function prepareInlineImage(path: string, options: InlineImagePrepareOptions = {}): Promise<PreparedInlineImage> {
  let png: Buffer = Buffer.from(await readFile(path));
  let dimensions = pngDimensions(png);
  if (!dimensions || !pngFitsTerminal(png, dimensions) || exceedsPreviewBounds(dimensions, options)) {
    png = await convertImageToPng(path, options);
    dimensions = pngDimensions(png);
  }

  return preparedPng(png, dimensions);
}

export async function prepareInlineImageBytes(data: Buffer, options: InlineImagePrepareOptions = {}): Promise<PreparedInlineImage> {
  let png = data;
  let dimensions = pngDimensions(png);
  if (!dimensions || !pngFitsTerminal(png, dimensions) || exceedsPreviewBounds(dimensions, options)) {
    png = await convertImageBytesToPng(data, options);
    dimensions = pngDimensions(png);
  }
  return preparedPng(png, dimensions);
}

export function inlineImagePreviewPixelBounds(cellWidthPixels = 8, cellHeightPixels = 16): InlineImagePrepareOptions {
  return {
    maxPixelWidth: INLINE_IMAGE_MAX_COLUMNS * Math.max(1, Math.floor(cellWidthPixels)),
    maxPixelHeight: INLINE_IMAGE_MAX_ROWS * Math.max(1, Math.floor(cellHeightPixels)),
  };
}

/**
 * Fit an image into chat while preserving its pixel aspect ratio. The terminal
 * cell dimensions come from CSI 16 t; 8x16 is used until that reply arrives.
 */
export function inlineImageCellLayout(
  image: Pick<InlineChatImageReady, "pixelWidth" | "pixelHeight">,
  availableColumns: number,
  cellWidthPixels = 8,
  cellHeightPixels = 16,
): InlineImageCellLayout {
  const pixelWidth = Math.max(1, image.pixelWidth);
  const pixelHeight = Math.max(1, image.pixelHeight);
  const cellWidth = Math.max(1, cellWidthPixels);
  const cellHeight = Math.max(1, cellHeightPixels);
  const maxColumns = Math.max(1, Math.min(INLINE_IMAGE_MAX_COLUMNS, Math.floor(availableColumns)));
  const maxRows = INLINE_IMAGE_MAX_ROWS;
  const scale = Math.min(
    1,
    (maxColumns * cellWidth) / pixelWidth,
    (maxRows * cellHeight) / pixelHeight,
  );

  return {
    columns: Math.max(1, Math.min(maxColumns, Math.ceil((pixelWidth * scale) / cellWidth))),
    rows: Math.max(1, Math.min(maxRows, Math.ceil((pixelHeight * scale) / cellHeight))),
  };
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Use a namespaced, deterministic nonzero Kitty image ID for an attachment. */
export function inlineImageId(attachment: Pick<DiscordMessageAttachment, "id" | "url">): number {
  return ((fnv1a32(`${attachment.id}\n${attachment.url}`) & 0x3fffffff) | 0x40000000) >>> 0;
}

/** Give each rendered occurrence its own placement while sharing image data. */
export function inlineImagePlacementId(imageId: number, messageId: string): number {
  return ((fnv1a32(`${imageId}\n${messageId}`) & 0x1fffffff) | 0x20000000) >>> 0;
}
