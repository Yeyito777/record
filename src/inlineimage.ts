/** Inline chat-image loading and terminal-cell layout helpers. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { DiscordMessage, DiscordMessageAttachment, DiscordMessageSticker } from "./discord";
import { embedImageSources } from "./embeds";
import { firstAnimatedWebpFrame } from "./webp";
import { trackChildProcess } from "./childprocesses";

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

export interface InlineChatImageWaiting extends InlineChatImageBase {
  phase: "waiting";
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
  sourcePixelWidth?: number;
  sourcePixelHeight?: number;
}

export type InlineChatImageState = InlineChatImageLoading | InlineChatImageWaiting | InlineChatImageError | InlineChatImageReady;

/**
 * Whether chat images can be drawn in the chat: the terminal answered the
 * Kitty graphics query. Until it does, and on terminals without it, images
 * keep their name rows (Enter opens them with the configured opener) instead
 * of reserving blank rows nothing is drawn in.
 */
export function inlineImagesDrawable(graphicsSupported: boolean | null | undefined): boolean {
  return graphicsSupported === true;
}

/** Resume requested previews even in hide mode, without retrying real errors. */
export function shouldLoadInlineImage(
  existing: InlineChatImageState | undefined,
  sourceUrl: string,
  autoShow: boolean,
  providerConnected: boolean,
  drawable: boolean,
): boolean {
  if (!drawable) return false;
  if (existing?.sourceUrl === sourceUrl) return existing.phase === "waiting" && providerConnected;
  return autoShow;
}

export interface InlineImageCellLayout {
  columns: number;
  rows: number;
}

export interface PreparedInlineImage {
  pngBase64: string;
  pixelWidth: number;
  pixelHeight: number;
  /** Original pixel size, present only when the encoded PNG was not bounded. */
  sourcePixelWidth?: number;
  sourcePixelHeight?: number;
}

export interface InlineImagePrepareOptions {
  /** Bound the encoded preview to the largest size it can occupy in chat. */
  maxPixelWidth?: number;
  maxPixelHeight?: number;
  /** Preserve source pixels up to the terminal protocol's safety limits. */
  preserveSourceResolution?: boolean;
}

export function isImageAttachment(attachment: DiscordMessageAttachment): boolean {
  if (attachment.contentType?.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(extname(attachment.filename).slice(1).toLowerCase());
}

export function discordStickerImageUrl(sticker: Pick<DiscordMessageSticker, "id" | "formatType">): string | null {
  if (sticker.formatType === 1 || sticker.formatType === 2) {
    return `https://cdn.discordapp.com/stickers/${sticker.id}.png`;
  }
  if (sticker.formatType === 4) {
    return `https://media.discordapp.net/stickers/${sticker.id}.gif`;
  }
  return null;
}

/** Adapt a raster-backed Discord sticker to the existing inline-image pipeline. */
export function stickerImageAttachment(
  sticker: DiscordMessageSticker,
  occurrenceId = sticker.id,
): DiscordMessageAttachment | null {
  // Preserve object identity: providers retain private download metadata in a
  // WeakMap keyed by the attachment, rather than serializing it into timelines.
  if (sticker.attachment) return sticker.attachment;
  const url = discordStickerImageUrl(sticker);
  if (!url) return null;
  const gif = sticker.formatType === 4;
  return {
    // Sticker IDs are reusable across messages, unlike attachment IDs. Include
    // the message occurrence so collapsing/selecting one does not affect every
    // other use of the same sticker in the channel.
    id: `sticker:${occurrenceId}:${sticker.id}`,
    // Repeated uses need separate UI state but share identical CDN bytes.
    cacheKey: `discord-sticker:${sticker.id}:${sticker.formatType}`,
    filename: `${sticker.name}.${gif ? "gif" : "png"}`,
    contentType: gif ? "image/gif" : "image/png",
    // Sticker items do not include their CDN byte size. A zero size tells the
    // bounded downloader to validate non-empty content without exact matching.
    size: 0,
    url,
  };
}

export function inlineImageSourcesForMessage(
  message: Pick<DiscordMessage, "id" | "attachments" | "stickers" | "forwarded" | "embeds">,
): DiscordMessageAttachment[] {
  const stickers = [
    ...(message.stickers ?? []),
    ...(message.forwarded?.stickers ?? []),
  ].map((sticker) => stickerImageAttachment(sticker, message.id))
    .filter((source): source is DiscordMessageAttachment => source !== null);
  return [
    ...message.attachments,
    ...(message.forwarded?.attachments ?? []),
    ...stickers,
    // Embed pictures (link previews, bot embeds), drawn inside their embed.
    ...embedImageSources(message),
  ];
}

type InlineImageMessage = Pick<DiscordMessage, "id" | "attachments" | "stickers" | "forwarded" | "embeds">;

/** id -> index per messages array; validated on use, rebuilt when stale. */
const messageIndexes = new WeakMap<readonly InlineImageMessage[], Map<string, number>>();

function findMessage(messages: readonly InlineImageMessage[], id: string): InlineImageMessage | undefined {
  let index = messageIndexes.get(messages);
  let position = index?.get(id);
  if (position === undefined || messages[position]?.id !== id) {
    // Appends keep indexes valid; prepends, removals or a new id rebuild once.
    index = new Map(messages.map((message, messageIndex) => [message.id, messageIndex]));
    messageIndexes.set(messages, index);
    position = index.get(id);
  }
  return position === undefined ? undefined : messages[position];
}

/** Index of the first bound starting at or after `row` (bounds are in row order). */
function firstBoundAtOrAfter(bounds: readonly { start: number }[], row: number): number {
  let low = 0;
  let high = bounds.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bounds[middle]!.start < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function visibleInlineImageSources(
  messages: readonly InlineImageMessage[],
  bounds: readonly { messageId: string; start: number; end: number }[],
  viewStart: number,
  viewRows: number,
  messageIds?: Map<string, string>,
): DiscordMessageAttachment[] {
  const viewEnd = viewStart + Math.max(0, viewRows);
  const seen = new Set<string>();
  const visible: DiscordMessageAttachment[] = [];
  // Chats are normally anchored at the newest content beside the prompt. Load
  // from the bottom of the viewport upward so the images nearest that reading
  // position become usable first. Reverse sources within one message too,
  // matching their visual bottom-to-top order. Only bounds near the viewport
  // are visited: this runs after every frame.
  for (let boundIndex = firstBoundAtOrAfter(bounds, viewEnd) - 1; boundIndex >= 0; boundIndex--) {
    const bound = bounds[boundIndex]!;
    if (bound.end <= viewStart) {
      // Bounds do not overlap, so earlier ones end even higher up.
      break;
    }
    if (bound.start >= viewEnd) continue;
    const message = findMessage(messages, bound.messageId);
    if (!message) continue;
    for (const source of inlineImageSourcesForMessage(message).toReversed()) {
      if (seen.has(source.id) || !isImageAttachment(source)) continue;
      seen.add(source.id);
      visible.push(source);
      messageIds?.set(source.id, message.id);
    }
  }
  return visible;
}

type ViewBound = { messageId: string; start: number; end: number };

/** messageId -> bound, per bounds array (bounds are replaced, never mutated, on re-layout). */
const boundIndexes = new WeakMap<readonly ViewBound[], Map<string, ViewBound>>();

/**
 * Rows between a message and the view (0 when any of it is in view), or
 * Infinity when it is not laid out: how much an image load is wanted now.
 */
export function inlineImageViewDistance(
  bounds: readonly ViewBound[],
  messageId: string,
  viewStart: number,
  viewRows: number,
): number {
  let index = boundIndexes.get(bounds);
  if (!index) {
    index = new Map(bounds.map((bound) => [bound.messageId, bound]));
    boundIndexes.set(bounds, index);
  }
  const bound = index.get(messageId);
  if (!bound) return Infinity;
  const viewEnd = viewStart + Math.max(0, viewRows);
  if (bound.end <= viewStart) return viewStart - bound.end + 1;
  if (bound.start >= viewEnd) return bound.start - viewEnd + 1;
  return 0;
}

/**
 * Images to load for a view: those in it (bottom first), then those within
 * `aheadRows` above and below it, nearest first, so scrolling finds them
 * ready instead of popping in.
 */
export function inlineImageSourcesNearView(
  messages: readonly InlineImageMessage[],
  bounds: readonly ViewBound[],
  viewStart: number,
  viewRows: number,
  aheadRows: number,
): { visible: DiscordMessageAttachment[]; nearby: DiscordMessageAttachment[]; messageIds: Map<string, string> } {
  const messageIds = new Map<string, string>();
  const visible = visibleInlineImageSources(messages, bounds, viewStart, viewRows, messageIds);
  const seen = new Set(visible.map((source) => source.id));
  const viewEnd = viewStart + Math.max(0, viewRows);
  const candidates: { distance: number; sources: DiscordMessageAttachment[] }[] = [];
  const first = firstBoundAtOrAfter(bounds, viewStart - aheadRows) - 1;
  for (let boundIndex = Math.max(0, first); boundIndex < bounds.length; boundIndex++) {
    const bound = bounds[boundIndex]!;
    if (bound.start >= viewEnd + aheadRows) break;
    if (bound.end <= viewStart - aheadRows) continue;
    const distance = inlineImageViewDistance(bounds, bound.messageId, viewStart, viewRows);
    if (distance === 0) continue;
    const message = findMessage(messages, bound.messageId);
    if (!message) continue;
    const sources = inlineImageSourcesForMessage(message).filter((source) => !seen.has(source.id) && isImageAttachment(source));
    for (const source of sources) {
      seen.add(source.id);
      messageIds.set(source.id, message.id);
    }
    if (sources.length) candidates.push({ distance, sources });
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return { visible, nearby: candidates.flatMap((candidate) => candidate.sources), messageIds };
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
  const maximum = options.preserveSourceResolution
    ? MAX_TERMINAL_IMAGE_DIMENSION
    : CONVERTED_IMAGE_MAX_DIMENSION;
  const normalize = (value: number | undefined): number => Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value!)))
    : maximum;
  return { width: normalize(options.maxPixelWidth), height: normalize(options.maxPixelHeight) };
}

function convertImageInputToPng(inputArgs: string[], input?: Buffer, options: InlineImagePrepareOptions = {}, prefixFilter = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bounds = normalizedPreviewBounds(options);
    const scale = `scale='min(iw,${bounds.width})':'min(ih,${bounds.height})':force_original_aspect_ratio=decrease`;
    const child = trackChildProcess(spawn("ffmpeg", [
      "-v", "error",
      "-nostdin",
      ...inputArgs,
      "-map", "0:v:0",
      "-vf", prefixFilter + scale,
      "-frames:v", "1",
      "-f", "image2pipe",
      "-vcodec", "png",
      "pipe:1",
    ], { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }));

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
export async function convertImageToPng(path: string, options: InlineImagePrepareOptions = {}): Promise<Buffer> {
  return convertLoadedImageToPng(path, await readFile(path), options);
}

function convertLoadedImageToPng(path: string, data: Buffer, options: InlineImagePrepareOptions): Promise<Buffer> {
  const frame = firstAnimatedWebpFrame(data);
  if (frame) return convertWebpFrameToPng(frame, options);
  return convertImageInputToPng(["-i", path], undefined, options);
}

export function convertImageBytesToPng(data: Buffer, options: InlineImagePrepareOptions = {}): Promise<Buffer> {
  const frame = firstAnimatedWebpFrame(data);
  if (frame) return convertWebpFrameToPng(frame, options);
  return convertImageInputToPng(["-i", "pipe:0"], data, options);
}

function convertWebpFrameToPng(frame: NonNullable<ReturnType<typeof firstAnimatedWebpFrame>>, options: InlineImagePrepareOptions): Promise<Buffer> {
  // First frames can cover only a subrectangle. Preserve the sticker's canvas
  // and transparent margins instead of enlarging that cropped fragment.
  return convertImageInputToPng(["-i", "pipe:0"], frame.data, options,
    `format=rgba,pad=${frame.width}:${frame.height}:${frame.x}:${frame.y}:color=black@0,`);
}

function preparedPng(
  png: Buffer,
  dimensions: { width: number; height: number } | null,
  exactSource: boolean,
): PreparedInlineImage {
  if (!dimensions || !pngFitsTerminal(png, dimensions)) {
    throw new Error("Image could not be converted to a terminal-compatible PNG.");
  }
  return {
    pngBase64: png.toString("base64"),
    pixelWidth: dimensions.width,
    pixelHeight: dimensions.height,
    ...(exactSource ? { sourcePixelWidth: dimensions.width, sourcePixelHeight: dimensions.height } : {}),
  };
}

/** ffmpeg output below both bounds was never scaled, so it is the source size. */
function convertedAtSourceSize(dimensions: { width: number; height: number } | null, options: InlineImagePrepareOptions): boolean {
  const bounds = normalizedPreviewBounds(options);
  return !!dimensions && dimensions.width < bounds.width && dimensions.height < bounds.height;
}

function exceedsPreviewBounds(dimensions: { width: number; height: number }, options: InlineImagePrepareOptions): boolean {
  if (options.preserveSourceResolution) return false;
  const bounds = normalizedPreviewBounds(options);
  return dimensions.width > bounds.width || dimensions.height > bounds.height;
}

/** What preparing one image took (debug log timings). */
export interface InlineImagePrepareReport {
  /** Bytes of the source file or data. */
  sourceBytes?: number;
  /** ffmpeg converted it (it was not already a fitting PNG). */
  converted?: boolean;
}

export async function prepareInlineImage(path: string, options: InlineImagePrepareOptions = {}, report: InlineImagePrepareReport = {}): Promise<PreparedInlineImage> {
  let png: Buffer = Buffer.from(await readFile(path));
  report.sourceBytes = png.length;
  let dimensions = pngDimensions(png);
  if (!dimensions || !pngFitsTerminal(png, dimensions) || exceedsPreviewBounds(dimensions, options)) {
    report.converted = true;
    png = await convertLoadedImageToPng(path, png, options);
    dimensions = pngDimensions(png);
    return preparedPng(png, dimensions, convertedAtSourceSize(dimensions, options));
  }

  report.converted = false;
  return preparedPng(png, dimensions, true);
}

export async function prepareInlineImageBytes(data: Buffer, options: InlineImagePrepareOptions = {}, report: InlineImagePrepareReport = {}): Promise<PreparedInlineImage> {
  let png = data;
  report.sourceBytes = data.length;
  report.converted = false;
  let dimensions = pngDimensions(png);
  if (!dimensions || !pngFitsTerminal(png, dimensions) || exceedsPreviewBounds(dimensions, options)) {
    report.converted = true;
    png = await convertImageBytesToPng(data, options);
    dimensions = pngDimensions(png);
    return preparedPng(png, dimensions, convertedAtSourceSize(dimensions, options));
  }
  return preparedPng(png, dimensions, true);
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

/**
 * Kitty image ids of chat images (and the viewer's full-size copies). Ids
 * above belong to others: the graphics query (0x6ffffffe), custom emoji
 * (0x72000000+) and sidebar icons (0x73000000+).
 */
export const INLINE_IMAGE_ID_FIRST = 0x40000000;
export const INLINE_IMAGE_ID_LAST = 0x6ffffff0;

/** Use a namespaced, deterministic nonzero Kitty image ID for an attachment. */
export function inlineImageId(attachment: Pick<DiscordMessageAttachment, "id" | "url">): number {
  return INLINE_IMAGE_ID_FIRST + (fnv1a32(`${attachment.id}\n${attachment.url}`) % (INLINE_IMAGE_ID_LAST - INLINE_IMAGE_ID_FIRST + 1));
}

/** The id after `imageId`, wrapping within the chat image range (probing for a free one). */
export function nextInlineImageId(imageId: number): number {
  return imageId >= INLINE_IMAGE_ID_LAST ? INLINE_IMAGE_ID_FIRST : imageId + 1;
}

/** Give each rendered occurrence its own placement while sharing image data. */
export function inlineImagePlacementId(imageId: number, messageId: string): number {
  return ((fnv1a32(`${imageId}\n${messageId}`) & 0x1fffffff) | 0x20000000) >>> 0;
}
