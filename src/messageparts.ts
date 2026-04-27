export interface DisplayAttachment {
  filename: string;
  contentType?: string | null;
  content_type?: string | null;
  size?: number;
}

function attachmentContentType(attachment: DisplayAttachment): string | null {
  return attachment.contentType ?? attachment.content_type ?? null;
}

export function formatAttachmentSummary(attachment: DisplayAttachment): string {
  const contentType = attachmentContentType(attachment);
  const details = [contentType, formatByteSize(attachment.size ?? 0)].filter(Boolean);
  const suffix = details.length > 0 ? ` · ${details.join(" · ")}` : "";
  return `${attachmentIcon(attachment)} ${attachment.filename}${suffix}`;
}

function attachmentIcon(attachment: DisplayAttachment): string {
  const type = attachmentContentType(attachment)?.toLowerCase() ?? "";
  const filename = attachment.filename.toLowerCase();
  if (type.startsWith("image/") && !filename.endsWith(".gif")) return "🖼";
  if (type.startsWith("video/") || type === "image/gif" || filename.endsWith(".gif")) return "🎞";
  if (type.startsWith("audio/")) return "🔊";
  if (type === "application/pdf" || filename.endsWith(".pdf")) return "📄";
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i.test(filename)) return "📦";
  return "📎";
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

export function formatStickerSummary(stickerNames: readonly string[]): string {
  const label = stickerNames.length === 1 ? "Sticker" : "Stickers";
  return `💟 ${label}: ${stickerNames.join(", ")}`;
}

export function formatEmbedSummary(embedsCount: number, content: string): string {
  const hasVisibleLink = /https?:\/\/\S+/i.test(content);
  if (hasVisibleLink) return embedsCount === 1 ? "↳ preview" : `↳ ${embedsCount} previews`;
  return embedsCount === 1 ? "▣ Embed preview" : `▣ ${embedsCount} embed previews`;
}

export function summarizeDisplayMessageParts(
  content: string,
  attachments: readonly DisplayAttachment[] = [],
  embedsCount = 0,
  stickerNames: readonly string[] = [],
): string[] {
  const parts: string[] = [];
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  if (/\S/.test(normalizedContent)) {
    parts.push(normalizedContent);
  }

  parts.push(...attachments.map(formatAttachmentSummary));

  if (stickerNames.length > 0) {
    parts.push(formatStickerSummary(stickerNames));
  }
  if (embedsCount > 0) {
    parts.push(formatEmbedSummary(embedsCount, normalizedContent));
  }
  return parts;
}

export function summarizeInlineMessageParts(
  content: string,
  attachments: readonly DisplayAttachment[] = [],
  embedsCount = 0,
  stickerNames: readonly string[] = [],
): string {
  const parts = summarizeDisplayMessageParts(content, attachments, embedsCount, stickerNames)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.join(" · ") || "(empty message)";
}
