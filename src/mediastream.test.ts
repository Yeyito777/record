import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { mediaStreamPlan, probeMedia, runMediaStream, type MediaPacket } from "./mediastream";

const ffmpeg = Bun.which("ffmpeg") && Bun.which("ffprobe");
const dir = mkdtempSync(join(tmpdir(), "record-mediastream-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function make(name: string, args: string[]): string {
  const path = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-nostdin", "-y", ...args, path], { stdio: "ignore" });
  return path;
}

function collect(path: string, maxWidth = 1280, maxHeight = 720): Promise<{ packets: MediaPacket[]; error: string | null; plan: ReturnType<typeof mediaStreamPlan> }> {
  return probeMedia(path).then((info) => new Promise((resolve) => {
    const plan = mediaStreamPlan(path, info!, maxWidth, maxHeight);
    const packets: MediaPacket[] = [];
    runMediaStream(plan!, (more) => packets.push(...more), (error) => resolve({ packets, error, plan }));
  }));
}

function nalTypes(data: Buffer): number[] {
  const types: number[] = [];
  for (let index = 0; index + 3 < data.length; index++) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) types.push(data[index + 3]! & 0x1f);
  }
  return types;
}

describe.skipIf(!ffmpeg)("videos with sound as st packets", () => {
  test("an H.264 + AAC mp4 is copied: access units, and raw AAC frames 1024 samples apart", async () => {
    const mp4 = make("clip.mp4", [
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ]);
    const info = (await probeMedia(mp4))!;
    expect(info.video).toMatchObject({ codec: "h264", width: 640, height: 360 });
    expect(info.audio).toMatchObject({ codec: "aac", sampleRate: 48000 });
    expect(Math.abs(info.durationUs - 2_000_000)).toBeLessThan(100_000);
    const { packets, error, plan } = await collect(mp4);
    expect(error).toBeNull();
    expect(plan).toMatchObject({ copiedVideo: true, copiedAudio: true, width: 640, height: 360, audio: { rate: 48000, channels: 1 } });
    const video = packets.filter((packet) => packet.stream === 0);
    const audio = packets.filter((packet) => packet.stream === 1);
    expect(video).toHaveLength(50);
    expect(video[0]!.keyframe).toBe(true);
    expect(nalTypes(video[0]!.data)).toEqual(expect.arrayContaining([7, 8, 5]));
    expect(audio.length).toBeGreaterThan(90);
    // No ADTS sync word left at the front of a frame.
    expect(audio.every((packet) => !(packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0))).toBe(true);
    const steps = audio.slice(1, 20).map((packet, index) => packet.ptsUs - audio[index]!.ptsUs);
    expect(steps.every((step) => Math.abs(step - 21_333) <= 1)).toBe(true);
    expect(Math.abs(Math.max(...video.map((packet) => packet.ptsUs)) - 1_960_000)).toBeLessThan(50_000);
  });

  test("other codecs are encoded: to H.264 at the viewer's size and AAC 48 kHz stereo", async () => {
    const webm = make("clip.webm", [
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=10:duration=1", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=1",
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest",
    ]);
    const { packets, error, plan } = await collect(webm, 960, 540);
    expect(error).toBeNull();
    expect(plan).toMatchObject({ copiedVideo: false, copiedAudio: false, width: 960, height: 540, audio: { rate: 48000, channels: 2 } });
    expect(packets.filter((packet) => packet.stream === 0)).toHaveLength(10);
    expect(packets.some((packet) => packet.stream === 1)).toBe(true);
  });

  test("silent video has no audio; a file without video has no plan", async () => {
    const silent = make("silent.mp4", ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const { packets, plan } = await collect(silent);
    expect(plan!.audio).toBeNull();
    expect(packets.every((packet) => packet.stream === 0)).toBe(true);
    const sound = make("sound.m4a", ["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac"]);
    expect(mediaStreamPlan(sound, (await probeMedia(sound))!, 100, 100)).toBeNull();
  });
});
