/**
 * Message timeline state and rendering helpers.
 */

import type { DiscordMessage } from "./discord";
import { loadingLabel } from "./loading";
import { markdownWordWrap } from "./markdown";
import { truncate } from "./textwidth";
import { theme, toneColor } from "./theme";

export interface TimelineState {
  channelId: string | null;
  messages: DiscordMessage[];
  scrollOffset: number;
  maxScroll: number;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  requestId: number;
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

  const insertedRows = countRenderedMessageRows(messages, width);
  timeline.messages = [...messages, ...timeline.messages];
  timeline.loading = false;
  timeline.loadingOlder = false;
  timeline.hasOlder = options.hasOlder;
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

export function renderTimelineLines(
  timeline: TimelineState,
  width: number,
  height: number,
  notice: { text: string; tone: "muted" | "success" | "warning" | "error"; loading?: boolean },
  loadingFrameIndex = 0,
): RenderedTimeline {
  const allLines: string[] = [];
  const lineAnchors: string[] = [];
  const wrapContinuation: boolean[] = [];
  const messageBounds: TimelineMessageBound[] = [];

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
  } else if (!timeline.channelId && timeline.messages.length === 0) {
    // No active channel yet.
  } else {
    if (timeline.loadingOlder) {
      allLines.push(`${theme.muted}${truncate(loadingLabel("Loading older messages…", loadingFrameIndex), width)}${theme.reset}`);
      lineAnchors.push("timeline:loading-older");
      wrapContinuation.push(false);
    }

    if (timeline.messages.length === 0) {
      allLines.push(`${theme.muted}No messages yet.${theme.reset}`);
      lineAnchors.push("timeline:empty");
      wrapContinuation.push(false);
    } else {
      for (const message of timeline.messages) {
        const renderedMessage = renderMessage(message, width);
        const start = allLines.length;
        allLines.push(...renderedMessage.lines);
        lineAnchors.push(...renderedMessage.lineAnchors);
        wrapContinuation.push(...renderedMessage.wrapContinuation);
        messageBounds.push({
          start,
          end: start + renderedMessage.lines.length,
          contentStart: start,
          contentEnd: start + renderedMessage.lines.length,
        });
        allLines.push("");
        lineAnchors.push(`msg:${message.id}:gap`);
        wrapContinuation.push(false);
      }
      while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
        allLines.pop();
        lineAnchors.pop();
        wrapContinuation.pop();
      }
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

function countRenderedMessageRows(messages: DiscordMessage[], width: number): number {
  let total = 0;
  for (const message of messages) {
    total += renderMessage(message, width).lines.length + 1;
  }
  return total;
}

function renderMessage(message: DiscordMessage, width: number): RenderedMessage {
  const time = new Date(message.timestamp).toISOString().slice(11, 16);
  const author = message.author.bot
    ? `${message.author.displayName} [bot]`
    : message.author.displayName;
  const header = `${theme.bold}${truncate(author, Math.max(1, width - 7))}${theme.boldOff}${theme.muted} ${time}${theme.reset}`;

  const content = summarizeMessage(message);
  if (content === "") {
    return {
      lines: [header, `${theme.dim}(empty message)${theme.reset}`],
      lineAnchors: [`msg:${message.id}:header`, `msg:${message.id}:empty`],
      wrapContinuation: [false, false],
    };
  }

  const wrappedContent = wrapMarkdownText(content, width);
  return {
    lines: [header, ...wrappedContent.map((line) => `${theme.text}${line.text}${theme.reset}`)],
    lineAnchors: [
      `msg:${message.id}:header`,
      ...wrappedContent.map((line) => `msg:${message.id}:content:${line.visualIndex}`),
    ],
    wrapContinuation: [false, ...wrappedContent.map((line) => line.wrapContinuation)],
  };
}

function summarizeMessage(message: DiscordMessage): string {
  const parts: string[] = [];
  const content = message.content.replace(/\r\n?/g, "\n");
  if (/\S/.test(content)) parts.push(content);
  if (message.attachments.length > 0) {
    const files = message.attachments.map((attachment) => attachment.filename).join(", ");
    parts.push(`[attachments] ${files}`);
  }
  if (message.embedsCount > 0) {
    parts.push(`[embeds] ${message.embedsCount}`);
  }
  return parts.join("\n");
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
