import { describe, expect, test } from "bun:test";

import { createVoiceMemberActionModal } from "../serveractions";
import { createInitialState } from "../state";
import { syncVoiceMemberWatchAction } from "./voice-member-action";

describe("watched stream voice-member action", () => {
  test("adds, updates, and removes the action in an open member menu", () => {
    const state = createInitialState(null, "/tmp/record-watch-action-test.json");
    state.sidebar.serverActionModal = createVoiceMemberActionModal({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "friend",
      displayName: "Friend",
      muted: false,
      volumePercent: 100,
      streaming: false,
    });

    syncVoiceMemberWatchAction(state, "voice-1", "friend", { canWatch: true, watching: false });
    expect(state.sidebar.serverActionModal.actions).toContain("watch_stream");
    expect(state.sidebar.serverActionModal.watchingStream).toBe(false);

    syncVoiceMemberWatchAction(state, "voice-1", "friend", { canWatch: true, watching: true });
    expect(state.sidebar.serverActionModal.watchingStream).toBe(true);

    state.sidebar.serverActionModal.selection = "watch_stream";
    syncVoiceMemberWatchAction(state, "voice-1", "friend", { canWatch: false, watching: false });
    expect(state.sidebar.serverActionModal.actions).not.toContain("watch_stream");
    expect(state.sidebar.serverActionModal.selection).not.toBe("watch_stream");
  });
});
