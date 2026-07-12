import { describe, expect, test } from "bun:test";

import { VoiceGatewayCloseError, type IncomingVoiceRtpPacket, type VoiceCallSession, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "./voice";
import { WatchStreamController, buildStreamKeyForVoiceSession, daveChannelIdForStreamServer, parseStreamKey, streamKeyMatchesVoiceSession } from "./watchstreamcontroller";
import { PlayerWatchStreamPlayback, buildWatchStreamFfplayArgs, buildWatchStreamMpvArgs, buildWatchStreamPlaybackSdp, resolveWatchStreamPlayer } from "./watchstreamplayback";

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    packet: Buffer.from([0x80, mediaType === "audio" ? 120 : 101, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 1]),
    payload: Buffer.from([1]),
    payloadType: mediaType === "audio" ? 120 : 101,
    sequence: 1,
    timestamp: 2,
    ssrc: 3,
    userId: "friend",
    streamKey: "guild:guild-1:voice-1:friend",
  };
}

describe("watch stream controller", () => {
  test("builds ffplay video playback SDP and args", () => {
    expect(buildWatchStreamPlaybackSdp(43123, 43124)).toContain("m=video 43123 RTP/AVP 101");
    expect(buildWatchStreamPlaybackSdp(43123, 43124)).toContain("a=rtpmap:101 H264/90000");
    expect(buildWatchStreamPlaybackSdp(43123, 43124)).toContain("m=audio 43124 RTP/AVP 120");
    expect(buildWatchStreamPlaybackSdp(43123, 43124)).toContain("a=rtpmap:120 opus/48000/2");
    expect(buildWatchStreamFfplayArgs("/tmp/watch.sdp")).toEqual([
      "-loglevel", "error",
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-protocol_whitelist", "file,udp,rtp",
      "-i", "/tmp/watch.sdp",
    ]);
    expect(buildWatchStreamFfplayArgs("/tmp/watch.sdp", "record stream — friend")).toContain("-window_title");
    expect(buildWatchStreamMpvArgs("/tmp/watch.sdp", "record stream — friend")).toEqual([
      "--profile=low-latency",
      "--hwdec=auto-safe",
      "--force-window=immediate",
      "--msg-level=all=error",
      "--title=record stream — friend",
      "--demuxer-lavf-o-append=protocol_whitelist=file,udp,rtp",
      "/tmp/watch.sdp",
    ]);
  });

  test("prefers mpv playback with env and PATH fallbacks", () => {
    expect(resolveWatchStreamPlayer({ RECORD_WATCH_PLAYER: "ffplay" }, () => "/usr/bin/mpv")).toBe("ffplay");
    expect(resolveWatchStreamPlayer({ RECORD_WATCH_PLAYER: "MPV" }, () => null)).toBe("mpv");
    expect(resolveWatchStreamPlayer({}, (command) => (command === "mpv" ? "/usr/bin/mpv" : null))).toBe("mpv");
    expect(resolveWatchStreamPlayer({}, () => null)).toBe("ffplay");
    expect(resolveWatchStreamPlayer({ RECORD_WATCH_PLAYER: "vlc" }, () => null)).toBe("ffplay");
  });

  test("reports playback end when the player window closes on its own", async () => {
    const ended: Array<Error | null> = [];
    const playback = new PlayerWatchStreamPlayback({
      command: "sh",
      args: ["-c", "exit 0"],
      onEnded: (error) => ended.push(error),
    });
    await playback.start();
    await waitFor(() => ended.length === 1);
    expect(ended).toEqual([null]);

    const failed: Array<Error | null> = [];
    const failing = new PlayerWatchStreamPlayback({
      command: "sh",
      args: ["-c", "exit 3"],
      onEnded: (error) => failed.push(error),
    });
    await failing.start();
    await waitFor(() => failed.length === 1);
    expect(failed[0]?.message).toContain("exited with status 3");

    const missing: Array<Error | null> = [];
    const unspawnable = new PlayerWatchStreamPlayback({
      command: "record-player-that-does-not-exist",
      onEnded: (error) => missing.push(error),
    });
    await unspawnable.start();
    await waitFor(() => missing.length === 1);
    expect(missing[0]?.message).toContain("Failed to start");
  });

  test("does not report playback end for an intentional stop", async () => {
    const ended: Array<Error | null> = [];
    const playback = new PlayerWatchStreamPlayback({
      command: "sh",
      args: ["-c", "sleep 5"],
      onEnded: (error) => ended.push(error),
    });
    await playback.start();
    playback.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ended).toEqual([]);
  });

  test("parses and matches Discord stream keys", () => {
    const session = readySession();

    expect(parseStreamKey("call:dm-1:friend")).toEqual({ type: "call", guildId: null, channelId: "dm-1", ownerUserId: "friend" });
    expect(parseStreamKey("guild:guild-1:voice-1:friend")).toEqual({ type: "guild", guildId: "guild-1", channelId: "voice-1", ownerUserId: "friend" });
    expect(parseStreamKey("guild:guild-1:voice-1")).toBeNull();
    expect(buildStreamKeyForVoiceSession(session, "friend")).toBe("guild:guild-1:voice-1:friend");
    expect(streamKeyMatchesVoiceSession("guild:guild-1:voice-1:friend", session)).toBe(true);
    expect(streamKeyMatchesVoiceSession("guild:guild-2:voice-1:friend", session)).toBe(false);
    expect(daveChannelIdForStreamServer("1001")).toBe("1000");
  });

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

    controller.handleCreate({
      streamKey: "guild:guild-1:voice-1:friend",
      rtcServerId: "9001",
      rtcChannelId: "9002",
      region: "us-east",
      viewerIds: [],
      paused: false,
    });
    controller.handleServerUpdate({ streamKey: "guild:guild-1:voice-1:friend", token: "stream-token", endpoint: "stream.example" });

    await controller.start();

    expect(watched).toEqual(["guild:guild-1:voice-1:friend"]);
    expect(gateways[0]?.connected).toBe(true);
    expect(joinData).toEqual([{
      guildId: "9001",
      channelId: "9002",
      userId: "self",
      sessionId: "voice-session",
      token: "stream-token",
      endpoint: "stream.example",
      video: true,
      streamReceive: {
        streamKey: "guild:guild-1:voice-1:friend",
        ownerUserId: "friend",
        quality: 100,
        pixelCount: 1920 * 1080,
      },
      daveChannelId: "9000",
    }]);

    gateways[0]?.callbacks.onIncomingRtp?.(incomingPacket("video"));
    expect(controller.currentStats.videoPackets).toBe(1);
    expect(typeof controller.currentStats.firstPacketAt).toBe("number");

    controller.stop("test");
    expect(gateways[0]?.disconnected).toBe(true);
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

    controller.handleCreate({ streamKey: "call:dm-1:friend", rtcServerId: "8001", rtcChannelId: "8002", region: null, viewerIds: [], paused: false });
    controller.handleServerUpdate({ streamKey: "call:dm-1:friend", token: "stream-token", endpoint: "stream.example" });
    await controller.start();

    gateways[0]?.callbacks.onClose?.(new VoiceGatewayCloseError(1006, "Connection ended."));

    expect(watched).toContain("call:dm-1:friend");
    expect(watched).toContain("ping:call:dm-1:friend");
  });
});
