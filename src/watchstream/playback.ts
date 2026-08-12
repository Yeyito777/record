import { spawn, type ChildProcess } from "child_process";
import { createSocket, type Socket as UdpSocket } from "dgram";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { debugLog } from "../debuglog";
import type { IncomingVoiceRtpPacket } from "../voice";
import { buildVoiceEnginePlaybackArgs, resolveVoiceEngineCommand } from "../voice/audio-ffmpeg";
import { OPUS_PAYLOAD_TYPE, VIDEO_PAYLOAD_TYPE_H264 } from "../voice/constants";
import { reserveUdpPort } from "../voice/rtp";

const WATCH_STREAM_HELPER_SHUTDOWN_GRACE_MS = 1_500;
const WATCH_STREAM_VIDEO_PAYLOAD_TYPE = VIDEO_PAYLOAD_TYPE_H264;
const WATCH_STREAM_AUDIO_PAYLOAD_TYPE = OPUS_PAYLOAD_TYPE;
const WATCH_STREAM_SDP_PROTOCOL_WHITELIST = "file,udp,rtp";
const WATCH_STREAM_AUDIO_READY_TIMEOUT_MS = 1_000;

export type WatchStreamPlayer = "mpv" | "ffplay";

export interface WatchStreamPlayback {
  start(): Promise<void> | void;
  handleIncomingRtp(packet: IncomingVoiceRtpPacket): void;
  stop(): void;
}

export class NoopWatchStreamPlayback implements WatchStreamPlayback {
  start(): void {}
  handleIncomingRtp(): void {}
  stop(): void {}
}

export interface PlayerWatchStreamPlaybackOptions {
  player?: WatchStreamPlayer;
  command?: string;
  args?: string[];
  title?: string;
  /** Override or disable the native stream-audio player. Intended for tests. */
  audioCommand?: string | false;
  audioArgs?: string[];
  /** Fired when the player exits on its own, e.g. the user closed the window. Not fired for stop(). */
  onEnded?: (error: Error | null) => void;
}

export class PlayerWatchStreamPlayback implements WatchStreamPlayback {
  private udp: UdpSocket | null = null;
  private tempDir: string | null = null;
  private sdpPath: string | null = null;
  private proc: ChildProcess | null = null;
  private audioProc: ChildProcess | null = null;
  private videoPort: number | null = null;
  private audioPort: number | null = null;
  private packetsForwarded = 0;
  private firstPacketLogged = false;

  constructor(private readonly options: PlayerWatchStreamPlaybackOptions = {}) {}

  async start(): Promise<void> {
    if (this.proc) return;
    this.videoPort = await reserveUdpPort();
    this.audioPort = await reserveUdpPort();
    this.udp = createSocket("udp4");
    // mpv opens the SDP's local UDP ports asynchronously. A packet sent during
    // that small startup race can produce an ICMP port-unreachable response;
    // without an error listener Node treats it as an uncaught process error.
    this.udp.on("error", this.handleUdpError);
    this.tempDir = mkdtempSync(join(tmpdir(), "record-watch-stream-"));
    this.sdpPath = join(this.tempDir, "stream.sdp");
    // Keep Opus out of the libavformat A/V session. With Discord's high-rate
    // H264 screen RTP, that demuxer can starve its second UDP socket until the
    // kernel audio queue fills. The native Rust voice engine consumes clear
    // Opus RTP independently and provides its own jitter/loss handling.
    writeFileSync(this.sdpPath, buildWatchStreamPlaybackSdp(this.videoPort, null));

    const audioCommand = this.options.audioCommand === false ? null : this.options.audioCommand ?? resolveVoiceEngineCommand();
    if (audioCommand && this.audioPort !== null) {
      const readyPath = join(this.tempDir, `audio-${Date.now()}.ready`);
      const audioArgs = this.options.audioArgs ?? buildVoiceEnginePlaybackArgs(this.audioPort, readyPath, process.pid);
      debugLog("stream.watch.audio.start", { backend: "engine", command: audioCommand, args: audioArgs, audioPort: this.audioPort });
      const audioProc = spawn(audioCommand, audioArgs, { stdio: ["pipe", "pipe", "pipe"] });
      this.audioProc = audioProc;
      const audioOutput = drainChildOutput(audioProc);
      audioProc.on("error", (error) => this.handleAudioPlaybackEnd(audioProc, new Error(`Failed to start stream audio: ${error.message}`)));
      audioProc.on("exit", (code, signal) => {
        if (this.audioProc !== audioProc) return;
        const details = audioOutput().trim();
        const reason = typeof code === "number" ? `exited with status ${code}` : `was killed by ${signal ?? "a signal"}`;
        this.handleAudioPlaybackEnd(audioProc, new Error(`Stream audio ${reason}${details ? `: ${details}` : ""}`));
      });
      if (!this.options.audioArgs) await waitForFile(readyPath, WATCH_STREAM_AUDIO_READY_TIMEOUT_MS);
      if (this.audioProc !== audioProc) return;
    } else if (this.options.audioCommand !== false) {
      debugLog("stream.watch.audio.unavailable", { reason: "voice_engine_missing" });
      this.audioPort = null;
    }

    const player = this.options.player ?? "mpv";
    const command = this.options.command ?? player;
    const args = this.options.args ?? (player === "mpv"
      ? buildWatchStreamMpvArgs(this.sdpPath, this.options.title)
      : buildWatchStreamFfplayArgs(this.sdpPath, this.options.title));
    debugLog("stream.watch.playback.start", { command, args, videoPort: this.videoPort, audioPort: this.audioPort, sdpPath: this.sdpPath });
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const stderr = drainChildOutput(proc);
    proc.on("error", (error) => {
      if (this.proc !== proc) return;
      this.proc = null;
      debugLog("stream.watch.playback.spawn_error", { error: error.message });
      this.stop();
      this.options.onEnded?.(new Error(`Failed to start ${command}: ${error.message}`));
    });
    proc.on("exit", (code, signal) => {
      const details = stderr().trim();
      debugLog("stream.watch.playback.exit", { code, signal, details, packetsForwarded: this.packetsForwarded });
      if (this.proc !== proc) return;
      this.proc = null;
      this.stop();
      this.options.onEnded?.(playerExitError(command, code, signal, details));
    });
  }

  handleIncomingRtp(packet: IncomingVoiceRtpPacket): void {
    if (!this.udp) return;
    const playbackMediaType = packet.mediaType === "video" && packet.payloadType === WATCH_STREAM_VIDEO_PAYLOAD_TYPE
      ? "video"
      : packet.mediaType === "audio" && packet.payloadType === WATCH_STREAM_AUDIO_PAYLOAD_TYPE
        ? "audio"
        : null;
    const targetPort = playbackMediaType === "video" ? this.videoPort : playbackMediaType === "audio" ? this.audioPort : null;
    if (playbackMediaType === null || targetPort === null) return;
    this.udp.send(packet.packet, targetPort, "127.0.0.1");
    this.packetsForwarded += 1;
    if (!this.firstPacketLogged) {
      this.firstPacketLogged = true;
      debugLog("stream.watch.playback.first_packet", {
        streamKey: packet.streamKey,
        payloadType: packet.payloadType,
        ssrc: packet.ssrc,
        bytes: packet.packet.length,
      });
    }
  }

  stop(): void {
    terminateChild(this.proc);
    this.proc = null;
    terminateChild(this.audioProc);
    this.audioProc = null;
    if (this.udp) {
      this.udp.off("error", this.handleUdpError);
      try { this.udp.close(); } catch {}
      this.udp = null;
    }
    if (this.tempDir) {
      try { rmSync(this.tempDir, { recursive: true, force: true }); } catch {}
      this.tempDir = null;
    }
    this.sdpPath = null;
    this.videoPort = null;
    this.audioPort = null;
    this.firstPacketLogged = false;
    this.packetsForwarded = 0;
  }

  private readonly handleUdpError = (error: Error): void => {
    debugLog("stream.watch.playback.udp_error", { error: error.message, packetsForwarded: this.packetsForwarded });
  };

  private handleAudioPlaybackEnd(proc: ChildProcess, error: Error): void {
    if (this.audioProc !== proc) return;
    this.audioProc = null;
    debugLog("stream.watch.audio.exit", { error: error.message });
    this.stop();
    this.options.onEnded?.(error);
  }
}

export interface CreateWatchStreamPlaybackOptions {
  title?: string;
  onEnded?: (error: Error | null) => void;
}

export function createDefaultWatchStreamPlayback(options: CreateWatchStreamPlaybackOptions = {}): WatchStreamPlayback {
  if (process.platform !== "linux") return new NoopWatchStreamPlayback();
  return new PlayerWatchStreamPlayback({ player: resolveWatchStreamPlayer(), ...options });
}

export function resolveWatchStreamPlayer(env: Record<string, string | undefined> = process.env, which: (command: string) => string | null = Bun.which): WatchStreamPlayer {
  const requested = env.RECORD_WATCH_PLAYER?.trim().toLowerCase();
  if (requested === "mpv" || requested === "ffplay") return requested;
  if (requested) debugLog("stream.watch.playback.unknown_player", { requested });
  return which("mpv") ? "mpv" : "ffplay";
}

export function buildWatchStreamPlaybackSdp(videoPort: number, audioPort: number | null = null, videoPayloadType = WATCH_STREAM_VIDEO_PAYLOAD_TYPE, audioPayloadType = WATCH_STREAM_AUDIO_PAYLOAD_TYPE): string {
  const sections = [
    `m=video ${videoPort} RTP/AVP ${videoPayloadType}`,
    `a=rtpmap:${videoPayloadType} H264/90000`,
    `a=fmtp:${videoPayloadType} profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1`,
    `a=rtcp-fb:${videoPayloadType} nack`,
    `a=rtcp-fb:${videoPayloadType} nack pli`,
  ];
  if (audioPort !== null) {
    sections.push(
      `m=audio ${audioPort} RTP/AVP ${audioPayloadType}`,
      `a=rtpmap:${audioPayloadType} opus/48000/2`,
      `a=fmtp:${audioPayloadType} minptime=10;useinbandfec=1`,
    );
  }
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=record-watch-stream",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    ...sections,
  ].join("\n");
}

export function buildWatchStreamMpvArgs(sdpPath: string, title?: string): string[] {
  return [
    "--profile=low-latency",
    "--hwdec=auto-safe",
    "--force-window=immediate",
    "--msg-level=all=error",
    `--title=${title ?? "record stream"}`,
    `--demuxer-lavf-o-append=protocol_whitelist=${WATCH_STREAM_SDP_PROTOCOL_WHITELIST}`,
    sdpPath,
  ];
}

export function buildWatchStreamFfplayArgs(sdpPath: string, title?: string): string[] {
  return [
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-protocol_whitelist", WATCH_STREAM_SDP_PROTOCOL_WHITELIST,
    ...(title ? ["-window_title", title] : []),
    "-i", sdpPath,
  ];
}

function playerExitError(command: string, code: number | null, signal: NodeJS.Signals | null, details: string): Error | null {
  if (code === 0) return null;
  const reason = typeof code === "number" ? `exited with status ${code}` : `was killed by ${signal ?? "a signal"}`;
  const lastLine = details.split("\n").filter((line) => line.trim()).pop();
  return new Error(`${command} ${reason}${lastLine ? `: ${lastLine.trim()}` : ""}`);
}

function drainChildOutput(proc: ChildProcess): () => string {
  let output = "";
  const append = (chunk: Buffer | string): void => {
    output += chunk.toString();
    if (output.length > 8_000) output = output.slice(-8_000);
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  return () => output;
}

function terminateChild(proc: ChildProcess | null): void {
  if (!proc || proc.killed) return;
  try { proc.kill("SIGTERM"); } catch {}
  const timer = setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {}
  }, WATCH_STREAM_HELPER_SHUTDOWN_GRACE_MS);
  timer.unref?.();
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  debugLog("stream.watch.audio.ready_timeout", { path, timeoutMs });
}
