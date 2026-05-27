import { describe, expect, test } from "bun:test";

import { ScreenStreamController } from "./streamcontroller";
import { VoiceGatewayCloseError, type VoiceCallSession, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "./voice";

class FakeGateway implements VoiceGatewayConnection {
  mediaSessionId = "media-1";
  connected = false;
  disconnected = false;
  connectError: Error | null = null;

  constructor(readonly data: VoiceGatewayJoinData, readonly callbacks: VoiceGatewayConnectionCallbacks = {}) {}

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

async function waitFor(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

describe("screen stream controller", () => {
  test("reconnects recoverable stream gateway 4014 closes without surfacing a stream error", async () => {
    const session: VoiceCallSession = {
      target: { guildId: null, channelId: "call-1" },
      state: "ready",
      gateway: null,
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      sessionId: "voice-session-1",
    };
    const gateways: FakeGateway[] = [];
    const errors: string[] = [];
    let renders = 0;
    const pinged: string[] = [];
    const controller = new ScreenStreamController(
      "call:call-1:me",
      session,
      "me",
      {
        scheduleRender: () => { renders += 1; },
        pingStreamServer: (streamKey) => {
          pinged.push(streamKey);
          return true;
        },
      },
      (error) => errors.push(error.message),
      (data, callbacks) => {
        const gateway = new FakeGateway(data, callbacks);
        gateways.push(gateway);
        return gateway;
      },
    );

    const started = controller.start();
    controller.handleCreate({
      streamKey: "call:call-1:me",
      rtcServerId: "call-1",
      rtcChannelId: "call-1",
      region: null,
      viewerIds: [],
      paused: false,
    });
    controller.handleServerUpdate({ streamKey: "call:call-1:me", token: "stream-token-1", endpoint: "stream.example" });
    await started;

    gateways[0]?.callbacks.onClose?.(new VoiceGatewayCloseError(4014, "Disconnected."));

    await waitFor(() => gateways.length === 2 && gateways[1]?.connected === true);
    expect(errors).toEqual([]);
    expect(pinged).toEqual(["call:call-1:me"]);
    expect(renders).toBeGreaterThan(0);
    expect(gateways[1]?.data.sessionId).toBe("voice-session-1");
  });

  test("keeps an existing stream alive when reconnect identify gets a stale 4006", async () => {
    const session: VoiceCallSession = {
      target: { guildId: null, channelId: "call-1" },
      state: "ready",
      gateway: null,
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      sessionId: "voice-session-1",
    };
    const gateways: FakeGateway[] = [];
    const errors: string[] = [];
    const refreshes: Array<{ streamKey: string; reason: string; attempt: number }> = [];
    const controller = new ScreenStreamController(
      "call:call-1:me",
      session,
      "me",
      {
        scheduleRender: () => {},
        refreshStreamServer: (streamKey, reason, attempt) => {
          refreshes.push({ streamKey, reason, attempt });
          return true;
        },
      },
      (error) => errors.push(error.message),
      (data, callbacks) => {
        const gateway = new FakeGateway(data, callbacks);
        if (gateways.length === 1) gateway.connectError = new VoiceGatewayCloseError(4006, "Session is no longer valid.");
        gateways.push(gateway);
        return gateway;
      },
    );

    const started = controller.start();
    controller.handleCreate({
      streamKey: "call:call-1:me",
      rtcServerId: "call-1",
      rtcChannelId: "call-1",
      region: null,
      viewerIds: [],
      paused: false,
    });
    controller.handleServerUpdate({ streamKey: "call:call-1:me", token: "stream-token-1", endpoint: "stream.example" });
    await started;

    gateways[0]?.callbacks.onClose?.(new VoiceGatewayCloseError(4014, "Disconnected."));
    await waitFor(() => gateways.length >= 2);
    await waitFor(() => refreshes.some((entry) => entry.reason === "invalid_session"));

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(gateways.length).toBe(2);

    session.sessionId = "voice-session-2";
    controller.handleServerUpdate({ streamKey: "call:call-1:me", token: "stream-token-2", endpoint: "stream2.example" });

    await waitFor(() => gateways.length === 3 && gateways[2]?.connected === true);
    expect(errors).toEqual([]);
    expect(gateways[1]?.disconnected).toBe(true);
    expect(gateways[2]?.data.sessionId).toBe("voice-session-2");
    expect(gateways[2]?.data.token).toBe("stream-token-2");
  });

  test("waits for fresh stream server details after parent voice session reconnects", async () => {
    const session: VoiceCallSession = {
      target: { guildId: null, channelId: "call-1" },
      state: "ready",
      gateway: null,
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      sessionId: "voice-session-1",
    };
    const gateways: FakeGateway[] = [];
    const errors: string[] = [];
    const refreshes: Array<{ streamKey: string; reason: string; attempt: number }> = [];
    const controller = new ScreenStreamController(
      "call:call-1:me",
      session,
      "me",
      {
        scheduleRender: () => {},
        refreshStreamServer: (streamKey, reason, attempt) => {
          refreshes.push({ streamKey, reason, attempt });
          return true;
        },
      },
      (error) => errors.push(error.message),
      (data, callbacks) => {
        const gateway = new FakeGateway(data, callbacks);
        gateways.push(gateway);
        return gateway;
      },
    );

    const started = controller.start();
    controller.handleCreate({
      streamKey: "call:call-1:me",
      rtcServerId: "stream-server-1",
      rtcChannelId: "stream-channel-1",
      region: null,
      viewerIds: [],
      paused: false,
    });
    controller.handleServerUpdate({ streamKey: "call:call-1:me", token: "stream-token-1", endpoint: "stream.example" });
    await started;

    session.state = "signaling";
    gateways[0]?.callbacks.onClose?.(new VoiceGatewayCloseError(4014, "Disconnected."));

    await waitFor(() => refreshes.some((entry) => entry.reason === "voice_session_not_ready"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(gateways.length).toBe(1);

    session.state = "ready";
    session.sessionId = "voice-session-2";
    controller.handleCreate({
      streamKey: "call:call-1:me",
      rtcServerId: "stream-server-2",
      rtcChannelId: "stream-channel-2",
      region: null,
      viewerIds: [],
      paused: false,
    });
    controller.handleServerUpdate({ streamKey: "call:call-1:me", token: "stream-token-2", endpoint: "stream2.example" });

    await waitFor(() => gateways.length === 2 && gateways[1]?.connected === true);
    expect(errors).toEqual([]);
    expect(gateways[1]?.data.sessionId).toBe("voice-session-2");
    expect(gateways[1]?.data.guildId).toBe("stream-server-2");
    expect(gateways[1]?.data.channelId).toBe("stream-channel-2");
    expect(gateways[1]?.data.token).toBe("stream-token-2");
  });

  test("recreates an unexpectedly deleted stream while the call is still active", async () => {
    const session: VoiceCallSession = {
      target: { guildId: "guild-1", channelId: "voice-1" },
      state: "ready",
      gateway: null,
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      sessionId: "voice-session-1",
    };
    const gateways: FakeGateway[] = [];
    const errors: string[] = [];
    const refreshes: Array<{ streamKey: string; reason: string; attempt: number }> = [];
    const controller = new ScreenStreamController(
      "guild:guild-1:voice-1:me",
      session,
      "me",
      {
        scheduleRender: () => {},
        refreshStreamServer: (streamKey, reason, attempt) => {
          refreshes.push({ streamKey, reason, attempt });
          return true;
        },
      },
      (error) => errors.push(error.message),
      (data, callbacks) => {
        const gateway = new FakeGateway(data, callbacks);
        gateways.push(gateway);
        return gateway;
      },
    );

    const started = controller.start();
    controller.handleCreate({
      streamKey: "guild:guild-1:voice-1:me",
      rtcServerId: "stream-server-1",
      rtcChannelId: "stream-channel-1",
      region: null,
      viewerIds: [],
      paused: false,
    });
    controller.handleServerUpdate({ streamKey: "guild:guild-1:voice-1:me", token: "stream-token-1", endpoint: "stream.example" });
    await started;

    controller.handleDelete({ streamKey: "guild:guild-1:voice-1:me", reason: "stream_ended", unavailable: false });

    await waitFor(() => refreshes.some((entry) => entry.reason === "stream_delete"));
    expect(gateways[0]?.disconnected).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(gateways.length).toBe(1);

    session.sessionId = "voice-session-2";
    controller.handleCreate({
      streamKey: "guild:guild-1:voice-1:me",
      rtcServerId: "stream-server-2",
      rtcChannelId: "stream-channel-2",
      region: null,
      viewerIds: [],
      paused: false,
    });
    controller.handleServerUpdate({ streamKey: "guild:guild-1:voice-1:me", token: "stream-token-2", endpoint: "stream2.example" });

    await waitFor(() => gateways.length === 2 && gateways[1]?.connected === true);
    expect(errors).toEqual([]);
    expect(gateways[1]?.data.sessionId).toBe("voice-session-2");
    expect(gateways[1]?.data.guildId).toBe("stream-server-2");
    expect(gateways[1]?.data.channelId).toBe("stream-channel-2");
    expect(gateways[1]?.data.token).toBe("stream-token-2");
  });
});
