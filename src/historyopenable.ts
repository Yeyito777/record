import { isThreadChannel, type DiscordMessageAttachment } from "./discord";
import { contentBounds, logicalLineRange, stripAnsi } from "./historycursor";
import { embedForSourceId, embedGroupForKey, embedVideoTarget, isEmbedSourceId, parseEmbedSourceId, type EmbedVideoTarget } from "./embeds";
import { inlineImageSourcesForMessage } from "./inlineimage";
import { findOpenableTargetMatches } from "./openable";
import type { AppState } from "./state";

export interface ForwardedOriginTarget {
  messageId: string;
  channelId: string;
  guildId: string | null;
}

export interface ThreadChannelTarget {
  channelId: string;
  guildId: string | null;
}

interface LogicalCursorLine {
  text: string;
  cursorOffset: number;
}

function logicalLineAtHistoryCursor(state: AppState): LogicalCursorLine | null {
  const row = state.historyCursor.row;
  const lines = state.historyLines;
  if (row < 0 || row >= lines.length) return null;

  const range = state.historyWrapContinuation.length > 0
    ? logicalLineRange(row, state.historyWrapContinuation)
    : { first: row, last: row };

  let logicalText = "";
  let cursorOffset: number | null = null;
  for (let r = range.first; r <= range.last; r++) {
    const plain = stripAnsi(lines[r] ?? "");
    const bounds = contentBounds(plain);
    const segment = plain.slice(bounds.start, bounds.end + 1);
    const joiner = r === range.first ? "" : " ";
    logicalText += joiner;
    const segmentStart = logicalText.length;
    logicalText += segment;

    if (r !== row) continue;
    const col = state.historyCursor.col;
    if (col < bounds.start || col > bounds.end) return null;
    cursorOffset = segmentStart + Math.max(0, Math.min(col - bounds.start, segment.length - 1));
  }

  return cursorOffset == null ? null : { text: logicalText, cursorOffset };
}

function selectedHistoryMessage(state: AppState) {
  const row = state.historyCursor.row;
  const bound = state.historyMessageBounds.find((entry) => row >= entry.start && row < entry.end);
  if (!bound) return null;
  return state.timeline.messages.find((message) => message.id === bound.messageId) ?? null;
}

function attachmentIdFromInlineImageAnchor(anchor: string | undefined): string | null {
  if (!anchor) return null;
  const marker = anchor.includes(":image-status:") ? ":image-status:" : ":image:";
  const markerIndex = anchor.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const encoded = anchor.slice(markerIndex + marker.length).split(":", 1)[0] ?? "";
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function attachmentIdFromInlineImageBodyAnchor(anchor: string | undefined): string | null {
  if (!anchor) return null;
  const marker = ":image:";
  const markerIndex = anchor.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const encoded = anchor.slice(markerIndex + marker.length).split(":", 1)[0] ?? "";
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function forwardedOriginAtHistoryCursor(state: AppState): ForwardedOriginTarget | null {
  const message = selectedHistoryMessage(state);
  const forwarded = message?.forwarded;
  if (!forwarded?.originMessageId || !forwarded.originChannelId) return null;
  return {
    messageId: forwarded.originMessageId,
    channelId: forwarded.originChannelId,
    guildId: forwarded.originGuildId,
  };
}

export function threadChannelAtHistoryCursor(state: AppState): ThreadChannelTarget | null {
  const message = selectedHistoryMessage(state);
  if (!message) return null;
  if (message.threadId) return { channelId: message.threadId, guildId: message.guildId ?? null };
  if (message.type !== 18) return null;

  // Older Record caches discarded the type-18 message reference. Recover its
  // thread from the parent channel and event content so existing rows remain
  // keyboard-openable after upgrading.
  const name = message.content
    .replace(/^🧵\s*Started a thread:\s*/i, "")
    .replace(/^Started a thread:\s*/i, "")
    .trim();
  if (!name) return null;
  const channels = [
    ...state.channelList.channels,
    ...Object.values(state.sidebar.cachedChannelsByGuildId).flat(),
  ];
  const candidates = [...new Map(channels.map((channel) => [channel.id, channel])).values()]
    .filter((channel) => isThreadChannel(channel) && channel.parentId === message.channelId && channel.name === name)
    .sort((left, right) => Math.abs((left.thread?.createTimestamp ?? message.timestamp) - message.timestamp)
      - Math.abs((right.thread?.createTimestamp ?? message.timestamp) - message.timestamp));
  const thread = candidates[0];
  return thread ? { channelId: thread.id, guildId: thread.guildId } : null;
}

export function attachmentAtHistoryCursor(state: AppState): DiscordMessageAttachment | null {
  const message = selectedHistoryMessage(state);
  const attachments = message ? inlineImageSourcesForMessage(message) : [];
  const anchoredAttachmentId = attachmentIdFromInlineImageAnchor(state.historyLineAnchors[state.historyCursor.row]);
  if (anchoredAttachmentId) {
    return attachments.find((attachment) => attachment.id === anchoredAttachmentId) ?? null;
  }

  const logicalLine = logicalLineAtHistoryCursor(state);
  if (!logicalLine) return null;

  if (!message || attachments.length === 0) return null;

  for (const attachment of attachments) {
    // Embed pictures have no name row to match.
    if (isEmbedSourceId(attachment.id)) continue;
    const providerSticker = [...(message.stickers ?? []), ...(message.forwarded?.stickers ?? [])]
      .find((item) => item.attachment?.id === attachment.id);
    const sticker = Boolean(providerSticker) || attachment.id.startsWith("sticker:");
    const displayName = sticker
      ? providerSticker?.name ?? attachment.filename.replace(/\.[^.]+$/, "")
      : attachment.filename;
    let searchFrom = 0;
    while (searchFrom < logicalLine.text.length) {
      const filenameStart = logicalLine.text.indexOf(displayName, searchFrom);
      if (filenameStart === -1) break;
      const filenameEnd = filenameStart + displayName.length;
      const prefix = sticker ? "[sticker]" : "📎";
      const prefixStart = logicalLine.text.lastIndexOf(prefix, filenameStart);
      const start = prefixStart >= searchFrom ? prefixStart : filenameStart;
      if (logicalLine.cursorOffset >= start && logicalLine.cursorOffset < filenameEnd) return attachment;
      searchFrom = filenameEnd;
    }
  }

  return null;
}

/** The image drawn under the cursor's cell, for pictures beside text or each other (embeds). */
function inlineImageIdUnderHistoryCursor(state: AppState): string | null {
  const { row, col } = state.historyCursor;
  for (const placement of state.historyInlineImages) {
    const offset = placement.columnOffset ?? 0;
    if (row >= placement.lineIndex && row < placement.lineIndex + placement.rows && col >= offset && col < offset + placement.columns) {
      return placement.image.attachmentId;
    }
  }
  return null;
}

/** Return an attachment only when the cursor is on its rendered image body. */
export function inlineImageBodyAttachmentAtHistoryCursor(state: AppState): DiscordMessageAttachment | null {
  const message = selectedHistoryMessage(state);
  if (!message) return null;
  const attachmentId = inlineImageIdUnderHistoryCursor(state)
    ?? attachmentIdFromInlineImageBodyAnchor(state.historyLineAnchors[state.historyCursor.row]);
  if (!attachmentId) return null;
  return inlineImageSourcesForMessage(message)
    .find((attachment) => attachment.id === attachmentId)
    ?? null;
}

/**
 * Return the configured-openable target currently under the history cursor.
 *
 * This supports http/https links and configured local file paths in rendered
 * message text. It also maps Discord attachment filenames back to their CDN URL
 * when the cursor is on an attachment name.
 */
export function openableTargetAtHistoryCursor(state: AppState): string | null {
  const logicalLine = logicalLineAtHistoryCursor(state);
  if (logicalLine) {
    for (const match of findOpenableTargetMatches(logicalLine.text)) {
      if (logicalLine.cursorOffset >= match.start && logicalLine.cursorOffset < match.end) return match.target;
    }
  }

  const embedLink = embedLinkAtHistoryCursor(state);
  if (embedLink) return embedLink;
  if (!logicalLine) return null;
  return attachmentAtHistoryCursor(state)?.url ?? null;
}

const EMBED_ROW_ANCHOR_RE = /^msg:(.+):embed:([^:]+):(\d+):([a-z]+)\d*:(\d+)$/;

function embedRowAtHistoryCursor(state: AppState) {
  const match = EMBED_ROW_ANCHOR_RE.exec(state.historyLineAnchors[state.historyCursor.row] ?? "");
  if (!match) return null;
  const message = selectedHistoryMessage(state);
  if (!message || message.id !== match[1]) return null;
  let occurrence: string;
  try {
    occurrence = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  const group = embedGroupForKey(message, occurrence, Number(match[3]));
  return group ? { group, occurrence, part: match[4]! } : null;
}

/** The link an embed row opens: its title's URL, its author's, its provider's. */
export function embedLinkAtHistoryCursor(state: AppState): string | null {
  const row = embedRowAtHistoryCursor(state);
  if (!row) return null;
  const { embed } = row.group;
  switch (row.part) {
    case "title":
    case "host":
      return embed.url ?? null;
    case "author":
      return embed.authorUrl ?? null;
    case "provider":
      return embed.providerUrl ?? null;
    default:
      return null;
  }
}

/** The video a cursor on a video embed's poster or play row opens. */
export function embedVideoAtHistoryCursor(state: AppState): EmbedVideoTarget | null {
  const row = embedRowAtHistoryCursor(state);
  if (row?.part === "video") return embedVideoTarget(row.group.embed, row.occurrence, row.group.index);
  if (row) return null;
  const message = selectedHistoryMessage(state);
  if (!message) return null;
  const sourceId = inlineImageIdUnderHistoryCursor(state)
    ?? attachmentIdFromInlineImageAnchor(state.historyLineAnchors[state.historyCursor.row]);
  if (!sourceId || parseEmbedSourceId(sourceId)?.role !== "poster") return null;
  const found = embedForSourceId(message, sourceId);
  return found ? embedVideoTarget(found.group.embed, parseEmbedSourceId(sourceId)!.occurrence, found.group.index) : null;
}

/** Whether a click at this history position opens something: an image, attachment, link or path. */
export function historyTargetAt(state: AppState, position: { row: number; col: number }): boolean {
  const saved = state.historyCursor;
  state.historyCursor = { ...saved, row: position.row, col: position.col };
  try {
    return embedVideoAtHistoryCursor(state) !== null
      || inlineImageBodyAttachmentAtHistoryCursor(state) !== null
      || openableTargetAtHistoryCursor(state) !== null;
  } finally {
    state.historyCursor = saved;
  }
}

/** Whether a history row is part of an inline image's body (a click anywhere on it opens the image). */
export function isInlineImageBodyRow(state: AppState, row: number): boolean {
  return attachmentIdFromInlineImageBodyAnchor(state.historyLineAnchors[row]) !== null;
}
