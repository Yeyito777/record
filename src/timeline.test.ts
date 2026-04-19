import { describe, expect, test } from "bun:test";

import {
  createTimelineState,
  prependTimelineMessages,
  renderTimelineLines,
  setTimelineMessages,
  startLoadingOlderMessages,
} from "./timeline";
import { termWidth } from "./textwidth";
import type { DiscordMessage } from "./discord";

function message(id: string, content: string): DiscordMessage {
  return {
    id,
    channelId: "channel-1",
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    editedTimestamp: null,
    content,
    author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
    attachments: [],
    embedsCount: 0,
  };
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

    const plainLines = rendered.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    for (const line of plainLines.slice(1)) {
      expect(termWidth(line)).toBeLessThanOrEqual(12);
    }
  });
});
