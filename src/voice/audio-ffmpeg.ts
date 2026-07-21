import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createSocket, type Socket as UdpSocket } from "dgram";
import { accessSync, constants as fsConstants, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type WriteStream } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";

import { debugLog } from "../debuglog";
import { DEFAULT_LOCAL_GAIN_DB, DEFAULT_NOISE_SUPPRESSION_MODE, DEFAULT_REMOTE_USER_VOLUME_PERCENT, formatGainDb, normalizeGainDb, normalizeRemoteUserVolumePercent, type LocalAudioVolumes, type NoiseSuppressionMode } from "../volume";
import { OPUS_PAYLOAD_TYPE, OPUS_RTP_CLOCK_INCREMENT, OPUS_SILENCE_FRAME, RTP_HEADER_LENGTH } from "./constants";
import { dbToLinear, linearToDb, speakingIdleMs, speakingStartThresholdDb, speakingStopThresholdDb } from "./env";
import { bindUdp, decryptAes256GcmRtp, encryptAes256GcmRtp, parseDiscordRtpPacket, parsePlainRtpPacket, reserveUdpPort } from "./rtp";
import { NoopVoiceAudioBackend, type VoiceAudioBackend, type VoiceAudioContext } from "./types";

const VOICE_HELPER_SHUTDOWN_GRACE_MS = 1_500;
const VOICE_CAPTURE_STARTUP_TIMEOUT_MS = 5_000;
const PLAYBACK_PACE_DELAY_MS = parsePositiveInt(process.env.RECORD_PLAYBACK_PACE_DELAY_MS, 240);
const PLAYBACK_PACER_IDLE_RESET_MS = 2_000;
const PLAYBACK_PACER_MAX_DELTA_SAMPLES = 48_000 * 60;
const PLAYBACK_MAX_CONCEALMENT_PACKETS = parsePositiveInt(process.env.RECORD_PLAYBACK_MAX_CONCEALMENT_PACKETS, 10);
const PLAYBACK_TRACE_DIR = process.env.RECORD_PLAYBACK_TRACE_DIR?.trim() || null;
const PLAYBACK_PREROLL_FRAME_MS = 20;
const PLAYBACK_LOSS_FILL_MODE = parsePlaybackLossFillMode(process.env.RECORD_PLAYBACK_LOSS_FILL_MODE);
const PLAYBACK_BACKEND = parsePlaybackBackend(process.env.RECORD_PLAYBACK_BACKEND);
const PLAYBACK_READY_TIMEOUT_MS = 1_000;

export function createDefaultVoiceAudioBackend(localVolumes?: LocalAudioVolumes, noiseSuppression?: NoiseSuppressionMode): VoiceAudioBackend {
  if (process.platform !== "linux") return new NoopVoiceAudioBackend();
  return new FfmpegRtpVoiceAudioBackend(localVolumes, noiseSuppression);
}

type CaptureBackend = "discord-voice-engine";

export class FfmpegRtpVoiceAudioBackend implements VoiceAudioBackend {
  private context: VoiceAudioContext | null = null;
  private captureSocket: UdpSocket | null = null;
  private playbackSocket: UdpSocket | null = null;
  private readonly playbackPacersBySsrc = new Map<number, PlaybackPacer>();
  private readonly playbackDiagnosticsBySsrc = new Map<number, PlaybackStreamDiagnostics>();
  private playbackTraceStream: WriteStream | null = null;
  private playbackTracePath: string | null = null;
  private captureProcess: ChildProcessWithoutNullStreams | null = null;
  private playbackProcess: ChildProcessWithoutNullStreams | null = null;
  private playbackBackend: PlaybackBackend = "ffplay";
  private resumeFfplayWhenUserVolumesReset = false;
  private captureStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private tempDir: string | null = null;
  private localPlaybackPort: number | null = null;
  private playbackSdpPath: string | null = null;
  private localCapturePort: number | null = null;
  private localVolumes: LocalAudioVolumes;
  private readonly remoteSsrcVolumes = new Map<number, number>();
  private noiseSuppression: NoiseSuppressionMode;
  private captureBackend: CaptureBackend | null = null;
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
  private playbackPacedPacketCount = 0;
  private playbackPacerLateCount = 0;
  private playbackPacerMaxLateMs = 0;
  private playbackPacerResetCount = 0;
  private playbackPacerDroppedCount = 0;
  private playbackPrerollPacketCount = 0;
  private playbackConcealmentPacketCount = 0;
  private playbackNativePacketCount = 0;
  private playbackSendErrorCount = 0;
  private playbackWrongPayloadCount = 0;
  private playbackInvalidPacketCount = 0;
  private playbackInvalidOpusPacketCount = 0;
  private playbackSelfDeafDropCount = 0;
  private playbackLocalMuteDropCount = 0;
  private playbackFirstPacketLogged = false;
  private playbackForceFfplay = false;
  private lastPlaybackStatsAt = 0;
  private captureHealthy = false;
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

  constructor(localVolumes: LocalAudioVolumes = { micVolume: DEFAULT_LOCAL_GAIN_DB, speakerVolume: DEFAULT_LOCAL_GAIN_DB }, noiseSuppression: NoiseSuppressionMode = DEFAULT_NOISE_SUPPRESSION_MODE) {
    this.localVolumes = normalizeLocalVolumes(localVolumes);
    this.noiseSuppression = noiseSuppression;
  }

  async start(context: VoiceAudioContext): Promise<void> {
    this.context = context;
    if (context.mode !== "aead_aes256_gcm_rtpsize") {
      context.onError(new Error(`Voice audio is connected without local audio: unsupported encryption mode ${context.mode}.`));
      return;
    }

    this.resetPlaybackStats();
    await Promise.all([
      this.startPlayback(context),
      this.startCapture(context),
    ]);
    if (this.context === context) context.udp.on("message", this.handleDiscordPacket);
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
    this.pcmRemainder = Buffer.alloc(0);
    if (this.playbackSocket) {
      try { this.playbackSocket.close(); } catch {}
      this.playbackSocket = null;
    }
    for (const pacer of this.playbackPacersBySsrc.values()) pacer.dispose();
    this.playbackPacersBySsrc.clear();
    this.stopPlaybackTrace();
    this.stopCaptureProcess("capture");
    this.stopPlaybackProcess("playback");
    this.logPlaybackStats("stop", true);
    if (this.tempDir) {
      try { rmSync(this.tempDir, { recursive: true, force: true }); } catch {}
      this.tempDir = null;
    }
    this.localPlaybackPort = null;
    this.playbackSdpPath = null;
    this.localCapturePort = null;
  }

  setLocalVolumes(volumes: LocalAudioVolumes): void {
    const next = normalizeLocalVolumes(volumes);
    const micChanged = next.micVolume !== this.localVolumes.micVolume;
    const speakerChanged = next.speakerVolume !== this.localVolumes.speakerVolume;
    this.localVolumes = next;
    debugLog("voice.volume.set", { ...next, micChanged, speakerChanged });
    if (!this.context) return;
    if (micChanged && !this.sendCaptureControl(`gain-db ${formatGainDb(next.micVolume)}\n`)) this.restartCaptureProcess("volume_change");
    if (speakerChanged && !this.sendPlaybackControl(`gain-db ${formatGainDb(next.speakerVolume)}\n`)) {
      this.restartPlaybackProcess("volume_change");
    }
  }

  setRemoteSsrcVolume(ssrc: number, volumePercent: number): void {
    if (!Number.isInteger(ssrc) || ssrc < 0) return;
    const normalized = normalizeRemoteUserVolumePercent(volumePercent);
    if (normalized === DEFAULT_REMOTE_USER_VOLUME_PERCENT) this.remoteSsrcVolumes.delete(ssrc);
    else this.remoteSsrcVolumes.set(ssrc, normalized);
    const controlled = this.sendPlaybackControl(`user-volume ${ssrc} ${normalized}\n`);
    if (this.remoteSsrcVolumes.size === 0 && this.resumeFfplayWhenUserVolumesReset && this.context && this.playbackProcess) {
      this.resumeFfplayWhenUserVolumesReset = false;
      this.playbackForceFfplay = true;
      this.restartPlaybackProcess("remote_user_volume_reset");
      return;
    }
    if (controlled) return;
    if (this.remoteSsrcVolumes.size === 0 || !this.context || !this.playbackProcess || !resolveVoiceEngineCommand()) return;
    this.resumeFfplayWhenUserVolumesReset = PLAYBACK_BACKEND === "ffplay" || this.playbackForceFfplay;
    this.playbackForceFfplay = false;
    this.restartPlaybackProcess("remote_user_volume_change");
  }

  setNoiseSuppression(mode: NoiseSuppressionMode): void {
    if (mode === this.noiseSuppression) return;
    this.noiseSuppression = mode;
    debugLog("voice.noise_suppression.set", { mode, backend: this.captureBackend });
    if (!this.context) return;
    if (this.sendCaptureControl(`noise-suppression ${mode}\n`)) return;
    this.restartCaptureProcess("noise_suppression_change");
  }

  private sendCaptureControl(line: string): boolean {
    if (this.captureBackend !== "discord-voice-engine" || !this.captureProcess || this.captureProcess.stdin.destroyed) return false;
    try {
      this.captureProcess.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  private sendPlaybackControl(line: string): boolean {
    if (this.playbackBackend !== "engine" || !this.playbackProcess || this.playbackProcess.stdin.destroyed) return false;
    try {
      this.playbackProcess.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  private async startPlayback(context: VoiceAudioContext): Promise<void> {
    const port = await reserveUdpPort();
    this.localPlaybackPort = port;
    this.playbackSocket = createSocket("udp4");
    this.tempDir = mkdtempSync(join(tmpdir(), "record-voice-"));
    this.playbackSdpPath = join(this.tempDir, "voice.sdp");
    writeFileSync(this.playbackSdpPath, buildVoicePlaybackSdp(port));
    this.startPlaybackTrace();
    await this.startPlaybackProcess(context, "start");
  }

  private async startPlaybackProcess(context: VoiceAudioContext, reason: string): Promise<void> {
    if (this.localPlaybackPort === null || !this.playbackSdpPath || !this.tempDir) return;
    const voiceEngine = resolveVoiceEngineCommand();
    const speakerVolume = this.localVolumes.speakerVolume;
    const needsPerUserVolume = this.remoteSsrcVolumes.size > 0;
    if (needsPerUserVolume && PLAYBACK_BACKEND === "ffplay") this.resumeFfplayWhenUserVolumesReset = true;
    const useNativePlayback = !this.playbackForceFfplay && shouldUseNativePlayback(voiceEngine, needsPerUserVolume);
    const command = useNativePlayback && voiceEngine ? voiceEngine : "ffplay";
    const readyPath = useNativePlayback ? join(this.tempDir, `playback-${Date.now()}.ready`) : null;
    const args = useNativePlayback ? buildVoiceEnginePlaybackArgs(this.localPlaybackPort, readyPath ?? undefined, process.pid, speakerVolume) : buildFfplayPlaybackArgs(this.playbackSdpPath, speakerVolume);
    this.playbackBackend = useNativePlayback ? "engine" : "ffplay";

    debugLog("voice.playback.start", { backend: this.playbackBackend, command, port: this.localPlaybackPort, sdpPath: useNativePlayback ? null : this.playbackSdpPath, args, codecChannels: 2, speakerVolume, reason });
    this.playbackProcess = spawnVoiceHelper(command, args);
    const playbackProcess = this.playbackProcess;
    if (useNativePlayback) {
      playbackProcess.stdin.on("error", () => {});
      for (const [ssrc, volumePercent] of this.remoteSsrcVolumes) {
        playbackProcess.stdin.write(`user-volume ${ssrc} ${volumePercent}\n`);
      }
    } else {
      playbackProcess.stdin.end();
    }
    const playbackErrorOutput = drainChildOutput(playbackProcess);
    playbackProcess.on("error", (error) => {
      if (this.playbackProcess !== playbackProcess) return;
      debugLog("voice.playback.spawn_error", { error: error.message });
      context.onError(new Error(`Failed to start voice playback: ${error.message}`));
      if (this.context === context) this.stop();
    });
    playbackProcess.on("exit", (code, signal) => {
      const details = playbackErrorOutput().trim();
      debugLog("voice.playback.exit", { code, signal, details, active: this.context === context });
      if (this.playbackProcess !== playbackProcess) return;
      if (this.context !== context || code === 0 || signal === "SIGTERM" || signal === "SIGKILL") return;
      if (this.playbackBackend === "engine" && isRecoverableNativePlaybackExit(details)) {
        // A malformed packet can still terminate older native helpers. Prefer
        // ffplay after that only when it would preserve the current semantics;
        // per-user gain requires the native mixer, so restart it instead.
        this.playbackProcess = null;
        const preservePerUserVolume = this.remoteSsrcVolumes.size > 0;
        this.playbackForceFfplay = !preservePerUserVolume;
        debugLog(preservePerUserVolume ? "voice.playback.restart" : "voice.playback.fallback", {
          from: "engine",
          to: preservePerUserVolume ? "engine" : "ffplay",
          reason: "recoverable_native_exit",
          details,
        });
        void this.startPlaybackProcess(context, "recoverable_native_exit").catch((error) => {
          context.onError(error instanceof Error ? error : new Error(String(error)));
          if (this.context === context) this.stop();
        });
        return;
      }
      context.onError(new Error(`Voice playback stopped${details ? `: ${details}` : "."}`));
      if (this.context === context) this.stop();
    });
    if (readyPath) await waitForFile(readyPath, PLAYBACK_READY_TIMEOUT_MS);
  }

  private async startCapture(context: VoiceAudioContext): Promise<void> {
    const socket = createSocket("udp4");
    this.captureSocket = socket;
    socket.on("message", this.handleCapturePacket);
    const port = await bindUdp(socket, "127.0.0.1", 0);
    this.localCapturePort = port;
    this.startCaptureProcess(context, port, "start");
  }

  private startCaptureProcess(context: VoiceAudioContext, port: number, reason: string): void {
    const voiceEngine = resolveVoiceEngineCommand();
    const micVolume = this.localVolumes.micVolume;
    this.captureHealthy = false;
    if (!voiceEngine) {
      context.onError(new Error("discord-voice-engine is required for voice capture; set DISCORD_VOICE_ENGINE or put discord-voice-engine on PATH."));
      if (this.context === context) this.stop();
      return;
    }
    const captureBackend: CaptureBackend = "discord-voice-engine";
    this.captureBackend = captureBackend;
    const args = buildVoiceEngineCaptureArgs(port, this.noiseSuppression, micVolume, process.pid);
    debugLog("voice.capture.start", { backend: captureBackend, command: voiceEngine, args, input: "default", micVolume, noiseSuppression: this.noiseSuppression, reason, speakingStartThresholdDb: this.speakingStartThresholdDb, speakingStopThresholdDb: this.speakingStopThresholdDb, speakingIdleMs: this.speakingIdleMs });
    this.captureProcess = spawnVoiceHelper(voiceEngine, args);
    this.armCaptureStartupTimer(context);
    const captureProcess = this.captureProcess;
    captureProcess.stdout.on("data", this.handleCapturePcm);
    const captureErrorOutput = drainChildStderr(captureProcess);
    captureProcess.on("error", (error) => {
      if (this.captureProcess !== captureProcess) return;
      debugLog("voice.capture.spawn_error", { error: error.message, backend: captureBackend });
      context.onError(new Error(`Failed to start voice capture: ${error.message}`));
      if (this.context === context) this.stop();
    });
    captureProcess.on("exit", (code, signal) => {
      const details = captureErrorOutput().trim();
      debugLog("voice.capture.exit", { code, signal, details, backend: captureBackend });
      if (this.captureProcess !== captureProcess) return;
      this.clearCaptureStartupTimer();
      if (signal === "SIGTERM" || signal === "SIGKILL") return;
      if (code !== 0 && this.context === context) {
        context.onError(new Error("Voice capture stopped; microphone audio is not being sent."));
        if (this.context === context) this.stop();
      }
    });
  }

  private restartPlaybackProcess(reason: string): void {
    const context = this.context;
    if (!context || this.localPlaybackPort === null) return;
    for (const pacer of this.playbackPacersBySsrc.values()) pacer.dispose();
    this.playbackPacersBySsrc.clear();
    this.stopPlaybackProcess(reason);
    void this.startPlaybackProcess(context, reason).catch((error) => {
      context.onError(error instanceof Error ? error : new Error(String(error)));
      if (this.context === context) this.stop();
    });
  }

  private stopPlaybackProcess(reason: string): void {
    terminateVoiceHelperProcess(this.playbackProcess, reason);
    this.playbackProcess = null;
  }

  private restartCaptureProcess(reason: string): void {
    const context = this.context;
    if (!context || this.localCapturePort === null) return;
    this.stopCaptureProcess(reason);
    this.startCaptureProcess(context, this.localCapturePort, reason);
  }

  private stopCaptureProcess(reason: string): void {
    this.captureProcess?.stdout.off("data", this.handleCapturePcm);
    this.clearCaptureStartupTimer();
    terminateVoiceHelperProcess(this.captureProcess, reason);
    this.captureProcess = null;
    this.captureBackend = null;
  }

  private armCaptureStartupTimer(context: VoiceAudioContext): void {
    this.clearCaptureStartupTimer();
    this.captureStartupTimer = setTimeout(() => {
      if (this.context !== context || this.captureHealthy) return;
      debugLog("voice.capture.startup_timeout", { timeoutMs: VOICE_CAPTURE_STARTUP_TIMEOUT_MS });
      terminateVoiceHelperProcess(this.captureProcess, "capture_startup_timeout");
      context.onError(new Error("Voice capture did not start; microphone audio helper was stopped to protect the desktop audio stack."));
      if (this.context === context) this.stop();
    }, VOICE_CAPTURE_STARTUP_TIMEOUT_MS);
    this.captureStartupTimer.unref?.();
  }

  private clearCaptureStartupTimer(): void {
    if (!this.captureStartupTimer) return;
    clearTimeout(this.captureStartupTimer);
    this.captureStartupTimer = null;
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
    if (context.shouldDropIncomingAudio?.(parsed.ssrc)) {
      this.playbackLocalMuteDropCount += 1;
      this.logPlaybackStats("local_mute");
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
    if (!isValidOpusPacket(decodedPayload)) {
      this.playbackInvalidOpusPacketCount += 1;
      debugLog("voice.playback.invalid_opus", {
        ssrc: parsed.ssrc,
        sequence: parsed.sequence,
        timestamp: parsed.timestamp,
        payloadBytes: decodedPayload.length,
        toc: decodedPayload[0] ?? null,
      });
      this.logPlaybackStats("invalid_opus");
      return;
    }
    if (!decodedPayload.equals(OPUS_SILENCE_FRAME)) context.onIncomingAudio?.(parsed.ssrc);
    const gap = this.observePlaybackPacket(parsed.ssrc, parsed.sequence, parsed.timestamp);
    if (gap) debugLog("voice.playback.sequence_gap", { ...gap });

    if (this.playbackBackend === "engine") this.sendNativePlaybackPacket(parsed.ssrc, parsed.sequence, parsed.timestamp, decodedPayload);
    else this.enqueuePlaybackPacket(parsed.ssrc, parsed.sequence, parsed.timestamp, decodedPayload);
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

  private enqueuePlaybackPacket(ssrc: number, sequence: number, timestamp: number, payload: Buffer): void {
    let pacer = this.playbackPacersBySsrc.get(ssrc);
    if (!pacer) {
      pacer = new PlaybackPacer({
        ssrc,
        delayMs: PLAYBACK_PACE_DELAY_MS,
        send: (pacedPacket, kind) => this.sendPlaybackPacket(pacedPacket, kind),
        onLate: (lateMs) => {
          this.playbackPacerLateCount += 1;
          this.playbackPacerMaxLateMs = Math.max(this.playbackPacerMaxLateMs, Math.round(lateMs));
        },
        onDrop: (reason) => {
          this.playbackPacerDroppedCount += 1;
          debugLog("voice.playback.pacer_drop", { ssrc, reason, delayMs: PLAYBACK_PACE_DELAY_MS });
        },
        onReset: (reason) => {
          this.playbackPacerResetCount += 1;
          debugLog("voice.playback.pacer_reset", { ssrc, reason, delayMs: PLAYBACK_PACE_DELAY_MS });
        },
      });
      this.playbackPacersBySsrc.set(ssrc, pacer);
    }
    pacer.enqueue(sequence, timestamp, payload);
  }

  private sendNativePlaybackPacket(ssrc: number, sequence: number, timestamp: number, payload: Buffer): void {
    this.sendPlaybackPacket(buildPlainPlaybackRtpPacket(ssrc, sequence, timestamp, payload), "native");
  }

  private sendPlaybackPacket(packet: Buffer, kind: PlaybackPacketKind = "audio"): void {
    if (!this.playbackSocket || this.localPlaybackPort === null) return;
    if (kind === "preroll") this.playbackPrerollPacketCount += 1;
    else if (kind === "concealment") this.playbackConcealmentPacketCount += 1;
    else if (kind === "native") this.playbackNativePacketCount += 1;
    else this.playbackPacedPacketCount += 1;
    this.writePlaybackTracePacket(packet);
    this.playbackSocket.send(packet, this.localPlaybackPort, "127.0.0.1", (error) => {
      if (error) {
        this.playbackSendErrorCount += 1;
        debugLog("voice.playback.send_error", { error: error.message });
      }
    });
  }

  private resetPlaybackStats(): void {
    this.playbackPacketCount = 0;
    this.playbackParsedPacketCount = 0;
    this.playbackTransportFailCount = 0;
    this.playbackEmptyPayloadCount = 0;
    this.playbackDaveDropCount = 0;
    this.playbackForwardedPacketCount = 0;
    this.playbackPacedPacketCount = 0;
    this.playbackPacerLateCount = 0;
    this.playbackPacerMaxLateMs = 0;
    this.playbackPacerResetCount = 0;
    this.playbackPacerDroppedCount = 0;
    this.playbackPrerollPacketCount = 0;
    this.playbackConcealmentPacketCount = 0;
    this.playbackNativePacketCount = 0;
    this.playbackSendErrorCount = 0;
    this.playbackWrongPayloadCount = 0;
    this.playbackInvalidPacketCount = 0;
    this.playbackInvalidOpusPacketCount = 0;
    this.playbackSelfDeafDropCount = 0;
    this.playbackLocalMuteDropCount = 0;
    this.playbackFirstPacketLogged = false;
    this.playbackForceFfplay = false;
    this.lastPlaybackStatsAt = 0;
    this.playbackDiagnosticsBySsrc.clear();
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
      pacedPackets: this.playbackPacedPacketCount,
      pacerLatePackets: this.playbackPacerLateCount,
      pacerMaxLateMs: this.playbackPacerMaxLateMs,
      pacerDroppedPackets: this.playbackPacerDroppedCount,
      pacerResets: this.playbackPacerResetCount,
      prerollPackets: this.playbackPrerollPacketCount,
      concealedPackets: this.playbackConcealmentPacketCount,
      nativePackets: this.playbackNativePacketCount,
      pacerDelayMs: PLAYBACK_PACE_DELAY_MS,
      backend: this.playbackBackend,
      transportFailures: this.playbackTransportFailCount,
      daveDrops: this.playbackDaveDropCount,
      emptyPayloads: this.playbackEmptyPayloadCount,
      invalidPackets: this.playbackInvalidPacketCount,
      invalidOpusPackets: this.playbackInvalidOpusPacketCount,
      wrongPayloads: this.playbackWrongPayloadCount,
      selfDeafDrops: this.playbackSelfDeafDropCount,
      localMuteDrops: this.playbackLocalMuteDropCount,
      sendErrors: this.playbackSendErrorCount,
      streams: [...this.playbackDiagnosticsBySsrc.values()].map((stream) => stream.snapshot()),
      tracePath: this.playbackTracePath,
      localPort: this.localPlaybackPort,
    });
  }

  private observePlaybackPacket(ssrc: number, sequence: number, timestamp: number): PlaybackSequenceGap | null {
    let diagnostics = this.playbackDiagnosticsBySsrc.get(ssrc);
    if (!diagnostics) {
      diagnostics = new PlaybackStreamDiagnostics(ssrc);
      this.playbackDiagnosticsBySsrc.set(ssrc, diagnostics);
    }
    return diagnostics.observe(sequence, timestamp);
  }

  private startPlaybackTrace(): void {
    if (!PLAYBACK_TRACE_DIR || this.playbackTraceStream) return;
    try {
      mkdirSync(PLAYBACK_TRACE_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.playbackTracePath = join(PLAYBACK_TRACE_DIR, `record-playback-${stamp}-${process.pid}.jsonl`);
      this.playbackTraceStream = createWriteStream(this.playbackTracePath, { flags: "a" });
      debugLog("voice.playback.trace_start", { path: this.playbackTracePath });
    } catch (error) {
      this.playbackTraceStream = null;
      this.playbackTracePath = null;
      debugLog("voice.playback.trace_error", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private stopPlaybackTrace(): void {
    if (!this.playbackTraceStream) return;
    const path = this.playbackTracePath;
    try { this.playbackTraceStream.end(); } catch {}
    this.playbackTraceStream = null;
    this.playbackTracePath = null;
    if (path) debugLog("voice.playback.trace_stop", { path });
  }

  private writePlaybackTracePacket(packet: Buffer): void {
    const stream = this.playbackTraceStream;
    if (!stream) return;
    const parsed = parsePlainRtpPacket(packet);
    if (!parsed || parsed.payloadType !== OPUS_PAYLOAD_TYPE || parsed.payload.length === 0) return;
    stream.write(`${JSON.stringify({
      t: Date.now(),
      ssrc: parsed.ssrc,
      sequence: parsed.sequence,
      timestamp: parsed.timestamp,
      payload: parsed.payload.toString("base64"),
    })}\n`);
  }

  private forwardCapturePacket(packet: Buffer): void {
    this.captureHealthy = true;
    this.clearCaptureStartupTimer();
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
    this.captureHealthy = true;
    this.clearCaptureStartupTimer();
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

export function isValidOpusPacket(payload: Buffer): boolean {
  if (payload.length === 0) return false;
  const frameCountCode = payload[0] & 0x03;
  switch (frameCountCode) {
    case 0:
      return true;
    case 1:
      return (payload.length - 1) % 2 === 0;
    case 2:
      return hasValidTwoFrameVbrLayout(payload);
    case 3:
      return hasValidArbitraryFrameLayout(payload);
    default:
      return false;
  }
}

interface OpusFrameLengthResult {
  length: number;
  bytes: number;
}

function hasValidTwoFrameVbrLayout(payload: Buffer): boolean {
  const firstLength = readOpusFrameLength(payload, 1);
  if (!firstLength) return false;
  const frameStart = 1 + firstLength.bytes;
  const remaining = payload.length - frameStart;
  return firstLength.length <= remaining;
}

function hasValidArbitraryFrameLayout(payload: Buffer): boolean {
  if (payload.length < 2) return false;
  const frameCountByte = payload[1];
  const isVbr = (frameCountByte & 0x80) !== 0;
  const hasPadding = (frameCountByte & 0x40) !== 0;
  const frameCount = frameCountByte & 0x3f;
  if (frameCount < 1 || frameCount > 48) return false;

  let offset = 2;
  let paddingBytes = 0;
  if (hasPadding) {
    while (true) {
      if (offset >= payload.length) return false;
      const padding = payload[offset];
      offset += 1;
      paddingBytes += padding;
      if (padding !== 255) break;
    }
  }
  if (paddingBytes > payload.length - offset) return false;
  const payloadEnd = payload.length - paddingBytes;
  if (payloadEnd < offset) return false;

  if (!isVbr) return (payloadEnd - offset) % frameCount === 0;

  let describedBytes = 0;
  for (let index = 0; index < frameCount - 1; index += 1) {
    const frameLength = readOpusFrameLength(payload, offset);
    if (!frameLength) return false;
    offset += frameLength.bytes;
    describedBytes += frameLength.length;
    if (offset + describedBytes > payloadEnd) return false;
  }
  return describedBytes <= payloadEnd - offset;
}

function readOpusFrameLength(payload: Buffer, offset: number): OpusFrameLengthResult | null {
  if (offset >= payload.length) return null;
  const first = payload[offset];
  if (first < 252) return { length: first, bytes: 1 };
  if (offset + 1 >= payload.length) return null;
  return { length: first + (payload[offset + 1] * 4), bytes: 2 };
}

export function buildPlainPlaybackRtpPacket(ssrc: number, sequence: number, timestamp: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(RTP_HEADER_LENGTH);
  header[0] = 0x80;
  header[1] = OPUS_PAYLOAD_TYPE;
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

export interface PlaybackSequenceGap {
  ssrc: number;
  previousSequence: number;
  sequence: number;
  missingPackets: number;
  timestampDelta: number | null;
  arrivalDeltaMs: number | null;
}

export interface PlaybackStreamDiagnosticSnapshot {
  ssrc: number;
  packets: number;
  firstSequence: number | null;
  lastSequence: number | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sequenceMissingPackets: number;
  sequenceGapEvents: number;
  maxSequenceGapPackets: number;
  duplicatePackets: number;
  outOfOrderPackets: number;
  timestampDiscontinuities: number;
  maxTimestampStepSamples: number;
  maxArrivalDeltaMs: number;
  maxArrivalSkewMs: number;
}

export class PlaybackStreamDiagnostics {
  private packets = 0;
  private firstSequence: number | null = null;
  private lastSequence: number | null = null;
  private firstTimestamp: number | null = null;
  private lastTimestamp: number | null = null;
  private lastArrivalMs: number | null = null;
  private sequenceMissingPackets = 0;
  private sequenceGapEvents = 0;
  private maxSequenceGapPackets = 0;
  private duplicatePackets = 0;
  private outOfOrderPackets = 0;
  private timestampDiscontinuities = 0;
  private maxTimestampStepSamples = 0;
  private maxArrivalDeltaMs = 0;
  private maxArrivalSkewMs = 0;

  constructor(private readonly ssrc: number) {}

  observe(sequence: number, timestamp: number, arrivalMs = Date.now()): PlaybackSequenceGap | null {
    sequence &= 0xffff;
    timestamp >>>= 0;
    this.packets += 1;
    if (this.firstSequence === null || this.lastSequence === null || this.firstTimestamp === null || this.lastTimestamp === null) {
      this.firstSequence = sequence;
      this.lastSequence = sequence;
      this.firstTimestamp = timestamp;
      this.lastTimestamp = timestamp;
      this.lastArrivalMs = arrivalMs;
      return null;
    }

    const previousSequence = this.lastSequence;
    const previousTimestamp = this.lastTimestamp;
    const previousArrivalMs = this.lastArrivalMs;
    const sequenceDelta = rtpSequenceDelta(sequence, previousSequence);
    const timestampDelta = rtpTimestampDelta(timestamp, previousTimestamp);
    const arrivalDeltaMs = previousArrivalMs === null ? null : Math.max(0, arrivalMs - previousArrivalMs);

    if (sequenceDelta === 0) {
      this.duplicatePackets += 1;
      return null;
    }
    if (sequenceDelta >= 0x8000) {
      this.outOfOrderPackets += 1;
      return null;
    }

    const expectedTimestampDelta = sequenceDelta * OPUS_RTP_CLOCK_INCREMENT;
    if (timestampDelta !== expectedTimestampDelta) {
      this.timestampDiscontinuities += 1;
      this.maxTimestampStepSamples = Math.max(this.maxTimestampStepSamples, timestampDelta);
    }
    if (arrivalDeltaMs !== null) {
      this.maxArrivalDeltaMs = Math.max(this.maxArrivalDeltaMs, Math.round(arrivalDeltaMs));
      const expectedArrivalDeltaMs = timestampDelta / 48;
      this.maxArrivalSkewMs = Math.max(this.maxArrivalSkewMs, Math.round(Math.abs(arrivalDeltaMs - expectedArrivalDeltaMs)));
    }

    this.lastSequence = sequence;
    this.lastTimestamp = timestamp;
    this.lastArrivalMs = arrivalMs;

    if (sequenceDelta <= 1) return null;
    const missingPackets = sequenceDelta - 1;
    this.sequenceMissingPackets += missingPackets;
    this.sequenceGapEvents += 1;
    this.maxSequenceGapPackets = Math.max(this.maxSequenceGapPackets, missingPackets);
    return {
      ssrc: this.ssrc,
      previousSequence,
      sequence,
      missingPackets,
      timestampDelta,
      arrivalDeltaMs: arrivalDeltaMs === null ? null : Math.round(arrivalDeltaMs),
    };
  }

  snapshot(): PlaybackStreamDiagnosticSnapshot {
    return {
      ssrc: this.ssrc,
      packets: this.packets,
      firstSequence: this.firstSequence,
      lastSequence: this.lastSequence,
      firstTimestamp: this.firstTimestamp,
      lastTimestamp: this.lastTimestamp,
      sequenceMissingPackets: this.sequenceMissingPackets,
      sequenceGapEvents: this.sequenceGapEvents,
      maxSequenceGapPackets: this.maxSequenceGapPackets,
      duplicatePackets: this.duplicatePackets,
      outOfOrderPackets: this.outOfOrderPackets,
      timestampDiscontinuities: this.timestampDiscontinuities,
      maxTimestampStepSamples: this.maxTimestampStepSamples,
      maxArrivalDeltaMs: this.maxArrivalDeltaMs,
      maxArrivalSkewMs: this.maxArrivalSkewMs,
    };
  }
}

export function buildFfplayPlaybackArgs(sdpPath: string, volume = DEFAULT_LOCAL_GAIN_DB): string[] {
  const args = [
    "-nodisp",
    "-loglevel", "error",
    "-protocol_whitelist", "file,udp,rtp",
  ];
  const normalizedVolume = normalizeGainDb(volume);
  if (normalizedVolume !== DEFAULT_LOCAL_GAIN_DB) args.push("-af", `volume=${formatGainDb(normalizedVolume)}dB`);
  args.push("-i", sdpPath);
  return args;
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

export function buildVoiceEngineCaptureArgs(port: number, noiseSuppression: NoiseSuppressionMode = DEFAULT_NOISE_SUPPRESSION_MODE, gainDb = DEFAULT_LOCAL_GAIN_DB, parentPid?: number): string[] {
  const args = [
    "capture-mic",
    "--rtp", `127.0.0.1:${port}`,
    "--mode", "voice",
    "--device", "default",
    "--channels", "2",
    "--bitrate", "96000",
    "--payload-type", String(OPUS_PAYLOAD_TYPE),
    "--noise-suppression", noiseSuppression,
    "--gain-db", formatGainDb(gainDb),
    "--meter-stdout",
  ];
  if (parentPid && parentPid > 0) args.push("--parent-pid", String(parentPid));
  return args;
}

export function buildVoiceEnginePlaybackArgs(port: number, readyFile?: string, parentPid?: number, gainDb = DEFAULT_LOCAL_GAIN_DB): string[] {
  const args = [
    "play-rtp",
    "--rtp", `127.0.0.1:${port}`,
    "--channels", "2",
    "--payload-type", String(OPUS_PAYLOAD_TYPE),
    "--jitter-ms", String(PLAYBACK_PACE_DELAY_MS),
    "--idle-timeout-ms", "350",
    "--max-plc-packets", "10",
    "--gain-db", formatGainDb(gainDb),
    "--output", "pipewire",
  ];
  if (readyFile) args.push("--ready-file", readyFile);
  if (parentPid && parentPid > 0) args.push("--parent-pid", String(parentPid));
  return args;
}

export function resolveVoiceEngineCommand(env: Record<string, string | undefined> = process.env, pathEnv = env.PATH): string | null {
  const configured = env.DISCORD_VOICE_ENGINE?.trim();
  if (configured) return expandHome(configured);
  if (!pathEnv) return null;
  for (const entry of pathEnv.split(delimiter)) {
    const candidate = join(entry || ".", "discord-voice-engine");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return "discord-voice-engine";
    } catch {}
  }
  return null;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function spawnVoiceHelper(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args, { detached: process.platform !== "win32" });
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  debugLog("voice.playback.ready_timeout", { path, timeoutMs });
}

interface PlaybackPacerOptions {
  ssrc: number;
  delayMs: number;
  send: (packet: Buffer, kind: PlaybackPacketKind) => void;
  onLate: (lateMs: number) => void;
  onDrop: (reason: string) => void;
  onReset: (reason: string) => void;
}

type PlaybackBackend = "engine" | "ffplay";

type PlaybackPacketKind = "audio" | "preroll" | "concealment" | "native";

class PlaybackPacer {
  private baseTimestamp: number | null = null;
  private baseWallMs = 0;
  private lastReceivedAt = 0;
  private lastSourceSequence: number | null = null;
  private lastSourceTimestamp: number | null = null;
  private lastPayload: Buffer | null = null;
  private localBaseTimestamp = Math.floor(Math.random() * 0x100000000) >>> 0;
  private localBaseWallMs: number | null = null;
  private localSequence = Math.floor(Math.random() * 0x10000) & 0xffff;
  private lastSentLocalTimestamp: number | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly options: PlaybackPacerOptions) {}

  enqueue(_sequence: number, timestamp: number, payload: Buffer): void {
    const now = Date.now();
    if (this.baseTimestamp === null) {
      this.resetBase(timestamp, now, "initial", false);
      this.schedulePreroll(now, this.baseWallMs);
    } else if (now - this.lastReceivedAt >= PLAYBACK_PACER_IDLE_RESET_MS) {
      this.clearTimers();
      this.resetBase(timestamp, now, "idle", true);
      this.schedulePreroll(now, this.baseWallMs);
    }
    this.lastReceivedAt = now;

    const sourceSequenceDelta = this.lastSourceSequence === null ? 1 : rtpSequenceDelta(_sequence, this.lastSourceSequence);
    if (this.lastSourceSequence !== null && sourceSequenceDelta === 0) {
      this.options.onDrop("duplicate_source_packet");
      return;
    }
    if (this.lastSourceSequence !== null && sourceSequenceDelta >= 0x8000) {
      this.options.onDrop("out_of_order_source_packet");
      return;
    }

    let deltaSamples = (timestamp - (this.baseTimestamp ?? timestamp)) >>> 0;
    if (deltaSamples > PLAYBACK_PACER_MAX_DELTA_SAMPLES) {
      this.clearTimers();
      this.resetBase(timestamp, now, "timestamp_jump", true);
      this.schedulePreroll(now, this.baseWallMs);
      deltaSamples = 0;
    }

    this.scheduleMissingSourcePackets(sourceSequenceDelta, now);
    const targetMs = this.baseWallMs + (deltaSamples / 48);
    const lateMs = Math.max(0, now - targetMs);
    const delayMs = Math.max(0, Math.ceil(targetMs - now));
    if (lateMs > 0) this.options.onLate(lateMs);
    this.schedulePayload(payload, targetMs, delayMs, "audio");
    this.lastSourceSequence = _sequence & 0xffff;
    this.lastSourceTimestamp = timestamp >>> 0;
    this.lastPayload = payload;
  }

  dispose(): void {
    this.clearTimers();
  }

  private resetBase(timestamp: number, now: number, reason: string, report: boolean): void {
    this.baseTimestamp = timestamp >>> 0;
    this.baseWallMs = now + this.options.delayMs;
    this.lastSourceSequence = null;
    this.lastSourceTimestamp = null;
    this.lastPayload = null;
    if (this.localBaseWallMs === null) this.localBaseWallMs = this.baseWallMs;
    if (report) this.options.onReset(reason);
  }

  private scheduleMissingSourcePackets(sourceSequenceDelta: number, now: number): void {
    if (PLAYBACK_LOSS_FILL_MODE === "off") return;
    if (this.lastSourceTimestamp === null || sourceSequenceDelta <= 1) return;
    const missingPackets = sourceSequenceDelta - 1;
    if (missingPackets > PLAYBACK_MAX_CONCEALMENT_PACKETS) {
      this.options.onDrop("concealment_gap_too_large");
      return;
    }
    const fillerPayload = this.concealmentPayload();
    for (let index = 1; index <= missingPackets; index += 1) {
      const missingTimestamp = (this.lastSourceTimestamp + (OPUS_RTP_CLOCK_INCREMENT * index)) >>> 0;
      const targetMs = this.targetMsForSourceTimestamp(missingTimestamp);
      const delayMs = Math.max(0, Math.ceil(targetMs - now));
      this.schedulePayload(fillerPayload, targetMs, delayMs, "concealment");
    }
  }

  private concealmentPayload(): Buffer {
    if (PLAYBACK_LOSS_FILL_MODE === "repeat" && this.lastPayload && !this.lastPayload.equals(OPUS_SILENCE_FRAME)) return this.lastPayload;
    return OPUS_SILENCE_FRAME;
  }

  private targetMsForSourceTimestamp(timestamp: number): number {
    const deltaSamples = (timestamp - (this.baseTimestamp ?? timestamp)) >>> 0;
    return this.baseWallMs + (deltaSamples / 48);
  }

  private schedulePreroll(now: number, firstAudioTargetMs: number): void {
    const frames = Math.floor(this.options.delayMs / PLAYBACK_PREROLL_FRAME_MS);
    if (frames <= 0) return;
    for (let index = 0; index < frames; index += 1) {
      const targetMs = firstAudioTargetMs - ((frames - index) * PLAYBACK_PREROLL_FRAME_MS);
      const delayMs = Math.max(0, Math.ceil(targetMs - now));
      this.schedulePayload(OPUS_SILENCE_FRAME, targetMs, delayMs, "preroll");
    }
  }

  private schedulePayload(payload: Buffer, targetMs: number, delayMs: number, kind: PlaybackPacketKind): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const localTimestamp = this.localTimestampForTarget(targetMs);
      if (this.lastSentLocalTimestamp !== null && !isNewerRtpTimestamp(localTimestamp, this.lastSentLocalTimestamp)) {
        this.options.onDrop(`out_of_order_${kind}_after_pace`);
        return;
      }
      this.lastSentLocalTimestamp = localTimestamp;
      const packet = buildPlainPlaybackRtpPacket(this.options.ssrc, this.localSequence, localTimestamp, payload);
      this.localSequence = (this.localSequence + 1) & 0xffff;
      this.options.send(packet, kind);
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private localTimestampForTarget(targetMs: number): number {
    const baseWallMs = this.localBaseWallMs ?? targetMs;
    const elapsedSamples = Math.round((targetMs - baseWallMs) * 48);
    return (this.localBaseTimestamp + elapsedSamples) >>> 0;
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

function isNewerRtpTimestamp(timestamp: number, previous: number): boolean {
  const delta = ((timestamp >>> 0) - (previous >>> 0)) >>> 0;
  return delta > 0 && delta < 0x80000000;
}

function rtpSequenceDelta(sequence: number, previous: number): number {
  return ((sequence & 0xffff) - (previous & 0xffff)) & 0xffff;
}

function rtpTimestampDelta(timestamp: number, previous: number): number {
  return ((timestamp >>> 0) - (previous >>> 0)) >>> 0;
}

type PlaybackLossFillMode = "repeat" | "silence" | "off";

function parsePlaybackLossFillMode(value: string | undefined): PlaybackLossFillMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "silence" || normalized === "off" || normalized === "repeat") return normalized;
  return "repeat";
}

type PlaybackBackendPreference = "auto" | "engine" | "ffplay";

function parsePlaybackBackend(value: string | undefined): PlaybackBackendPreference {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "engine" || normalized === "ffplay" || normalized === "auto") return normalized;
  return "auto";
}

export function shouldUseNativePlayback(
  voiceEngine: string | null,
  needsPerUserVolume = false,
  preference: PlaybackBackendPreference = PLAYBACK_BACKEND,
): boolean {
  if (!voiceEngine) return false;
  if (needsPerUserVolume) return true;
  if (preference === "ffplay") return false;
  return preference === "engine" || preference === "auto";
}

function isRecoverableNativePlaybackExit(details: string): boolean {
  return /decode Opus (?:FEC\/PLC )?playback packet/i.test(details) || /opus_decode_float: corrupted stream/i.test(details);
}

function normalizeLocalVolumes(volumes: LocalAudioVolumes): LocalAudioVolumes {
  return {
    micVolume: normalizeGainDb(volumes.micVolume),
    speakerVolume: normalizeGainDb(volumes.speakerVolume),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function terminateVoiceHelperProcess(child: ChildProcessWithoutNullStreams | null, reason: string): void {
  if (!child) return;
  const pid = child.pid;
  const target = pid && process.platform !== "win32" ? -pid : pid;
  if (!target) {
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  try {
    process.kill(target, "SIGTERM");
    debugLog("voice.helper.terminate", { reason, pid, target, signal: "SIGTERM" });
  } catch (error) {
    try { child.kill("SIGTERM"); } catch {}
    debugLog("voice.helper.terminate_error", { reason, pid, target, error: error instanceof Error ? error.message : String(error) });
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(target, "SIGKILL");
      debugLog("voice.helper.terminate", { reason, pid, target, signal: "SIGKILL" });
    } catch {}
  }, VOICE_HELPER_SHUTDOWN_GRACE_MS);
  killTimer.unref?.();
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
