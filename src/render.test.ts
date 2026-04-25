import { describe, expect, test } from "bun:test";

import { render } from "./render";
import { createInitialState } from "./state";
import { setTimelineMessages } from "./timeline";
import type { DiscordMessage } from "./discord";

function message(id: string, content: string): DiscordMessage {
  return {
    id,
    channelId: "channel-1",
    type: 0,
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    editedTimestamp: null,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
    reply: null,
    call: null,
    attachments: [],
    embedsCount: 0,
  };
}

function captureRender(state: ReturnType<typeof createInitialState>): string {
  let output = "";
  const originalWrite = process.stdout.write;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
  }
  return output;
}

describe("render", () => {
  test("opening a new channel stays pinned to the bottom even with old history anchors", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    state.historyLineAnchors = ["msg:old:header"];
    state.historyLines = ["old line"];

    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
    ]);

    captureRender(state);

    expect(state.timeline.maxScroll).toBeGreaterThan(0);
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
  });

  test("pending images push chat history up while keeping the bottom pinned", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
      message("4", "fourth"),
    ]);
    captureRender(state);
    const baselineMaxScroll = state.timeline.maxScroll;
    expect(state.timeline.scrollOffset).toBe(baselineMaxScroll);

    state.pendingImages = [{ mediaType: "image/png", base64: "", sizeBytes: 1536, filename: "image-1.png" }];
    captureRender(state);

    expect(state.timeline.maxScroll).toBe(baselineMaxScroll + 1);
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
  });

  test("renders pending images between prompt separator and prompt line", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    state.pendingImages = [{ mediaType: "image/png", base64: "", sizeBytes: 1536, filename: "image-1.png" }];

    const output = captureRender(state);

    expect(output).toContain("📎 Image pasted (PNG, 1.5 KB)");
    expect(output.indexOf("📎 Image pasted")).toBeLessThan(output.indexOf("I\x1b["));
  });
});
