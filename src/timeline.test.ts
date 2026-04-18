import { describe, expect, test } from "bun:test";

import { createTimelineState, renderTimelineLines } from "./timeline";

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
});
