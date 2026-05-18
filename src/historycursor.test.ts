import { describe, expect, test } from "bun:test";

import {
  buildLineAnchorIndex,
  getHistoryVisualSelection,
  handleHistoryVimKey,
  jumpHistoryCursorToReplyTarget,
  placeHistoryCursorAtVisibleBottom,
  replyTargetAtHistoryCursor,
  remapRenderedRow,
  scrollHistoryPageWithCursor,
  scrollHistoryViewportSticky,
  scrollHistoryWithCursor,
} from "./historycursor";
import type { DiscordMessage } from "./discord";
import { createInitialState } from "./state";

function message(id: string, content: string, reply: DiscordMessage["reply"] = null): DiscordMessage {
  return {
    id,
    channelId: "channel-1",
    guildId: "guild-1",
    type: 0,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    timestamp: Date.parse("2025-01-01T00:00:00Z"),
    editedTimestamp: null,
    author: { id: `author-${id}`, username: `user-${id}`, displayName: `User ${id}`, bot: false },
    reply,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
  };
}

describe("history cursor", () => {
  test("places the cursor at the visible bottom of the current viewport", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = ["one", "two", "three", "four"];
    state.timeline.scrollOffset = 1;

    placeHistoryCursorAtVisibleBottom(state, 2);

    expect(state.historyCursor).toEqual({ row: 2, col: 0 });
  });

  test("remaps rows by stable line anchors across history mutations", () => {
    const oldAnchors = ["msg:2:header", "msg:2:content:0:0", "msg:3:header"];
    const newAnchors = [
      "timeline:loading-older",
      "msg:1:header",
      "msg:1:content:0:0",
      "msg:2:header",
      "msg:2:content:0:0",
      "msg:3:header",
    ];

    const index = buildLineAnchorIndex(newAnchors);

    expect(remapRenderedRow(0, oldAnchors, index)).toBe(3);
    expect(remapRenderedRow(1, oldAnchors, index)).toBe(4);
    expect(remapRenderedRow(2, oldAnchors, index)).toBe(5);
  });

  test("resolves and jumps from a rendered reply preview to its original message", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [
      message("original", "hello"),
      message("reply", "replying", {
        messageId: "original",
        channelId: "channel-1",
        authorId: "author-original",
        authorDisplayName: "Original Author",
        timestamp: Date.parse("2025-01-01T00:00:00Z"),
        summary: "hello",
      }),
    ];
    state.historyLines = [
      "Original Author 00:00",
      "hello",
      "",
      "↱ Original Author: hello",
      "Reply Author 00:01",
      "replying",
    ];
    state.historyLineAnchors = [
      "msg:original:header",
      "msg:original:content:0",
      "msg:original:gap",
      "msg:reply:reply:0",
      "msg:reply:header",
      "msg:reply:content:0",
    ];
    state.historyMessageBounds = [
      { messageId: "original", start: 0, end: 2, contentStart: 0, contentEnd: 2 },
      { messageId: "reply", start: 3, end: 6, contentStart: 3, contentEnd: 6 },
    ];
    state.historyCursor = { row: 3, col: 0 };
    state.timeline.scrollOffset = 3;
    state.timeline.maxScroll = 3;

    expect(replyTargetAtHistoryCursor(state)).toEqual({ messageId: "original", channelId: "channel-1" });
    expect(jumpHistoryCursorToReplyTarget(state, 3)).toEqual({ messageId: "original", channelId: "channel-1" });

    expect(state.historyCursor).toEqual({ row: 0, col: 0 });
    expect(state.timeline.scrollOffset).toBe(0);
  });

  test("line scrolling keeps the history cursor sticky until it would leave the viewport", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = Array.from({ length: 10 }, (_unused, index) => `line ${index}`);
    state.timeline.scrollOffset = 5;
    state.historyCursor = { row: 5, col: 0 };

    scrollHistoryViewportSticky(state, -1, 3);

    expect(state.timeline.scrollOffset).toBe(6);
    expect(state.historyCursor.row).toBe(6);

    scrollHistoryViewportSticky(state, 1, 3);

    expect(state.timeline.scrollOffset).toBe(5);
    expect(state.historyCursor.row).toBe(6);
  });

  test("half-page scrolling moves the cursor even when the viewport is already at an edge", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = Array.from({ length: 20 }, (_unused, index) => `line ${index}`);
    state.timeline.scrollOffset = 0;
    state.historyCursor = { row: 3, col: 0 };

    scrollHistoryWithCursor(state, 1, 5, 5);

    expect(state.timeline.scrollOffset).toBe(0);
    expect(state.historyCursor.row).toBe(0);

    state.timeline.scrollOffset = 15;
    state.historyCursor = { row: 16, col: 0 };
    scrollHistoryWithCursor(state, -1, 5, 5);

    expect(state.timeline.scrollOffset).toBe(15);
    expect(state.historyCursor.row).toBe(19);
  });

  test("full-page scrolling moves the window first and only clamps the cursor on-screen", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = Array.from({ length: 20 }, (_unused, index) => `line ${index}`);
    state.timeline.scrollOffset = 5;
    state.historyCursor = { row: 6, col: 0 };

    scrollHistoryPageWithCursor(state, -1, 5, 5);

    expect(state.timeline.scrollOffset).toBe(10);
    expect(state.historyCursor.row).toBe(10);

    state.historyCursor = { row: 12, col: 0 };
    scrollHistoryPageWithCursor(state, 1, 5, 5);

    expect(state.timeline.scrollOffset).toBe(5);
    expect(state.historyCursor.row).toBe(9);
  });

  test("supports quote text objects in history visual mode", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = ["The \"quick brown\" fox"];
    state.historyWrapContinuation = [false];
    state.historyCursor = { row: 0, col: 7 };

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 3)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "i" }, 3)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "\"" }, 3)).toBe(true);

    expect(state.editor.mode).toBe("visual");
    expect(getHistoryVisualSelection(state)).toBe("quick brown");
  });

  test("lowercase message text object selects only message text", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = [
      "Alice 12:00",
      "  hello there",
      "",
      "Bob 12:01",
      "  later",
    ];
    state.historyWrapContinuation = [false, false, false, false, false];
    state.historyLineAnchors = [
      "msg:message-1:header",
      "msg:message-1:content:0",
      "msg:message-1:gap",
      "msg:message-2:header",
      "msg:message-2:content:0",
    ];
    state.historyMessageBounds = [
      { messageId: "message-1", start: 0, end: 3, contentStart: 1, contentEnd: 2 },
      { messageId: "message-2", start: 3, end: 5, contentStart: 4, contentEnd: 5 },
    ];
    state.historyCursor = { row: 1, col: 2 };

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "i" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "m" }, 5)).toBe(true);

    expect(state.editor.mode).toBe("visual");
    expect(getHistoryVisualSelection(state)).toBe("hello there");
  });

  test("uppercase message text object selects the full rendered message", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = [
      "Alice 12:00",
      "  hello there",
      "",
      "Bob 12:01",
      "  later",
    ];
    state.historyWrapContinuation = [false, false, false, false, false];
    state.historyLineAnchors = [
      "msg:message-1:header",
      "msg:message-1:content:0",
      "msg:message-1:gap",
      "msg:message-2:header",
      "msg:message-2:content:0",
    ];
    state.historyMessageBounds = [
      { messageId: "message-1", start: 0, end: 3, contentStart: 1, contentEnd: 2 },
      { messageId: "message-2", start: 3, end: 5, contentStart: 4, contentEnd: 5 },
    ];
    state.historyCursor = { row: 1, col: 2 };

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "i" }, 5)).toBe(true);
    expect(handleHistoryVimKey(state, { type: "char", char: "M" }, 5)).toBe(true);

    expect(state.editor.mode).toBe("visual");
    expect(getHistoryVisualSelection(state)).toBe("Alice 12:00\nhello there\n");
  });

  test("message motions treat grouped timeline messages as one message", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = [
      "Alice 12:00",
      "first",
      "second",
      "",
      "Bob 12:01",
      "third",
    ];
    state.historyWrapContinuation = [false, false, false, false, false, false];
    state.historyMessageBounds = [
      { messageId: "message-1", groupId: "message-1", start: 0, end: 2, contentStart: 1, contentEnd: 2 },
      { messageId: "message-2", groupId: "message-1", start: 2, end: 3, contentStart: 2, contentEnd: 3 },
      { messageId: "message-3", groupId: "message-3", start: 4, end: 6, contentStart: 5, contentEnd: 6 },
    ];

    state.historyCursor = { row: 1, col: 0 };
    expect(handleHistoryVimKey(state, { type: "char", char: "}" }, 6)).toBe(true);
    expect(state.historyCursor.row).toBe(5);

    expect(handleHistoryVimKey(state, { type: "char", char: "{" }, 6)).toBe(true);
    expect(state.historyCursor.row).toBe(1);

    state.historyCursor = { row: 2, col: 0 };
    expect(handleHistoryVimKey(state, { type: "char", char: "{" }, 6)).toBe(true);
    expect(state.historyCursor.row).toBe(1);

    state.historyCursor = { row: 2, col: 0 };
    expect(handleHistoryVimKey(state, { type: "char", char: "}" }, 6)).toBe(true);
    expect(state.historyCursor.row).toBe(5);
  });

  test("supports vim motions and visual selection in history", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.chatFocus = "history";
    state.historyLines = [
      "Alpha beta",
      "Gamma delta",
      "Epsilon zeta",
    ];
    state.historyWrapContinuation = [false, false, false];
    state.historyMessageBounds = [
      { messageId: "message-1", start: 0, end: 1, contentStart: 0, contentEnd: 1 },
      { messageId: "message-2", start: 1, end: 2, contentStart: 1, contentEnd: 2 },
      { messageId: "message-3", start: 2, end: 3, contentStart: 2, contentEnd: 3 },
    ];

    expect(handleHistoryVimKey(state, { type: "char", char: "j" }, 3)).toBe(true);
    expect(state.historyCursor.row).toBe(1);

    expect(handleHistoryVimKey(state, { type: "char", char: "v" }, 3)).toBe(true);
    expect(state.editor.mode).toBe("visual");
    expect(state.historyVisualAnchor).toEqual({ row: 1, col: 0 });

    expect(handleHistoryVimKey(state, { type: "char", char: "w" }, 3)).toBe(true);
    expect(state.historyCursor.col).toBeGreaterThan(0);
    expect(getHistoryVisualSelection(state)).toBe("Gamma d");

    expect(handleHistoryVimKey(state, { type: "char", char: "V" }, 3)).toBe(true);
    expect(state.editor.mode).toBe("visual-line");
    expect(getHistoryVisualSelection(state)).toBe("Gamma delta");

    expect(handleHistoryVimKey(state, { type: "char", char: "}" }, 3)).toBe(true);
    expect(state.historyCursor.row).toBe(2);
  });
});
