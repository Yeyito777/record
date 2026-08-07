import { describe, expect, test } from "bun:test";

import type { VoiceCallSession } from "../voice";
import { buildStreamKeyForVoiceSession, daveChannelIdForStreamServer, parseStreamKey, streamKeyMatchesVoiceSession } from "./keys";

function readySession(overrides: Partial<VoiceCallSession> = {}): VoiceCallSession {
  return {
    target: { guildId: "guild-1", channelId: "voice-1", displayName: "Voice" },
    state: "ready",
    gateway: null,
    startedAt: 1,
    selfMute: false,
    selfDeaf: false,
    sessionId: "voice-session",
    ...overrides,
  };
}

describe("watched stream keys", () => {
  test("parses, builds, and matches Discord stream keys", () => {
    const session = readySession();
    expect(parseStreamKey("call:dm-1:friend")).toEqual({ type: "call", guildId: null, channelId: "dm-1", ownerUserId: "friend" });
    expect(parseStreamKey("guild:guild-1:voice-1:friend")).toEqual({ type: "guild", guildId: "guild-1", channelId: "voice-1", ownerUserId: "friend" });
    expect(parseStreamKey("guild:guild-1:voice-1")).toBeNull();
    expect(buildStreamKeyForVoiceSession(session, "friend")).toBe("guild:guild-1:voice-1:friend");
    expect(streamKeyMatchesVoiceSession("guild:guild-1:voice-1:friend", session)).toBe(true);
    expect(streamKeyMatchesVoiceSession("guild:guild-2:voice-1:friend", session)).toBe(false);
    expect(daveChannelIdForStreamServer("1001")).toBe("1000");
  });
});
