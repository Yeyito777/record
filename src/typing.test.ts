import { describe, expect, test } from "bun:test";

import { channelsWithTyping, clearTypingUser, createTypingState, formatTypingUsers, getTypingUsers, recordTypingStart, typingFrame } from "./typing";

describe("typing state", () => {
  test("uses the shared one-character spinner animation", () => {
    expect(typingFrame(0)).toBe("⠋");
    expect(typingFrame(1)).toBe("⠙");
    expect(typingFrame(10)).toBe("⠋");
  });

  test("tracks typing users and expires them", () => {
    const typing = createTypingState();
    recordTypingStart(typing, "channel-1", { id: "user-1", displayName: "Alice" }, 1_000);

    expect(formatTypingUsers(getTypingUsers(typing, "channel-1", "viewer", 1_000))).toBe("Alice is typing…");
    expect(getTypingUsers(typing, "channel-1", "viewer", 20_000)).toEqual([]);
  });

  test("excludes the viewer and exposes channels with typing", () => {
    const typing = createTypingState();
    recordTypingStart(typing, "channel-1", { id: "viewer", displayName: "Me" }, 1_000);
    recordTypingStart(typing, "channel-2", { id: "user-2", displayName: "Bob" }, 1_000);

    expect(getTypingUsers(typing, "channel-1", "viewer", 1_000)).toEqual([]);
    expect([...channelsWithTyping(typing, "viewer", 1_000)]).toEqual(["channel-2"]);
  });

  test("does not display raw user ids as names", () => {
    const typing = createTypingState();
    recordTypingStart(typing, "channel-1", { id: "708497088777945158", displayName: "708497088777945158" }, 1_000);

    expect(formatTypingUsers(getTypingUsers(typing, "channel-1", "viewer", 1_000))).toBe("Someone is typing…");
  });

  test("clears a user after their message arrives", () => {
    const typing = createTypingState();
    recordTypingStart(typing, "channel-1", { id: "user-1", displayName: "Alice" }, 1_000);

    clearTypingUser(typing, "channel-1", "user-1");

    expect(getTypingUsers(typing, "channel-1", "viewer", 1_000)).toEqual([]);
  });
});
