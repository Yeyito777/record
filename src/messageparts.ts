export interface DisplayAttachment {
  filename: string;
  contentType?: string | null;
  content_type?: string | null;
  size?: number;
}

/** An embed as mapped (DiscordMessageEmbed) or as Discord sends it (reply previews). */
export interface DisplayEmbed {
  type?: string | null;
  title?: string | null;
  url?: string | null;
  description?: string | null;
  providerName?: string | null;
  provider?: { name?: string | null } | null;
  authorName?: string | null;
  author?: { name?: string | null } | null;
  image?: unknown;
  thumbnail?: unknown;
  video?: unknown;
}

export interface MessagePartStyle {
  muted: string;
  accent: string;
  restore: string;
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^;]*;[^\x1b]*\x1b\\/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function styleText(text: string, color: string | undefined, restore: string | undefined): string {
  return color && restore ? `${color}${text}${restore}` : text;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function formatAttachmentSummary(attachment: DisplayAttachment, style?: MessagePartStyle): string {
  const clip = styleText("📎", style?.muted, style?.restore);
  const filename = styleText(attachment.filename, style?.accent, style?.restore);
  const size = formatByteSize(attachment.size ?? 0);
  const suffix = size ? styleText(` • ${size}`, style?.muted, style?.restore) : "";
  return `${clip} ${filename}${suffix}`;
}

export function formatByteSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

export function formatStickerSummary(stickerNames: readonly string[], style?: MessagePartStyle): string {
  const label = stickerNames.length === 1 ? "sticker" : "stickers";
  const prefix = styleText(`[${label}]`, style?.muted, style?.restore);
  return `${prefix} ${stickerNames.join(", ")}`;
}

function normalizeEmbeds(embeds: readonly DisplayEmbed[] | number): readonly DisplayEmbed[] {
  // A bare count (caches from before embeds were kept) has nothing to show.
  return typeof embeds === "number" ? [] : embeds.filter(shouldRenderEmbedPreview);
}

function providerName(embed: DisplayEmbed): string {
  return (embed.providerName ?? embed.provider?.name ?? "").trim();
}

function authorName(embed: DisplayEmbed): string {
  return (embed.authorName ?? embed.author?.name ?? "").trim();
}

function embedTitle(embed: DisplayEmbed): string {
  return (embed.title ?? "").replace(/\s+/g, " ").trim();
}

function embedDescription(embed: DisplayEmbed): string {
  return (embed.description ?? "").replace(/\s+/g, " ").trim();
}

function isTenorUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "tenor.com" || host.endsWith(".tenor.com");
  } catch {
    return /(?:^|\.)tenor\.com$/i.test(url.split(/[/?#]/, 1)[0] ?? "");
  }
}

function urlHost(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function shouldRenderEmbedPreview(embed: DisplayEmbed): boolean {
  if (!embedLabel(embed)) return false;
  const provider = providerName(embed).toLowerCase();
  if (provider !== "tenor" && !isTenorUrl(embed.url)) return true;
  // A Tenor gif's line would only repeat its link.
  if (embedTitle(embed) || embedDescription(embed) || authorName(embed)) return true;
  return false;
}

/** One-line label; empty when the embed has nothing to show but its link. */
function embedLabel(embed: DisplayEmbed): string {
  const provider = providerName(embed);
  const author = authorName(embed);
  const title = embedTitle(embed);
  const description = embedDescription(embed);

  const source = provider || author;
  if (source && title) return `${source}: ${title}`;
  if (title) return title;
  if (source) return source;
  if (description) return description.slice(0, 120);
  // Media only (a video post, a picture): say where it is from.
  const host = urlHost(embed.url);
  if (!host) return "";
  return embed.video || embed.type === "video" || embed.type === "gifv" ? `▶ ${host}`
    : embed.image || embed.thumbnail || embed.type === "image" ? `🖼 ${host}` : host;
}

function formatEmbedLine(embed: DisplayEmbed, suffix: string, style?: MessagePartStyle): string {
  const text = `↳ ${embedLabel(embed)}${suffix}`;
  return styleText(text, style?.muted, style?.restore);
}

export function formatEmbedSummary(embeds: readonly DisplayEmbed[] | number, style?: MessagePartStyle): string[] {
  const normalized = normalizeEmbeds(embeds);
  if (normalized.length === 0) return [];

  return normalized.map((embed, index) => {
    const suffix = normalized.length > 1 ? ` ${index + 1}/${normalized.length}` : "";
    return formatEmbedLine(embed, suffix, style);
  });
}

function trimTrailingTargetPunctuation(target: string): string {
  return target.replace(/[),.;:!?\]}]+$/g, "");
}

function lineUrlTargets(line: string): string[] {
  const plain = stripAnsi(line);
  return [...plain.matchAll(URL_RE)]
    .map((match) => trimTrailingTargetPunctuation(match[0]))
    .filter(Boolean);
}

export function embedMatchesLine(embed: Pick<DisplayEmbed, "url">, line: string): boolean {
  const embedUrl = embed.url?.trim();
  const targets = lineUrlTargets(line);
  if (targets.length === 0) return false;
  if (!embedUrl) return true;
  return targets.some((target) => target === embedUrl || embedUrl.startsWith(target) || target.startsWith(embedUrl));
}

/**
 * The message is nothing but the link of the GIF it embeds (Tenor, Giphy, a
 * .gif): it shows just the GIF, without the link line, as Discord does.
 */
export function isOnlyGifLink(content: string, embeds: readonly DisplayEmbed[]): boolean {
  const text = content.trim();
  if (!/^<?https?:\/\/\S+>?$/.test(text)) return false;
  return embeds.some((embed) => (embed.type === "gifv" || (embed.type === "image" && /\.gif(?:[?#]|$)/i.test(embed.url ?? "")))
    && embedMatchesLine(embed, text.replace(/^<|>$/g, "")));
}

export type DisplayMessagePart<T> =
  | { kind: "text"; text: string }
  /** `placed`: drawn right under the line holding its URL. */
  | { kind: "embed"; embed: T; placed: boolean };

const FENCE_RE = /^\s*```/;

/**
 * A message's text, attachment and sticker rows with its embeds between
 * them: each embed right under the first line holding its URL (never inside
 * a code block), the rest after the attachments.
 */
export function displayMessageParts<T extends Pick<DisplayEmbed, "url">>(
  content: string,
  attachments: readonly DisplayAttachment[],
  embeds: readonly T[],
  stickerNames: readonly string[] = [],
  style?: MessagePartStyle,
): DisplayMessagePart<T>[] {
  const parts: DisplayMessagePart<T>[] = [];
  let text: string[] = [];
  const flushText = (): void => {
    if (text.length > 0) parts.push({ kind: "text", text: text.join("\n") });
    text = [];
  };
  const placed = new Set<number>();
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  if (/\S/.test(normalizedContent)) {
    let inFence = false;
    let waiting: number[] = [];
    for (const line of normalizedContent.split("\n")) {
      text.push(line);
      if (FENCE_RE.test(stripAnsi(line))) inFence = !inFence;
      embeds.forEach((embed, index) => {
        if (placed.has(index) || !embedMatchesLine(embed, line)) return;
        placed.add(index);
        waiting.push(index);
      });
      if (inFence || waiting.length === 0) continue;
      flushText();
      for (const index of waiting) parts.push({ kind: "embed", embed: embeds[index]!, placed: true });
      waiting = [];
    }
    flushText();
    for (const index of waiting) parts.push({ kind: "embed", embed: embeds[index]!, placed: true });
  }

  text.push(...attachments.map((attachment) => formatAttachmentSummary(attachment, style)));
  if (stickerNames.length > 0) text.push(formatStickerSummary(stickerNames, style));
  flushText();
  embeds.forEach((embed, index) => {
    if (!placed.has(index)) parts.push({ kind: "embed", embed, placed: false });
  });
  return parts;
}

export function summarizeDisplayMessageParts(
  content: string,
  attachments: readonly DisplayAttachment[] = [],
  embeds: readonly DisplayEmbed[] | number = [],
  stickerNames: readonly string[] = [],
  style?: MessagePartStyle,
): string[] {
  const parts: string[] = [];
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const normalizedEmbeds = [...normalizeEmbeds(embeds)];
  const placedEmbeds = new Set<number>();

  if (/\S/.test(normalizedContent)) {
    for (const line of normalizedContent.split("\n")) {
      parts.push(line);
      normalizedEmbeds.forEach((embed, index) => {
        if (placedEmbeds.has(index) || !embedMatchesLine(embed, line)) return;
        placedEmbeds.add(index);
        parts.push(formatEmbedLine(embed, "", style));
      });
    }
  }

  parts.push(...attachments.map((attachment) => formatAttachmentSummary(attachment, style)));

  if (stickerNames.length > 0) {
    parts.push(formatStickerSummary(stickerNames, style));
  }

  const unplaced = normalizedEmbeds.filter((_embed, index) => !placedEmbeds.has(index));
  parts.push(...formatEmbedSummary(unplaced, style));
  return parts;
}

export function summarizeInlineMessageParts(
  content: string,
  attachments: readonly DisplayAttachment[] = [],
  embeds: readonly DisplayEmbed[] | number = [],
  stickerNames: readonly string[] = [],
): string {
  const parts: string[] = [];
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  if (normalizedContent) parts.push(normalizedContent);
  parts.push(...attachments.map((attachment) => formatAttachmentSummary(attachment)));
  if (stickerNames.length > 0) parts.push(formatStickerSummary(stickerNames));
  parts.push(...formatEmbedSummary(embeds));
  return parts.map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ") || "(empty message)";
}
