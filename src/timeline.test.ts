import { describe, expect, test } from "bun:test";

import {
  createTimelineState,
  prependTimelineMessages,
  renderTimelineLines,
  setTimelineMessages,
  setTimelineRenderContext,
  startLoadingOlderMessages,
} from "./timeline";
import { theme } from "./theme";
import { termWidth } from "./textwidth";
import type { DiscordMessage } from "./discord";

function message(
  id: string,
  content: string,
  options: { authorId?: string; authorName?: string; bot?: boolean } = {},
): DiscordMessage {
  return {
    id,
    channelId: "channel-1",
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    editedTimestamp: null,
    content,
    author: {
      id: options.authorId ?? "user-1",
      username: "tester",
      displayName: options.authorName ?? "Tester",
      bot: options.bot ?? false,
    },
    attachments: [],
    embedsCount: 0,
  };
}

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("timeline rendering", () => {
  test("loading notices use the shared spinner label", () => {
    const timeline = createTimelineState();
    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "Validating token…", tone: "muted", loading: true },
      1,
    );

    expect(rendered.lines[0]).toContain("⠙ Validating token…");
  });

  test("message loading uses the shared spinner label", () => {
    const timeline = createTimelineState();
    timeline.loading = true;

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain("⠋ Loading messages…");
  });

  test("shows a top loader while fetching older messages", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("2", "newer")], { hasOlder: true });
    timeline.scrollOffset = 0;
    startLoadingOlderMessages(timeline);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain("⠋ Loading older messages…");
  });

  test("prepending older messages shifts scroll to preserve the current viewport", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("2", "newer")], { hasOlder: true });
    timeline.scrollOffset = 0;
    startLoadingOlderMessages(timeline);

    prependTimelineMessages(timeline, [message("1", "older")], 80, { hasOlder: false });

    expect(timeline.loadingOlder).toBe(false);
    expect(timeline.hasOlder).toBe(false);
    expect(timeline.messages.map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(timeline.scrollOffset).toBe(0);
  });

  test("reuses cached timeline content across identical redraws", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "before **bold** *italic* `code` after")]);

    const first = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );
    const second = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(second.allLines).toBe(first.allLines);
    expect(second.lineAnchors).toBe(first.lineAnchors);
    expect(second.wrapContinuation).toBe(first.wrapContinuation);
    expect(second.messageBounds).toBe(first.messageBounds);
  });

  test("invalidates cached timeline content after prepending older messages", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("2", "newer")], { hasOlder: true });

    const first = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    prependTimelineMessages(timeline, [message("1", "older **message**")], 80, { hasOlder: false });

    const second = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(second.allLines).not.toBe(first.allLines);
    expect(second.lines.map(stripAnsi).some((line) => line.includes("older message"))).toBe(true);
  });

  test("wraps wide unicode message content by terminal columns", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "memes＆media 【the🦋chat】 café")]);

    const rendered = renderTimelineLines(
      timeline,
      12,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    for (const line of plainLines.slice(1)) {
      expect(termWidth(line)).toBeLessThanOrEqual(12);
    }
  });

  test("renders inline markdown formatting in chat history", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "before **bold** *italic* `code` after")]);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("before bold italic code after");
    expect(rendered.lines[1]).not.toContain("**bold**");
    expect(rendered.lines[1]).not.toContain("*italic*");
    expect(rendered.lines[1]).not.toContain("`code`");
  });

  test("renders fenced code blocks with gutter and language label", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "```ts\nconst x = 1\n```")]);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines).toContain("▎ ts");
    expect(plainLines).toContain("▎ const x = 1");
  });

  test("renders markdown tables with box drawing", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "| Name | Value |\n| --- | --- |\n| foo | bar |")]);

    const rendered = renderTimelineLines(
      timeline,
      40,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines.some((line) => line.startsWith("┌"))).toBe(true);
    expect(plainLines.some((line) => line.includes("│ Name") && line.includes("│ Value "))).toBe(true);
    expect(plainLines.some((line) => line.startsWith("└"))).toBe(true);
  });

  test("renders the viewer display name in accent inside direct messages", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "hello", { authorId: "viewer", authorName: "Paramount" })]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      40,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain(theme.accent);
    expect(stripAnsi(rendered.lines[0] ?? "")).toContain("Paramount 12:00");
  });

  test("renders markdown horizontal rules", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "---")]);

    const rendered = renderTimelineLines(
      timeline,
      20,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("────────────────────");
  });
});
