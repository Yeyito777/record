import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createSocket, type Socket as UdpSocket } from "dgram";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { debugLog } from "../debuglog";
import { OPUS_PAYLOAD_TYPE, OPUS_RTP_CLOCK_INCREMENT, OPUS_SILENCE_FRAME, RTP_HEADER_LENGTH } from "./constants";
import { dbToLinear, linearToDb, speakingIdleMs, speakingStartThresholdDb, speakingStopThresholdDb } from "./env";
import { bindUdp, decryptAes256GcmRtp, encryptAes256GcmRtp, parseDiscordRtpPacket, parsePlainRtpPacket, reserveUdpPort } from "./rtp";
import { NoopVoiceAudioBackend, type VoiceAudioBackend, type VoiceAudioContext } from "./types";

export function createDefaultVoiceAudioBackend(): VoiceAudioBackend {
  if (process.platform !== "linux") return new NoopVoiceAudioBackend();
  return new FfmpegRtpVoiceAudioBackend();
}

export class FfmpegRtpVoiceAudioBackend implements VoiceAudioBackend {
  private context: VoiceAudioContext | null = null;
  private captureSocket: UdpSocket | null = null;
  private playbackSocket: UdpSocket | null = null;
  private captureProcess: ChildProcessWithoutNullStreams | null = null;
  private playbackProcess: ChildProcessWithoutNullStreams | null = null;
  private tempDir: string | null = null;
  private localPlaybackPort: number | null = null;
  private sendSequence = 0;
  private sendTimestamp = 0;
  private sendCounter = 0;
  private speaking = false;
  private capturePacketCount = 0;
  private forwardedPacketCount = 0;
  private droppedPacketCount = 0;
  private nonSilencePacketCount = 0;
  private captureDropLogged = false;
  private playbackPacketCount = 0;
  private playbackParsedPacketCount = 0;
  private playbackTransportFailCount = 0;
  private playbackEmptyPayloadCount = 0;
  private playbackDaveDropCount = 0;
  private playbackForwardedPacketCount = 0;
  private playbackSendErrorCount = 0;
  private playbackWrongPayloadCount = 0;
  private playbackInvalidPacketCount = 0;
  private playbackSelfDeafDropCount = 0;
  private playbackFirstPacketLogged = false;
  private lastPlaybackStatsAt = 0;
  private pcmRemainder = Buffer.alloc(0);
  private lastInputLevelDb = -Infinity;
  // Coupled with discord-cli's transcription speech gate.  If the Record
  // speaking-widget hysteresis/idle logic changes here, mirror the intent in:
  // /home/yeyito/Workspace/exocortex/external-tools/discord-cli/src/calls/receive.py
  private readonly speakingStartThresholdDb = speakingStartThresholdDb();
  private readonly speakingStopThresholdDb = speakingStopThresholdDb();
  private readonly speakingStartThreshold = dbToLinear(this.speakingStartThresholdDb);
  private readonly speakingStopThreshold = dbToLinear(this.speakingStopThresholdDb);
  private readonly speakingIdleMs = speakingIdleMs();
  private speakingIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handleDiscordPacket = (packet: Buffer): void => this.forwardDiscordPacket(packet);
  private readonly handleCapturePacket = (packet: Buffer): void => this.forwardCapturePacket(packet);
  private readonly handleCapturePcm = (chunk: Buffer | string): void => this.updateCaptureLevel(chunk);

  async start(context: VoiceAudioContext): Promise<void> {
    this.context = context;
    if (context.mode !== "aead_aes256_gcm_rtpsize") {
      context.onError(new Error(`Voice audio is connected without local audio: unsupported encryption mode ${context.mode}.`));
      return;
    }

    context.udp.on("message", this.handleDiscordPacket);
    this.resetPlaybackStats();
    await Promise.all([
      this.startPlayback(context),
      this.startCapture(context),
    ]);
  }

  stop(): void {
    if (this.context) {
      this.context.udp.off("message", this.handleDiscordPacket);
      if (this.speaking) this.context.sendSpeaking(false);
    }
    this.context = null;
    this.speaking = false;
    if (this.speakingIdleTimer) {
      clearTimeout(this.speakingIdleTimer);
      this.speakingIdleTimer = null;
    }

    if (this.captureSocket) {
      this.captureSocket.off("message", this.handleCapturePacket);
      try { this.captureSocket.close(); } catch {}
      this.captureSocket = null;
    }
    this.captureProcess?.stdout.off("data", this.handleCapturePcm);
    this.pcmRemainder = Buffer.alloc(0);
    if (this.playbackSocket) {
      try { this.playbackSocket.close(); } catch {}
      this.playbackSocket = null;
    }
    this.captureProcess?.kill("SIGTERM");
    this.captureProcess = null;
    this.playbackProcess?.kill("SIGTERM");
    this.playbackProcess = null;
    this.logPlaybackStats("stop", true);
    if (this.tempDir) {
      try { rmSync(this.tempDir, { recursive: true, force: true }); } catch {}
      this.tempDir = null;
    }
  }

  private async startPlayback(context: VoiceAudioContext): Promise<void> {
    const port = await reserveUdpPort();
    this.localPlaybackPort = port;
    this.playbackSocket = createSocket("udp4");
    this.tempDir = mkdtempSync(join(tmpdir(), "record-voice-"));
    const sdpPath = join(this.tempDir, "voice.sdp");
    writeFileSync(sdpPath, buildVoicePlaybackSdp(port));

    const args = buildFfplayPlaybackArgs(sdpPath);
    debugLog("voice.playback.start", { port, sdpPath, args, codecChannels: 2 });
    this.playbackProcess = spawn("ffplay", args);
    this.playbackProcess.stdin.end();
    const playbackErrorOutput = drainChildOutput(this.playbackProcess);
    this.playbackProcess.on("error", (error) => {
      debugLog("voice.playback.spawn_error", { error: error.message });
      context.onError(new Error(`Failed to start voice playback: ${error.message}`));
    });
    this.playbackProcess.on("exit", (code, signal) => {
      const details = playbackErrorOutput().trim();
      debugLog("voice.playback.exit", { code, signal, details, active: this.context === context });
      if (this.context !== context || code === 0 || signal === "SIGTERM") return;
      context.onError(new Error(`Voice playback stopped${details ? `: ${details}` : "."}`));
    });
  }

  private async startCapture(context: VoiceAudioContext): Promise<void> {
    const socket = createSocket("udp4");
    this.captureSocket = socket;
    socket.on("message", this.handleCapturePacket);
    const port = await bindUdp(socket, "127.0.0.1", 0);

    debugLog("voice.capture.start", { input: "default", speakingStartThresholdDb: this.speakingStartThresholdDb, speakingStopThresholdDb: this.speakingStopThresholdDb, speakingIdleMs: this.speakingIdleMs });
    this.captureProcess = spawn("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "pulse",
      "-i", "default",
      "-filter_complex", "[0:a]asplit=2[aout][meter]",
      "-map", "[aout]",
      "-ac", "2",
      "-ar", "48000",
      "-c:a", "libopus",
      "-application", "voip",
      "-frame_duration", "20",
      "-payload_type", String(OPUS_PAYLOAD_TYPE),
      "-f", "rtp",
      `rtp://127.0.0.1:${port}`,
      "-map", "[meter]",
      "-ac", "1",
      "-ar", "16000",
      "-f", "s16le",
      "pipe:1",
    ]);
    this.captureProcess.stdout.on("data", this.handleCapturePcm);
    const captureErrorOutput = drainChildStderr(this.captureProcess);
    this.captureProcess.on("error", (error) => {
      debugLog("voice.capture.spawn_error", { error: error.message });
      context.onError(new Error(`Failed to start voice capture: ${error.message}`));
    });
    this.captureProcess.on("exit", (code, signal) => {
      const details = captureErrorOutput().trim();
      debugLog("voice.capture.exit", { code, signal, details });
      if (code !== 0 && this.context === context) context.onError(new Error("Voice capture stopped; microphone audio is not being sent."));
    });
  }

  private forwardDiscordPacket(packet: Buffer): void {
    const context = this.context;
    this.playbackPacketCount += 1;
    if (!context || !this.playbackSocket || this.localPlaybackPort === null) {
      this.playbackInvalidPacketCount += 1;
      this.logPlaybackStats("missing_context");
      return;
    }
    if (context.selfDeaf) {
      this.playbackSelfDeafDropCount += 1;
      this.logPlaybackStats("self_deaf");
      return;
    }
    const parsed = parseDiscordRtpPacket(packet);
    if (!parsed) {
      this.playbackInvalidPacketCount += 1;
      this.logPlaybackStats("invalid_rtp");
      return;
    }
    this.playbackParsedPacketCount += 1;
    if (parsed.payloadType !== OPUS_PAYLOAD_TYPE) {
      this.playbackWrongPayloadCount += 1;
      this.logPlaybackStats("wrong_payload");
      return;
    }

    const decrypted = decryptAes256GcmRtp(packet, parsed.headerLength, context.secretKey);
    if (!decrypted) {
      this.playbackTransportFailCount += 1;
      this.logPlaybackStats("transport_fail");
      return;
    }
    const extensionBodyLength = parsed.hasExtension ? packet.readUInt16BE(parsed.headerLength - 2) * 4 : 0;
    const opusPayload = extensionBodyLength < decrypted.length ? decrypted.subarray(extensionBodyLength) : Buffer.alloc(0);
    if (opusPayload.length === 0) {
      this.playbackEmptyPayloadCount += 1;
      this.logPlaybackStats("empty_payload");
      return;
    }
    const decodedPayload = context.decodeIncomingOpus ? context.decodeIncomingOpus(parsed.ssrc, opusPayload) : opusPayload;
    if (!decodedPayload || decodedPayload.length === 0) {
      this.playbackDaveDropCount += 1;
      this.logPlaybackStats("dave_drop");
      return;
    }

    const header = Buffer.alloc(RTP_HEADER_LENGTH);
    header[0] = 0x80;
    header[1] = OPUS_PAYLOAD_TYPE;
    header.writeUInt16BE(parsed.sequence, 2);
    header.writeUInt32BE(parsed.timestamp, 4);
    header.writeUInt32BE(parsed.ssrc, 8);
    this.playbackSocket.send(Buffer.concat([header, decodedPayload]), this.localPlaybackPort, "127.0.0.1", (error) => {
      if (error) {
        this.playbackSendErrorCount += 1;
        debugLog("voice.playback.send_error", { error: error.message });
      }
    });
    this.playbackForwardedPacketCount += 1;
    if (!this.playbackFirstPacketLogged) {
      this.playbackFirstPacketLogged = true;
      debugLog("voice.playback.first_packet", {
        ssrc: parsed.ssrc,
        sequence: parsed.sequence,
        timestamp: parsed.timestamp,
        payloadBytes: opusPayload.length,
        decodedBytes: decodedPayload.length,
        hasExtension: parsed.hasExtension,
        extensionBodyLength,
        localPort: this.localPlaybackPort,
      });
    }
    this.logPlaybackStats("forwarded");
  }

  private resetPlaybackStats(): void {
    this.playbackPacketCount = 0;
    this.playbackParsedPacketCount = 0;
    this.playbackTransportFailCount = 0;
    this.playbackEmptyPayloadCount = 0;
    this.playbackDaveDropCount = 0;
    this.playbackForwardedPacketCount = 0;
    this.playbackSendErrorCount = 0;
    this.playbackWrongPayloadCount = 0;
    this.playbackInvalidPacketCount = 0;
    this.playbackSelfDeafDropCount = 0;
    this.playbackFirstPacketLogged = false;
    this.lastPlaybackStatsAt = 0;
  }

  private logPlaybackStats(reason: string, force = false): void {
    const now = Date.now();
    if (!force && this.playbackForwardedPacketCount > 0 && now - this.lastPlaybackStatsAt < 5_000) return;
    if (!force && this.playbackForwardedPacketCount === 0 && now - this.lastPlaybackStatsAt < 2_000) return;
    this.lastPlaybackStatsAt = now;
    debugLog("voice.playback.stats", {
      reason,
      packets: this.playbackPacketCount,
      parsedPackets: this.playbackParsedPacketCount,
      forwardedPackets: this.playbackForwardedPacketCount,
      transportFailures: this.playbackTransportFailCount,
      daveDrops: this.playbackDaveDropCount,
      emptyPayloads: this.playbackEmptyPayloadCount,
      invalidPackets: this.playbackInvalidPacketCount,
      wrongPayloads: this.playbackWrongPayloadCount,
      selfDeafDrops: this.playbackSelfDeafDropCount,
      sendErrors: this.playbackSendErrorCount,
      localPort: this.localPlaybackPort,
    });
  }

  private forwardCapturePacket(packet: Buffer): void {
    const context = this.context;
    if (!context) return;
    if (context.selfMute) {
      this.setCaptureSpeaking(context, false);
      return;
    }
    const parsed = parsePlainRtpPacket(packet);
    if (!parsed || parsed.payloadType !== OPUS_PAYLOAD_TYPE) return;
    const opusPayload = parsed.payload;
    if (opusPayload.length === 0) return;
    this.capturePacketCount += 1;
    const silence = isOpusSilenceFrame(opusPayload);
    if (!silence) this.nonSilencePacketCount += 1;

    const encodedPayload = context.encodeOutgoingOpus ? context.encodeOutgoingOpus(opusPayload) : opusPayload;
    if (!encodedPayload || encodedPayload.length === 0) {
      this.droppedPacketCount += 1;
      if (!this.captureDropLogged) {
        this.captureDropLogged = true;
        debugLog("voice.capture.drop", {
          packets: this.capturePacketCount,
          nonSilencePackets: this.nonSilencePacketCount,
          forwardedPackets: this.forwardedPacketCount,
          droppedPackets: this.droppedPacketCount,
          speaking: this.speaking,
        });
      }
      return;
    }
    this.forwardedPacketCount += 1;

    const header = Buffer.alloc(RTP_HEADER_LENGTH);
    header[0] = 0x80;
    header[1] = OPUS_PAYLOAD_TYPE;
    header.writeUInt16BE(this.sendSequence & 0xffff, 2);
    header.writeUInt32BE(this.sendTimestamp >>> 0, 4);
    header.writeUInt32BE(context.ssrc >>> 0, 8);
    this.sendSequence += 1;
    this.sendTimestamp = (this.sendTimestamp + OPUS_RTP_CLOCK_INCREMENT) >>> 0;

    const encrypted = encryptAes256GcmRtp(header, encodedPayload, context.secretKey, this.nextCounter());
    context.udp.send(encrypted);
  }

  private updateCaptureLevel(chunk: Buffer | string): void {
    const context = this.context;
    if (!context) return;
    if (context.selfMute) {
      this.setCaptureSpeaking(context, false);
      return;
    }

    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const data = this.pcmRemainder.length > 0 ? Buffer.concat([this.pcmRemainder, incoming]) : incoming;
    const byteLength = data.length - (data.length % 2);
    this.pcmRemainder = byteLength === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(byteLength));
    if (byteLength <= 0) return;

    let sumSquares = 0;
    const sampleCount = byteLength / 2;
    for (let offset = 0; offset < byteLength; offset += 2) {
      const sample = data.readInt16LE(offset) / 32768;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    this.lastInputLevelDb = linearToDb(rms);
    // Keep this start/stop hysteresis aligned with discord-cli's
    // SpeakerSegmenter so Record's green talking state and Exo's call
    // transcription gate behave similarly for the same audio.
    const threshold = this.speaking ? this.speakingStopThreshold : this.speakingStartThreshold;
    if (rms >= threshold) this.markCaptureSpeaking(context);
  }

  private markCaptureSpeaking(context: VoiceAudioContext): void {
    this.setCaptureSpeaking(context, true);
    if (this.speakingIdleTimer) clearTimeout(this.speakingIdleTimer);
    this.speakingIdleTimer = setTimeout(() => {
      if (this.context === context) this.setCaptureSpeaking(context, false);
    }, this.speakingIdleMs);
    this.speakingIdleTimer.unref?.();
  }

  private setCaptureSpeaking(context: VoiceAudioContext, speaking: boolean): void {
    if (this.speakingIdleTimer && !speaking) {
      clearTimeout(this.speakingIdleTimer);
      this.speakingIdleTimer = null;
    }
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    debugLog("voice.capture.speaking", {
      speaking,
      packets: this.capturePacketCount,
      nonSilencePackets: this.nonSilencePacketCount,
      forwardedPackets: this.forwardedPacketCount,
      droppedPackets: this.droppedPacketCount,
      selfMute: context.selfMute,
      inputLevelDb: Number.isFinite(this.lastInputLevelDb) ? Math.round(this.lastInputLevelDb * 10) / 10 : null,
      speakingThresholdDb: this.speakingStartThresholdDb,
      speakingStartThresholdDb: this.speakingStartThresholdDb,
      speakingStopThresholdDb: this.speakingStopThresholdDb,
      speakingIdleMs: this.speakingIdleMs,
    });
    context.sendSpeaking(speaking);
  }

  private nextCounter(): Buffer {
    this.sendCounter = (this.sendCounter + 1) >>> 0;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.sendCounter, 0);
    return counter;
  }
}

export function isOpusSilenceFrame(payload: Buffer): boolean {
  return payload.equals(OPUS_SILENCE_FRAME);
}

export function buildFfplayPlaybackArgs(sdpPath: string): string[] {
  return [
    "-nodisp",
    "-loglevel", "error",
    "-protocol_whitelist", "file,udp,rtp",
    "-i", sdpPath,
  ];
}

export function buildVoicePlaybackSdp(port: number): string {
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=Record Discord Voice",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${port} RTP/AVP ${OPUS_PAYLOAD_TYPE}`,
    // Discord voice Opus payloads are commonly stereo; ffmpeg also announces
    // RTP Opus as /2 even when the source was mono. Advertising /1 here made
    // ffplay accept the socket but fail to render those packets audibly.
    `a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/48000/2`,
    "",
  ].join("\n");
}

function drainChildOutput(child: ChildProcessWithoutNullStreams): () => string {
  child.stdout.resume();
  return drainChildStderr(child);
}

function drainChildStderr(child: ChildProcessWithoutNullStreams): () => string {
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let totalLength = stderrChunks.reduce((total, item) => total + item.length, 0);
    while (totalLength > 8_192 && stderrChunks.length > 1) {
      const removed = stderrChunks.shift();
      totalLength -= removed?.length ?? 0;
    }
  });
  child.stderr.resume();
  return () => Buffer.concat(stderrChunks).toString("utf8");
}
