import { describe, expect, test } from "bun:test";

import { VoiceGatewayCloseError, type IncomingVoiceRtpPacket, type VoiceCallSession, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "../voice";
import { WatchStreamController, WatchStreamStartCancelledError } from "./controller";

class FakeWatchGateway implements VoiceGatewayConnection {
  mediaSessionId = "media-watch-1";
  connected = false;
  disconnected = false;

  constructor(readonly callbacks: VoiceGatewayConnectionCallbacks = {}) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

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

function incomingPacket(mediaType: IncomingVoiceRtpPacket["mediaType"]): IncomingVoiceRtpPacket {
  return {
    mediaType,
    packet: Buffer.from([0x80, mediaType === "audio" ? 120 : 103, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 1]),
    payload: Buffer.from([1]),
    payloadType: mediaType === "audio" ? 120 : 103,
    sequence: 1,
    timestamp: 2,
    ssrc: 3,
    userId: "friend",
    streamKey: "guild:guild-1:voice-1:friend",
  };
}

describe("watched stream controller", () => {
  test("requests WATCH_STREAM and connects a receive-only stream voice gateway", async () => {
    const watched: string[] = [];
    const joinData: VoiceGatewayJoinData[] = [];
    const gateways: FakeWatchGateway[] = [];
    const controller = new WatchStreamController("guild:guild-1:voice-1:friend", readySession(), "self", {
      scheduleRender: () => {},
      watchStream: (streamKey) => {
        watched.push(streamKey);
        return true;
      },
    }, () => {}, (data, callbacks) => {
      joinData.push(data);
      const gateway = new FakeWatchGateway(callbacks);
      gateways.push(gateway);
      return gateway;
    });

    controller.handleCreate({ streamKey: controller.streamKey, rtcServerId: "9001", rtcChannelId: "9002", region: "us-east", viewerIds: [], paused: false });
    controller.handleServerUpdate({ streamKey: controller.streamKey, token: "stream-token", endpoint: "stream.example" });
    await controller.start();

    expect(watched).toEqual([controller.streamKey]);
    expect(gateways[0]?.connected).toBe(true);
    expect(joinData).toEqual([{
      guildId: "9001",
      channelId: "9002",
      userId: "self",
      sessionId: "voice-session",
      token: "stream-token",
      endpoint: "stream.example",
      video: true,
      streamReceive: { streamKey: controller.streamKey, ownerUserId: "friend", quality: 100, pixelCount: 1920 * 1080 },
      daveChannelId: "9000",
    }]);

    gateways[0]?.callbacks.onIncomingRtp?.(incomingPacket("video"));
    expect(controller.currentStats.videoPackets).toBe(1);
    expect(typeof controller.currentStats.firstPacketAt).toBe("number");
    controller.stop("test");
    expect(gateways[0]?.disconnected).toBe(true);
  });

  test("settles startup when stopped before Discord supplies stream details", async () => {
    const controller = new WatchStreamController("call:dm-1:friend", readySession({ target: { guildId: null, channelId: "dm-1" } }), "self", {
      scheduleRender: () => {},
      watchStream: () => true,
    }, () => {});
    const starting = controller.start();
    controller.stop("user_cancelled");
    await expect(starting).rejects.toBeInstanceOf(WatchStreamStartCancelledError);
  });

  test("re-requests the watched stream after a recoverable gateway close", async () => {
    const watched: string[] = [];
    const gateways: FakeWatchGateway[] = [];
    const controller = new WatchStreamController("call:dm-1:friend", readySession({ target: { guildId: null, channelId: "dm-1" } }), "self", {
      scheduleRender: () => {},
      watchStream: (streamKey) => {
        watched.push(streamKey);
        return true;
      },
      pingStreamServer: (streamKey) => {
        watched.push(`ping:${streamKey}`);
        return true;
      },
    }, () => {}, (_data, callbacks) => {
      const gateway = new FakeWatchGateway(callbacks);
      gateways.push(gateway);
      return gateway;
    });

    controller.handleCreate({ streamKey: controller.streamKey, rtcServerId: "8001", rtcChannelId: "8002", region: null, viewerIds: [], paused: false });
    controller.handleServerUpdate({ streamKey: controller.streamKey, token: "stream-token", endpoint: "stream.example" });
    await controller.start();
    gateways[0]?.callbacks.onClose?.(new VoiceGatewayCloseError(1006, "Connection ended."));
    expect(watched).toContain(controller.streamKey);
    expect(watched).toContain(`ping:${controller.streamKey}`);
    controller.stop("test");
  });

  test("stops when the broadcaster ends the stream", async () => {
    const watched: string[] = [];
    const errors: Error[] = [];
    const gateways: FakeWatchGateway[] = [];
    const controller = new WatchStreamController("call:dm-1:friend", readySession({ target: { guildId: null, channelId: "dm-1" } }), "self", {
      scheduleRender: () => {},
      watchStream: (streamKey) => {
        watched.push(streamKey);
        return true;
      },
    }, (error) => errors.push(error), (_data, callbacks) => {
      const gateway = new FakeWatchGateway(callbacks);
      gateways.push(gateway);
      return gateway;
    });

    controller.handleCreate({ streamKey: controller.streamKey, rtcServerId: "8001", rtcChannelId: "8002", region: null, viewerIds: [], paused: false });
    controller.handleServerUpdate({ streamKey: controller.streamKey, token: "stream-token", endpoint: "stream.example" });
    await controller.start();
    controller.handleDelete({ streamKey: controller.streamKey, reason: "stream_ended", unavailable: false });

    expect(controller.active).toBe(false);
    expect(gateways[0]?.disconnected).toBe(true);
    expect(watched).toEqual([controller.streamKey]);
    expect(errors[0]?.message).toContain("stream_ended");
  });

  test("does not synchronously re-request an unavailable stream from STREAM_DELETE", async () => {
    const watched: string[] = [];
    const controller = new WatchStreamController("call:dm-1:friend", readySession({ target: { guildId: null, channelId: "dm-1" } }), "self", {
      scheduleRender: () => {},
      watchStream: (streamKey) => {
        watched.push(streamKey);
        return true;
      },
    }, () => {}, (_data, callbacks) => new FakeWatchGateway(callbacks));

    controller.handleCreate({ streamKey: controller.streamKey, rtcServerId: "8001", rtcChannelId: "8002", region: null, viewerIds: [], paused: false });
    controller.handleServerUpdate({ streamKey: controller.streamKey, token: "stream-token", endpoint: "stream.example" });
    await controller.start();
    controller.handleDelete({ streamKey: controller.streamKey, reason: "server_reallocating", unavailable: true });

    expect(watched).toEqual([controller.streamKey]);
    controller.stop("test");
  });
});
