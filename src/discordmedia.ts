/**
 * Discord's media proxy (media.discordapp.net) serves attachments scaled to
 * the size they are drawn at. Record asks for them the way the web client
 * does, parameter for parameter: the attachment's proxy URL (its signed
 * `ex`/`is`/`hm` query ends in `&`, which the client carries through as an
 * empty `=` pair), then `format=webp`, `quality=lossless` for PNGs only, and
 * the width and height. A full photo is often megabytes; the copy for a
 * preview is a few hundred kilobytes.
 */

import type { DiscordMessageAttachment } from "./discord";

const ATTACHMENT_CDN_HOST = "cdn.discordapp.com";
const MEDIA_PROXY_HOST = "media.discordapp.net";

export interface DiscordMediaProxyRequest {
  url: string;
  width: number;
  height: number;
}

type ProxyKind = "png" | "jpeg" | "webp";

function proxyKind(attachment: Pick<DiscordMessageAttachment, "contentType" | "filename">): ProxyKind | null {
  const type = attachment.contentType?.toLowerCase().split(";")[0]?.trim();
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpeg";
  if (type === "image/webp") return "webp";
  if (type) return null;
  const extension = attachment.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === "png") return "png";
  if (extension === "jpg" || extension === "jpeg") return "jpeg";
  if (extension === "webp") return "webp";
  return null;
}

/**
 * The attachment's media-proxy URL, as sent: the API's `proxy_url`, else its
 * CDN URL on the proxy's host (the same path and signature).
 */
function attachmentProxyUrl(attachment: Pick<DiscordMessageAttachment, "url" | "proxyUrl">): string | null {
  for (const candidate of [attachment.proxyUrl, attachment.url]) {
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !url.pathname.startsWith("/attachments/")) continue;
    if (url.hostname === MEDIA_PROXY_HOST) return candidate;
    if (url.hostname === ATTACHMENT_CDN_HOST) return candidate.replace(/^https:\/\/cdn\.discordapp\.com\//i, `https://${MEDIA_PROXY_HOST}/`);
  }
  return null;
}

/**
 * The media-proxy request for an attachment drawn within `maxPixelWidth` x
 * `maxPixelHeight` (its cell box in the terminal's pixels), or null to fetch
 * the original: not a PNG, JPEG or WebP attachment, its size unknown, not a
 * Discord attachment URL, or no larger than the box already.
 */
export function discordAttachmentProxyRequest(
  attachment: Pick<DiscordMessageAttachment, "url" | "proxyUrl" | "contentType" | "filename" | "width" | "height">,
  maxPixelWidth: number | undefined,
  maxPixelHeight: number | undefined,
): DiscordMediaProxyRequest | null {
  const kind = proxyKind(attachment);
  const width = attachment.width ?? 0;
  const height = attachment.height ?? 0;
  if (!kind || width <= 0 || height <= 0) return null;
  const boxWidth = Number.isFinite(maxPixelWidth) ? Math.max(1, Math.floor(maxPixelWidth!)) : width;
  const boxHeight = Number.isFinite(maxPixelHeight) ? Math.max(1, Math.floor(maxPixelHeight!)) : height;
  const scale = Math.min(boxWidth / width, boxHeight / height);
  if (scale >= 1) return null;
  const proxy = attachmentProxyUrl(attachment);
  if (!proxy) return null;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const base = proxy;
  const separator = base.endsWith("&") ? "=&" : base.includes("?") ? "&" : "?";
  const quality = kind === "png" ? "&quality=lossless" : "";
  return {
    url: `${base}${separator}format=webp${quality}&width=${targetWidth}&height=${targetHeight}`,
    width: targetWidth,
    height: targetHeight,
  };
}

/** The attachment as fetched through the proxy: its own disk-cache entry, so the original's stays the original. */
export function proxiedAttachment(attachment: DiscordMessageAttachment, request: DiscordMediaProxyRequest): DiscordMessageAttachment {
  const stem = attachment.filename.replace(/\.[^./]+$/, "") || "image";
  return {
    ...attachment,
    url: request.url,
    cacheKey: `${attachment.cacheKey ?? attachment.id}:media-proxy:${request.width}x${request.height}`,
    filename: `${stem}.webp`,
    contentType: "image/webp",
    // The proxy's copy has its own size; any complete download is the copy.
    size: 0,
    width: request.width,
    height: request.height,
  };
}
