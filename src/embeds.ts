/**
 * Discord embeds (link previews and bot embeds): what one shows, and its
 * pictures as sources for the inline-image pipeline (inlineimage.ts).
 */

import type { DiscordMessage, DiscordMessageAttachment, DiscordMessageEmbed, DiscordMessageEmbedMedia } from "./discord";

/** How an embed picture is drawn: large below, small at the right, or a video's poster. */
export type EmbedMediaRole = "image" | "thumbnail" | "poster";

export interface EmbedMediaSource {
  attachment: DiscordMessageAttachment;
  role: EmbedMediaRole;
  media: DiscordMessageEmbedMedia;
}

/** One embed as drawn: Discord merges same-URL embeds carrying only an image into a gallery. */
export interface EmbedGroup {
  embed: DiscordMessageEmbed;
  /** Index in the message's embed list; part of every row anchor and source id. */
  index: number;
  /** The lead picture or poster first, then gallery images. */
  media: EmbedMediaSource[];
}

const EMBED_SOURCE_PREFIX = "embed:";
const DISCORD_MEDIA_PROXY_HOST_RE = /^(?:media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/i;
const IMAGE_FILE_RE = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;
/** Size requested from Discord's media proxy: comfortably above what a chat row draws, even on HiDPI. */
const LARGE_MEDIA_BOUNDS = { width: 1280, height: 720 };
const THUMBNAIL_MEDIA_BOUNDS = { width: 400, height: 400 };

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function embedHost(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export function isTenorEmbed(embed: Pick<DiscordMessageEmbed, "providerName" | "url">): boolean {
  if (clean(embed.providerName).toLowerCase() === "tenor") return true;
  const host = embedHost(embed.url).toLowerCase();
  return host === "tenor.com" || host.endsWith(".tenor.com");
}

/** Whether the embed has any text of its own to show (beyond its URL). */
export function embedHasText(embed: DiscordMessageEmbed): boolean {
  return Boolean(clean(embed.title) || clean(embed.description) || clean(embed.authorName)
    || (embed.fields ?? []).some((field) => clean(field.name) || clean(field.value))
    || clean(embed.footer?.text));
}

/** Plays as a video in Discord: YouTube, Tenor/Giphy gifs, fxtwitter-style video posts. */
export function isVideoEmbed(embed: DiscordMessageEmbed): boolean {
  if (embed.type === "image") return false;
  return embed.type === "video" || embed.type === "gifv" || Boolean(embed.video);
}

/** Discord draws image and gifv embeds as bare media, without the embed's box. */
export function isBareMediaEmbed(embed: DiscordMessageEmbed): boolean {
  if (embed.type === "image" || embed.type === "gifv") return true;
  return !embedHasText(embed) && !clean(embed.providerName) && Boolean(embed.video || embed.image || embed.thumbnail);
}

function hasOnlyImage(embed: DiscordMessageEmbed): boolean {
  return Boolean(embed.image) && !embedHasText(embed) && !embed.thumbnail && !embed.video;
}

/** Whether an embed has nothing to show at all (no text, picture or video). */
export function embedIsEmpty(embed: DiscordMessageEmbed): boolean {
  return !embedHasText(embed) && !clean(embed.providerName) && !embed.image && !embed.thumbnail && !embed.video;
}

function isDiscordMediaProxy(url: URL): boolean {
  return url.protocol === "https:" && DISCORD_MEDIA_PROXY_HOST_RE.test(url.hostname);
}

/**
 * The URL to load a picture from: Discord's proxy (the original host never
 * sees the viewer), asking it for no more pixels than a chat row can use.
 */
export function embedMediaUrl(
  media: DiscordMessageEmbedMedia,
  bounds: { width: number; height: number },
  extraParams: Readonly<Record<string, string>> = {},
): string {
  const proxy = media.proxyUrl;
  if (!proxy) return media.url;
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return proxy;
  }
  if (!isDiscordMediaProxy(url)) return proxy;
  if (media.width && media.height) {
    const scale = Math.min(1, bounds.width / media.width, bounds.height / media.height);
    if (scale < 1) {
      url.searchParams.set("width", String(Math.max(1, Math.round(media.width * scale))));
      url.searchParams.set("height", String(Math.max(1, Math.round(media.height * scale))));
    }
  }
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * A still frame for a video with no thumbnail: Discord's proxy renders one
 * (`format=jpeg`). Only its proxy can; an original host is never asked.
 */
function videoPosterMedia(video: DiscordMessageEmbedMedia): { media: DiscordMessageEmbedMedia; params: Record<string, string> } | null {
  if (!video.proxyUrl) return null;
  try {
    if (!isDiscordMediaProxy(new URL(video.proxyUrl))) return null;
  } catch {
    return null;
  }
  return { media: video, params: { format: "jpeg" } };
}

function mediaFilename(url: string, role: EmbedMediaRole): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
    if (IMAGE_FILE_RE.test(name)) return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  } catch {
    // Fall through to a generic name.
  }
  return role === "thumbnail" ? "thumbnail.jpg" : role === "poster" ? "poster.jpg" : "image.jpg";
}

export function embedSourceId(occurrence: string, index: number, role: EmbedMediaRole): string {
  return `${EMBED_SOURCE_PREFIX}${occurrence}:${index}:${role}`;
}

export function isEmbedSourceId(id: string): boolean {
  return id.startsWith(EMBED_SOURCE_PREFIX);
}

/** occurrence:index:role of an embed source id, or null. */
export function parseEmbedSourceId(id: string): { occurrence: string; index: number; role: EmbedMediaRole } | null {
  if (!isEmbedSourceId(id)) return null;
  const match = /^(.+):(\d+):(image|thumbnail|poster)$/.exec(id.slice(EMBED_SOURCE_PREFIX.length));
  if (!match) return null;
  return { occurrence: match[1]!, index: Number(match[2]), role: match[3] as EmbedMediaRole };
}

function mediaSource(
  occurrence: string,
  index: number,
  role: EmbedMediaRole,
  media: DiscordMessageEmbedMedia,
  params: Record<string, string> = {},
): EmbedMediaSource {
  const url = embedMediaUrl(media, role === "thumbnail" ? THUMBNAIL_MEDIA_BOUNDS : LARGE_MEDIA_BOUNDS, params);
  return {
    role,
    media,
    attachment: {
      id: embedSourceId(occurrence, index, role),
      // Embeds are re-sent on every edit and unfurl: key the bytes by URL.
      cacheKey: `discord-embed:${url}`,
      filename: mediaFilename(media.url, role),
      contentType: "image/embed",
      // Embed media carries no byte size; zero asks the downloader for any non-empty body.
      size: 0,
      url,
      ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
    },
  };
}

/** The pictures one embed draws, lead first. */
function embedMedia(embed: DiscordMessageEmbed, occurrence: string, index: number): EmbedMediaSource[] {
  if (isVideoEmbed(embed)) {
    const still = embed.thumbnail ?? embed.image;
    if (still) return [mediaSource(occurrence, index, "poster", still)];
    const poster = embed.video ? videoPosterMedia(embed.video) : null;
    return poster ? [mediaSource(occurrence, index, "poster", poster.media, poster.params)] : [];
  }
  if (embed.type === "image") {
    const picture = embed.image ?? embed.thumbnail;
    return picture ? [mediaSource(occurrence, index, "image", picture)] : [];
  }
  const sources: EmbedMediaSource[] = [];
  if (embed.image) sources.push(mediaSource(occurrence, index, "image", embed.image));
  if (embed.thumbnail) sources.push(mediaSource(occurrence, index, "thumbnail", embed.thumbnail));
  return sources;
}

function sameEmbed(left: DiscordMessageEmbed, right: DiscordMessageEmbed): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Embeds as drawn: exact duplicates dropped, and same-URL image-only embeds
 * (a tweet's extra pictures) folded into the embed before them as a gallery.
 */
export function embedGroups(embeds: readonly DiscordMessageEmbed[], occurrence: string): EmbedGroup[] {
  if (embeds.length === 0) return [];
  // Messages keep their embed array until an update replaces it; image
  // sources are asked for on every frame.
  let byOccurrence = groupCache.get(embeds);
  const cached = byOccurrence?.get(occurrence);
  if (cached) return cached;
  const groups = buildEmbedGroups(embeds, occurrence);
  if (!byOccurrence) {
    byOccurrence = new Map();
    groupCache.set(embeds, byOccurrence);
  }
  byOccurrence.set(occurrence, groups);
  return groups;
}

const groupCache = new WeakMap<readonly DiscordMessageEmbed[], Map<string, EmbedGroup[]>>();

function buildEmbedGroups(embeds: readonly DiscordMessageEmbed[], occurrence: string): EmbedGroup[] {
  const groups: EmbedGroup[] = [];
  embeds.forEach((embed, index) => {
    if (groups.some((group) => sameEmbed(group.embed, embed))) return;
    const previous = groups.at(-1);
    if (previous && embed.url && previous.embed.url === embed.url && hasOnlyImage(embed) && !isVideoEmbed(previous.embed)) {
      previous.media.push(mediaSource(occurrence, index, "image", embed.image!));
      return;
    }
    groups.push({ embed, index, media: embedMedia(embed, occurrence, index) });
  });
  return groups;
}

/** Source ids of a forwarded message's embeds stay apart from the message's own. */
export function forwardedEmbedOccurrence(messageId: string): string {
  return `${messageId}~fwd`;
}

/** Every embed picture of a message (and of the message it forwards) as inline-image sources. */
export function embedImageSources(message: Pick<DiscordMessage, "id" | "embeds" | "forwarded">): DiscordMessageAttachment[] {
  const sources: DiscordMessageAttachment[] = [];
  for (const group of embedGroups(message.embeds ?? [], message.id)) sources.push(...group.media.map((source) => source.attachment));
  const forwarded = message.forwarded?.embeds ?? [];
  for (const group of embedGroups(forwarded, forwardedEmbedOccurrence(message.id))) sources.push(...group.media.map((source) => source.attachment));
  return sources;
}

/** The embed a source id belongs to, with its group. */
export function embedForSourceId(
  message: Pick<DiscordMessage, "id" | "embeds" | "forwarded">,
  sourceId: string,
): { group: EmbedGroup; source: EmbedMediaSource } | null {
  const parsed = parseEmbedSourceId(sourceId);
  if (!parsed) return null;
  const embeds = parsed.occurrence === message.id
    ? message.embeds ?? []
    : parsed.occurrence === forwardedEmbedOccurrence(message.id) ? message.forwarded?.embeds ?? [] : [];
  for (const group of embedGroups(embeds, parsed.occurrence)) {
    const source = group.media.find((candidate) => candidate.attachment.id === sourceId);
    if (source) return { group, source };
  }
  return null;
}

/** The embed group a row anchor's `occurrence:index` names. */
export function embedGroupForKey(
  message: Pick<DiscordMessage, "id" | "embeds" | "forwarded">,
  occurrence: string,
  index: number,
): EmbedGroup | null {
  const embeds = occurrence === message.id
    ? message.embeds ?? []
    : occurrence === forwardedEmbedOccurrence(message.id) ? message.forwarded?.embeds ?? [] : [];
  return embedGroups(embeds, occurrence).find((group) => group.index === index) ?? null;
}

/** What opening a video embed plays. */
export type EmbedVideoTarget =
  /** A media file: downloaded and opened like a video attachment. */
  | { kind: "file"; attachment: DiscordMessageAttachment }
  /** A page (YouTube, Tenor): opened with the URL opener (Tenor through its gif download). */
  | { kind: "link"; url: string };

const VIDEO_FILE_RE = /\.(?:mp4|m4v|mov|webm|mkv|gif)$/i;

function videoFilename(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
    return VIDEO_FILE_RE.test(name) ? name.replace(/[\u0000-\u001f\u007f-\u009f\/\\]/g, "") : null;
  } catch {
    return null;
  }
}

export function embedVideoTarget(embed: DiscordMessageEmbed, occurrence: string, index: number): EmbedVideoTarget | null {
  if (!isVideoEmbed(embed)) return null;
  // Tenor pages resolve to their gif (openable.ts); keep that path.
  if (isTenorEmbed(embed) && embed.url) return { kind: "link", url: embed.url };
  const video = embed.video;
  const fileUrl = video ? (video.proxyUrl ?? video.url) : null;
  const filename = video ? videoFilename(video.url) ?? (video.proxyUrl ? videoFilename(video.proxyUrl) : null) : null;
  if (video && fileUrl && filename) {
    return {
      kind: "file",
      attachment: {
        id: `embed-video:${occurrence}:${index}`,
        cacheKey: `discord-embed-video:${video.url}`,
        filename,
        contentType: null,
        size: 0,
        url: fileUrl,
      },
    };
  }
  const page = embed.url ?? video?.url ?? null;
  return page ? { kind: "link", url: page } : null;
}

export function formatVideoDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}
