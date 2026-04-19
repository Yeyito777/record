import { describe, expect, test } from "bun:test";

import { createTimelineState, renderTimelineLines, setTimelineMessages } from "./timeline";
import { termWidth } from "./textwidth";

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

  test("wraps wide unicode message content by terminal columns", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [{
      id: "message-1",
      channelId: "channel-1",
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      editedTimestamp: null,
      content: "memes＆media 【the🦋chat】 café",
      author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
      attachments: [],
      embedsCount: 0,
    }]);

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
