/**
 * Message timeline state and rendering helpers.
 */

import type { DiscordMessage } from "./discord";
import { loadingLabel } from "./loading";
import { sliceByWidth, termWidth, truncate } from "./textwidth";
import { theme, toneColor } from "./theme";

export interface TimelineState {
  channelId: string | null;
  messages: DiscordMessage[];
  scrollOffset: number;
  maxScroll: number;
  loading: boolean;
  requestId: number;
}

export interface RenderedTimeline {
  lines: string[];
  maxScroll: number;
}

export function createTimelineState(): TimelineState {
  return {
    channelId: null,
    messages: [],
    scrollOffset: 0,
    maxScroll: 0,
    loading: false,
    requestId: 0,
  };
}

export function clearTimeline(timeline: TimelineState): void {
  timeline.channelId = null;
  timeline.messages = [];
  timeline.scrollOffset = 0;
  timeline.maxScroll = 0;
  timeline.loading = false;
}

export function setTimelineMessages(timeline: TimelineState, channelId: string, messages: DiscordMessage[]): void {
  timeline.channelId = channelId;
  timeline.messages = messages;
  timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  timeline.maxScroll = 0;
  timeline.loading = false;
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

  if (notice.text) {
    for (const line of notice.text.split("\n")) {
      const renderedLine = notice.loading ? loadingLabel(line, loadingFrameIndex) : line;
      allLines.push(`${toneColor(notice.tone)}${truncate(renderedLine, width)}${theme.reset}`);
    }
    if (allLines.length > 0) allLines.push("");
  }

  if (timeline.loading) {
    allLines.push(`${theme.muted}${truncate(loadingLabel("Loading messages…", loadingFrameIndex), width)}${theme.reset}`);
  } else if (!timeline.channelId && timeline.messages.length === 0) {
    // No active channel yet.
  } else if (timeline.messages.length === 0) {
    allLines.push(`${theme.muted}No messages yet.${theme.reset}`);
  } else {
    for (const message of timeline.messages) {
      allLines.push(...renderMessage(message, width));
      allLines.push("");
    }
    while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
  }

  const maxScroll = Math.max(0, allLines.length - Math.max(0, height));
  const scrollOffset = Math.max(0, Math.min(timeline.scrollOffset, maxScroll));
  timeline.scrollOffset = scrollOffset;
  timeline.maxScroll = maxScroll;

  return {
    lines: allLines.slice(scrollOffset, scrollOffset + Math.max(0, height)),
    maxScroll,
  };
}

function renderMessage(message: DiscordMessage, width: number): string[] {
  const time = new Date(message.timestamp).toISOString().slice(11, 16);
  const author = message.author.bot
    ? `${message.author.displayName} [bot]`
    : message.author.displayName;
  const header = `${theme.bold}${truncate(author, Math.max(1, width - 7))}${theme.boldOff}${theme.muted} ${time}${theme.reset}`;

  const content = summarizeMessage(message);
  const wrappedContent = wrapPlainText(content, width);
  if (wrappedContent.length === 0) {
    return [header, `${theme.dim}(empty message)${theme.reset}`];
  }

  return [header, ...wrappedContent.map((line) => `${theme.text}${line}${theme.reset}`)];
}

function summarizeMessage(message: DiscordMessage): string {
  const parts: string[] = [];
  const trimmed = message.content.trim();
  if (trimmed) parts.push(trimmed);
  if (message.attachments.length > 0) {
    const files = message.attachments.map((attachment) => attachment.filename).join(", ");
    parts.push(`[attachments] ${files}`);
  }
  if (message.embedsCount > 0) {
    parts.push(`[embeds] ${message.embedsCount}`);
  }
  return parts.join("\n");
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    let current = rawLine;
    while (termWidth(current) > width) {
      const [taken, rest] = sliceByWidth(current, width);
      if (!taken) {
        lines.push(Array.from(current)[0] ?? "");
        current = Array.from(current).slice(1).join("");
        continue;
      }

      let line = taken;
      let remainder = rest;
      const cut = taken.lastIndexOf(" ");
      if (cut > 0) {
        line = taken.slice(0, cut);
        remainder = current.slice(cut).trimStart();
      }

      lines.push(line);
      current = remainder;
    }
    lines.push(current);
  }

  return lines;
}
