import { describe, expect, test } from "bun:test";

import { render } from "./render";
import { createInitialState, focusHistory } from "./state";
import { setTimelineMessages } from "./timeline";
import { theme } from "./theme";
import type { DiscordMessage } from "./discord";
import { recordTypingStart } from "./typing";

function message(id: string, content: string): DiscordMessage {
  const numericId = Number(id);
  const offsetMinutes = Number.isFinite(numericId) ? numericId * 7 : 0;
  return {
    id,
    channelId: "channel-1",
    type: 0,
    timestamp: Date.UTC(2026, 0, 1, 12, offsetMinutes, 0),
    editedTimestamp: null,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
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

  test("typing indicator bumps an unpinned history viewport instead of covering its bottom row", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    state.auth.user = {
      id: "viewer",
      username: "viewer",
      globalName: null,
      discriminator: "0",
      avatar: null,
      bot: false,
      email: null,
      verified: null,
    };
    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
      message("4", "fourth"),
      message("5", "fifth"),
      message("6", "sixth"),
      message("7", "seventh"),
      message("8", "eighth"),
    ]);
    captureRender(state);
    focusHistory(state);
    state.timeline.scrollOffset = 5;
    captureRender(state);
    const offsetBeforeTyping = state.timeline.scrollOffset;

    recordTypingStart(state.typing, "channel-1", { id: "other-user", displayName: "Alice" }, Date.now());
    captureRender(state);

    expect(state.timeline.scrollOffset).toBe(offsetBeforeTyping + 1);
  });

  test("prompt-focused one-line history scroll is not auto-pinned back to bottom", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
      message("4", "fourth"),
      message("5", "fifth"),
      message("6", "sixth"),
    ]);
    captureRender(state);
    expect(state.chatFocus).toBe("prompt");
    expect(state.timeline.maxScroll).toBeGreaterThan(1);

    state.timeline.scrollOffset = state.timeline.maxScroll - 1;
    captureRender(state);

    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll - 1);
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

  test("renders voice-message listening prompt in the theme accent color", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    state.voiceMessagePrompt = { phase: "recording", frameIndex: 0 };

    const output = captureRender(state);

    expect(output).toContain(`${theme.accent}⠋ Listening…${theme.reset}`);
  });

  test("keeps status notices out of populated chat history", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 100;
    state.rows = 12;
    setTimelineMessages(state.timeline, "channel-1", [message("1", "sacred chat")]);
    state.notice = { text: "Hidden channels shown.", tone: "muted", loading: false, statusLine: true, chat: true };

    const output = captureRender(state);

    expect(output).toContain("sacred chat");
    expect(output).toContain("Hidden channels shown.");
    expect(output.indexOf("Hidden channels shown.")).toBeGreaterThan(output.indexOf("N "));
    expect(state.historyLines.join("\n")).not.toContain("Hidden channels shown.");
  });

  test("renders pinged message rows with the ping background", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    state.auth.user = {
      id: "viewer",
      username: "viewer",
      globalName: null,
      discriminator: "0",
      avatar: null,
      bot: false,
      email: null,
      verified: null,
    };
    const ping = message("1", "hi <@viewer>");
    ping.author.id = "other-user";
    ping.mentionUserIds = ["viewer"];
    setTimelineMessages(state.timeline, "channel-1", [ping]);

    const output = captureRender(state);

    expect(state.historyLineBackgrounds.slice(0, 2)).toEqual([theme.pingBg, theme.pingBg]);
    expect(output).toContain(theme.pingBg);
  });
});
