/**
 * Media refs (docs/social-protocol.md §3.5) for Discord's pictures, and the
 * URL each is fetched from at the size the app draws it, the way record
 * asks for them: avatars, server and group icons as PNG at a power-of-two
 * `size`, custom emoji as lossless PNG, attachments through the media proxy
 * scaled to the box (record's discordmedia.ts), link-preview pictures
 * through their proxy URL. Refs are short where the URL can be rebuilt and
 * carry the URL where Discord signs it; only Discord's own hosts are ever
 * fetched.
 */

import { discordAttachmentProxyRequest } from "../../../discordmedia";
import { BridgeError, type WireMedia } from "../../protocol";

const CDN = "https://cdn.discordapp.com";
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"]);

function iconSize(max: number | null, fallback: number): number {
  const wanted = Math.max(16, Math.min(4096, max ?? fallback));
  let size = 16;
  while (size < wanted) size *= 2;
  return size;
}

export function avatarMedia(userId: string, hash: string): WireMedia {
  return { ref: `av:${userId}:${hash}`, kind: "image", w: 1024, h: 1024, mime: "image/png" };
}

export function defaultAvatarMedia(userId: string): WireMedia {
  const index = /^\d+$/.test(userId) ? Number((BigInt(userId) >> 22n) % 6n) : 0;
  return { ref: `dav:${index}`, kind: "image", w: 256, h: 256, mime: "image/png" };
}

export function memberAvatarMedia(guildId: string, userId: string, hash: string): WireMedia {
  return { ref: `gav:${guildId}:${userId}:${hash}`, kind: "image", w: 1024, h: 1024, mime: "image/png" };
}

export function guildIconMedia(guildId: string, hash: string): WireMedia {
  return { ref: `ic:${guildId}:${hash}`, kind: "image", w: 1024, h: 1024, mime: "image/png" };
}

export function groupIconMedia(channelId: string, hash: string): WireMedia {
  return { ref: `gi:${channelId}:${hash}`, kind: "image", w: 1024, h: 1024, mime: "image/png" };
}

export function emojiMedia(emojiId: string, animated: boolean): WireMedia {
  return { ref: `em:${emojiId}`, kind: animated ? "gif" : "image", w: 128, h: 128, mime: "image/png" };
}

/** A sticker, unless it is a Lottie one (format 3), which nothing here draws. */
export function stickerMedia(stickerId: string, name: string, format: number | null): WireMedia | null {
  if (format === 3) return null;
  return { ref: `st:${stickerId}`, kind: "sticker", w: 320, h: 320, mime: "image/png", name };
}

/** An attachment or embed picture: `p:W:H:TYPE:URL` (the proxy scales it), `u:URL` as is. */
export function proxiedRef(url: string, width: number | null | undefined, height: number | null | undefined, contentType: string | null | undefined): string {
  if (width && height && width > 0 && height > 0) return `p:${Math.round(width)}:${Math.round(height)}:${contentType ?? ""}:${url}`;
  return `u:${url}`;
}

/** A video's first frame, from the media proxy. */
export function posterRef(url: string, width: number | null | undefined, height: number | null | undefined): string {
  return `v:${Math.round(width ?? 0)}:${Math.round(height ?? 0)}:${url}`;
}

function allowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeError("invalid_argument", "bad media ref");
  }
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) throw new BridgeError("invalid_argument", "not a Discord media URL");
  return parsed;
}

/** The query's signature (ex/is/hm) changes when Discord re-signs a link: not part of the cache key. */
function stableKey(url: URL): string {
  return `${url.hostname}${url.pathname}`;
}

export interface MediaRequest {
  url: string;
  /** The media cache's key: the same picture at the same size is one file. */
  key: string;
  mime: string;
}

function withQuery(url: string, query: string): string {
  const separator = url.endsWith("&") ? "=&" : url.includes("?") ? "&" : "?";
  return `${url}${separator}${query}`;
}

/** Where to fetch `ref` for a box `max` px on its longest side. */
export function mediaRequest(ref: string, max: number | null): MediaRequest {
  const colon = ref.indexOf(":");
  const kind = colon > 0 ? ref.slice(0, colon) : "";
  const rest = colon > 0 ? ref.slice(colon + 1) : "";
  const parts = rest.split(":");
  const id = (value: string | undefined) => {
    if (!value || !/^\d{1,22}$/.test(value)) throw new BridgeError("invalid_argument", "bad media ref");
    return value;
  };
  const hash = (value: string | undefined) => {
    if (!value || !/^(a_)?[0-9a-f]{8,64}$/i.test(value)) throw new BridgeError("invalid_argument", "bad media ref");
    return value;
  };
  switch (kind) {
    case "av": {
      const size = iconSize(max, 128);
      const url = `${CDN}/avatars/${id(parts[0])}/${hash(parts[1])}.png?size=${size}`;
      return { url, key: `av/${parts[0]}/${parts[1]}@${size}`, mime: "image/png" };
    }
    case "gav": {
      const size = iconSize(max, 128);
      const url = `${CDN}/guilds/${id(parts[0])}/users/${id(parts[1])}/avatars/${hash(parts[2])}.png?size=${size}`;
      return { url, key: `gav/${parts[0]}/${parts[1]}/${parts[2]}@${size}`, mime: "image/png" };
    }
    case "dav": {
      const index = Number(parts[0]);
      if (!Number.isInteger(index) || index < 0 || index > 5) throw new BridgeError("invalid_argument", "bad media ref");
      return { url: `${CDN}/embed/avatars/${index}.png`, key: `dav/${index}`, mime: "image/png" };
    }
    case "ic": {
      const size = iconSize(max, 128);
      const url = `${CDN}/icons/${id(parts[0])}/${hash(parts[1])}.png?size=${size}`;
      return { url, key: `ic/${parts[0]}/${parts[1]}@${size}`, mime: "image/png" };
    }
    case "gi": {
      const size = iconSize(max, 128);
      const url = `${CDN}/channel-icons/${id(parts[0])}/${hash(parts[1])}.png?size=${size}`;
      return { url, key: `gi/${parts[0]}/${parts[1]}@${size}`, mime: "image/png" };
    }
    case "em": {
      const size = iconSize(max, 64);
      const url = `${CDN}/emojis/${id(parts[0])}.png?size=${size}&quality=lossless`;
      return { url, key: `em/${parts[0]}@${size}`, mime: "image/png" };
    }
    case "st": {
      const url = `${CDN}/stickers/${id(parts[0])}.png`;
      return { url, key: `st/${parts[0]}`, mime: "image/png" };
    }
    case "p": {
      const width = Number(parts[0]);
      const height = Number(parts[1]);
      const contentType = parts[2] || null;
      const url = parts.slice(3).join(":");
      const parsed = allowed(url);
      const filename = parsed.pathname.split("/").at(-1) ?? "";
      const box = max ?? Math.max(width, height);
      const request = parsed.pathname.startsWith("/attachments/")
        ? discordAttachmentProxyRequest({ url, proxyUrl: url, contentType, filename, width, height }, box, box)
        : null;
      if (request) {
        allowed(request.url);
        return { url: request.url, key: `${stableKey(parsed)}@${request.width}x${request.height}`, mime: "image/webp" };
      }
      if (parsed.hostname.startsWith("images-ext-") && width > 0 && height > 0) {
        // A link preview's picture: its proxy scales it the same way.
        const scale = Math.min(1, box / Math.max(width, height));
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const scaled = scale < 1 ? withQuery(url, `width=${w}&height=${h}`) : url;
        return { url: scaled, key: `${stableKey(parsed)}${parsed.search}@${w}x${h}`, mime: contentType ?? "image/png" };
      }
      return { url, key: `${stableKey(parsed)}${parsed.hostname.startsWith("images-ext-") ? parsed.search : ""}`, mime: contentType ?? "image/png" };
    }
    case "v": {
      const width = Number(parts[0]);
      const height = Number(parts[1]);
      const url = parts.slice(2).join(":");
      const parsed = allowed(url.replace(/^https:\/\/cdn\.discordapp\.com\//i, "https://media.discordapp.net/"));
      const base = parsed.href;
      const box = max ?? 640;
      const scale = width > 0 && height > 0 ? Math.min(1, box / Math.max(width, height)) : 1;
      const size = width > 0 && height > 0 ? `&width=${Math.max(1, Math.round(width * scale))}&height=${Math.max(1, Math.round(height * scale))}` : "";
      return { url: withQuery(base, `format=webp${size}`), key: `${stableKey(parsed)}#poster@${Math.round(width * scale)}`, mime: "image/webp" };
    }
    case "u": {
      const parsed = allowed(rest);
      return { url: rest, key: `${stableKey(parsed)}${parsed.hostname.startsWith("images-ext-") ? parsed.search : ""}`, mime: "image/png" };
    }
    default:
      throw new BridgeError("invalid_argument", "unknown media ref");
  }
}
