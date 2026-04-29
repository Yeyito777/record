export interface DisplayAttachment {
  filename: string;
  contentType?: string | null;
  content_type?: string | null;
  size?: number;
}

export interface DisplayEmbed {
  type?: string | null;
  title?: string | null;
  url?: string | null;
  description?: string | null;
  providerName?: string | null;
  provider?: { name?: string | null } | null;
  authorName?: string | null;
  author?: { name?: string | null } | null;
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
  return typeof embeds === "number"
    ? Array.from({ length: Math.max(0, embeds) }, () => ({}))
    : embeds.filter(shouldRenderEmbedPreview);
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

function shouldRenderEmbedPreview(embed: DisplayEmbed): boolean {
  const provider = providerName(embed).toLowerCase();
  if (provider !== "tenor" && !isTenorUrl(embed.url)) return true;
  if (embedTitle(embed) || embedDescription(embed) || authorName(embed)) return true;
  return false;
}

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
  return "preview";
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

function embedMatchesLine(embed: DisplayEmbed, line: string): boolean {
  const embedUrl = embed.url?.trim();
  const targets = lineUrlTargets(line);
  if (targets.length === 0) return false;
  if (!embedUrl) return true;
  return targets.some((target) => target === embedUrl || embedUrl.startsWith(target) || target.startsWith(embedUrl));
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
