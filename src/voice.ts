/**
 * Discord voice/call backend.
 *
 * The backend is split into three pieces so the same core can be reused for
 * server voice channels later:
 * - VoiceSignalingClient: the normal Discord gateway op-4 voice-state leg.
 * - DiscordVoiceGatewayConnection: the dedicated voice websocket + UDP leg.
 * - VoiceAudioBackend: pluggable local audio capture/playback implementation.
 */

import { DAVE_PROTOCOL_VERSION, DAVESession, MediaType, type ProposalsOperationType } from "@snazzah/davey";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createCipheriv, createDecipheriv } from "crypto";
import { createSocket, type Socket as UdpSocket } from "dgram";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { debugLog } from "./debuglog";

const VOICE_GATEWAY_VERSION = 8;
const VOICE_FLAGS = 3; // CLIPS_ENABLED | ALLOW_VOICE_RECORDING, matches Discord desktop/endcord.
const VOICE_READY_TIMEOUT_MS = 10_000;
const VOICE_CONNECT_TIMEOUT_MS = 10_000;
const VOICE_SIGNALING_READY_TIMEOUT_MS = 20_000;
const VOICE_SIGNALING_READY_RETRY_MS = 100;
const VOICE_GATEWAY_REJOIN_ATTEMPTS = 3;
const VOICE_GATEWAY_REJOIN_DELAY_MS = 250;
const VOICE_GATEWAY_INVALID_SESSION_CODE = 4006;
const VOICE_GATEWAY_CALL_TERMINATED_CODE = 4022;
const UDP_DISCOVERY_TIMEOUT_MS = 5_000;
const VOICE_REGION_TIMEOUT_MS = 3_000;
const OPUS_PAYLOAD_TYPE = 120;
const OPUS_RTP_CLOCK_INCREMENT = 960; // 20 ms at 48 kHz.
const RTP_HEADER_LENGTH = 12;
const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const DAVE_ENCRYPTED_MARKER = Buffer.from([0xfa, 0xfa]);
const DEFAULT_SPEAKING_THRESHOLD_DB = -40;
const DEFAULT_SPEAKING_IDLE_MS = 700;

let cachedPreferredVoiceRegions: string[] | null = null;

function speakingThresholdDb(): number {
  const raw = process.env.RECORD_VOICE_SPEAKING_THRESHOLD_DB;
  if (!raw) return DEFAULT_SPEAKING_THRESHOLD_DB;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SPEAKING_THRESHOLD_DB;
}

function speakingIdleMs(): number {
  const raw = process.env.RECORD_VOICE_SPEAKING_IDLE_MS;
  if (!raw) return DEFAULT_SPEAKING_IDLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SPEAKING_IDLE_MS;
}

function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

function linearToDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

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
  isReady(): boolean;
  requestVoiceState(request: VoiceStateRequest): boolean;
  leaveVoice(): boolean;
}

export interface VoiceCallTarget {
  guildId: string | null;
  channelId: string;
  recipientIds?: string[];
  displayName?: string;
  preferredRegions?: string[];
  ringRecipients?: boolean;
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
  setSelfVoiceState?(state: { selfMute: boolean; selfDeaf: boolean }): void;
  readonly mediaSessionId: string | null;
}

export class VoiceGatewayCloseError extends Error {
  constructor(readonly code: number, readonly closeReason: string) {
    super(`Discord voice gateway closed (${code || "unknown"}: ${closeReason}).`);
    this.name = "VoiceGatewayCloseError";
  }
}

export interface VoiceGatewayConnectionCallbacks {
  onError?: (error: Error) => void;
  onClose?: (error: VoiceGatewayCloseError) => void;
  onSpeakingChange?: (userId: string, speaking: boolean) => void;
}

export interface VoiceCallSession {
  target: VoiceCallTarget;
  state: VoiceConnectionState;
  gateway: VoiceGatewayConnection | null;
  startedAt: number;
  selfMute: boolean;
  selfDeaf: boolean;
}

export interface VoiceCallStartResult {
  session: VoiceCallSession;
  warnings: string[];
}

export interface VoiceCallStartOptions {
  replaceActive?: boolean;
}

export interface VoiceCallControllerOptions {
  selfUserId: string;
  signaling: VoiceSignalingClient;
  createGatewayConnection?: (data: VoiceGatewayJoinData, callbacks: VoiceGatewayConnectionCallbacks) => VoiceGatewayConnection;
  fetchPreferredRegions?: () => Promise<string[]>;
  ringRecipients?: (channelId: string, recipientIds: string[]) => Promise<void>;
  retryDelayMs?: number;
  onStateChange?: (session: VoiceCallSession | null) => void;
  onSpeakingChange?: (userId: string, speaking: boolean) => void;
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
  selfMute: boolean;
  selfDeaf: boolean;
  sendSpeaking: (speaking: boolean) => void;
  encodeOutgoingOpus?: (payload: Buffer) => Buffer | null;
  decodeIncomingOpus?: (ssrc: number, payload: Buffer) => Buffer | null;
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

interface DaveVoiceEncryptionOptions {
  userId: string;
  channelId: string;
  sendJson: (payload: unknown) => void;
  sendBinary: (opcode: number, payload: Buffer) => void;
  onError?: (error: Error) => void;
}

class DaveVoiceEncryption {
  private session: DAVESession | null = null;
  private protocolVersion = 0;
  private pendingTransitions = new Map<number, number>();
  private knownUserIds = new Set<string>();
  private externalSender: Buffer | null = null;
  private downgraded = false;
  private reinitializing = false;
  private lastTransitionId: number | null = null;
  private lastMediaErrorAt = 0;
  private passthroughRecoveryEnabled = false;

  constructor(private readonly options: DaveVoiceEncryptionOptions) {
    this.knownUserIds.add(options.userId);
  }

  get advertisedProtocolVersion(): number {
    return DAVE_PROTOCOL_VERSION;
  }

  get ready(): boolean {
    return this.protocolVersion !== 0 && Boolean(this.session?.ready);
  }

  handleSessionDescription(data: Record<string, unknown>): void {
    const version = typeof data.dave_protocol_version === "number" ? data.dave_protocol_version : 0;
    this.protocolVersion = version;
    this.reinit();
  }

  addKnownUsers(userIds: readonly string[]): void {
    for (const userId of userIds) this.knownUserIds.add(userId);
  }

  removeKnownUser(userId: string): void {
    this.knownUserIds.delete(userId);
  }

  handleJsonOpcode(opcode: number | undefined, data: unknown): boolean {
    switch (opcode) {
      case 21:
        this.handlePrepareTransition(data);
        return true;
      case 22:
        this.handleExecuteTransition(data);
        return true;
      case 24:
        this.handlePrepareEpoch(data);
        return true;
      default:
        return false;
    }
  }

  handleBinaryOpcode(opcode: number, payload: Buffer): boolean {
    switch (opcode) {
      case 25:
        this.handleExternalSender(payload);
        return true;
      case 27:
        this.handleProposals(payload);
        return true;
      case 29:
        this.handleAnnounceCommitTransition(payload);
        return true;
      case 30:
        this.handleWelcome(payload);
        return true;
      default:
        return false;
    }
  }

  encodeOutgoingOpus(payload: Buffer): Buffer | null {
    if (payload.equals(OPUS_SILENCE_FRAME)) return payload;
    if (this.protocolVersion === 0) return payload;
    if (!this.session?.ready) return null;
    try {
      return this.session.encryptOpus(payload);
    } catch (error) {
      this.reportMediaError(asError(error, "Failed to DAVE-encrypt outgoing voice audio."));
      return null;
    }
  }

  decodeIncomingOpus(userId: string | null, payload: Buffer): Buffer | null {
    if (payload.equals(OPUS_SILENCE_FRAME)) return payload;
    if (!this.session) return this.protocolVersion === 0 ? payload : null;
    if (!userId) return this.protocolVersion === 0 ? payload : null;

    const canDecrypt = this.ready || (this.session.ready && this.session.canPassthrough(userId));
    if (!canDecrypt) return this.protocolVersion === 0 ? payload : null;

    const encrypted = isDaveEncryptedPayload(payload);
    try {
      const decoded = this.session.decrypt(userId, MediaType.AUDIO, payload);
      if (isDaveEncryptedPayload(decoded)) {
        this.reportMediaError(new Error(`DAVE decrypt returned encrypted-looking voice audio from ${userId}; dropping packet.`));
        return null;
      }
      return decoded;
    } catch (error) {
      if (isUnencryptedDavePassthroughError(error) && !encrypted) {
        this.enablePassthroughRecovery();
        return payload;
      }
      this.reportMediaError(asError(error, `Failed to DAVE-decrypt voice audio from ${userId}.`));
      return null;
    }
  }

  private handlePrepareTransition(data: unknown): void {
    if (!isObject(data)) return;
    const transitionId = typeof data.transition_id === "number" ? data.transition_id : null;
    const protocolVersion = typeof data.protocol_version === "number" ? data.protocol_version : null;
    if (transitionId === null || protocolVersion === null) return;

    this.pendingTransitions.set(transitionId, protocolVersion);
    if (transitionId === 0) {
      this.executePendingTransition(transitionId);
      return;
    }

    if (protocolVersion === 0) this.session?.setPassthroughMode(true, 30);
    this.sendTransitionReady(transitionId);
  }

  private handleExecuteTransition(data: unknown): void {
    if (!isObject(data) || typeof data.transition_id !== "number") return;
    this.executePendingTransition(data.transition_id);
  }

  private handlePrepareEpoch(data: unknown): void {
    if (!isObject(data)) return;
    const epoch = typeof data.epoch === "number" ? data.epoch : null;
    const protocolVersion = typeof data.protocol_version === "number" ? data.protocol_version : null;
    if (epoch !== 1 || protocolVersion === null) return;

    this.protocolVersion = protocolVersion;
    this.reinit();
  }

  private handleExternalSender(payload: Buffer): void {
    this.externalSender = Buffer.from(payload);
    this.applyExternalSender();
  }

  private handleProposals(payload: Buffer): void {
    if (!this.session || payload.length < 1) return;
    try {
      const operationType = payload.readUInt8(0) as ProposalsOperationType;
      const result = this.session.processProposals(operationType, payload.subarray(1), [...this.knownUserIds]);
      if (!result.commit) return;
      this.sendBinary(28, result.welcome ? Buffer.concat([result.commit, result.welcome]) : result.commit);
    } catch (error) {
      this.reportError(asError(error, "Failed to process DAVE MLS proposals."));
      this.recoverFromInvalidTransition(this.lastTransitionId);
    }
  }

  private handleAnnounceCommitTransition(payload: Buffer): void {
    if (!this.session || payload.length < 2) return;
    const transitionId = payload.readUInt16BE(0);
    try {
      this.session.processCommit(payload.subarray(2));
      this.finishCommitOrWelcomeTransition(transitionId);
    } catch (error) {
      this.reportError(asError(error, "Failed to process DAVE MLS commit."));
      this.recoverFromInvalidTransition(transitionId);
    }
  }

  private handleWelcome(payload: Buffer): void {
    if (!this.session || payload.length < 2) return;
    const transitionId = payload.readUInt16BE(0);
    try {
      this.session.processWelcome(payload.subarray(2));
      this.finishCommitOrWelcomeTransition(transitionId);
    } catch (error) {
      this.reportError(asError(error, "Failed to process DAVE MLS welcome."));
      this.recoverFromInvalidTransition(transitionId);
    }
  }

  private finishCommitOrWelcomeTransition(transitionId: number): void {
    if (transitionId === 0) {
      this.lastTransitionId = 0;
      this.reinitializing = false;
      return;
    }

    this.pendingTransitions.set(transitionId, this.protocolVersion);
    this.sendTransitionReady(transitionId);
  }

  private executePendingTransition(transitionId: number): boolean {
    const nextVersion = this.pendingTransitions.get(transitionId);
    if (nextVersion === undefined) return false;

    this.protocolVersion = nextVersion;
    this.pendingTransitions.delete(transitionId);
    if (nextVersion === 0) {
      this.downgraded = true;
      this.session?.setPassthroughMode(true, 10);
    } else if (this.downgraded && transitionId > 0) {
      this.downgraded = false;
      this.session?.setPassthroughMode(true, 10);
    }
    this.reinitializing = false;
    this.lastTransitionId = transitionId;
    return true;
  }

  private reinit(): void {
    if (this.protocolVersion <= 0) {
      this.session?.setPassthroughMode(true, 10);
      this.session?.reset();
      return;
    }

    try {
      if (this.session) this.session.reinit(this.protocolVersion, this.options.userId, this.options.channelId);
      else this.session = new DAVESession(this.protocolVersion, this.options.userId, this.options.channelId);
      this.applyExternalSender();
      this.sendKeyPackage();
    } catch (error) {
      this.reportError(asError(error, "Failed to initialize DAVE voice encryption."));
    }
  }

  private applyExternalSender(): void {
    if (!this.session || !this.externalSender) return;
    try {
      this.session.setExternalSender(this.externalSender);
    } catch (error) {
      this.reportError(asError(error, "Failed to apply DAVE MLS external sender."));
    }
  }

  private sendKeyPackage(): void {
    if (!this.session || this.protocolVersion <= 0) return;
    try {
      this.sendBinary(26, this.session.getSerializedKeyPackage());
    } catch (error) {
      this.reportError(asError(error, "Failed to send DAVE MLS key package."));
    }
  }

  private recoverFromInvalidTransition(transitionId: number | null): void {
    if (transitionId === null || this.reinitializing) return;
    this.reinitializing = true;
    this.options.sendJson({ op: 31, d: { transition_id: transitionId } });
    this.reinit();
  }

  private sendTransitionReady(transitionId: number): void {
    this.options.sendJson({ op: 23, d: { transition_id: transitionId } });
  }

  private sendBinary(opcode: number, payload: Buffer): void {
    this.options.sendBinary(opcode, payload);
  }

  private enablePassthroughRecovery(): void {
    if (this.passthroughRecoveryEnabled) return;
    this.passthroughRecoveryEnabled = true;
    this.session?.setPassthroughMode(true, 120);
  }

  private reportMediaError(error: Error): void {
    const now = Date.now();
    if (now - this.lastMediaErrorAt < 5_000) return;
    this.lastMediaErrorAt = now;
    this.reportError(error);
  }

  private reportError(error: Error): void {
    this.options.onError?.(error);
  }
}

export class VoiceCallController {
  private pending: PendingVoiceJoin | null = null;
  private active: VoiceCallSession | null = null;
  private recoveringSession: VoiceCallSession | null = null;

  constructor(private readonly options: VoiceCallControllerOptions) {}

  get activeSession(): VoiceCallSession | null {
    return this.active;
  }

  async startCall(target: VoiceCallTarget, startOptions: VoiceCallStartOptions = {}): Promise<VoiceCallStartResult> {
    if (this.active && this.active.state !== "ended" && this.active.state !== "error") {
      if (!startOptions.replaceActive) throw new Error("Already in a call.");
      this.leave();
    }
    if (this.pending) throw new Error("Already joining a call.");

    const session: VoiceCallSession = {
      target,
      state: "signaling",
      gateway: null,
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
    };
    this.active = session;
    this.emitState();

    const preferredRegions = target.preferredRegions ?? await this.fetchPreferredRegions();
    if (this.active !== session) throw new Error("Call cancelled.");
    session.target = { ...target, preferredRegions };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= VOICE_GATEWAY_REJOIN_ATTEMPTS; attempt++) {
      try {
        if (attempt > 0) await this.prepareVoiceGatewayRejoin(session);
        await this.connectSessionGateway(session);

        const warnings: string[] = [];
        const recipients = target.recipientIds ?? [];
        if (target.ringRecipients !== false && recipients.length > 0 && this.options.ringRecipients) {
          try {
            await this.options.ringRecipients(target.channelId, recipients);
          } catch (error) {
            warnings.push(error instanceof Error ? error.message : String(error));
          }
        }

        if (this.active !== session) throw new Error("Call cancelled.");
        session.state = "ready";
        this.emitState();
        return { session, warnings };
      } catch (error) {
        const asErr = error instanceof Error ? error : new Error(String(error));
        lastError = asErr;
        session.gateway?.disconnect();
        session.gateway = null;
        if (this.active !== session) throw asErr;
        if (attempt < VOICE_GATEWAY_REJOIN_ATTEMPTS && isRecoverableVoiceGatewayClose(asErr)) continue;
        this.failSession(session, asErr);
        throw asErr;
      }
    }

    const error = lastError ?? new Error("Failed to join Discord voice gateway.");
    this.failSession(session, error);
    throw error;
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
    this.recoveringSession = null;
    this.options.signaling.leaveVoice();
    this.emitState();
  }

  disconnect(): void {
    this.leave();
  }

  setSelfMute(selfMute: boolean): boolean {
    return this.updateSelfVoiceState({ selfMute });
  }

  toggleSelfMute(): boolean | null {
    const session = this.active;
    if (!session || session.state === "ended" || session.state === "error") return null;
    return this.setSelfMute(!session.selfMute);
  }

  setSelfDeaf(selfDeaf: boolean): boolean {
    return this.updateSelfVoiceState({ selfDeaf });
  }

  toggleSelfDeaf(): boolean | null {
    const session = this.active;
    if (!session || session.state === "ended" || session.state === "error") return null;
    return this.setSelfDeaf(!session.selfDeaf);
  }

  handleVoiceStateUpdate(update: VoiceStateUpdate): void {
    if (update.userId !== this.options.selfUserId) return;
    const active = this.active;
    if (active && update.channelId === active.target.channelId) {
      const changed = active.selfMute !== update.selfMute || active.selfDeaf !== update.selfDeaf;
      active.selfMute = update.selfMute;
      active.selfDeaf = update.selfDeaf;
      if (changed) {
        active.gateway?.setSelfVoiceState?.({ selfMute: active.selfMute, selfDeaf: active.selfDeaf });
        this.emitState();
      }
    }
    if (!this.pending) return;
    if (update.channelId !== this.pending.target.channelId) return;
    this.pending.state = update;
    this.maybeResolvePending();
  }

  handleVoiceServerUpdate(update: VoiceServerUpdate): void {
    if (!this.pending) return;
    const targetGuildId = this.pending.target.guildId ?? this.pending.target.channelId;
    if (update.guildId && update.guildId !== targetGuildId && update.guildId !== this.pending.target.guildId) return;
    if (!update.endpoint) return;
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

  private updateSelfVoiceState(update: { selfMute?: boolean; selfDeaf?: boolean }): boolean {
    const session = this.active;
    if (!session || session.state === "ended" || session.state === "error") return false;
    const previousMute = session.selfMute;
    const previousDeaf = session.selfDeaf;
    session.selfMute = update.selfMute ?? session.selfMute;
    session.selfDeaf = update.selfDeaf ?? session.selfDeaf;
    session.gateway?.setSelfVoiceState?.({ selfMute: session.selfMute, selfDeaf: session.selfDeaf });
    this.emitState();

    const requested = this.options.signaling.requestVoiceState({
      guildId: session.target.guildId,
      channelId: session.target.channelId,
      selfMute: session.selfMute,
      selfDeaf: session.selfDeaf,
      selfVideo: false,
      preferredRegions: session.target.preferredRegions,
    });
    if (requested) return true;

    session.selfMute = previousMute;
    session.selfDeaf = previousDeaf;
    session.gateway?.setSelfVoiceState?.({ selfMute: session.selfMute, selfDeaf: session.selfDeaf });
    this.emitState();
    return false;
  }

  private async requestGatewayDataWhenSignalingReady(session: VoiceCallSession, request: VoiceStateRequest): Promise<VoiceGatewayJoinData> {
    const deadline = Date.now() + VOICE_SIGNALING_READY_TIMEOUT_MS;
    const retryDelay = Math.max(0, this.options.retryDelayMs ?? VOICE_SIGNALING_READY_RETRY_MS);
    while (true) {
      if (this.active !== session) throw new Error("Call cancelled.");
      if (this.options.signaling.isReady()) {
        const gatewayDataPromise = this.waitForGatewayData(session.target);
        if (this.options.signaling.requestVoiceState(request)) return gatewayDataPromise;
        void gatewayDataPromise.catch(() => {});
        this.clearPending(new Error("Retrying Discord gateway voice-state request."));
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Discord gateway to become ready.");
      await sleep(retryDelay);
    }
  }

  private async connectSessionGateway(session: VoiceCallSession): Promise<void> {
    if (this.active !== session) throw new Error("Call cancelled.");
    session.state = "signaling";
    this.emitState();

    const gatewayData = await this.requestGatewayDataWhenSignalingReady(session, {
      guildId: session.target.guildId,
      channelId: session.target.channelId,
      selfMute: session.selfMute,
      selfDeaf: session.selfDeaf,
      selfVideo: false,
      preferredRegions: session.target.preferredRegions,
    });
    if (this.active !== session) throw new Error("Call cancelled.");
    session.state = "connecting";
    this.emitState();

    const callbacks = this.gatewayCallbacks(session);
    const gateway = this.options.createGatewayConnection?.(gatewayData, callbacks)
      ?? new DiscordVoiceGatewayConnection(gatewayData, createDefaultVoiceAudioBackend(), callbacks);
    session.gateway = gateway;
    gateway.setSelfVoiceState?.({ selfMute: session.selfMute, selfDeaf: session.selfDeaf });
    await gateway.connect();
  }

  private gatewayCallbacks(session: VoiceCallSession): VoiceGatewayConnectionCallbacks {
    return {
      onError: this.options.onError,
      onClose: (error) => this.handleGatewayClose(session, error),
      onSpeakingChange: this.options.onSpeakingChange,
    };
  }

  private handleGatewayClose(session: VoiceCallSession, error: VoiceGatewayCloseError): void {
    if (this.active !== session || session.state === "ended" || session.state === "error") return;
    session.gateway = null;
    if (isTerminalVoiceGatewayClose(error)) {
      this.endSession(session);
      return;
    }
    if (!isRecoverableVoiceGatewayClose(error)) {
      this.failSession(session, error);
      return;
    }
    if (this.recoveringSession === session) return;
    this.recoveringSession = session;
    void this.recoverVoiceGateway(session, error).finally(() => {
      if (this.recoveringSession === session) this.recoveringSession = null;
    });
  }

  private async recoverVoiceGateway(session: VoiceCallSession, cause: VoiceGatewayCloseError): Promise<void> {
    let lastError: Error = cause;
    for (let attempt = 0; attempt < VOICE_GATEWAY_REJOIN_ATTEMPTS; attempt++) {
      if (this.active !== session) return;
      try {
        await this.prepareVoiceGatewayRejoin(session);
        await this.connectSessionGateway(session);
        if (this.active !== session) return;
        session.state = "ready";
        this.emitState();
        return;
      } catch (error) {
        const asErr = error instanceof Error ? error : new Error(String(error));
        lastError = asErr;
        session.gateway?.disconnect();
        session.gateway = null;
        if (!isRecoverableVoiceGatewayClose(asErr)) break;
      }
    }

    if (this.active === session) this.failSession(session, lastError);
  }

  private async prepareVoiceGatewayRejoin(session: VoiceCallSession): Promise<void> {
    if (this.pending) this.clearPending(new Error("Retrying Discord voice gateway."));
    session.gateway?.disconnect();
    session.gateway = null;
    session.state = "signaling";
    this.emitState();
    this.options.signaling.leaveVoice();
    const delay = Math.max(0, this.options.retryDelayMs ?? VOICE_GATEWAY_REJOIN_DELAY_MS);
    if (delay > 0) await sleep(delay);
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

  private endSession(session: VoiceCallSession): void {
    if (this.active !== session) return;
    session.state = "ended";
    session.gateway?.disconnect();
    session.gateway = null;
    this.options.signaling.leaveVoice();
    this.emitState();
    this.active = null;
    this.recoveringSession = null;
    this.emitState();
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

function isRecoverableVoiceGatewayClose(error: Error): boolean {
  return error instanceof VoiceGatewayCloseError && error.code === VOICE_GATEWAY_INVALID_SESSION_CODE;
}

function isTerminalVoiceGatewayClose(error: Error): boolean {
  return error instanceof VoiceGatewayCloseError
    && (error.code === VOICE_GATEWAY_CALL_TERMINATED_CODE || /call terminated/i.test(error.closeReason));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function voiceGatewayCloseError(event: CloseEvent): VoiceGatewayCloseError {
  const reason = event.code === 4017
    ? "DAVE/E2EE protocol required"
    : event.reason || (event.code === VOICE_GATEWAY_INVALID_SESSION_CODE ? "Session is no longer valid." : "unknown reason");
  return new VoiceGatewayCloseError(event.code, reason);
}

export class DiscordVoiceGatewayConnection implements VoiceGatewayConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private udp: UdpSocket | null = null;
  private seq = -1;
  private ssrc: number | null = null;
  private selectedMode: string | null = null;
  private secretKey: Buffer | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private disconnected = false;
  private audioStarted = false;
  private speaking = false;
  private audioContext: VoiceAudioContext | null = null;
  private selfMute = false;
  private selfDeaf = false;
  private readonly ssrcToUserId = new Map<number, string>();
  private readonly dave: DaveVoiceEncryption;
  mediaSessionId: string | null = null;

  constructor(
    private readonly data: VoiceGatewayJoinData,
    private readonly audio: VoiceAudioBackend = new NoopVoiceAudioBackend(),
    private readonly callbacks: VoiceGatewayConnectionCallbacks = {},
  ) {
    this.dave = new DaveVoiceEncryption({
      userId: data.userId,
      channelId: data.channelId,
      sendJson: (payload) => this.send(payload),
      sendBinary: (opcode, payload) => this.sendBinary(opcode, payload),
      onError: callbacks.onError,
    });
  }

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

  setSelfVoiceState(state: { selfMute: boolean; selfDeaf: boolean }): void {
    this.selfMute = state.selfMute;
    this.selfDeaf = state.selfDeaf;
    if (this.audioContext) {
      this.audioContext.selfMute = this.selfMute;
      this.audioContext.selfDeaf = this.selfDeaf;
    }
    if (this.selfMute) this.sendSpeaking(false);
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
    this.speaking = false;
    this.audioContext = null;
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
    void this.handleMessageData(event.data).catch((error) => {
      this.reportError(asError(error, "Failed to handle Discord voice gateway payload."));
    });
  };

  private async handleMessageData(data: unknown): Promise<void> {
    const binary = await messageDataToBinaryBuffer(data);
    if (binary && isDaveVoiceGatewayBinaryMessage(binary)) {
      this.handleBinaryMessage(binary);
      return;
    }

    let payload: { op?: number; seq?: number; d?: unknown };
    try {
      payload = JSON.parse(messageDataToString(data)) as { op?: number; seq?: number; d?: unknown };
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
      case 5:
        this.handleSpeaking(payload.d);
        break;
      case 11:
        this.handleClientsConnect(payload.d);
        break;
      case 13:
        this.handleClientDisconnect(payload.d);
        break;
      default:
        this.dave.handleJsonOpcode(payload.op, payload.d);
        break;
    }
  }

  private handleBinaryMessage(packet: Buffer): void {
    this.seq = Math.max(this.seq, packet.readUInt16BE(0));
    const opcode = packet.readUInt8(2);
    this.dave.handleBinaryOpcode(opcode, packet.subarray(3));
  }

  private handleSpeaking(data: unknown): void {
    if (!isObject(data)) return;
    const userId = snowflakeToString(data.user_id);
    if (!userId) return;
    const ssrc = typeof data.ssrc === "number" ? data.ssrc : null;
    if (ssrc !== null) this.ssrcToUserId.set(ssrc, userId);
    const speaking = typeof data.speaking === "number" ? data.speaking !== 0 : Boolean(data.speaking);
    // Our local capture path is the authoritative source for the current user.
    // Discord may echo stale SPEAKING frames for self, which made the call
    // widget clear the green speaking ring immediately after we set it locally.
    if (userId !== this.data.userId) this.callbacks.onSpeakingChange?.(userId, speaking);
    this.dave.addKnownUsers([userId]);
  }

  private handleClientsConnect(data: unknown): void {
    if (!isObject(data) || !Array.isArray(data.user_ids)) return;
    this.dave.addKnownUsers(data.user_ids.map(snowflakeToString).filter((userId): userId is string => Boolean(userId)));
  }

  private handleClientDisconnect(data: unknown): void {
    if (!isObject(data)) return;
    const disconnectedUserId = snowflakeToString(data.user_id);
    if (!disconnectedUserId) return;
    this.dave.removeKnownUser(disconnectedUserId);
    for (const [ssrc, userId] of this.ssrcToUserId) {
      if (userId === disconnectedUserId) this.ssrcToUserId.delete(ssrc);
    }
  }

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
    this.dave.handleSessionDescription(data);

    if (!this.udp || this.ssrc === null || !this.secretKey) {
      this.rejectReady(new Error("Discord voice session became ready before UDP setup completed."));
      return;
    }

    if (!this.audioStarted) {
      this.audioStarted = true;
      const audioContext: VoiceAudioContext = {
        udp: this.udp,
        mode: this.selectedMode,
        secretKey: this.secretKey,
        ssrc: this.ssrc,
        selfMute: this.selfMute,
        selfDeaf: this.selfDeaf,
        sendSpeaking: (speaking) => this.sendSpeaking(speaking),
        encodeOutgoingOpus: (payload) => this.dave.encodeOutgoingOpus(payload),
        decodeIncomingOpus: (ssrc, payload) => this.dave.decodeIncomingOpus(this.ssrcToUserId.get(ssrc) ?? null, payload),
        onError: (error) => this.reportError(error),
      };
      this.audioContext = audioContext;
      try {
        await this.audio.start(audioContext);
      } catch (error) {
        this.reportError(asError(error, "Voice audio backend failed to start."));
      }
    }

    this.resolveReady();
  }

  private identify(): void {
    this.send(buildVoiceIdentifyPayload(this.data, this.dave.advertisedProtocolVersion));
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
    this.speaking = speaking;
    this.callbacks.onSpeakingChange?.(this.data.userId, speaking);
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

  private sendBinary(opcode: number, payload: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.concat([Buffer.from([opcode]), payload]));
  }

  private handleClose = (event: CloseEvent): void => {
    if (this.disconnected) return;
    const error = voiceGatewayCloseError(event);
    if (this.readyReject) {
      this.rejectReady(error, { report: false });
    } else if (this.callbacks.onClose) {
      this.callbacks.onClose(error);
    } else {
      this.reportError(error);
    }
    this.disconnect();
  };

  private handleError = (): void => {
    if (this.disconnected) return;
    const error = new Error("Discord voice gateway connection error.");
    if (this.readyReject) this.rejectReady(error, { report: false });
    else this.reportError(error);
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

  private rejectReady(error: Error, options: { report?: boolean } = {}): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    if (options.report ?? true) this.reportError(error);
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
  private capturePacketCount = 0;
  private forwardedPacketCount = 0;
  private droppedPacketCount = 0;
  private nonSilencePacketCount = 0;
  private captureDropLogged = false;
  private pcmRemainder = Buffer.alloc(0);
  private lastInputLevelDb = -Infinity;
  private readonly speakingThresholdDb = speakingThresholdDb();
  private readonly speakingThreshold = dbToLinear(this.speakingThresholdDb);
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
      `a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/48000/1`,
      "",
    ].join("\n"));

    this.playbackProcess = spawn("ffplay", buildFfplayPlaybackArgs(sdpPath));
    this.playbackProcess.stdin.end();
    const playbackErrorOutput = drainChildOutput(this.playbackProcess);
    this.playbackProcess.on("error", (error) => context.onError(new Error(`Failed to start voice playback: ${error.message}`)));
    this.playbackProcess.on("exit", (code, signal) => {
      if (this.context !== context || code === 0 || signal === "SIGTERM") return;
      const details = playbackErrorOutput().trim();
      context.onError(new Error(`Voice playback stopped${details ? `: ${details}` : "."}`));
    });
  }

  private async startCapture(context: VoiceAudioContext): Promise<void> {
    const socket = createSocket("udp4");
    this.captureSocket = socket;
    socket.on("message", this.handleCapturePacket);
    const port = await bindUdp(socket, "127.0.0.1", 0);

    debugLog("voice.capture.start", { input: "default", speakingThresholdDb: this.speakingThresholdDb, speakingIdleMs: this.speakingIdleMs });
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
    if (!context || !this.playbackSocket || this.localPlaybackPort === null || context.selfDeaf) return;
    const parsed = parseDiscordRtpPacket(packet);
    if (!parsed || parsed.payloadType !== OPUS_PAYLOAD_TYPE) return;

    const decrypted = decryptAes256GcmRtp(packet, parsed.headerLength, context.secretKey);
    if (!decrypted) return;
    const extensionBodyLength = parsed.hasExtension ? packet.readUInt16BE(parsed.headerLength - 2) * 4 : 0;
    const opusPayload = extensionBodyLength < decrypted.length ? decrypted.subarray(extensionBodyLength) : Buffer.alloc(0);
    if (opusPayload.length === 0) return;
    const decodedPayload = context.decodeIncomingOpus ? context.decodeIncomingOpus(parsed.ssrc, opusPayload) : opusPayload;
    if (!decodedPayload || decodedPayload.length === 0) return;

    const header = Buffer.alloc(RTP_HEADER_LENGTH);
    header[0] = 0x80;
    header[1] = OPUS_PAYLOAD_TYPE;
    header.writeUInt16BE(parsed.sequence, 2);
    header.writeUInt32BE(parsed.timestamp, 4);
    header.writeUInt32BE(parsed.ssrc, 8);
    this.playbackSocket.send(Buffer.concat([header, decodedPayload]), this.localPlaybackPort, "127.0.0.1");
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
    if (rms >= this.speakingThreshold) this.markCaptureSpeaking(context);
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
      speakingThresholdDb: this.speakingThresholdDb,
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

async function messageDataToBinaryBuffer(data: unknown): Promise<Buffer | null> {
  if (typeof data === "string") return null;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  return null;
}

function isDaveVoiceGatewayBinaryMessage(packet: Buffer): boolean {
  if (packet.length < 3) return false;
  const opcode = packet.readUInt8(2);
  return opcode === 25 || opcode === 27 || opcode === 29 || opcode === 30;
}

function messageDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

function snowflakeToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDaveEncryptedPayload(payload: Buffer | null | undefined): boolean {
  if (!payload || payload.length < DAVE_ENCRYPTED_MARKER.length) return false;
  const marker = payload.lastIndexOf(DAVE_ENCRYPTED_MARKER);
  if (marker < 0) return false;
  const suffix = payload.subarray(marker + DAVE_ENCRYPTED_MARKER.length);
  // DAVE-encrypted media usually ends in FAFA, but Discord/davey can leave
  // padding bytes after the marker. Do not feed those encrypted bytes to Opus.
  if (suffix.length === 0) return true;
  if (marker < payload.length - 256) return false;
  return suffix.every((byte) => byte === suffix[0]);
}

function isUnencryptedDavePassthroughError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UnencryptedWhenPassthroughDisabled");
}

function asError(error: unknown, prefix: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix} ${message}`.trim());
}

export function buildVoiceIdentifyPayload(data: VoiceGatewayJoinData, maxDaveProtocolVersion = DAVE_PROTOCOL_VERSION): unknown {
  return {
    op: 0,
    d: {
      server_id: data.guildId,
      channel_id: data.channelId,
      user_id: data.userId,
      session_id: data.sessionId,
      token: data.token,
      video: false,
      max_dave_protocol_version: maxDaveProtocolVersion,
    },
  };
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
