/**
 * GIFs as H.264 streams for st's video (videoprotocol.ts). An H.264 source
 * (a Tenor/Giphy mp4, a WhatsApp GIF) is remuxed to Annex B without
 * re-encoding; anything else (GIF, APNG) is encoded at its box's size. ffmpeg
 * writes MPEG-TS, which carries each access unit's timestamps; it is split
 * here into packets, kept on disk, and looped by the player.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { trackChildProcess } from "./childprocesses";

export interface VideoPacket {
  /** Presentation time from the stream's start, microseconds. */
  ptsUs: number;
  keyframe: boolean;
  /** One access unit, Annex B. */
  data: Buffer;
}

export interface VideoStream {
  /** Coded size of the frames. */
  width: number;
  height: number;
  /** One loop, microseconds: the next loop's timestamps start here. */
  durationUs: number;
  /** In decode order; the first is a keyframe carrying SPS and PPS. */
  packets: VideoPacket[];
  /** Remuxed as it came, or encoded here. */
  remuxed: boolean;
}

export interface VideoEncodeOptions {
  /** The box it is drawn in, in the terminal's pixels: encodes no larger. */
  maxWidth: number;
  maxHeight: number;
  /** Encoders ffmpeg has (videoEncoders()): h264_videotoolbox is used when present. */
  encoders?: ReadonlySet<string>;
  /** Colour transparent pixels are laid on ("#rrggbb"), black when absent. */
  background?: string;
  /** At most this many seconds of the source. */
  maxSeconds?: number;
}

const TS_PACKET = 188;
/** Remux an H.264 source only when it is at most this many times the box's pixels; bigger ones are encoded smaller. */
const REMUX_MAX_AREA_FACTOR = 4;
const MAX_SOURCE_SECONDS = 30;
const FFMPEG_TIMEOUT_MS = 60_000;

function run(command: string, args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = trackChildProcess(spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }));
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim().split("\n").at(-1) || `${command} ${signal ? `stopped by ${signal}` : `exited ${code}`}`));
    });
  });
}

let encoderList: Promise<Set<string>> | null = null;

/** The video encoders ffmpeg has (asked once). */
export function videoEncoders(): Promise<Set<string>> {
  return encoderList ??= run("ffmpeg", ["-hide_banner", "-nostdin", "-encoders"], 10_000)
    .then((output) => new Set([...output.toString().matchAll(/^\s*V\S*\s+(\S+)/gm)].map((match) => match[1]!)))
    .catch(() => new Set<string>());
}

interface SourceInfo {
  codec: string;
  pixelFormat: string;
  profile: string;
  width: number;
  height: number;
}

async function probe(path: string, format: readonly string[] = []): Promise<SourceInfo | null> {
  try {
    const output = await run("ffprobe", ["-v", "error", ...format, "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,profile,width,height", "-of", "json", path], 15_000);
    const stream = (JSON.parse(output.toString()) as { streams?: Record<string, unknown>[] }).streams?.[0];
    if (!stream) return null;
    return {
      codec: String(stream.codec_name ?? ""),
      pixelFormat: String(stream.pix_fmt ?? ""),
      profile: String(stream.profile ?? ""),
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
    };
  } catch {
    return null;
  }
}

/** 8-bit 4:2:0 H.264 that every decoder (VideoToolbox included) takes as it is. */
function remuxable(info: SourceInfo, maxWidth: number, maxHeight: number): boolean {
  return info.codec === "h264"
    && (info.pixelFormat === "yuv420p" || info.pixelFormat === "yuvj420p")
    && !/10|4:2:2|4:4:4|422|444/i.test(info.profile)
    && info.width > 0 && info.height > 0 && info.width <= 4096 && info.height <= 4096
    && info.width * info.height <= REMUX_MAX_AREA_FACTOR * maxWidth * maxHeight;
}

/** The size to encode at: the source fitted in the box, even (4:2:0), at least 2x2. */
export function encodeSize(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / Math.max(1, sourceWidth), maxHeight / Math.max(1, sourceHeight));
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);
  return { width: even(sourceWidth), height: even(sourceHeight) };
}

function encoderArgs(encoders: ReadonlySet<string> | undefined, width: number, height: number): string[] {
  if (process.platform === "darwin" && encoders?.has("h264_videotoolbox")) {
    // About 0.1 bit per pixel per frame at 15 fps: GIFs are small and flat.
    const bitrate = Math.max(150_000, Math.min(1_500_000, Math.round(width * height * 15 * 0.1)));
    return ["-c:v", "h264_videotoolbox", "-b:v", String(bitrate), "-profile:v", "high", "-allow_sw", "1", "-g", "250"];
  }
  return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "animation", "-crf", "28", "-g", "250"];
}

/**
 * An animated PNG: a PNG whose acTL chunk comes before its image data.
 * ffmpeg reads a .png by its name (first frame only) unless told it is APNG.
 */
export function isAnimatedPng(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(4096);
    const length = readSync(fd, head, 0, head.length, 0);
    if (length < 16 || head.toString("latin1", 1, 4) !== "PNG") return false;
    for (let offset = 8; offset + 8 <= length;) {
      const type = head.toString("latin1", offset + 4, offset + 8);
      if (type === "acTL") return true;
      if (type === "IDAT") return false;
      offset += 12 + head.readUInt32BE(offset);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Turn a video or animated picture into a stream for the box (null if it has no usable video). */
export async function encodeVideoStream(path: string, options: VideoEncodeOptions): Promise<VideoStream | null> {
  const format = isAnimatedPng(path) ? ["-f", "apng"] : [];
  const info = await probe(path, format);
  if (!info || info.width <= 0 || info.height <= 0) return null;
  const seconds = String(Math.min(options.maxSeconds ?? MAX_SOURCE_SECONDS, MAX_SOURCE_SECONDS));
  const input = ["-hide_banner", "-v", "error", "-nostdin", "-t", seconds, ...format, "-i", path, "-map", "0:v:0", "-an", "-sn", "-dn"];
  let args: string[];
  const remux = remuxable(info, options.maxWidth, options.maxHeight);
  if (remux) {
    args = [...input, "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", "pipe:1"];
  } else {
    const size = encodeSize(info.width, info.height, options.maxWidth, options.maxHeight);
    const background = /^#[0-9a-f]{6}$/i.test(options.background ?? "") ? `0x${options.background!.slice(1)}` : "black";
    // Transparent pixels (GIF, APNG) lie on the chat's background: H.264 has
    // no alpha. The backdrop is a filled copy of each frame, so the output
    // keeps the source's own frame times.
    const filter = `[0:v]scale=${size.width}:${size.height}:flags=lanczos,format=rgba,split[a][b];`
      + `[a]drawbox=x=0:y=0:w=iw:h=ih:color=${background}@1:t=fill[bg];`
      + "[bg][b]overlay=format=auto,format=yuv420p[v]";
    args = [
      ...input.slice(0, input.indexOf("-map")),
      "-filter_complex", filter, "-map", "[v]", "-an", "-sn", "-dn",
      "-fps_mode", "passthrough",
      ...encoderArgs(options.encoders, size.width, size.height),
      "-f", "mpegts", "pipe:1",
    ];
  }
  let ts: Buffer;
  try {
    ts = await run("ffmpeg", args);
  } catch (error) {
    // VideoToolbox can be missing at run time (a VM, a sandbox): encode in software.
    if (remux || !args.includes("h264_videotoolbox")) throw error;
    return encodeVideoStream(path, { ...options, encoders: new Set() });
  }
  const packets = parseMpegTsVideo(ts);
  if (packets.length === 0 || !packets[0]!.keyframe) return null;
  // st needs the first keyframe to carry its parameter sets. libx264 and
  // remuxes do; should VideoToolbox not, encode in software instead.
  if (!hasParameterSets(packets[0]!.data)) {
    if (!remux && args.includes("h264_videotoolbox")) return encodeVideoStream(path, { ...options, encoders: new Set() });
    return null;
  }
  const size = remux ? { width: info.width, height: info.height } : encodeSize(info.width, info.height, options.maxWidth, options.maxHeight);
  return { ...size, durationUs: streamDuration(packets), packets, remuxed: remux };
}

/** One loop: from the first frame to the last plus one typical frame. */
export function streamDuration(packets: readonly VideoPacket[]): number {
  if (packets.length === 0) return 0;
  const times = packets.map((packet) => packet.ptsUs).sort((left, right) => left - right);
  const steps = times.slice(1).map((time, index) => time - times[index]!).filter((step) => step > 0).sort((left, right) => left - right);
  const frame = steps.length ? steps[Math.floor(steps.length / 2)]! : 100_000;
  return times.at(-1)! - times[0]! + frame;
}

/** Whether an Annex B access unit carries an SPS (7) and a PPS (8). */
function hasParameterSets(data: Buffer): boolean {
  let sps = false;
  let pps = false;
  for (let index = 0; index + 3 < data.length; index++) {
    if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 1) continue;
    const type = data[index + 3]! & 0x1f;
    if (type === 7) sps = true;
    if (type === 8) pps = true;
  }
  return sps && pps;
}

/** Whether an Annex B access unit holds an IDR slice (NAL type 5). */
function hasIdr(data: Buffer): boolean {
  for (let index = 0; index + 3 < data.length; index++) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1 && ((data[index + 3]! & 0x1f) === 5)) return true;
  }
  return false;
}

function pesTimestamp(bytes: Buffer, offset: number): number {
  return ((bytes[offset]! >> 1) & 0x07) * 2 ** 30
    + (bytes[offset + 1]! << 22 | (bytes[offset + 2]! >> 1) << 15 | bytes[offset + 3]! << 7 | bytes[offset + 4]! >> 1);
}

/**
 * The H.264 access units of an MPEG-TS stream with their PTS, in decode
 * order, timestamps rebased to start at 0 and in microseconds.
 */
export function parseMpegTsVideo(ts: Buffer): VideoPacket[] {
  const units: { pts: number; chunks: Buffer[] }[] = [];
  let videoPid = -1;
  for (let offset = 0; offset + TS_PACKET <= ts.length; offset += TS_PACKET) {
    if (ts[offset] !== 0x47) continue;
    const start = (ts[offset + 1]! & 0x40) !== 0;
    const pid = ((ts[offset + 1]! & 0x1f) << 8) | ts[offset + 2]!;
    const adaptation = (ts[offset + 3]! >> 4) & 0x03;
    let payload = offset + 4;
    if (adaptation === 2) continue;
    if (adaptation === 3) payload += 1 + ts[payload]!;
    if (payload >= offset + TS_PACKET) continue;
    const body = ts.subarray(payload, offset + TS_PACKET);
    if (start && body.length >= 9 && body[0] === 0 && body[1] === 0 && body[2] === 1) {
      const streamId = body[3]!;
      if (streamId < 0xe0 || streamId > 0xef) continue;
      if (videoPid === -1) videoPid = pid;
      if (pid !== videoPid) continue;
      const flags = body[7]!;
      const headerLength = body[8]!;
      const pts = (flags & 0x80) && body.length >= 14 ? pesTimestamp(body, 9) : units.at(-1)?.pts ?? 0;
      units.push({ pts, chunks: [body.subarray(9 + headerLength)] });
    } else if (pid === videoPid && units.length) {
      units.at(-1)!.chunks.push(body);
    }
  }
  if (units.length === 0) return [];
  const first = Math.min(...units.map((unit) => unit.pts));
  return units.map((unit) => {
    const data = Buffer.concat(unit.chunks);
    return { ptsUs: Math.round(((unit.pts - first) * 1_000_000) / 90_000), keyframe: hasIdr(data), data };
  }).filter((packet) => packet.data.length > 0);
}

const STREAM_MAGIC = "RVS1";

/** A stream as one file: a JSON header, then per packet its pts, flags, length and data. */
export function serializeVideoStream(stream: VideoStream): Buffer {
  const header = Buffer.from(JSON.stringify({ width: stream.width, height: stream.height, durationUs: stream.durationUs, remuxed: stream.remuxed, count: stream.packets.length }));
  const parts: Buffer[] = [Buffer.from(STREAM_MAGIC), Buffer.alloc(4), header];
  parts[1]!.writeUInt32BE(header.length);
  for (const packet of stream.packets) {
    const head = Buffer.alloc(13);
    head.writeBigInt64BE(BigInt(packet.ptsUs), 0);
    head[8] = packet.keyframe ? 1 : 0;
    head.writeUInt32BE(packet.data.length, 9);
    parts.push(head, packet.data);
  }
  return Buffer.concat(parts);
}

export function deserializeVideoStream(bytes: Buffer): VideoStream | null {
  try {
    if (bytes.toString("latin1", 0, 4) !== STREAM_MAGIC) return null;
    const headerLength = bytes.readUInt32BE(4);
    const header = JSON.parse(bytes.toString("utf8", 8, 8 + headerLength)) as { width: number; height: number; durationUs: number; remuxed: boolean; count: number };
    const packets: VideoPacket[] = [];
    let offset = 8 + headerLength;
    for (let index = 0; index < header.count; index++) {
      const ptsUs = Number(bytes.readBigInt64BE(offset));
      const keyframe = bytes[offset + 8] === 1;
      const length = bytes.readUInt32BE(offset + 9);
      offset += 13;
      if (offset + length > bytes.length) return null;
      packets.push({ ptsUs, keyframe, data: bytes.subarray(offset, offset + length) });
      offset += length;
    }
    if (!packets.length || !packets[0]!.keyframe) return null;
    return { width: header.width, height: header.height, durationUs: header.durationUs, remuxed: header.remuxed, packets };
  } catch {
    return null;
  }
}

/** Bump when streams are encoded differently. */
const STREAM_FORMAT = 1;
export const VIDEO_STREAM_DISK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Encoded GIF streams on disk (`image-cache/videos`), least recently used out past the budget. */
export class VideoStreamDiskCache {
  private bytes: number | null = null;

  constructor(private readonly dir: string, private readonly maxBytes = VIDEO_STREAM_DISK_CACHE_MAX_BYTES) {}

  /** Keyed by the animation's identity (its URL's path, not a re-signed query) and the box. */
  key(identity: string, maxWidth: number, maxHeight: number, background = ""): string {
    return createHash("sha256").update(JSON.stringify([STREAM_FORMAT, identity, Math.round(maxWidth), Math.round(maxHeight), background])).digest("hex").slice(0, 32);
  }

  async get(key: string): Promise<VideoStream | null> {
    const path = join(this.dir, `${key}.rvs`);
    try {
      const stream = deserializeVideoStream(await readFile(path));
      if (stream) {
        const now = new Date();
        void utimes(path, now, now).catch(() => {});
      }
      return stream;
    } catch {
      return null;
    }
  }

  getSync(key: string): VideoStream | null {
    try {
      return deserializeVideoStream(readFileSync(join(this.dir, `${key}.rvs`)));
    } catch {
      return null;
    }
  }

  async set(key: string, stream: VideoStream): Promise<void> {
    const bytes = serializeVideoStream(stream);
    const path = join(this.dir, `${key}.rvs`);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path);
      if (this.bytes !== null) this.bytes += bytes.length;
      if (this.bytes === null || this.bytes > this.maxBytes) await this.prune(path);
    } catch {
      // An optimization only.
    }
  }

  private async prune(keep: string): Promise<void> {
    const entries: { path: string; bytes: number; modifiedAtMs: number }[] = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith(".rvs")) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) entries.push({ path, bytes: info.size, modifiedAtMs: info.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    entries.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path));
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      if (entry.path === keep) continue;
      await unlink(entry.path).catch(() => {});
      total -= entry.bytes;
    }
    this.bytes = total;
  }
}
