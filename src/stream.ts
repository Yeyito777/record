import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { debugLog } from "./debuglog";
import { OPUS_PAYLOAD_TYPE, RTP_HEADER_LENGTH, VIDEO_PAYLOAD_TYPE_H264, VIDEO_RTX_PAYLOAD_TYPE_H264 } from "./voice/constants";
import { bindUdp, decryptAes256GcmRtp, encryptAes256GcmRtp, parsePlainRtpPacket } from "./voice/rtp";
import { rewriteH264SpsVuiForWebRtc } from "./voice/sps-vui";
import type { VoiceAudioBackend, VoiceAudioContext } from "./voice/types";

const RUN_STREAM_HELPER_PATH = fileURLToPath(new URL("../scripts/run-stream-helper", import.meta.url));
const DEFAULT_STREAM_HELPER_COMMAND = [RUN_STREAM_HELPER_PATH];
const STREAM_HELPER_SHUTDOWN_GRACE_MS = 1_500;
const STREAM_SOUNDSHARE_FLAG = 1 << 1;
const VIDEO_RTP_CLOCK_RATE = 90_000;
const RTP_EXTENSION_PROFILE_ONE_BYTE = 0xbede;
const RTP_TRANSPORT_SEQUENCE_EXTENSION_ID = 5;
const PLAYOUT_DELAY_EXTENSION_ID = 6;
const VIDEO_CONTENT_TYPE_EXTENSION_ID = 7;
const RTP_STREAM_ID_EXTENSION_ID = 11;
const RTP_REPAIRED_STREAM_ID_EXTENSION_ID = 12;
const PLAYOUT_DELAY_MIN_10MS = 0;
const PLAYOUT_DELAY_MAX_10MS = 10;
const VIDEO_CONTENT_TYPE_SCREEN = 1;
const STREAM_RID = "100";
const H264_START_CODE_3 = Buffer.from([0x00, 0x00, 0x01]);
const H264_START_CODE_4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const H264_NAL_TYPE_IDR = 5;
const H264_NAL_TYPE_SPS = 7;
const H264_NAL_TYPE_AUD = 9;
const H264_NAL_TYPE_FU_A = 28;
const MAX_H264_RTP_PAYLOAD_BYTES = 1_100;
const VIDEO_PACKET_PACE_INTERVAL_MS = 2;
const VIDEO_PACKETS_PER_PACE_TICK = 8;
const VIDEO_QUEUE_DROP_THRESHOLD = 600;
const RTCP_SENDER_REPORT_INTERVAL_MS = 5_000;
const NTP_UNIX_EPOCH_OFFSET_SECONDS = 2_208_988_800;
const STREAM_VIDEO_STATS_INTERVAL_MS = 5_000;
const VIDEO_RTP_HISTORY_PACKETS = 2_048;

export interface StreamMediaBackendOptions {
  command?: string[];
  disabled?: boolean;
}

export class StreamMediaBackend implements VoiceAudioBackend {
  private context: VoiceAudioContext | null = null;
  private audioSocket: UdpSocket | null = null;
  private proc: ChildProcess | null = null;
  private sendCounter = 0;
  private videoSequence = Math.floor(Math.random() * 0x10000);
  private videoTransportSequence = Math.floor(Math.random() * 0x10000);
  private videoRtxSequence = Math.floor(Math.random() * 0x10000);
  private videoTimestamp = Math.floor(Math.random() * 0x100000000) >>> 0;
  private audioSpeaking = false;
  private videoPackets = 0;
  private videoFrames = 0;
  private firstSentVideoLogged = false;
  private sentInitialVideoKeyframe = false;
  private videoPayloadOctets = 0;
  private videoKeyframes = 0;
  private lastVideoStatsAt = 0;
  private lastVideoStatsFrames = 0;
  private lastVideoStatsBytes = 0;
  private lastVideoStatsKeyframes = 0;
  private lastAudioTimestamp = 0;
  private audioPayloadOctets = 0;
  private audioPackets = 0;
  private incomingUdpPackets = 0;
  private capturedVideoBytes = 0;
  private capturedVideoFrames = 0;
  private videoRtxPackets = 0;
  private readonly videoHistory = new Map<number, StoredVideoRtpPacket>();
  private videoPacketQueue: Buffer[] = [];
  private videoPaceTimer: ReturnType<typeof setInterval> | null = null;
  private rtcpSenderReportTimer: ReturnType<typeof setInterval> | null = null;
  private readonly command: string[];
  private readonly videoAssembler = new H264AnnexBFrameAssembler((nalus) => this.handleVideoFrame(nalus));

  constructor(private readonly options: StreamMediaBackendOptions = {}) {
    this.command = options.command ?? DEFAULT_STREAM_HELPER_COMMAND;
  }

  async start(context: VoiceAudioContext): Promise<void> {
    this.context = context;
    this.firstSentVideoLogged = false;
    this.sentInitialVideoKeyframe = false;
    this.incomingUdpPackets = 0;
    this.capturedVideoBytes = 0;
    this.capturedVideoFrames = 0;
    this.videoRtxPackets = 0;
    this.videoHistory.clear();
    this.videoPayloadOctets = 0;
    this.videoKeyframes = 0;
    this.lastVideoStatsAt = 0;
    this.lastVideoStatsFrames = 0;
    this.lastVideoStatsBytes = 0;
    this.lastVideoStatsKeyframes = 0;
    this.lastAudioTimestamp = 0;
    this.audioPayloadOctets = 0;
    this.videoPacketQueue = [];
    if (this.options.disabled) return;
    if (!context.videoSsrc) {
      throw new Error("Discord did not allocate a video SSRC for this stream.");
    }
    if (!context.sendSpeakingFlags) {
      throw new Error("Discord stream connection cannot announce soundshare audio.");
    }
    if (context.mode !== "aead_aes256_gcm_rtpsize") {
      if (context.mode === "webrtc" && context.sendEncodedVideoFrame && context.sendOpusFrame) {
        const audioSocket = createSocket("udp4");
        this.audioSocket = audioSocket;
        const audioPort = await bindUdp(audioSocket, "127.0.0.1", 0);
        audioSocket.on("message", this.handleAudioPacket);
        context.sendVideo?.();
        context.sendSpeakingFlags(STREAM_SOUNDSHARE_FLAG);
        this.startHelper(context, audioPort);
        return;
      }
      throw new Error(`Discord stream connected without media: unsupported encryption mode ${context.mode}.`);
    }

    const audioSocket = createSocket("udp4");
    this.audioSocket = audioSocket;
    const audioPort = await bindUdp(audioSocket, "127.0.0.1", 0);
    audioSocket.on("message", this.handleAudioPacket);
    context.udp.on("message", this.handleDiscordPacket);

    context.sendVideo?.();
    context.sendSpeakingFlags(STREAM_SOUNDSHARE_FLAG);
    this.startRtcpSenderReports(context);
    this.startHelper(context, audioPort);
  }

  stop(): void {
    const context = this.context;
    if (context?.sendSpeakingFlags) context.sendSpeakingFlags(0);
    if (context) context.udp.off("message", this.handleDiscordPacket);
    this.context = null;
    this.audioSpeaking = false;
    this.videoAssembler.reset();
    this.videoPacketQueue = [];
    this.videoHistory.clear();
    this.stopVideoPacer();
    this.stopRtcpSenderReports();
    if (this.audioSocket) {
      this.audioSocket.off("message", this.handleAudioPacket);
      try { this.audioSocket.close(); } catch {}
      this.audioSocket = null;
    }
    terminateHelper(this.proc);
    this.proc = null;
    debugLog("stream.media.stop", { videoFrames: this.videoFrames, videoPackets: this.videoPackets, audioPackets: this.audioPackets, incomingUdpPackets: this.incomingUdpPackets });
  }

  private startHelper(context: VoiceAudioContext, audioPort: number): void {
    const executable = this.command[0];
    if (!executable || !existsSync(executable)) {
      throw new Error("record stream helper is missing; run scripts/build-stream-helper.");
    }
    const args = [
      ...this.command.slice(1),
      "--audio-port", String(audioPort),
      "--audio-ssrc", String(context.ssrc),
      "--parent-pid", String(process.pid),
    ];
    debugLog("stream.media.start", { command: executable, args, audioPort, videoSsrc: context.videoSsrc, audioSsrc: context.ssrc, videoTransport: "h264-annexb-stdout" });
    const proc = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout?.on("data", (chunk) => {
      if (this.proc !== proc) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.capturedVideoBytes += bytes.length;
      if (this.capturedVideoBytes === bytes.length) debugLog("stream.media.first_capture_chunk", { bytes: bytes.length });
      this.videoAssembler.push(bytes);
    });
    const stderr = drainStderr(proc);
    proc.on("error", (error) => {
      if (this.proc !== proc) return;
      context.onError(new Error(`Failed to start stream helper: ${error.message}`));
      if (this.context === context) this.stop();
    });
    proc.on("exit", (code, signal) => {
      const details = stderr().trim();
      debugLog("stream.media.exit", { code, signal, details });
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.context !== context || signal === "SIGTERM" || signal === "SIGKILL") return;
      context.onError(new Error(`Screen stream stopped${details ? `: ${details}` : "."}`));
      if (this.context === context) this.stop();
    });
  }

  private readonly handleVideoFrame = (nalus: Buffer[]): void => {
    const context = this.context;
    if (!context || !context.videoSsrc) return;
    this.capturedVideoFrames += 1;
    if (this.capturedVideoFrames === 1) debugLog("stream.media.first_captured_frame", { nalus: nalus.length, bytes: nalus.reduce((sum, nalu) => sum + nalu.length, 0) });
    const videoSsrc = context.videoSsrc;
    if (nalus.length === 0) return;
    const keyframe = isH264Keyframe(nalus);
    if (!this.sentInitialVideoKeyframe) {
      if (!keyframe) return;
    }
    const payloadType = context.videoPayloadType ?? VIDEO_PAYLOAD_TYPE_H264;
    const normalizedNalus = context.sendEncodedVideoFrame ? rewriteH264SpsNalusForWebRtc(nalus) : nalus;
    const encodedFrame = context.encodeOutgoingVideo ? context.encodeOutgoingVideo(annexBAccessUnit(normalizedNalus), "H264") : null;
    if (context.sendEncodedVideoFrame) {
      if (!encodedFrame || encodedFrame.length === 0) return;
      if (!this.sentInitialVideoKeyframe) this.sentInitialVideoKeyframe = true;
      this.videoFrames += 1;
      this.videoPackets += 1;
      this.videoPayloadOctets += encodedFrame.length;
      if (keyframe) this.videoKeyframes += 1;
      context.sendEncodedVideoFrame(encodedFrame, 1000 / 30, keyframe);
      this.maybeLogVideoStats("webrtc-frame", encodedFrame.length);
      if (!this.firstSentVideoLogged) {
        this.firstSentVideoLogged = true;
        debugLog("stream.media.first_video", { frameNalus: nalus.length, packets: 1, timestamp: this.videoTimestamp, clockRate: VIDEO_RTP_CLOCK_RATE, packetization: "webrtc-frame", encodedBytes: encodedFrame.length, keyframe });
      }
      return;
    }
    const packetization = context.encodeOutgoingVideo
      ? packetizeMaybeAnnexBVideoPayload(encodedFrame, MAX_H264_RTP_PAYLOAD_BYTES)
      : { payloads: packetizeH264AccessUnit(nalus, MAX_H264_RTP_PAYLOAD_BYTES), mode: "h264" as const };
    const { payloads } = packetization;
    if (payloads.length === 0) return;
    if (!keyframe && this.videoPacketQueue.length > VIDEO_QUEUE_DROP_THRESHOLD) return;
    if (!this.sentInitialVideoKeyframe) this.sentInitialVideoKeyframe = true;
    this.videoFrames += 1;
    if (keyframe) this.videoKeyframes += 1;
    this.videoTimestamp = (this.videoTimestamp + Math.round(VIDEO_RTP_CLOCK_RATE / 30)) >>> 0;

    payloads.forEach((payload, index) => {
      const sequence = this.videoSequence & 0xffff;
      const marker = index === payloads.length - 1;
      const extensionBody = buildDiscordVideoRtpExtensionBody(this.videoTransportSequence);
      this.videoTransportSequence = (this.videoTransportSequence + 1) & 0xffff;
      // In Discord's rtpsize AEAD modes, only the RTP header and extension
      // prelude are clear/AAD. The extension body is transport-encrypted along
      // with the H.264 payload.
      const header = Buffer.alloc(RTP_HEADER_LENGTH + 4);
      header[0] = 0x90;
      header[1] = (marker ? 0x80 : 0) | payloadType;
      header.writeUInt16BE(sequence, 2);
      header.writeUInt32BE(this.videoTimestamp >>> 0, 4);
      header.writeUInt32BE(videoSsrc >>> 0, 8);
      header.writeUInt16BE(RTP_EXTENSION_PROFILE_ONE_BYTE, 12);
      header.writeUInt16BE(extensionBody.length / 4, 14);
      this.videoSequence = (this.videoSequence + 1) & 0xffff;

      const encrypted = encryptAes256GcmRtp(header, Buffer.concat([extensionBody, payload]), context.secretKey, this.nextCounter());
      this.videoPacketQueue.push(encrypted);
      this.rememberVideoPacket({ sequence, timestamp: this.videoTimestamp, marker, payload: Buffer.from(payload) });
      this.videoPackets += 1;
      this.videoPayloadOctets += payload.length;
    });
    this.ensureVideoPacer();
    this.maybeLogVideoStats(packetization.mode, encodedFrame?.length ?? payloads.reduce((sum, payload) => sum + payload.length, 0));
    if (!this.firstSentVideoLogged) {
      this.firstSentVideoLogged = true;
      debugLog("stream.media.first_video", { frameNalus: nalus.length, packets: payloads.length, timestamp: this.videoTimestamp, clockRate: VIDEO_RTP_CLOCK_RATE, packetization: packetization.mode, encodedBytes: encodedFrame?.length ?? null, keyframe });
    }
  };

  private readonly handleAudioPacket = (packet: Buffer): void => {
    const context = this.context;
    if (!context) return;
    const parsed = parsePlainRtpPacket(packet);
    if (!parsed || parsed.payloadType !== OPUS_PAYLOAD_TYPE || parsed.payload.length === 0) return;
    const encodedPayload = context.encodeOutgoingOpus ? context.encodeOutgoingOpus(parsed.payload) : parsed.payload;
    if (!encodedPayload || encodedPayload.length === 0) return;

    if (context.sendOpusFrame) {
      context.sendOpusFrame(encodedPayload, 20);
      this.audioPackets += 1;
      this.lastAudioTimestamp = parsed.timestamp >>> 0;
      this.audioPayloadOctets += encodedPayload.length;
      if (!this.audioSpeaking) {
        this.audioSpeaking = true;
        context.sendSpeakingFlags?.(STREAM_SOUNDSHARE_FLAG);
      }
      if (this.audioPackets === 1) debugLog("stream.media.first_audio", { sequence: parsed.sequence, timestamp: parsed.timestamp, payloadBytes: parsed.payload.length, transport: "webrtc" });
      return;
    }

    const header = Buffer.alloc(RTP_HEADER_LENGTH);
    header[0] = 0x80;
    header[1] = OPUS_PAYLOAD_TYPE;
    header.writeUInt16BE(parsed.sequence & 0xffff, 2);
    header.writeUInt32BE(parsed.timestamp >>> 0, 4);
    header.writeUInt32BE(context.ssrc >>> 0, 8);
    const encrypted = encryptAes256GcmRtp(header, encodedPayload, context.secretKey, this.nextCounter());
    context.udp.send(encrypted);
    this.audioPackets += 1;
    this.lastAudioTimestamp = parsed.timestamp >>> 0;
    this.audioPayloadOctets += encodedPayload.length;
    if (!this.audioSpeaking) {
      this.audioSpeaking = true;
      context.sendSpeakingFlags?.(STREAM_SOUNDSHARE_FLAG);
    }
    if (this.audioPackets === 1) debugLog("stream.media.first_audio", { sequence: parsed.sequence, timestamp: parsed.timestamp, payloadBytes: parsed.payload.length });
  };

  private readonly handleDiscordPacket = (packet: Buffer): void => {
    this.incomingUdpPackets += 1;
    const version = packet.length > 0 ? packet[0] >> 6 : 0;
    const payloadType = packet.length > 1 ? packet[1] : null;
    const rtcpType = version === 2 && payloadType !== null && payloadType >= 192 && payloadType <= 223 ? payloadType : null;
    const rtcpFormat = rtcpType !== null ? packet[0] & 0x1f : null;
    const ssrc = rtcpType !== null && packet.length >= 8 ? packet.readUInt32BE(4) : null;
    if (this.incomingUdpPackets <= 5) debugLog("stream.media.incoming_udp", { bytes: packet.length, rtcpType, rtcpFormat, ssrc });
    if (rtcpType === null) return;
    const context = this.context;
    if (!context || !context.videoSsrc || !context.videoRtxSsrc) return;
    const decryptedBody = decryptAes256GcmRtp(packet, 8, context.secretKey);
    if (!decryptedBody) return;
    const clearPacket = Buffer.concat([packet.subarray(0, 8), decryptedBody]);
    const missing = parseRtcpNackSequences(clearPacket, context.videoSsrc);
    if (missing.length === 0) return;
    let retransmitted = 0;
    for (const sequence of missing.slice(0, 256)) {
      const original = this.videoHistory.get(sequence);
      if (!original) continue;
      const header = Buffer.alloc(RTP_HEADER_LENGTH + 4);
      header[0] = 0x90;
      header[1] = (original.marker ? 0x80 : 0) | VIDEO_RTX_PAYLOAD_TYPE_H264;
      header.writeUInt16BE(this.videoRtxSequence, 2);
      header.writeUInt32BE(original.timestamp >>> 0, 4);
      header.writeUInt32BE(context.videoRtxSsrc >>> 0, 8);
      const extensionBody = buildDiscordVideoRtpExtensionBody(this.videoTransportSequence, STREAM_RID, RTP_REPAIRED_STREAM_ID_EXTENSION_ID);
      header.writeUInt16BE(RTP_EXTENSION_PROFILE_ONE_BYTE, 12);
      header.writeUInt16BE(extensionBody.length / 4, 14);
      const rtxPayload = Buffer.alloc(2 + original.payload.length);
      rtxPayload.writeUInt16BE(original.sequence, 0);
      original.payload.copy(rtxPayload, 2);
      context.udp.send(encryptAes256GcmRtp(header, Buffer.concat([extensionBody, rtxPayload]), context.secretKey, this.nextCounter()));
      this.videoRtxSequence = (this.videoRtxSequence + 1) & 0xffff;
      this.videoTransportSequence = (this.videoTransportSequence + 1) & 0xffff;
      retransmitted += 1;
    }
    const firstRetransmission = this.videoRtxPackets === 0 && retransmitted > 0;
    this.videoRtxPackets += retransmitted;
    if (firstRetransmission) {
      debugLog("stream.media.rtx", { requested: missing.length, retransmitted, total: this.videoRtxPackets, history: this.videoHistory.size });
    }
  };

  private rememberVideoPacket(packet: StoredVideoRtpPacket): void {
    this.videoHistory.delete(packet.sequence);
    this.videoHistory.set(packet.sequence, packet);
    while (this.videoHistory.size > VIDEO_RTP_HISTORY_PACKETS) {
      const oldest = this.videoHistory.keys().next().value;
      if (oldest === undefined) break;
      this.videoHistory.delete(oldest);
    }
  }

  private maybeLogVideoStats(packetization: string, lastFrameBytes: number): void {
    const now = Date.now();
    if (now - this.lastVideoStatsAt < STREAM_VIDEO_STATS_INTERVAL_MS) return;
    const elapsedSeconds = this.lastVideoStatsAt === 0 ? 0 : (now - this.lastVideoStatsAt) / 1000;
    const frameDelta = this.videoFrames - this.lastVideoStatsFrames;
    const byteDelta = this.videoPayloadOctets - this.lastVideoStatsBytes;
    const keyframeDelta = this.videoKeyframes - this.lastVideoStatsKeyframes;
    debugLog("stream.media.video_stats", {
      frames: this.videoFrames,
      packets: this.videoPackets,
      rtxPackets: this.videoRtxPackets,
      keyframes: this.videoKeyframes,
      fps: elapsedSeconds > 0 ? frameDelta / elapsedSeconds : null,
      bitrateKbps: elapsedSeconds > 0 ? (byteDelta * 8) / elapsedSeconds / 1000 : null,
      keyframesInWindow: keyframeDelta,
      lastFrameBytes,
      packetization,
    });
    this.lastVideoStatsAt = now;
    this.lastVideoStatsFrames = this.videoFrames;
    this.lastVideoStatsBytes = this.videoPayloadOctets;
    this.lastVideoStatsKeyframes = this.videoKeyframes;
  }

  private ensureVideoPacer(): void {
    if (this.videoPaceTimer) return;
    this.videoPaceTimer = setInterval(() => this.flushVideoPacketQueue(), VIDEO_PACKET_PACE_INTERVAL_MS);
    this.videoPaceTimer.unref?.();
  }

  private flushVideoPacketQueue(): void {
    const context = this.context;
    if (!context) {
      this.videoPacketQueue = [];
      this.stopVideoPacer();
      return;
    }
    for (let i = 0; i < VIDEO_PACKETS_PER_PACE_TICK; i += 1) {
      const packet = this.videoPacketQueue.shift();
      if (!packet) break;
      context.udp.send(packet);
    }
    if (this.videoPacketQueue.length === 0) this.stopVideoPacer();
  }

  private stopVideoPacer(): void {
    if (!this.videoPaceTimer) return;
    clearInterval(this.videoPaceTimer);
    this.videoPaceTimer = null;
  }

  private startRtcpSenderReports(context: VoiceAudioContext): void {
    this.stopRtcpSenderReports();
    this.rtcpSenderReportTimer = setInterval(() => this.sendRtcpSenderReports(), RTCP_SENDER_REPORT_INTERVAL_MS);
    this.rtcpSenderReportTimer.unref?.();
    setTimeout(() => {
      if (this.context === context) this.sendRtcpSenderReports();
    }, 1_000).unref?.();
  }

  private stopRtcpSenderReports(): void {
    if (!this.rtcpSenderReportTimer) return;
    clearInterval(this.rtcpSenderReportTimer);
    this.rtcpSenderReportTimer = null;
  }

  private sendRtcpSenderReports(): void {
    const context = this.context;
    if (!context) return;
    const now = Date.now();
    if (this.audioPackets > 0) {
      context.udp.send(encryptRtcpSenderReport(buildRtcpSenderReport(context.ssrc, this.lastAudioTimestamp, this.audioPackets, this.audioPayloadOctets, now), context.secretKey, this.nextCounter()));
    }
    if (context.videoSsrc && this.videoPackets > 0) {
      context.udp.send(encryptRtcpSenderReport(buildRtcpSenderReport(context.videoSsrc, this.videoTimestamp, this.videoPackets, this.videoPayloadOctets, now), context.secretKey, this.nextCounter()));
    }
    debugLog("stream.media.rtcp_sr", { audioPackets: this.audioPackets, videoPackets: this.videoPackets, videoQueue: this.videoPacketQueue.length });
  }

  private nextCounter(): Buffer {
    this.sendCounter = (this.sendCounter + 1) >>> 0;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.sendCounter, 0);
    return counter;
  }
}

export function buildPlayoutDelayExtension(minDelay10Ms: number, maxDelay10Ms: number): Buffer {
  const minDelay = clamp12Bit(minDelay10Ms);
  const maxDelay = clamp12Bit(maxDelay10Ms);
  const packed = (minDelay << 12) | maxDelay;
  return Buffer.from([
    (PLAYOUT_DELAY_EXTENSION_ID << 4) | 2,
    (packed >> 16) & 0xff,
    (packed >> 8) & 0xff,
    packed & 0xff,
  ]);
}

export function buildDiscordVideoRtpExtensionBody(transportSequence: number, rid = STREAM_RID, ridExtensionId = RTP_STREAM_ID_EXTENSION_ID): Buffer {
  const body: number[] = [];
  pushOneByteRtpExtension(body, RTP_TRANSPORT_SEQUENCE_EXTENSION_ID, Buffer.from([(transportSequence >>> 8) & 0xff, transportSequence & 0xff]));
  pushOneByteRtpExtension(body, PLAYOUT_DELAY_EXTENSION_ID, buildPlayoutDelayExtension(PLAYOUT_DELAY_MIN_10MS, PLAYOUT_DELAY_MAX_10MS).subarray(1));
  pushOneByteRtpExtension(body, VIDEO_CONTENT_TYPE_EXTENSION_ID, Buffer.from([VIDEO_CONTENT_TYPE_SCREEN]));
  pushOneByteRtpExtension(body, ridExtensionId, Buffer.from(rid, "ascii"));
  while (body.length % 4 !== 0) body.push(0);
  return Buffer.from(body);
}

interface StoredVideoRtpPacket {
  sequence: number;
  timestamp: number;
  marker: boolean;
  payload: Buffer;
}

export function parseRtcpNackSequences(packet: Buffer, mediaSsrc: number): number[] {
  const missing: number[] = [];
  let offset = 0;
  while (offset + 4 <= packet.length) {
    const packetBytes = (packet.readUInt16BE(offset + 2) + 1) * 4;
    if (packetBytes < 4 || offset + packetBytes > packet.length) break;
    const format = packet[offset]! & 0x1f;
    const type = packet[offset + 1];
    if (type === 205 && format === 1 && packetBytes >= 12 && packet.readUInt32BE(offset + 8) === (mediaSsrc >>> 0)) {
      for (let cursor = offset + 12; cursor + 4 <= offset + packetBytes; cursor += 4) {
        const packetId = packet.readUInt16BE(cursor);
        const bitmask = packet.readUInt16BE(cursor + 2);
        missing.push(packetId);
        for (let bit = 0; bit < 16; bit += 1) {
          if ((bitmask & (1 << bit)) !== 0) missing.push((packetId + bit + 1) & 0xffff);
        }
      }
    }
    offset += packetBytes;
  }
  return Array.from(new Set(missing));
}

function pushOneByteRtpExtension(output: number[], id: number, value: Buffer): void {
  if (id < 1 || id > 14 || value.length < 1 || value.length > 16) throw new Error("Invalid one-byte RTP extension.");
  output.push((id << 4) | (value.length - 1), ...value);
}

function encryptRtcpSenderReport(packet: Buffer, key: Buffer, counter: Buffer): Buffer {
  return encryptAes256GcmRtp(packet.subarray(0, 8), packet.subarray(8), key, counter);
}

export function buildRtcpSenderReport(ssrc: number, rtpTimestamp: number, packetCount: number, octetCount: number, nowMs = Date.now()): Buffer {
  const packet = Buffer.alloc(28);
  packet[0] = 0x80;
  packet[1] = 200;
  packet.writeUInt16BE(6, 2);
  packet.writeUInt32BE(ssrc >>> 0, 4);
  const seconds = Math.floor(nowMs / 1000) + NTP_UNIX_EPOCH_OFFSET_SECONDS;
  const fraction = Math.floor(((nowMs % 1000) / 1000) * 0x100000000);
  packet.writeUInt32BE(seconds >>> 0, 8);
  packet.writeUInt32BE(fraction >>> 0, 12);
  packet.writeUInt32BE(rtpTimestamp >>> 0, 16);
  packet.writeUInt32BE(packetCount >>> 0, 20);
  packet.writeUInt32BE(octetCount >>> 0, 24);
  return packet;
}

function clamp12Bit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0xfff, Math.round(value)));
}

export function packetizeH264AccessUnit(nalus: readonly Buffer[], maxPayloadBytes = MAX_H264_RTP_PAYLOAD_BYTES): Buffer[] {
  const payloads: Buffer[] = [];
  for (const nalu of nalus) {
    if (nalu.length === 0 || h264NalType(nalu) === H264_NAL_TYPE_AUD) continue;
    if (nalu.length <= maxPayloadBytes) {
      payloads.push(Buffer.from(nalu));
      continue;
    }
    if (maxPayloadBytes < 3) continue;
    const nalHeader = nalu[0];
    const nalType = nalHeader & 0x1f;
    const fuIndicator = (nalHeader & 0xe0) | H264_NAL_TYPE_FU_A;
    const fragmentCapacity = maxPayloadBytes - 2;
    for (let offset = 1; offset < nalu.length; offset += fragmentCapacity) {
      const end = Math.min(nalu.length, offset + fragmentCapacity);
      const fuHeader = (offset === 1 ? 0x80 : 0) | (end === nalu.length ? 0x40 : 0) | nalType;
      payloads.push(Buffer.concat([Buffer.from([fuIndicator, fuHeader]), nalu.subarray(offset, end)]));
    }
  }
  return payloads;
}

export function isH264Keyframe(nalus: readonly Buffer[]): boolean {
  return nalus.some((nalu) => h264NalType(nalu) === H264_NAL_TYPE_IDR);
}

export function rewriteH264SpsNalusForWebRtc(nalus: readonly Buffer[]): Buffer[] {
  let rewritten = false;
  const output = nalus.map((nalu) => {
    if (h264NalType(nalu) !== H264_NAL_TYPE_SPS) return nalu;
    try {
      const next = rewriteH264SpsVuiForWebRtc(nalu);
      rewritten = true;
      return next;
    } catch (error) {
      debugLog("stream.media.sps_rewrite_failed", { message: error instanceof Error ? error.message : String(error), bytes: nalu.length });
      return nalu;
    }
  });
  return rewritten ? output : [...nalus];
}

export function packetizeGenericVideoPayload(payload: Buffer | null, maxPayloadBytes = MAX_H264_RTP_PAYLOAD_BYTES): Buffer[] {
  if (!payload || payload.length === 0) return [];
  const packets: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += maxPayloadBytes) {
    packets.push(payload.subarray(offset, Math.min(payload.length, offset + maxPayloadBytes)));
  }
  return packets;
}

export function packetizeMaybeAnnexBVideoPayload(payload: Buffer | null, maxPayloadBytes = MAX_H264_RTP_PAYLOAD_BYTES): { payloads: Buffer[]; mode: "h264-annexb" | "h264-opaque-fua" | "empty" } {
  if (!payload || payload.length === 0) return { payloads: [], mode: "empty" };
  const nalus = splitAnnexBNalus(payload);
  return nalus.length > 0
    ? { payloads: packetizeH264AccessUnit(nalus, maxPayloadBytes), mode: "h264-annexb" }
    : { payloads: packetizeH264AccessUnit([payload], maxPayloadBytes), mode: "h264-opaque-fua" };
}

function annexBAccessUnit(nalus: readonly Buffer[]): Buffer {
  return Buffer.concat(nalus.filter((nalu) => nalu.length > 0 && h264NalType(nalu) !== H264_NAL_TYPE_AUD).flatMap((nalu) => [H264_START_CODE_3, nalu]));
}

function splitAnnexBNalus(buffer: Buffer): Buffer[] {
  const nalus: Buffer[] = [];
  let cursor = findAnnexBStartCode(buffer, 0);
  if (!cursor) return nalus;
  while (cursor) {
    const next = findAnnexBStartCode(buffer, cursor.index + cursor.length);
    const nalu = buffer.subarray(cursor.index + cursor.length, next?.index ?? buffer.length);
    if (nalu.length > 0) nalus.push(nalu);
    cursor = next;
  }
  return nalus;
}

export class H264AnnexBFrameAssembler {
  private pending = Buffer.alloc(0);
  private currentAccessUnit: Buffer[] = [];

  constructor(private readonly onFrame: (nalus: Buffer[]) => void) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    this.drainCompleteNalus();
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.currentAccessUnit = [];
  }

  private drainCompleteNalus(): void {
    while (true) {
      const first = findAnnexBStartCode(this.pending, 0);
      if (!first) {
        if (this.pending.length > 4) this.pending = this.pending.subarray(this.pending.length - 4);
        return;
      }
      if (first.index > 0) this.pending = this.pending.subarray(first.index);
      const next = findAnnexBStartCode(this.pending, first.length);
      if (!next) return;
      const nalu = this.pending.subarray(first.length, next.index);
      this.pending = this.pending.subarray(next.index);
      this.pushNalu(nalu);
    }
  }

  private pushNalu(nalu: Buffer): void {
    if (nalu.length === 0) return;
    if (h264NalType(nalu) === H264_NAL_TYPE_AUD) {
      this.flushCurrentAccessUnit();
      this.currentAccessUnit = [nalu];
      return;
    }
    this.currentAccessUnit.push(nalu);
  }

  private flushCurrentAccessUnit(): void {
    const hasVideoData = this.currentAccessUnit.some((nalu) => {
      const type = h264NalType(nalu);
      return type !== H264_NAL_TYPE_AUD;
    });
    if (!hasVideoData) return;
    this.onFrame(this.currentAccessUnit);
  }
}

function findAnnexBStartCode(buffer: Buffer, offset: number): { index: number; length: 3 | 4 } | null {
  const three = buffer.indexOf(H264_START_CODE_3, offset);
  const four = buffer.indexOf(H264_START_CODE_4, offset);
  if (three === -1 && four === -1) return null;
  if (four !== -1 && (three === -1 || four <= three)) return { index: four, length: 4 };
  return { index: three, length: 3 };
}

function h264NalType(nalu: Buffer): number {
  return nalu[0] & 0x1f;
}

function terminateHelper(proc: ChildProcess | null): void {
  if (!proc || proc.killed) return;
  try { proc.kill("SIGTERM"); } catch { return; }
  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }, STREAM_HELPER_SHUTDOWN_GRACE_MS).unref?.();
}

function drainStderr(proc: ChildProcess): () => string {
  let output = "";
  proc.stderr?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    output = (output + text).slice(-8_192);
    const trimmed = text.trim();
    if (trimmed) debugLog("stream.media.stderr", { text: trimmed });
  });
  return () => output;
}
