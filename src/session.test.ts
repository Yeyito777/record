import { describe, expect, test } from "bun:test";

import { clearReadOnlyClient } from "./session";
import { createInitialState, focusSidebar } from "./state";

describe("session", () => {
  test("clearing the read-only client drops loaded UI state and invalidates pending requests", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    focusSidebar(state);
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.requestId = 3;
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{
      id: "channel-1",
      guildId: "guild-1",
      parentId: null,
      name: "general",
      topic: null,
      position: 0,
      type: 0,
      nsfw: false,
    }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.requestId = 7;
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [{
      id: "message-1",
      channelId: "channel-1",
      type: 0,
      content: "hello",
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      editedTimestamp: null,
      author: { id: "user-1", username: "user", displayName: "User", bot: false },
      reply: null,
      call: null,
      attachments: [],
      embedsCount: 0,
    }];
    state.timeline.requestId = 11;
    state.memberList.open = true;
    state.memberList.guildId = "guild-1";
    state.memberList.channelId = "channel-1";
    state.memberList.members = [{ id: "user-1", username: "user", displayName: "User", bot: false }];
    state.memberList.requestId = 13;

    clearReadOnlyClient(state);

    expect(state.panelFocus === "chat").toBe(true);
    expect(state.chatFocus === "prompt").toBe(true);
    expect(state.sidebar.guilds).toEqual([]);
    expect(state.channelList.channels).toEqual([]);
    expect(state.timeline.messages).toEqual([]);
    expect(state.memberList.members).toEqual([]);
    expect(state.sidebar.requestId).toBe(4);
    expect(state.channelList.requestId).toBe(8);
    expect(state.timeline.requestId).toBe(12);
    expect(state.memberList.requestId).toBe(14);
  });
});
