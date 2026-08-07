import { describe, expect, test } from "bun:test";

import {
  PlayerWatchStreamPlayback,
  buildWatchStreamFfplayArgs,
  buildWatchStreamMpvArgs,
  buildWatchStreamPlaybackSdp,
  resolveWatchStreamPlayer,
} from "./playback";

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("watched stream playback", () => {
  test("builds H264 and Opus playback SDP and low-latency player args", () => {
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
});
