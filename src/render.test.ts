import { describe, expect, test } from "bun:test";

import { render } from "./render";
import { createInitialState } from "./state";
import { setTimelineMessages } from "./timeline";
import type { DiscordMessage } from "./discord";

function message(id: string, content: string): DiscordMessage {
  return {
    id,
    channelId: "channel-1",
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    editedTimestamp: null,
    content,
    author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
    reply: null,
    attachments: [],
    embedsCount: 0,
  };
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

    const originalWrite = process.stdout.write;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = (() => true) as typeof process.stdout.write;
    try {
      render(state);
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
    }

    expect(state.timeline.maxScroll).toBeGreaterThan(0);
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
  });
});
