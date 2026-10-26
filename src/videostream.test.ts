import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  deserializeVideoStream, encodeSize, encodeVideoStream, isAnimatedPng, parseMpegTsVideo, serializeVideoStream, streamDuration, VideoStreamDiskCache,
  type VideoStream,
} from "./videostream";

const ffmpeg = Bun.which("ffmpeg") && Bun.which("ffprobe");
const dir = mkdtempSync(join(tmpdir(), "record-videostream-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function make(name: string, args: string[]): string {
  const path = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-nostdin", "-y", ...args, path], { stdio: "ignore" });
  return path;
}

/** NAL unit types in an Annex B access unit. */
function nalTypes(data: Buffer): number[] {
  const types: number[] = [];
  for (let index = 0; index + 3 < data.length; index++) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) types.push(data[index + 3]! & 0x1f);
  }
  return types;
}

function checkPlayable(stream: VideoStream, frames: number, durationUs: number): void {
  expect(stream.packets).toHaveLength(frames);
  expect(stream.packets[0]!.keyframe).toBe(true);
  // The first access unit carries its parameter sets in band (SPS 7, PPS 8) and an IDR (5).
  expect(nalTypes(stream.packets[0]!.data)).toEqual(expect.arrayContaining([7, 8, 5]));
  const times = stream.packets.map((packet) => packet.ptsUs).sort((left, right) => left - right);
  expect(times[0]).toBe(0);
  expect(new Set(times).size).toBe(frames);
  expect(Math.abs(stream.durationUs - durationUs)).toBeLessThan(2000);
}

describe.skipIf(!ffmpeg)("GIFs as H.264 streams", () => {
  test("an H.264 mp4 is remuxed as it is, B-frames and all", async () => {
    const mp4 = make("tenor.mp4", ["-f", "lavfi", "-i", "testsrc2=size=480x270:rate=15", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bf", "2"]);
    const stream = (await encodeVideoStream(mp4, { maxWidth: 864, maxHeight: 486 }))!;
    expect(stream.remuxed).toBe(true);
    expect([stream.width, stream.height]).toEqual([480, 270]);
    checkPlayable(stream, 30, 2_000_000);
    // Decode order is not presentation order.
    const decodeOrder = stream.packets.map((packet) => packet.ptsUs);
    expect(decodeOrder).not.toEqual([...decodeOrder].sort((left, right) => left - right));
  });

  test("a GIF is encoded at its box's size, keeping its frame times", async () => {
    const gif = make("cat.gif", ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "2"]);
    const stream = (await encodeVideoStream(gif, { maxWidth: 200, maxHeight: 200, background: "#102030" }))!;
    expect(stream.remuxed).toBe(false);
    expect([stream.width, stream.height]).toEqual([200, 150]);
    checkPlayable(stream, 20, 2_000_000);
  });

  test("an APNG sticker too, even named .png as Discord serves it; a much larger H.264 source is encoded smaller", async () => {
    const apng = make("sticker.png", ["-f", "lavfi", "-i", "testsrc2=size=160x160:rate=10", "-t", "1", "-plays", "0", "-f", "apng"]);
    expect(isAnimatedPng(apng)).toBe(true);
    checkPlayable((await encodeVideoStream(apng, { maxWidth: 320, maxHeight: 320 }))!, 10, 1_000_000);
    const still = make("still.png", ["-f", "lavfi", "-i", "testsrc2=size=32x32", "-frames:v", "1"]);
    expect(isAnimatedPng(still)).toBe(false);
    const big = make("big.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const small = (await encodeVideoStream(big, { maxWidth: 320, maxHeight: 180 }))!;
    expect(small.remuxed).toBe(false);
    expect([small.width, small.height]).toEqual([320, 180]);
  });

  test("not a video: null", async () => {
    const text = join(dir, "notes.txt");
    await Bun.write(text, "hello");
    expect(await encodeVideoStream(text, { maxWidth: 100, maxHeight: 100 })).toBeNull();
  });

  test("streams survive on disk", async () => {
    const gif = make("loop.gif", ["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=10", "-t", "1"]);
    const stream = (await encodeVideoStream(gif, { maxWidth: 64, maxHeight: 48 }))!;
    expect(deserializeVideoStream(serializeVideoStream(stream))).toEqual(stream);
    const cache = new VideoStreamDiskCache(join(dir, "videos"));
    const key = cache.key("https://cdn.example/loop.gif", 64, 48);
    expect(await cache.get(key)).toBeNull();
    await cache.set(key, stream);
    expect(await cache.get(key)).toEqual(stream);
    expect(cache.getSync(key)).toEqual(stream);
    expect(cache.key("https://cdn.example/loop.gif", 128, 96)).not.toBe(key);
    expect(readdirSync(join(dir, "videos")).filter((name) => name.endsWith(".rvs"))).toHaveLength(1);
  });
});

describe("stream helpers", () => {
  test("even sizes within the box, never larger than the source", () => {
    expect(encodeSize(480, 270, 864, 486)).toEqual({ width: 480, height: 270 });
    expect(encodeSize(1001, 501, 500, 500)).toEqual({ width: 500, height: 250 });
    expect(encodeSize(3, 3, 100, 100)).toEqual({ width: 2, height: 2 });
  });

  test("a loop lasts from the first frame to one frame past the last", () => {
    const packet = (ptsUs: number) => ({ ptsUs, keyframe: false, data: Buffer.alloc(1) });
    expect(streamDuration([packet(0), packet(200_000), packet(100_000)])).toBe(300_000);
    expect(streamDuration([packet(0)])).toBe(100_000);
  });

  test("garbage is not a stream", () => {
    expect(parseMpegTsVideo(Buffer.alloc(1000, 0x47))).toEqual([]);
    expect(deserializeVideoStream(Buffer.from("nope"))).toBeNull();
  });
});
