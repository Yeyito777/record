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

function attachmentContentType(attachment: DisplayAttachment): string | null {
  return attachment.contentType ?? attachment.content_type ?? null;
}

function styleText(text: string, color: string | undefined, restore: string | undefined): string {
  return color && restore ? `${color}${text}${restore}` : text;
}

export function formatAttachmentSummary(attachment: DisplayAttachment, style?: MessagePartStyle): string {
  const contentType = attachmentContentType(attachment);
  const details = [contentType, formatByteSize(attachment.size ?? 0)].filter(Boolean);
  const label = styleText(`[${attachmentKind(attachment)}]`, style?.muted, style?.restore);
  const filename = styleText(attachment.filename, style?.accent, style?.restore);
  const suffix = details.length > 0
    ? styleText(` · ${details.join(" · ")}`, style?.muted, style?.restore)
    : "";
  return `${label} ${filename}${suffix}`;
}

function attachmentKind(attachment: DisplayAttachment): string {
  const type = attachmentContentType(attachment)?.toLowerCase() ?? "";
  const filename = attachment.filename.toLowerCase();
  if (type === "image/gif" || filename.endsWith(".gif")) return "gif";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf" || filename.endsWith(".pdf")) return "pdf";
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(filename)) return "archive";
  return "file";
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
  return typeof embeds === "number" ? Array.from({ length: Math.max(0, embeds) }, () => ({})) : embeds;
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

export function formatEmbedSummary(embeds: readonly DisplayEmbed[] | number, content: string, style?: MessagePartStyle): string[] {
  const normalized = normalizeEmbeds(embeds);
  if (normalized.length === 0) return [];

  const hasVisibleLink = /https?:\/\/\S+/i.test(content);
  return normalized.map((embed, index) => {
    const prefixText = hasVisibleLink ? "preview" : "embed";
    const prefix = styleText(`${prefixText}:`, style?.muted, style?.restore);
    const label = embedLabel(embed);
    const styledLabel = label === "preview"
      ? styleText(label, style?.muted, style?.restore)
      : styleText(label, style?.accent, style?.restore);
    const suffix = normalized.length > 1 ? styleText(` ${index + 1}/${normalized.length}`, style?.muted, style?.restore) : "";
    return `${prefix} ${styledLabel}${suffix}`;
  });
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
  if (/\S/.test(normalizedContent)) {
    parts.push(normalizedContent);
  }

  parts.push(...attachments.map((attachment) => formatAttachmentSummary(attachment, style)));

  if (stickerNames.length > 0) {
    parts.push(formatStickerSummary(stickerNames, style));
  }
  parts.push(...formatEmbedSummary(embeds, normalizedContent, style));
  return parts;
}

export function summarizeInlineMessageParts(
  content: string,
  attachments: readonly DisplayAttachment[] = [],
  embeds: readonly DisplayEmbed[] | number = [],
  stickerNames: readonly string[] = [],
): string {
  const parts = summarizeDisplayMessageParts(content, attachments, embeds, stickerNames)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.join(" · ") || "(empty message)";
}
