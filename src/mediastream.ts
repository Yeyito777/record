/**
 * Videos with sound for the viewer, through st's video (videoprotocol.ts).
 * ffmpeg turns the file into MPEG-TS as it reads it: H.264 copied as it is
 * when st can decode it (8-bit 4:2:0), else encoded at the viewer's size;
 * AAC-LC copied, else encoded (48 kHz stereo). The TS is split here, as it
 * arrives, into access units and raw AAC frames (ADTS headers taken off), so
 * playback starts before the whole file is read.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { trackChildProcess } from "./childprocesses";
import { encodeSize } from "./videostream";

export interface MediaPacket {
  /** 0 video, 1 audio (st's stream numbers). */
  stream: 0 | 1;
  keyframe: boolean;
  /** From the first packet, microseconds (audio can start a little before 0). */
  ptsUs: number;
  data: Buffer;
}

export interface MediaInfo {
  durationUs: number;
  video: { codec: string; pixelFormat: string; profile: string; width: number; height: number } | null;
  audio: { codec: string; profile: string; sampleRate: number; channels: number } | null;
}

export async function probeMedia(path: string): Promise<MediaInfo | null> {
  const output = await new Promise<string | null>((resolve) => {
    const child = trackChildProcess(spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt,profile,width,height,sample_rate,channels", "-of", "json", path,
    ], { stdio: ["ignore", "pipe", "ignore"] }));
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(chunks).toString() : null); });
  });
  if (!output) return null;
  try {
    const json = JSON.parse(output) as { format?: { duration?: string }; streams?: Record<string, unknown>[] };
    const streams = json.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video" && Number(stream.width) > 0);
    const audio = streams.find((stream) => stream.codec_type === "audio");
    return {
      durationUs: Math.round((Number(json.format?.duration) || 0) * 1_000_000),
      video: video ? {
        codec: String(video.codec_name ?? ""), pixelFormat: String(video.pix_fmt ?? ""), profile: String(video.profile ?? ""),
        width: Number(video.width) || 0, height: Number(video.height) || 0,
      } : null,
      audio: audio ? {
        codec: String(audio.codec_name ?? ""), profile: String(audio.profile ?? ""),
        sampleRate: Number(audio.sample_rate) || 0, channels: Number(audio.channels) || 0,
      } : null,
    };
  } catch {
    return null;
  }
}

/** H.264 st decodes as it is: 8-bit 4:2:0, at most 4096 pixels a side. */
function copyableVideo(video: NonNullable<MediaInfo["video"]>): boolean {
  return video.codec === "h264" && (video.pixelFormat === "yuv420p" || video.pixelFormat === "yuvj420p")
    && !/10|4:2:2|4:4:4|422|444/i.test(video.profile) && video.width <= 4096 && video.height <= 4096;
}

/** AAC-LC, mono or stereo, at a rate st plays. */
function copyableAudio(audio: NonNullable<MediaInfo["audio"]>): boolean {
  return audio.codec === "aac" && /^LC$/i.test(audio.profile) && audio.channels >= 1 && audio.channels <= 2
    && audio.sampleRate >= 8000 && audio.sampleRate <= 96_000;
}

export interface MediaStreamPlan {
  args: string[];
  /** What st is opened with. */
  width: number;
  height: number;
  audio: { rate: number; channels: number } | null;
  copiedVideo: boolean;
  copiedAudio: boolean;
}

/** The ffmpeg command for a file shown in a box of the viewer's pixels. */
export function mediaStreamPlan(path: string, info: MediaInfo, maxWidth: number, maxHeight: number): MediaStreamPlan | null {
  const video = info.video;
  if (!video) return null;
  const args = ["-hide_banner", "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0"];
  let width = video.width;
  let height = video.height;
  const copiedVideo = copyableVideo(video);
  if (copiedVideo) {
    args.push("-c:v", "copy", "-bsf:v", "h264_mp4toannexb");
  } else {
    ({ width, height } = encodeSize(video.width, video.height, maxWidth, maxHeight));
    args.push("-vf", `scale=${width}:${height}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "48");
  }
  let audio: MediaStreamPlan["audio"] = null;
  let copiedAudio = false;
  if (info.audio) {
    args.push("-map", "0:a:0");
    copiedAudio = copyableAudio(info.audio);
    if (copiedAudio) {
      args.push("-c:a", "copy");
      audio = { rate: info.audio.sampleRate, channels: info.audio.channels };
    } else {
      args.push("-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
      audio = { rate: 48_000, channels: 2 };
    }
  }
  args.push("-sn", "-dn", "-f", "mpegts", "pipe:1");
  return { args, width, height, audio, copiedVideo, copiedAudio };
}

/** Run a plan: packets as they come, then the end (with an error if it failed). */
export function runMediaStream(
  plan: MediaStreamPlan,
  onPackets: (packets: MediaPacket[]) => void,
  onEnd: (error: string | null) => void,
): { stop: () => void } {
  const demuxer = new TsDemuxer();
  let child: ChildProcess;
  try {
    child = trackChildProcess(spawn("ffmpeg", plan.args, { stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    queueMicrotask(() => onEnd(error instanceof Error ? error.message : String(error)));
    return { stop: () => {} };
  }
  let stderr = "";
  let stopped = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stopped) return;
    const packets = demuxer.push(chunk);
    if (packets.length) onPackets(packets);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
  child.once("error", (error) => { if (!stopped) onEnd(error.message); });
  child.once("close", (code) => {
    if (stopped) return;
    const rest = demuxer.end();
    if (rest.length) onPackets(rest);
    onEnd(code === 0 ? null : stderr.trim().split("\n").at(-1) || `ffmpeg exited ${code}`);
  });
  return {
    stop: () => {
      stopped = true;
      child.kill("SIGKILL");
    },
  };
}

const TS_PACKET = 188;
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function pesTimestamp(bytes: Buffer, offset: number): number {
  return ((bytes[offset]! >> 1) & 0x07) * 2 ** 30
    + (bytes[offset + 1]! << 22 | (bytes[offset + 2]! >> 1) << 15 | bytes[offset + 3]! << 7 | bytes[offset + 4]! >> 1);
}

function hasIdr(data: Buffer): boolean {
  for (let index = 0; index + 3 < data.length; index++) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1 && ((data[index + 3]! & 0x1f) === 5)) return true;
  }
  return false;
}

interface Pes {
  stream: 0 | 1;
  pts: number | null;
  chunks: Buffer[];
}

/**
 * MPEG-TS as it streams in: each video PES is an access unit; each audio PES
 * holds ADTS frames, returned one by one without their headers, 1024
 * samples apart. Timestamps count from the first PES.
 */
export class TsDemuxer {
  private rest = Buffer.alloc(0);
  private readonly open = new Map<number, Pes>();
  private base: number | null = null;
  private lastPts = new Map<0 | 1, number>();

  push(chunk: Buffer): MediaPacket[] {
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const out: MediaPacket[] = [];
    let offset = 0;
    // Find sync if the stream starts mid-packet.
    while (offset < data.length && data[offset] !== 0x47) offset++;
    for (; offset + TS_PACKET <= data.length; offset += TS_PACKET) {
      if (data[offset] !== 0x47) continue;
      this.packet(data.subarray(offset, offset + TS_PACKET), out);
    }
    this.rest = Buffer.from(data.subarray(offset));
    return out;
  }

  end(): MediaPacket[] {
    const out: MediaPacket[] = [];
    for (const pid of [...this.open.keys()]) this.finish(pid, out);
    return out;
  }

  private packet(ts: Buffer, out: MediaPacket[]): void {
    const start = (ts[1]! & 0x40) !== 0;
    const pid = ((ts[1]! & 0x1f) << 8) | ts[2]!;
    const adaptation = (ts[3]! >> 4) & 0x03;
    let payload = 4;
    if (adaptation === 2) return;
    if (adaptation === 3) payload += 1 + ts[4]!;
    if (payload >= TS_PACKET) return;
    const body = ts.subarray(payload);
    if (start) {
      if (this.open.has(pid)) this.finish(pid, out);
      if (body.length < 9 || body[0] !== 0 || body[1] !== 0 || body[2] !== 1) return;
      const streamId = body[3]!;
      const stream = streamId >= 0xe0 && streamId <= 0xef ? 0 : streamId >= 0xc0 && streamId <= 0xdf ? 1 : null;
      if (stream === null) return;
      const flags = body[7]!;
      const headerLength = body[8]!;
      const pts = (flags & 0x80) && body.length >= 14 ? pesTimestamp(body, 9) : null;
      this.open.set(pid, { stream, pts, chunks: [Buffer.from(body.subarray(9 + headerLength))] });
    } else {
      this.open.get(pid)?.chunks.push(Buffer.from(body));
    }
  }

  private finish(pid: number, out: MediaPacket[]): void {
    const pes = this.open.get(pid);
    this.open.delete(pid);
    if (!pes) return;
    const data = Buffer.concat(pes.chunks);
    if (data.length === 0) return;
    const pts = pes.pts ?? this.lastPts.get(pes.stream) ?? 0;
    this.base ??= pts;
    this.lastPts.set(pes.stream, pts);
    const us = (ticks: number) => Math.round(((ticks - this.base!) * 1_000_000) / 90_000);
    if (pes.stream === 0) {
      out.push({ stream: 0, keyframe: hasIdr(data), ptsUs: us(pts), data });
      return;
    }
    // ADTS frames: a 7-byte header (9 with CRC), its length in bits 30..42.
    let offset = 0;
    let frame = 0;
    while (offset + 7 <= data.length && data[offset] === 0xff && (data[offset + 1]! & 0xf0) === 0xf0) {
      const protectionAbsent = data[offset + 1]! & 0x01;
      const header = protectionAbsent ? 7 : 9;
      const length = ((data[offset + 3]! & 0x03) << 11) | (data[offset + 4]! << 3) | (data[offset + 5]! >> 5);
      const rate = AAC_RATES[(data[offset + 2]! >> 2) & 0x0f] ?? 48_000;
      if (length < header || offset + length > data.length) break;
      out.push({ stream: 1, keyframe: false, ptsUs: us(pts) + Math.round((frame * 1024 * 1_000_000) / rate), data: data.subarray(offset + header, offset + length) });
      offset += length;
      frame += 1;
    }
  }
}
