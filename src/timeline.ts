/**
 * Message timeline state and rendering helpers.
 */

import type { DiscordMessage } from "./discord";
import { loadingLabel } from "./loading";
import { markdownWordWrap } from "./markdown";
import { sliceByWidth, termWidth, truncate } from "./textwidth";
import { dmAuthorColor, theme, toneColor } from "./theme";

export interface TimelineState {
  channelId: string | null;
  messages: DiscordMessage[];
  scrollOffset: number;
  maxScroll: number;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  requestId: number;
  viewerId: string | null;
  accentViewerInDirectMessages: boolean;
}

export interface TimelineMessageBound {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

export interface RenderedTimeline {
  lines: string[];
  allLines: string[];
  lineAnchors: string[];
  wrapContinuation: boolean[];
  messageBounds: TimelineMessageBound[];
  maxScroll: number;
}

interface WrappedLine {
  text: string;
  wrapContinuation: boolean;
  visualIndex: number;
}

interface RenderedMessage {
  lines: string[];
  lineAnchors: string[];
  wrapContinuation: boolean[];
}

interface CachedRenderedMessage {
  width: number;
  fingerprint: string;
  rendered: RenderedMessage;
}

interface CachedTimelineContent {
  width: number;
  version: number;
  lines: string[];
  lineAnchors: string[];
  wrapContinuation: boolean[];
  messageBounds: TimelineMessageBound[];
}

interface TimelineCacheState {
  version: number;
  messageRenderCache: Map<string, CachedRenderedMessage>;
  contentCache: CachedTimelineContent | null;
}

const timelineCaches = new WeakMap<TimelineState, TimelineCacheState>();

export function createTimelineState(): TimelineState {
  return {
    channelId: null,
    messages: [],
    scrollOffset: 0,
    maxScroll: 0,
    loading: false,
    loadingOlder: false,
    hasOlder: false,
    requestId: 0,
    viewerId: null,
    accentViewerInDirectMessages: false,
  };
}

export function clearTimeline(timeline: TimelineState): void {
  timeline.channelId = null;
  timeline.messages = [];
  timeline.scrollOffset = 0;
  timeline.maxScroll = 0;
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.hasOlder = false;
  resetTimelineRenderCaches(timeline);
}

export function setTimelineMessages(
  timeline: TimelineState,
  channelId: string,
  messages: DiscordMessage[],
  options: { hasOlder?: boolean } = {},
): void {
  timeline.channelId = channelId;
  timeline.messages = messages;
  timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  timeline.maxScroll = 0;
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.hasOlder = options.hasOlder ?? messages.length > 0;
  resetTimelineRenderCaches(timeline);
}

export function startLoadingOlderMessages(timeline: TimelineState): void {
  if (timeline.loading || timeline.loadingOlder || !timeline.hasOlder || !timeline.channelId) return;
  timeline.loadingOlder = true;
}

export function finishLoadingOlderMessages(timeline: TimelineState, hasOlder = timeline.hasOlder): void {
  timeline.loadingOlder = false;
  timeline.hasOlder = hasOlder;
}

export function prependTimelineMessages(
  timeline: TimelineState,
  messages: DiscordMessage[],
  width: number,
  options: { hasOlder: boolean },
): number {
  if (messages.length === 0) {
    finishLoadingOlderMessages(timeline, options.hasOlder);
    return 0;
  }

  const insertedRows = countRenderedMessageRows(timeline, messages, width);
  timeline.messages = [...messages, ...timeline.messages];
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.hasOlder = options.hasOlder;
  invalidateTimelineContentCache(timeline);
  return insertedRows;
}

export function shouldLoadOlderMessages(timeline: TimelineState): boolean {
  if (timeline.loading || timeline.loadingOlder || !timeline.hasOlder || !timeline.channelId || timeline.messages.length === 0) {
    return false;
  }

  if (timeline.maxScroll === 0) {
    return timeline.scrollOffset === 0;
  }

  return timeline.scrollOffset <= Math.floor(timeline.maxScroll / 2);
}

export function moveTimelineScroll(timeline: TimelineState, delta: number): void {
  timeline.scrollOffset = Math.max(0, Math.min(timeline.scrollOffset + delta, timeline.maxScroll));
}

export function setTimelineRenderContext(
  timeline: TimelineState,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
): void {
  if (timeline.viewerId === viewerId && timeline.accentViewerInDirectMessages === accentViewerInDirectMessages) {
    return;
  }

  timeline.viewerId = viewerId;
  timeline.accentViewerInDirectMessages = accentViewerInDirectMessages;
  resetTimelineRenderCaches(timeline);
}

export function renderTimelineLines(
  timeline: TimelineState,
  width: number,
  height: number,
  notice: { text: string; tone: "muted" | "success" | "warning" | "error"; loading?: boolean },
  loadingFrameIndex = 0,
): RenderedTimeline {
  let allLines: string[] = [];
  let lineAnchors: string[] = [];
  let wrapContinuation: boolean[] = [];
  let messageBounds: TimelineMessageBound[] = [];

  if (notice.text) {
    for (const [index, line] of notice.text.split("\n").entries()) {
      const renderedLine = notice.loading ? loadingLabel(line, loadingFrameIndex) : line;
      allLines.push(`${toneColor(notice.tone)}${truncate(renderedLine, width)}${theme.reset}`);
      lineAnchors.push(`notice:${index}:${notice.loading ? "loading" : "static"}:${line}`);
      wrapContinuation.push(false);
    }
    if (allLines.length > 0) {
      allLines.push("");
      lineAnchors.push("notice:gap");
      wrapContinuation.push(false);
    }
  }

  if (timeline.loading) {
    allLines.push(`${theme.muted}${truncate(loadingLabel("Loading messages…", loadingFrameIndex), width)}${theme.reset}`);
    lineAnchors.push("timeline:loading");
    wrapContinuation.push(false);
  } else {
    const content = getRenderedTimelineContent(timeline, width);
    if (notice.text || timeline.loadingOlder) {
      if (timeline.loadingOlder) {
        allLines.push(`${theme.muted}${truncate(loadingLabel("Loading older messages…", loadingFrameIndex), width)}${theme.reset}`);
        lineAnchors.push("timeline:loading-older");
        wrapContinuation.push(false);
      }
      appendRenderedTimelineContent(allLines, lineAnchors, wrapContinuation, messageBounds, content);
    } else {
      allLines = content.lines;
      lineAnchors = content.lineAnchors;
      wrapContinuation = content.wrapContinuation;
      messageBounds = content.messageBounds;
    }
  }

  const maxScroll = Math.max(0, allLines.length - Math.max(0, height));
  const scrollOffset = Math.max(0, Math.min(timeline.scrollOffset, maxScroll));
  timeline.scrollOffset = scrollOffset;
  timeline.maxScroll = maxScroll;

  return {
    lines: allLines.slice(scrollOffset, scrollOffset + Math.max(0, height)),
    allLines,
    lineAnchors,
    wrapContinuation,
    messageBounds,
    maxScroll,
  };
}

function countRenderedMessageRows(timeline: TimelineState, messages: DiscordMessage[], width: number): number {
  let total = 0;
  for (const message of messages) {
    total += renderMessageCached(timeline, message, width).lines.length + 1;
  }
  return total;
}

function appendRenderedTimelineContent(
  allLines: string[],
  lineAnchors: string[],
  wrapContinuation: boolean[],
  messageBounds: TimelineMessageBound[],
  content: CachedTimelineContent,
): void {
  const offset = allLines.length;
  allLines.push(...content.lines);
  lineAnchors.push(...content.lineAnchors);
  wrapContinuation.push(...content.wrapContinuation);
  if (offset === 0) {
    messageBounds.push(...content.messageBounds);
    return;
  }
  messageBounds.push(...content.messageBounds.map((bound) => ({
    start: bound.start + offset,
    end: bound.end + offset,
    contentStart: bound.contentStart + offset,
    contentEnd: bound.contentEnd + offset,
  })));
}

function getRenderedTimelineContent(timeline: TimelineState, width: number): CachedTimelineContent {
  const cacheState = getTimelineCacheState(timeline);
  if (cacheState.contentCache && cacheState.contentCache.width === width && cacheState.contentCache.version === cacheState.version) {
    return cacheState.contentCache;
  }

  const lines: string[] = [];
  const lineAnchors: string[] = [];
  const wrapContinuation: boolean[] = [];
  const messageBounds: TimelineMessageBound[] = [];

  if (!timeline.channelId && timeline.messages.length === 0) {
    // No active channel yet.
  } else if (timeline.messages.length === 0) {
    lines.push(`${theme.muted}No messages yet.${theme.reset}`);
    lineAnchors.push("timeline:empty");
    wrapContinuation.push(false);
  } else {
    for (const message of timeline.messages) {
      const renderedMessage = renderMessageCached(timeline, message, width);
      const start = lines.length;
      lines.push(...renderedMessage.lines);
      lineAnchors.push(...renderedMessage.lineAnchors);
      wrapContinuation.push(...renderedMessage.wrapContinuation);
      messageBounds.push({
        start,
        end: start + renderedMessage.lines.length,
        contentStart: start,
        contentEnd: start + renderedMessage.lines.length,
      });
      lines.push("");
      lineAnchors.push(`msg:${message.id}:gap`);
      wrapContinuation.push(false);
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
      lineAnchors.pop();
      wrapContinuation.pop();
    }
  }

  const content = {
    width,
    version: cacheState.version,
    lines,
    lineAnchors,
    wrapContinuation,
    messageBounds,
  };
  cacheState.contentCache = content;
  return content;
}

function renderMessageCached(timeline: TimelineState, message: DiscordMessage, width: number): RenderedMessage {
  const cacheState = getTimelineCacheState(timeline);
  const fingerprint = messageRenderFingerprint(message);
  const cached = cacheState.messageRenderCache.get(message.id);
  if (cached && cached.width === width && cached.fingerprint === fingerprint) {
    return cached.rendered;
  }

  const rendered = renderMessage(message, width, timeline.viewerId, timeline.accentViewerInDirectMessages);
  cacheState.messageRenderCache.set(message.id, { width, fingerprint, rendered });
  return rendered;
}

function renderMessage(
  message: DiscordMessage,
  width: number,
  viewerId: string | null,
  accentViewerInDirectMessages: boolean,
): RenderedMessage {
  const time = new Date(message.timestamp).toISOString().slice(11, 16);
  const author = message.author.bot
    ? `${message.author.displayName} [bot]`
    : message.author.displayName;
  const authorColor = accentViewerInDirectMessages
    ? viewerId === message.author.id
      ? theme.accent
      : dmAuthorColor(message.author.id)
    : "";
  const header = `${theme.bold}${authorColor}${truncate(author, Math.max(1, width - 7))}${theme.boldOff}${theme.muted} ${time}${theme.reset}`;
  const replyPreview = wrapReplyPreview(message, width);

  const content = summarizeMessage(message);
  if (content === "") {
    return {
      lines: [
        ...replyPreview.map((line) => `${theme.muted}${line.text}${theme.reset}`),
        header,
        `${theme.dim}(empty message)${theme.reset}`,
      ],
      lineAnchors: [
        ...replyPreview.map((line) => `msg:${message.id}:reply:${line.visualIndex}`),
        `msg:${message.id}:header`,
        `msg:${message.id}:empty`,
      ],
      wrapContinuation: [...replyPreview.map((line) => line.wrapContinuation), false, false],
    };
  }

  const wrappedContent = wrapMarkdownText(content, width);
  return {
    lines: [
      ...replyPreview.map((line) => `${theme.muted}${line.text}${theme.reset}`),
      header,
      ...wrappedContent.map((line) => `${theme.text}${line.text}${theme.reset}`),
    ],
    lineAnchors: [
      ...replyPreview.map((line) => `msg:${message.id}:reply:${line.visualIndex}`),
      `msg:${message.id}:header`,
      ...wrappedContent.map((line) => `msg:${message.id}:content:${line.visualIndex}`),
    ],
    wrapContinuation: [
      ...replyPreview.map((line) => line.wrapContinuation),
      false,
      ...wrappedContent.map((line) => line.wrapContinuation),
    ],
  };
}

function summarizeMessage(message: DiscordMessage): string {
  return summarizeMessageParts(message.content, message.attachments, message.embedsCount).join("\n");
}

function summarizeMessageParts(
  content: string,
  attachments: Array<{ filename: string }>,
  embedsCount: number,
): string[] {
  const parts: string[] = [];
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  if (/\S/.test(normalizedContent)) {
    parts.push(normalizedContent);
  }
  if (attachments.length > 0) {
    parts.push(`[attachments] ${attachments.map((attachment) => attachment.filename).join(", ")}`);
  }
  if (embedsCount > 0) {
    parts.push(`[embeds] ${embedsCount}`);
  }
  return parts;
}

function wrapReplyPreview(message: DiscordMessage, width: number): WrappedLine[] {
  if (!message.reply || width <= 0) return [];

  const prefix = "↪ ";
  const preview = formatReplyPreview(message.reply);
  if (width <= termWidth(prefix)) {
    return wrapPlainText(`↪ ${preview}`, width).map((line, visualIndex) => ({
      text: line,
      wrapContinuation: visualIndex > 0,
      visualIndex,
    }));
  }

  const continuationPrefix = "  ";
  const bodyWidth = width - termWidth(prefix);
  const lines = wrapPlainText(preview, bodyWidth);

  return lines.map((line, visualIndex) => ({
    text: `${visualIndex === 0 ? prefix : continuationPrefix}${line}`,
    wrapContinuation: visualIndex > 0,
    visualIndex,
  }));
}

function formatReplyPreview(reply: NonNullable<DiscordMessage["reply"]>): string {
  const parts: string[] = [];
  if (reply.authorDisplayName) {
    parts.push(reply.authorDisplayName);
  }
  parts.push(reply.summary);
  return parts.join(" · ");
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) return [];

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (!current) {
        current = wrapFirstWord(word, width, lines);
        continue;
      }

      const candidate = `${current} ${word}`;
      if (termWidth(candidate) <= width) {
        current = candidate;
        continue;
      }

      lines.push(current);
      current = wrapFirstWord(word, width, lines);
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [""];
}

function wrapFirstWord(word: string, width: number, lines: string[]): string {
  let remaining = word;
  while (termWidth(remaining) > width) {
    const [taken, rest] = sliceByWidth(remaining, width);
    if (!taken) {
      lines.push(remaining[0] ?? "");
      remaining = remaining.slice(1);
      continue;
    }
    lines.push(taken);
    remaining = rest;
  }
  return remaining;
}

function wrapMarkdownText(text: string, width: number): WrappedLine[] {
  if (width <= 0) return [];

  const wrapped = markdownWordWrap(text, width, theme.text);
  return wrapped.lines.map((line, visualIndex) => ({
    text: line,
    wrapContinuation: wrapped.cont[visualIndex] ?? false,
    visualIndex,
  }));
}

function getTimelineCacheState(timeline: TimelineState): TimelineCacheState {
  let cacheState = timelineCaches.get(timeline);
  if (cacheState) return cacheState;

  cacheState = {
    version: 0,
    messageRenderCache: new Map(),
    contentCache: null,
  };
  timelineCaches.set(timeline, cacheState);
  return cacheState;
}

function invalidateTimelineContentCache(timeline: TimelineState): void {
  const cacheState = getTimelineCacheState(timeline);
  cacheState.version += 1;
  cacheState.contentCache = null;
}

function resetTimelineRenderCaches(timeline: TimelineState): void {
  const cacheState = getTimelineCacheState(timeline);
  cacheState.version += 1;
  cacheState.messageRenderCache.clear();
  cacheState.contentCache = null;
}

function messageRenderFingerprint(message: DiscordMessage): string {
  const attachmentKey = message.attachments.map((attachment) => attachment.filename).join("\u0000");
  const replyKey = message.reply
    ? [
      message.reply.messageId ?? "",
      message.reply.authorId ?? "",
      message.reply.authorDisplayName ?? "",
      String(message.reply.timestamp ?? ""),
      message.reply.summary,
    ].join("\u0000")
    : "";
  return [
    String(message.timestamp),
    message.author.id,
    message.author.displayName,
    message.author.bot ? "1" : "0",
    message.content,
    replyKey,
    attachmentKey,
    String(message.embedsCount),
  ].join("\u0001");
}
