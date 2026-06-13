import { spawn, type ChildProcess } from "child_process";
import { createSocket, type Socket as UdpSocket } from "dgram";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { debugLog } from "./debuglog";
import type { IncomingVoiceRtpPacket } from "./voice";
import { reserveUdpPort } from "./voice/rtp";

const WATCH_STREAM_HELPER_SHUTDOWN_GRACE_MS = 1_500;
const WATCH_STREAM_VIDEO_PAYLOAD_TYPE = 101;
const WATCH_STREAM_AUDIO_PAYLOAD_TYPE = 120;

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

export interface FfplayWatchStreamPlaybackOptions {
  command?: string;
}

export class FfplayWatchStreamPlayback implements WatchStreamPlayback {
  private udp: UdpSocket | null = null;
  private tempDir: string | null = null;
  private sdpPath: string | null = null;
  private proc: ChildProcess | null = null;
  private videoPort: number | null = null;
  private audioPort: number | null = null;
  private packetsForwarded = 0;
  private firstPacketLogged = false;

  constructor(private readonly options: FfplayWatchStreamPlaybackOptions = {}) {}

  async start(): Promise<void> {
    if (this.proc) return;
    this.videoPort = await reserveUdpPort();
    this.audioPort = await reserveUdpPort();
    this.udp = createSocket("udp4");
    this.tempDir = mkdtempSync(join(tmpdir(), "record-watch-stream-"));
    this.sdpPath = join(this.tempDir, "stream.sdp");
    writeFileSync(this.sdpPath, buildWatchStreamPlaybackSdp(this.videoPort, this.audioPort));

    const command = this.options.command ?? "ffplay";
    const args = buildWatchStreamFfplayArgs(this.sdpPath);
    debugLog("stream.watch.playback.start", { command, args, videoPort: this.videoPort, audioPort: this.audioPort, sdpPath: this.sdpPath });
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const stderr = drainChildOutput(proc);
    proc.on("error", (error) => {
      if (this.proc !== proc) return;
      debugLog("stream.watch.playback.spawn_error", { error: error.message });
      this.stop();
    });
    proc.on("exit", (code, signal) => {
      const details = stderr().trim();
      debugLog("stream.watch.playback.exit", { code, signal, details, packetsForwarded: this.packetsForwarded });
      if (this.proc !== proc) return;
      this.proc = null;
      if (signal === "SIGTERM" || signal === "SIGKILL") return;
      this.stop();
    });
  }

  handleIncomingRtp(packet: IncomingVoiceRtpPacket): void {
    if (!this.udp) return;
    const targetPort = packet.mediaType === "video" && packet.payloadType === WATCH_STREAM_VIDEO_PAYLOAD_TYPE
      ? this.videoPort
      : packet.mediaType === "audio" && packet.payloadType === WATCH_STREAM_AUDIO_PAYLOAD_TYPE
        ? this.audioPort
        : null;
    if (targetPort === null) return;
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
    if (this.udp) {
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
}

export function createDefaultWatchStreamPlayback(): WatchStreamPlayback {
  if (process.platform !== "linux") return new NoopWatchStreamPlayback();
  return new FfplayWatchStreamPlayback();
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

export function buildWatchStreamFfplayArgs(sdpPath: string): string[] {
  return [
    "-loglevel", "error",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-protocol_whitelist", "file,udp,rtp",
    "-i", sdpPath,
  ];
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
