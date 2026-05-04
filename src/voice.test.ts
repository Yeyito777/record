import { describe, expect, test } from "bun:test";

import { buildFfplayPlaybackArgs, buildVoiceIdentifyPayload, buildVoicePlaybackSdp, buildVoiceStatePayload, fetchPreferredVoiceRegions, isOpusSilenceFrame, NoopVoiceAudioBackend, stripDavePadding, VoiceCallController, VoiceGatewayCloseError, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceStateRequest } from "./voice";

class FakeSignaling {
  requests: VoiceStateRequest[] = [];
  leaves = 0;
  ready = true;

  isReady(): boolean {
    return this.ready;
  }

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
  selfVoiceStates: Array<{ selfMute: boolean; selfDeaf: boolean }> = [];

  constructor(readonly callbacks: VoiceGatewayConnectionCallbacks = {}) {}

  setSelfVoiceState(state: { selfMute: boolean; selfDeaf: boolean }): void {
    this.selfVoiceStates.push({ ...state });
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
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

  test("builds ffplay playback args accepted by ffplay", () => {
    expect(buildFfplayPlaybackArgs("/tmp/voice.sdp")).toEqual([
      "-nodisp",
      "-loglevel", "error",
      "-protocol_whitelist", "file,udp,rtp",
      "-i", "/tmp/voice.sdp",
    ]);
    expect(buildFfplayPlaybackArgs("/tmp/voice.sdp")).not.toContain("-nostdin");
  });

  test("builds a stereo-compatible Opus playback SDP", () => {
    expect(buildVoicePlaybackSdp(38830)).toContain("m=audio 38830 RTP/AVP 120");
    expect(buildVoicePlaybackSdp(38830)).toContain("a=rtpmap:120 opus/48000/2");
  });

  test("detects Opus silence frames", () => {
    expect(isOpusSilenceFrame(Buffer.from([0xf8, 0xff, 0xfe]))).toBe(true);
    expect(isOpusSilenceFrame(Buffer.from([0xf8, 0xff]))).toBe(false);
  });

  test("strips repeated padding after DAVE media marker", () => {
    const padded = Buffer.from([0x01, 0x02, 0xfa, 0xfa, 0x37, 0x37, 0x37]);
    expect(stripDavePadding(padded)).toEqual(Buffer.from([0x01, 0x02, 0xfa, 0xfa]));
    const clean = Buffer.from([0x01, 0x02, 0xfa, 0xfa]);
    expect(stripDavePadding(clean)).toBe(clean);
    const mixedSuffix = Buffer.from([0x01, 0x02, 0xfa, 0xfa, 0x37, 0x38]);
    expect(stripDavePadding(mixedSuffix)).toBe(mixedSuffix);
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

    expect(controller.setSelfMute(true)).toBe(true);
    expect(controller.activeSession?.selfMute).toBe(true);
    expect(signaling.requests.at(-1)).toEqual({ guildId: null, channelId: "dm-1", selfMute: true, selfDeaf: false, selfVideo: false, preferredRegions: ["iad", "atl"] });
    expect(gateway.selfVoiceStates.at(-1)).toEqual({ selfMute: true, selfDeaf: false });

    expect(controller.setSelfDeaf(true)).toBe(true);
    expect(controller.activeSession?.selfDeaf).toBe(true);
    expect(signaling.requests.at(-1)).toEqual({ guildId: null, channelId: "dm-1", selfMute: true, selfDeaf: true, selfVideo: false, preferredRegions: ["iad", "atl"] });
    expect(gateway.selfVoiceStates.at(-1)).toEqual({ selfMute: true, selfDeaf: true });

    controller.leave();
    expect(gateway.disconnected).toBe(true);
    expect(signaling.leaves).toBe(1);
  });

  test("can replace an active DM call with another DM call", async () => {
    const signaling = new FakeSignaling();
    const gateways: FakeGateway[] = [];
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => [],
      createGatewayConnection: () => {
        const gateway = new FakeGateway();
        gateways.push(gateway);
        return gateway;
      },
    });

    const firstStarted = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: [], displayName: "One" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleVoiceStateUpdate({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session-1",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    controller.handleVoiceServerUpdate({ token: "voice-token-1", endpoint: "voice1.example", guildId: null });
    const first = await firstStarted;
    expect(first.session.state).toBe("ready");

    const secondStarted = controller.startCall(
      { guildId: null, channelId: "dm-2", recipientIds: [], displayName: "Two" },
      { replaceActive: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.session.state).toBe("ended");
    expect(gateways[0]?.disconnected).toBe(true);
    expect(signaling.leaves).toBe(1);
    expect(signaling.requests).toEqual([
      { guildId: null, channelId: "dm-1", selfMute: false, selfDeaf: false, selfVideo: false, preferredRegions: [] },
      { guildId: null, channelId: "dm-2", selfMute: false, selfDeaf: false, selfVideo: false, preferredRegions: [] },
    ]);

    controller.handleVoiceStateUpdate({
      userId: "me",
      channelId: "dm-2",
      guildId: null,
      sessionId: "voice-session-2",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    controller.handleVoiceServerUpdate({ token: "voice-token-2", endpoint: "voice2.example", guildId: null });
    const second = await secondStarted;

    expect(second.session.state).toBe("ready");
    expect(controller.activeSession?.target.channelId).toBe("dm-2");
    expect(gateways[1]?.connected).toBe(true);
  });

  test("can join an existing DM call without ringing recipients", async () => {
    const signaling = new FakeSignaling();
    const gateway = new FakeGateway();
    const rings: Array<{ channelId: string; recipientIds: string[] }> = [];
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => [],
      createGatewayConnection: () => gateway,
      ringRecipients: async (channelId, recipientIds) => {
        rings.push({ channelId, recipientIds: [...recipientIds] });
      },
    });

    const started = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: ["friend"], displayName: "Friend", ringRecipients: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
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

    await started;

    expect(gateway.connected).toBe(true);
    expect(rings).toEqual([]);
  });

  test("forwards speaking callbacks to voice gateway connections", async () => {
    const signaling = new FakeSignaling();
    const speakingEvents: Array<{ userId: string; speaking: boolean }> = [];
    const gateways: FakeGateway[] = [];
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => [],
      createGatewayConnection: (_data, callbacks) => {
        const gateway = new FakeGateway(callbacks);
        gateways.push(gateway);
        return gateway;
      },
      onSpeakingChange: (userId, speaking) => speakingEvents.push({ userId, speaking }),
    });

    const started = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: [], displayName: "Friend" });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await started;

    gateways[0]?.callbacks.onSpeakingChange?.("friend", true);
    gateways[0]?.callbacks.onSpeakingChange?.("friend", false);
    expect(speakingEvents).toEqual([
      { userId: "friend", speaking: true },
      { userId: "friend", speaking: false },
    ]);
  });

  test("waits for the app gateway before requesting voice state", async () => {
    const signaling = new FakeSignaling();
    signaling.ready = false;
    const gateway = new FakeGateway();
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => [],
      retryDelayMs: 0,
      createGatewayConnection: () => gateway,
    });

    const started = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: [], displayName: "Friend" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signaling.requests).toEqual([]);

    signaling.ready = true;
    await waitFor(() => signaling.requests.length === 1);
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
    expect(result.session.state).toBe("ready");
    expect(gateway.connected).toBe(true);
  });

  test("recovers invalid voice gateway sessions without surfacing an error", async () => {
    const signaling = new FakeSignaling();
    const gateways: FakeGateway[] = [];
    const errors: string[] = [];
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => [],
      retryDelayMs: 0,
      createGatewayConnection: (_data, callbacks) => {
        const gateway = new FakeGateway(callbacks);
        gateways.push(gateway);
        return gateway;
      },
      onError: (error) => errors.push(error.message),
    });

    const started = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: [], displayName: "Friend" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleVoiceStateUpdate({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session-1",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    controller.handleVoiceServerUpdate({ token: "voice-token-1", endpoint: "voice1.example", guildId: null });
    await started;

    gateways[0]?.callbacks.onClose?.(new VoiceGatewayCloseError(101, "Session is no longer valid."));
    await waitFor(() => signaling.requests.length === 2);

    expect(signaling.leaves).toBe(1);
    controller.handleVoiceStateUpdate({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session-2",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    controller.handleVoiceServerUpdate({ token: "voice-token-2", endpoint: "voice2.example", guildId: null });

    await waitFor(() => gateways.length === 2 && gateways[1]?.connected === true && controller.activeSession?.state === "ready");
    expect(errors).toEqual([]);
  });

  test("treats call-terminated voice gateway closes as a normal hangup", async () => {
    const signaling = new FakeSignaling();
    const gateways: FakeGateway[] = [];
    const errors: string[] = [];
    const states: Array<string | null> = [];
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => [],
      createGatewayConnection: (_data, callbacks) => {
        const gateway = new FakeGateway(callbacks);
        gateways.push(gateway);
        return gateway;
      },
      onStateChange: (session) => states.push(session?.state ?? null),
      onError: (error) => errors.push(error.message),
    });

    const started = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: [], displayName: "Friend" });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await started;

    gateways[0]?.callbacks.onClose?.(new VoiceGatewayCloseError(4022, "Disconnected: Call terminated."));

    expect(controller.activeSession).toBeNull();
    expect(signaling.leaves).toBe(1);
    expect(errors).toEqual([]);
    expect(states.at(-2)).toBe("ended");
    expect(states.at(-1)).toBeNull();
  });

  test("retries a stale session during initial voice gateway connect", async () => {
    const signaling = new FakeSignaling();
    const gateways: FakeGateway[] = [];
    const errors: string[] = [];
    const controller = new VoiceCallController({
      selfUserId: "me",
      signaling,
      fetchPreferredRegions: async () => [],
      retryDelayMs: 0,
      createGatewayConnection: (_data, callbacks) => {
        const gateway = new FakeGateway(callbacks);
        gateways.push(gateway);
        if (gateways.length === 1) {
          gateway.connect = async () => {
            gateway.connected = true;
            throw new VoiceGatewayCloseError(4006, "Session is no longer valid.");
          };
        }
        return gateway;
      },
      onError: (error) => errors.push(error.message),
    });

    const started = controller.startCall({ guildId: null, channelId: "dm-1", recipientIds: [], displayName: "Friend" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.handleVoiceStateUpdate({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session-1",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    controller.handleVoiceServerUpdate({ token: "voice-token-1", endpoint: "voice1.example", guildId: null });

    await waitFor(() => signaling.requests.length === 2);
    controller.handleVoiceStateUpdate({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session-2",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });
    controller.handleVoiceServerUpdate({ token: "voice-token-2", endpoint: "voice2.example", guildId: null });

    const result = await started;
    expect(result.session.state).toBe("ready");
    expect(gateways).toHaveLength(2);
    expect(gateways[0]?.disconnected).toBe(true);
    expect(gateways[1]?.connected).toBe(true);
    expect(signaling.leaves).toBe(1);
    expect(errors).toEqual([]);
  });

  test("uses no-op audio backend as a reusable test backend", () => {
    const backend = new NoopVoiceAudioBackend();
    expect(() => backend.start()).not.toThrow();
    expect(() => backend.stop()).not.toThrow();
  });
});
