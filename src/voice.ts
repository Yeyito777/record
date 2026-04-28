/**
 * Discord voice/call backend.
 *
 * The backend is split into three pieces so the same core can be reused for
 * server voice channels later:
 * - VoiceSignalingClient: the normal Discord gateway op-4 voice-state leg.
 * - DiscordVoiceGatewayConnection: the dedicated voice websocket + UDP leg.
 * - VoiceAudioBackend: pluggable local audio capture/playback implementation.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createCipheriv, createDecipheriv } from "crypto";
import { createSocket, type Socket as UdpSocket } from "dgram";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const VOICE_GATEWAY_VERSION = 8;
const VOICE_FLAGS = 3; // CLIPS_ENABLED | ALLOW_VOICE_RECORDING, matches Discord desktop/endcord.
const VOICE_READY_TIMEOUT_MS = 10_000;
const VOICE_CONNECT_TIMEOUT_MS = 10_000;
const UDP_DISCOVERY_TIMEOUT_MS = 5_000;
const VOICE_REGION_TIMEOUT_MS = 3_000;
const OPUS_PAYLOAD_TYPE = 120;
const OPUS_RTP_CLOCK_INCREMENT = 960; // 20 ms at 48 kHz.
const RTP_HEADER_LENGTH = 12;

let cachedPreferredVoiceRegions: string[] | null = null;

export type VoiceConnectionState = "idle" | "signaling" | "connecting" | "ready" | "ended" | "error";

export interface VoiceStateUpdate {
  userId: string;
  channelId: string | null;
  guildId: string | null;
  sessionId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  mute: boolean;
  deaf: boolean;
}

export interface VoiceServerUpdate {
  token: string;
  endpoint: string | null;
  guildId: string | null;
}

export interface VoiceStateRequest {
  guildId: string | null;
  channelId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo: boolean;
  preferredRegions?: string[];
}

export interface VoiceSignalingClient {
  requestVoiceState(request: VoiceStateRequest): boolean;
  leaveVoice(): boolean;
}

export interface VoiceCallTarget {
  guildId: string | null;
  channelId: string;
  recipientIds?: string[];
  displayName?: string;
  preferredRegions?: string[];
}

export interface VoiceGatewayJoinData {
  guildId: string;
  channelId: string;
  userId: string;
  sessionId: string;
  token: string;
  endpoint: string;
}

export interface VoiceGatewayConnection {
  connect(): Promise<void>;
  disconnect(): void;
  readonly mediaSessionId: string | null;
}

export interface VoiceCallSession {
  target: VoiceCallTarget;
  state: VoiceConnectionState;
  gateway: VoiceGatewayConnection | null;
  startedAt: number;
}

export interface VoiceCallStartResult {
  session: VoiceCallSession;
  warnings: string[];
}

export interface VoiceCallControllerOptions {
  selfUserId: string;
  signaling: VoiceSignalingClient;
  createGatewayConnection?: (data: VoiceGatewayJoinData) => VoiceGatewayConnection;
  fetchPreferredRegions?: () => Promise<string[]>;
  ringRecipients?: (channelId: string, recipientIds: string[]) => Promise<void>;
  onStateChange?: (session: VoiceCallSession | null) => void;
  onError?: (error: Error) => void;
}

interface PendingVoiceJoin {
  target: VoiceCallTarget;
  state: VoiceStateUpdate | null;
  server: VoiceServerUpdate | null;
  resolve: (data: VoiceGatewayJoinData) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface VoiceAudioContext {
  udp: UdpSocket;
  mode: string;
  secretKey: Buffer;
  ssrc: number;
  sendSpeaking: (speaking: boolean) => void;
  onError: (error: Error) => void;
}

export interface VoiceAudioBackend {
  start(context: VoiceAudioContext): Promise<void> | void;
  stop(): void;
}

export class NoopVoiceAudioBackend implements VoiceAudioBackend {
  start(): void {
    // Intentionally no-op. Useful for tests and unsupported platforms.
  }

  stop(): void {
    // Intentionally no-op.
  }
}

export class VoiceCallController {
  private pending: PendingVoiceJoin | null = null;
  private active: VoiceCallSession | null = null;

  constructor(private readonly options: VoiceCallControllerOptions) {}

  get activeSession(): VoiceCallSession | null {
    return this.active;
  }

  async startCall(target: VoiceCallTarget): Promise<VoiceCallStartResult> {
    if (this.active && this.active.state !== "ended" && this.active.state !== "error") {
      throw new Error("Already in a call.");
    }
    if (this.pending) throw new Error("Already joining a call.");

    const session: VoiceCallSession = {
      target,
      state: "signaling",
      gateway: null,
      startedAt: Date.now(),
    };
    this.active = session;
    this.emitState();

    const preferredRegions = target.preferredRegions ?? await this.fetchPreferredRegions();
    if (this.active !== session) throw new Error("Call cancelled.");
    session.target = { ...target, preferredRegions };

    const gatewayDataPromise = this.waitForGatewayData(session.target);
    const requested = this.options.signaling.requestVoiceState({
      guildId: target.guildId,
      channelId: target.channelId,
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
      preferredRegions,
    });

    if (!requested) {
      const error = new Error("Discord gateway is not ready yet.");
      void gatewayDataPromise.catch(() => {});
      this.clearPending(error);
      this.failSession(session, error);
      throw error;
    }

    try {
      const gatewayData = await gatewayDataPromise;
      session.state = "connecting";
      this.emitState();

      const gateway = this.options.createGatewayConnection?.(gatewayData)
        ?? new DiscordVoiceGatewayConnection(gatewayData, createDefaultVoiceAudioBackend(), { onError: this.options.onError });
      session.gateway = gateway;
      await gateway.connect();

      const warnings: string[] = [];
      const recipients = target.recipientIds ?? [];
      if (recipients.length > 0 && this.options.ringRecipients) {
        try {
          await this.options.ringRecipients(target.channelId, recipients);
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }

      session.state = "ready";
      this.emitState();
      return { session, warnings };
    } catch (error) {
      const asErr = error instanceof Error ? error : new Error(String(error));
      this.failSession(session, asErr);
      throw asErr;
    }
  }

  leave(): void {
    if (this.pending) this.clearPending(new Error("Call cancelled."));
    if (this.active?.gateway) this.active.gateway.disconnect();
    if (this.active) {
      this.active.state = "ended";
      this.active.gateway = null;
      this.emitState();
    }
    this.active = null;
    this.options.signaling.leaveVoice();
    this.emitState();
  }

  disconnect(): void {
    this.leave();
  }

  handleVoiceStateUpdate(update: VoiceStateUpdate): void {
    if (update.userId !== this.options.selfUserId) return;
    if (!this.pending) return;
    if (update.channelId !== this.pending.target.channelId) return;
    this.pending.state = update;
    this.maybeResolvePending();
  }

  handleVoiceServerUpdate(update: VoiceServerUpdate): void {
    if (!this.pending) return;
    const targetGuildId = this.pending.target.guildId ?? this.pending.target.channelId;
    if (update.guildId && update.guildId !== targetGuildId && update.guildId !== this.pending.target.guildId) return;
    this.pending.server = update;
    this.maybeResolvePending();
  }

  private async fetchPreferredRegions(): Promise<string[]> {
    try {
      return await (this.options.fetchPreferredRegions ? this.options.fetchPreferredRegions() : fetchPreferredVoiceRegions());
    } catch {
      return [];
    }
  }

  private waitForGatewayData(target: VoiceCallTarget): Promise<VoiceGatewayJoinData> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearPending(new Error("Timed out waiting for Discord voice gateway details."));
      }, VOICE_READY_TIMEOUT_MS);
      timer.unref?.();
      this.pending = { target, state: null, server: null, resolve, reject, timer };
    });
  }

  private maybeResolvePending(): void {
    const pending = this.pending;
    if (!pending || !pending.state || !pending.server) return;
    if (!pending.state.sessionId) {
      this.clearPending(new Error("Discord voice state did not include a session id."));
      return;
    }
    if (!pending.server.endpoint) {
      this.clearPending(new Error("Discord voice server did not include an endpoint."));
      return;
    }

    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve({
      guildId: pending.state.guildId ?? pending.target.channelId,
      channelId: pending.target.channelId,
      userId: this.options.selfUserId,
      sessionId: pending.state.sessionId,
      token: pending.server.token,
      endpoint: pending.server.endpoint,
    });
  }

  private clearPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }

  private failSession(session: VoiceCallSession, error: Error): void {
    session.state = "error";
    session.gateway?.disconnect();
    session.gateway = null;
    this.options.signaling.leaveVoice();
    this.options.onError?.(error);
    this.emitState();
    if (this.active === session) this.active = null;
  }

  private emitState(): void {
    this.options.onStateChange?.(this.active);
  }
}

export class DiscordVoiceGatewayConnection implements VoiceGatewayConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private udp: UdpSocket | null = null;
  private seq = 1;
  private ssrc: number | null = null;
  private selectedMode: string | null = null;
  private secretKey: Buffer | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private disconnected = false;
  private audioStarted = false;
  mediaSessionId: string | null = null;

  constructor(
    private readonly data: VoiceGatewayJoinData,
    private readonly audio: VoiceAudioBackend = new NoopVoiceAudioBackend(),
    private readonly callbacks: { onError?: (error: Error) => void } = {},
  ) {}

  connect(): Promise<void> {
    if (this.ws) return Promise.resolve();
    this.disconnected = false;
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.connectTimer = setTimeout(() => {
        this.rejectReady(new Error("Timed out connecting to Discord voice gateway."));
        this.disconnect();
      }, VOICE_CONNECT_TIMEOUT_MS);
      this.connectTimer.unref?.();

      const endpoint = this.data.endpoint.replace(/^wss?:\/\//, "");
      this.ws = new WebSocket(`wss://${endpoint}/?v=${VOICE_GATEWAY_VERSION}`);
      this.ws.addEventListener("message", this.handleMessage);
      this.ws.addEventListener("close", this.handleClose);
      this.ws.addEventListener("error", this.handleError);
    });
  }

  disconnect(): void {
    this.disconnected = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.audio.stop();
    this.audioStarted = false;
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        // Best-effort close.
      }
      this.udp = null;
    }

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeEventListener("message", this.handleMessage);
      ws.removeEventListener("close", this.handleClose);
      ws.removeEventListener("error", this.handleError);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }

  private handleMessage = (event: MessageEvent<unknown>): void => {
    let payload: { op?: number; seq?: number; d?: unknown };
    try {
      payload = JSON.parse(messageDataToString(event.data)) as { op?: number; seq?: number; d?: unknown };
    } catch (error) {
      this.reportError(asError(error, "Failed to parse Discord voice gateway payload."));
      return;
    }

    if (typeof payload.seq === "number") this.seq = Math.max(this.seq, payload.seq);

    switch (payload.op) {
      case 8:
        this.handleHello(payload.d);
        break;
      case 6:
        break;
      case 2:
        void this.handleReady(payload.d);
        break;
      case 4:
        void this.handleSessionDescription(payload.d);
        break;
      case 3:
        this.sendHeartbeat();
        break;
      default:
        break;
    }
  };

  private handleHello(data: unknown): void {
    const interval = isObject(data) && typeof data.heartbeat_interval === "number" ? data.heartbeat_interval : null;
    if (!interval) {
      this.rejectReady(new Error("Discord voice gateway did not send a heartbeat interval."));
      return;
    }

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), Math.max(1_000, interval));
    this.identify();
  }

  private async handleReady(data: unknown): Promise<void> {
    if (!isObject(data)) return;
    const ip = typeof data.ip === "string" ? data.ip : null;
    const port = typeof data.port === "number" ? data.port : Number(data.port);
    const ssrc = typeof data.ssrc === "number" ? data.ssrc : null;
    const modes = Array.isArray(data.modes) ? data.modes.filter((mode): mode is string => typeof mode === "string") : [];
    if (!ip || !Number.isFinite(port) || !ssrc) {
      this.rejectReady(new Error("Discord voice gateway sent incomplete UDP details."));
      return;
    }

    this.ssrc = ssrc;
    try {
      const udp = createSocket("udp4");
      this.udp = udp;
      await connectUdp(udp, ip, port);
      const discovery = await discoverUdpAddress(udp, ssrc);
      this.selectedMode = selectEncryptionMode(modes);
      this.selectProtocol(discovery.address, discovery.port, this.selectedMode);
    } catch (error) {
      this.rejectReady(asError(error, "Failed to initialize Discord voice UDP."));
      this.disconnect();
    }
  }

  private async handleSessionDescription(data: unknown): Promise<void> {
    if (!isObject(data) || !Array.isArray(data.secret_key) || typeof data.mode !== "string") {
      this.rejectReady(new Error("Discord voice gateway sent an invalid session description."));
      return;
    }

    this.mediaSessionId = typeof data.media_session_id === "string" ? data.media_session_id : null;
    this.selectedMode = data.mode;
    this.secretKey = Buffer.from(data.secret_key.filter((byte): byte is number => typeof byte === "number"));

    if (!this.udp || this.ssrc === null || !this.secretKey) {
      this.rejectReady(new Error("Discord voice session became ready before UDP setup completed."));
      return;
    }

    if (!this.audioStarted) {
      this.audioStarted = true;
      try {
        await this.audio.start({
          udp: this.udp,
          mode: this.selectedMode,
          secretKey: this.secretKey,
          ssrc: this.ssrc,
          sendSpeaking: (speaking) => this.sendSpeaking(speaking),
          onError: (error) => this.reportError(error),
        });
      } catch (error) {
        this.reportError(asError(error, "Voice audio backend failed to start."));
      }
    }

    this.resolveReady();
  }

  private identify(): void {
    this.send({
      op: 0,
      d: {
        server_id: this.data.guildId,
        channel_id: this.data.channelId,
        user_id: this.data.userId,
        session_id: this.data.sessionId,
        token: this.data.token,
        video: false,
        max_dave_protocol_version: 0,
      },
    });
  }

  private selectProtocol(address: string, port: number, mode: string): void {
    this.send({
      op: 1,
      d: {
        protocol: "udp",
        data: { address, port, mode },
        codecs: [
          { name: "opus", type: "audio", priority: 1000, payload_type: OPUS_PAYLOAD_TYPE },
        ],
      },
    });
  }

  private sendSpeaking(speaking: boolean): void {
    if (this.ssrc === null) return;
    this.send({
      op: 5,
      d: {
        speaking: speaking ? 1 : 0,
        delay: 0,
        ssrc: this.ssrc,
      },
    });
  }

  private sendHeartbeat(): void {
    this.send({ op: 3, d: { t: Date.now(), seq_ack: this.seq } });
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private handleClose = (event: CloseEvent): void => {
    if (this.disconnected) return;
    this.rejectReady(new Error(`Discord voice gateway closed (${event.code || "unknown"}).`));
    this.disconnect();
  };

  private handleError = (): void => {
    if (this.disconnected) return;
    this.rejectReady(new Error("Discord voice gateway connection error."));
  };

  private resolveReady(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private rejectReady(error: Error): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.reportError(error);
  }

  private reportError(error: Error): void {
    this.callbacks.onError?.(error);
  }
}

export async function fetchPreferredVoiceRegions(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (fetchImpl === fetch && cachedPreferredVoiceRegions) return cachedPreferredVoiceRegions;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_REGION_TIMEOUT_MS);
  try {
    const response = await fetchImpl("https://latency.discord.media/rtc", {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const regions = await response.json() as unknown;
    if (!Array.isArray(regions)) return [];
    const preferred = regions
      .map((region) => isObject(region) && typeof region.region === "string" ? region.region : null)
      .filter((region): region is string => Boolean(region));
    if (fetchImpl === fetch && preferred.length > 0) cachedPreferredVoiceRegions = preferred;
    return preferred;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

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
  private readonly handleDiscordPacket = (packet: Buffer): void => this.forwardDiscordPacket(packet);
  private readonly handleCapturePacket = (packet: Buffer): void => this.forwardCapturePacket(packet);

  async start(context: VoiceAudioContext): Promise<void> {
    this.context = context;
    if (context.mode !== "aead_aes256_gcm_rtpsize") {
      context.onError(new Error(`Voice audio is connected without local audio: unsupported encryption mode ${context.mode}.`));
      return;
    }

    context.udp.on("message", this.handleDiscordPacket);
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

    if (this.captureSocket) {
      this.captureSocket.off("message", this.handleCapturePacket);
      try { this.captureSocket.close(); } catch {}
      this.captureSocket = null;
    }
    if (this.playbackSocket) {
      try { this.playbackSocket.close(); } catch {}
      this.playbackSocket = null;
    }
    this.captureProcess?.kill("SIGTERM");
    this.captureProcess = null;
    this.playbackProcess?.kill("SIGTERM");
    this.playbackProcess = null;
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
    writeFileSync(sdpPath, [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=Record Discord Voice",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=audio ${port} RTP/AVP ${OPUS_PAYLOAD_TYPE}`,
      `a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/48000/2`,
      "",
    ].join("\n"));

    this.playbackProcess = spawn("ffplay", [
      "-nostdin",
      "-nodisp",
      "-loglevel", "error",
      "-protocol_whitelist", "file,udp,rtp",
      "-i", sdpPath,
    ]);
    drainChildOutput(this.playbackProcess);
    this.playbackProcess.on("error", (error) => context.onError(new Error(`Failed to start voice playback: ${error.message}`)));
  }

  private async startCapture(context: VoiceAudioContext): Promise<void> {
    const socket = createSocket("udp4");
    this.captureSocket = socket;
    socket.on("message", this.handleCapturePacket);
    const port = await bindUdp(socket, "127.0.0.1", 0);

    this.captureProcess = spawn("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "pulse",
      "-i", "default",
      "-ac", "2",
      "-ar", "48000",
      "-c:a", "libopus",
      "-application", "voip",
      "-frame_duration", "20",
      "-payload_type", String(OPUS_PAYLOAD_TYPE),
      "-f", "rtp",
      `rtp://127.0.0.1:${port}`,
    ]);
    drainChildOutput(this.captureProcess);
    this.captureProcess.on("error", (error) => context.onError(new Error(`Failed to start voice capture: ${error.message}`)));
    this.captureProcess.on("exit", (code) => {
      if (code !== 0 && this.context === context) context.onError(new Error("Voice capture stopped; microphone audio is not being sent."));
    });
  }

  private forwardDiscordPacket(packet: Buffer): void {
    const context = this.context;
    if (!context || !this.playbackSocket || this.localPlaybackPort === null) return;
    const parsed = parseDiscordRtpPacket(packet);
    if (!parsed || parsed.payloadType !== OPUS_PAYLOAD_TYPE) return;

    const decrypted = decryptAes256GcmRtp(packet, parsed.headerLength, context.secretKey);
    if (!decrypted) return;
    const extensionBodyLength = parsed.hasExtension ? packet.readUInt16BE(parsed.headerLength - 2) * 4 : 0;
    const opusPayload = extensionBodyLength < decrypted.length ? decrypted.subarray(extensionBodyLength) : Buffer.alloc(0);
    if (opusPayload.length === 0) return;

    const header = Buffer.alloc(RTP_HEADER_LENGTH);
    header[0] = 0x80;
    header[1] = OPUS_PAYLOAD_TYPE;
    header.writeUInt16BE(parsed.sequence, 2);
    header.writeUInt32BE(parsed.timestamp, 4);
    header.writeUInt32BE(parsed.ssrc, 8);
    this.playbackSocket.send(Buffer.concat([header, opusPayload]), this.localPlaybackPort, "127.0.0.1");
  }

  private forwardCapturePacket(packet: Buffer): void {
    const context = this.context;
    if (!context) return;
    const parsed = parsePlainRtpPacket(packet);
    if (!parsed || parsed.payloadType !== OPUS_PAYLOAD_TYPE) return;
    const opusPayload = parsed.payload;
    if (opusPayload.length === 0) return;

    if (!this.speaking) {
      this.speaking = true;
      context.sendSpeaking(true);
    }

    const header = Buffer.alloc(RTP_HEADER_LENGTH);
    header[0] = 0x80;
    header[1] = OPUS_PAYLOAD_TYPE;
    header.writeUInt16BE(this.sendSequence & 0xffff, 2);
    header.writeUInt32BE(this.sendTimestamp >>> 0, 4);
    header.writeUInt32BE(context.ssrc >>> 0, 8);
    this.sendSequence += 1;
    this.sendTimestamp = (this.sendTimestamp + OPUS_RTP_CLOCK_INCREMENT) >>> 0;

    const encrypted = encryptAes256GcmRtp(header, opusPayload, context.secretKey, this.nextCounter());
    context.udp.send(encrypted);
  }

  private nextCounter(): Buffer {
    this.sendCounter = (this.sendCounter + 1) >>> 0;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.sendCounter, 0);
    return counter;
  }
}

function drainChildOutput(child: ChildProcessWithoutNullStreams): void {
  child.stdout.resume();
  child.stderr.resume();
}

function selectEncryptionMode(modes: string[]): string {
  if (modes.includes("aead_aes256_gcm_rtpsize")) return "aead_aes256_gcm_rtpsize";
  if (modes.includes("aead_xchacha20_poly1305_rtpsize")) return "aead_xchacha20_poly1305_rtpsize";
  return modes[0] ?? "aead_aes256_gcm_rtpsize";
}

function connectUdp(socket: UdpSocket, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, host, () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function bindUdp(socket: UdpSocket, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, host, () => {
      socket.off("error", reject);
      const address = socket.address();
      resolve(typeof address === "string" ? port : address.port);
    });
  });
}

async function reserveUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  const port = await bindUdp(socket, "127.0.0.1", 0);
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

function discoverUdpAddress(socket: UdpSocket, ssrc: number): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out during Discord voice UDP discovery."));
    }, UDP_DISCOVERY_TIMEOUT_MS);
    timer.unref?.();

    const onMessage = (packet: Buffer): void => {
      if (packet.length < 74) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      const type = packet.readUInt16BE(0);
      const length = packet.readUInt16BE(2);
      if (type !== 2 || length !== 70) {
        reject(new Error("Discord voice UDP discovery returned an invalid packet."));
        return;
      }
      const nul = packet.indexOf(0, 8);
      const addressEnd = nul >= 8 ? nul : 72;
      resolve({
        address: packet.subarray(8, addressEnd).toString("ascii"),
        port: packet.readUInt16BE(72),
      });
    };

    socket.on("message", onMessage);
    const packet = Buffer.alloc(74);
    packet.writeUInt16BE(1, 0);
    packet.writeUInt16BE(70, 2);
    packet.writeUInt32BE(ssrc, 4);
    socket.send(packet);
  });
}

interface ParsedRtpPacket {
  sequence: number;
  timestamp: number;
  ssrc: number;
  payloadType: number;
  headerLength: number;
  hasExtension: boolean;
}

function parseDiscordRtpPacket(packet: Buffer): ParsedRtpPacket | null {
  const parsed = parseRtpHeader(packet, { encryptedDiscordPacket: true });
  if (!parsed || packet.length <= parsed.headerLength + 4) return null;
  return parsed;
}

function parsePlainRtpPacket(packet: Buffer): (ParsedRtpPacket & { payload: Buffer }) | null {
  const parsed = parseRtpHeader(packet, { encryptedDiscordPacket: false });
  if (!parsed || packet.length <= parsed.headerLength) return null;
  return { ...parsed, payload: packet.subarray(parsed.headerLength) };
}

function parseRtpHeader(packet: Buffer, options: { encryptedDiscordPacket: boolean }): ParsedRtpPacket | null {
  if (packet.length < RTP_HEADER_LENGTH || (packet[0] >> 6) !== 2) return null;
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = (packet[0] & 0x10) !== 0;
  let headerLength = RTP_HEADER_LENGTH + csrcCount * 4;
  if (hasExtension) {
    if (packet.length < headerLength + 4) return null;
    if (options.encryptedDiscordPacket) {
      // Discord's rtpsize AEAD modes authenticate only the RTP header and the
      // 4-byte extension prelude; the extension body is inside the encrypted payload.
      headerLength += 4;
    } else {
      const extensionLength = packet.readUInt16BE(headerLength + 2) * 4;
      headerLength += 4 + extensionLength;
    }
  }
  if (packet.length < headerLength) return null;
  return {
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payloadType: packet[1] & 0x7f,
    headerLength,
    hasExtension,
  };
}

function encryptAes256GcmRtp(header: Buffer, payload: Buffer, key: Buffer, counter: Buffer): Buffer {
  const nonce = Buffer.alloc(12);
  counter.copy(nonce, 0);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, ciphertext, tag, counter]);
}

function decryptAes256GcmRtp(packet: Buffer, headerLength: number, key: Buffer): Buffer | null {
  if (packet.length <= headerLength + 4 + 16) return null;
  const header = packet.subarray(0, headerLength);
  const encrypted = packet.subarray(headerLength, packet.length - 4);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const counter = packet.subarray(packet.length - 4);
  const nonce = Buffer.alloc(12);
  counter.copy(nonce, 0);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

function messageDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asError(error: unknown, prefix: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix} ${message}`.trim());
}

export function buildVoiceStatePayload(request: VoiceStateRequest): unknown {
  if (!request.channelId) {
    return {
      op: 4,
      d: {
        guild_id: null,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
        self_video: false,
        flags: VOICE_FLAGS,
      },
    };
  }

  const preferredRegions = request.preferredRegions?.length ? request.preferredRegions : ["automatic"];
  return {
    op: 4,
    d: {
      guild_id: request.guildId,
      channel_id: request.channelId,
      self_mute: request.selfMute,
      self_deaf: request.selfDeaf,
      self_video: request.selfVideo,
      preferred_regions: preferredRegions,
      preferred_region: preferredRegions[0],
      flags: VOICE_FLAGS,
    },
  };
}
