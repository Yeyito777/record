import { isThreadChannel, type DiscordMessageAttachment } from "./discord";
import { contentBounds, logicalLineRange, stripAnsi } from "./historycursor";
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
  const logicalLine = logicalLineAtHistoryCursor(state);
  if (!logicalLine) return null;

  const message = selectedHistoryMessage(state);
  const attachments = message ? [...message.attachments, ...(message.forwarded?.attachments ?? [])] : [];
  if (!message || attachments.length === 0) return null;

  for (const attachment of attachments) {
    let searchFrom = 0;
    while (searchFrom < logicalLine.text.length) {
      const filenameStart = logicalLine.text.indexOf(attachment.filename, searchFrom);
      if (filenameStart === -1) break;
      const filenameEnd = filenameStart + attachment.filename.length;
      const clipStart = logicalLine.text.lastIndexOf("📎", filenameStart);
      const start = clipStart >= searchFrom ? clipStart : filenameStart;
      if (logicalLine.cursorOffset >= start && logicalLine.cursorOffset < filenameEnd) return attachment;
      searchFrom = filenameEnd;
    }
  }

  return null;
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
  if (!logicalLine) return null;

  for (const match of findOpenableTargetMatches(logicalLine.text)) {
    if (logicalLine.cursorOffset >= match.start && logicalLine.cursorOffset < match.end) return match.target;
  }

  return attachmentAtHistoryCursor(state)?.url ?? null;
}
