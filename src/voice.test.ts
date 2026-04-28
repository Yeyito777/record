import { describe, expect, test } from "bun:test";

import { buildVoiceIdentifyPayload, buildVoiceStatePayload, fetchPreferredVoiceRegions, NoopVoiceAudioBackend, VoiceCallController, type VoiceGatewayConnection, type VoiceStateRequest } from "./voice";

class FakeSignaling {
  requests: VoiceStateRequest[] = [];
  leaves = 0;
  ready = true;

  requestVoiceState(request: VoiceStateRequest): boolean {
    if (!this.ready) return false;
    this.requests.push(request);
    return true;
  }

  leaveVoice(): boolean {
    this.leaves += 1;
    return true;
  }
}

class FakeGateway implements VoiceGatewayConnection {
  mediaSessionId = "media-1";
  connected = false;
  disconnected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

describe("voice backend", () => {
  test("builds Discord voice gateway identify payload with DAVE support", () => {
    const joinData = {
      guildId: "dm-1",
      channelId: "dm-1",
      userId: "me",
      sessionId: "voice-session",
      token: "voice-token",
      endpoint: "voice.example",
    };

    expect(buildVoiceIdentifyPayload(joinData, 1)).toEqual({
      op: 0,
      d: {
        server_id: "dm-1",
        channel_id: "dm-1",
        user_id: "me",
        session_id: "voice-session",
        token: "voice-token",
        video: false,
        max_dave_protocol_version: 1,
      },
    });

    const defaultPayload = buildVoiceIdentifyPayload(joinData) as { d: { max_dave_protocol_version: number } };
    expect(defaultPayload.d.max_dave_protocol_version).toBeGreaterThan(0);
  });

  test("builds Discord gateway voice-state payloads", () => {
    expect(buildVoiceStatePayload({
      guildId: null,
      channelId: "dm-1",
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      preferredRegions: ["automatic"],
    })).toEqual({
      op: 4,
      d: {
        guild_id: null,
        channel_id: "dm-1",
        self_mute: false,
        self_deaf: false,
        self_video: false,
        preferred_regions: ["automatic"],
        preferred_region: "automatic",
        flags: 3,
      },
    });

    expect(buildVoiceStatePayload({ guildId: null, channelId: null, selfMute: true, selfDeaf: true, selfVideo: true })).toEqual({
      op: 4,
      d: {
        guild_id: null,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
        self_video: false,
        flags: 3,
      },
    });
  });

  test("fetches ranked voice regions like Discord desktop", async () => {
    const regions = await fetchPreferredVoiceRegions((async () => new Response(JSON.stringify([
      { region: "iad" },
      { region: "atl" },
      { ignored: true },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch);

    expect(regions).toEqual(["iad", "atl"]);
  });

  test("joins a DM call after app gateway voice events and rings recipients", async () => {
    const signaling = new FakeSignaling();
    const gateway = new FakeGateway();
    const rings: Array<{ channelId: string; recipientIds: string[] }> = [];
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => ["iad", "atl"],
      createGatewayConnection: (data) => {
        expect(data).toEqual({
          guildId: "dm-1",
          channelId: "dm-1",
          userId: "me",
          sessionId: "voice-session",
          token: "voice-token",
          endpoint: "voice.example",
        });
        return gateway;
      },
      ringRecipients: async (channelId, recipientIds) => {
        rings.push({ channelId, recipientIds: [...recipientIds] });
      },
    });

    const started = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: ["friend"], displayName: "Friend" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signaling.requests).toEqual([{ guildId: null, channelId: "dm-1", selfMute: false, selfDeaf: false, selfVideo: false, preferredRegions: ["iad", "atl"] }]);

    controller.handleVoiceStateUpdate({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    controller.handleVoiceServerUpdate({ token: "voice-token", endpoint: "voice.example", guildId: null });

    const result = await started;

    expect(gateway.connected).toBe(true);
    expect(result.session.state).toBe("ready");
    expect(controller.activeSession?.target.channelId).toBe("dm-1");
    expect(rings).toEqual([{ channelId: "dm-1", recipientIds: ["friend"] }]);

    controller.leave();
    expect(gateway.disconnected).toBe(true);
    expect(signaling.leaves).toBe(1);
  });

  test("uses no-op audio backend as a reusable test backend", () => {
    const backend = new NoopVoiceAudioBackend();
    expect(() => backend.start()).not.toThrow();
    expect(() => backend.stop()).not.toThrow();
  });
});
