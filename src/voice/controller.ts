import { VOICE_GATEWAY_ABNORMAL_CLOSE_CODE, VOICE_GATEWAY_DISCONNECTED_CODE, VOICE_GATEWAY_REJOIN_ATTEMPTS, VOICE_GATEWAY_REJOIN_DELAY_MS, VOICE_READY_TIMEOUT_MS, VOICE_SIGNALING_READY_RETRY_MS, VOICE_SIGNALING_READY_TIMEOUT_MS } from "./constants";
import { isRecoverableVoiceGatewayClose, isTerminalVoiceGatewayClose } from "./errors";
import { fetchPreferredVoiceRegions } from "./regions";
import { createDefaultVoiceAudioBackend } from "./audio-ffmpeg";
import { DiscordVoiceGatewayConnection } from "./gateway";
import { VoiceGatewayCloseError, type PendingVoiceJoin, type VoiceCallControllerOptions, type VoiceCallSession, type VoiceCallStartOptions, type VoiceCallStartResult, type VoiceCallTarget, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData, type VoiceServerUpdate, type VoiceStateRequest, type VoiceStateUpdate } from "./types";
import { DEFAULT_LOCAL_GAIN_DB, DEFAULT_NOISE_SUPPRESSION_MODE, type LocalAudioVolumes, type NoiseSuppressionMode } from "../volume";
import { debugLog } from "../debuglog";

const VOICE_GATEWAY_RECOVERY_REJOIN_ATTEMPTS = 12;

export class VoiceCallController {
  private pending: PendingVoiceJoin | null = null;
  private active: VoiceCallSession | null = null;
  private recoveringSession: VoiceCallSession | null = null;
  private localVolumes: LocalAudioVolumes;
  private noiseSuppression: NoiseSuppressionMode;
  private readonly remoteMutedUserIds = new Set<string>();

  constructor(private readonly options: VoiceCallControllerOptions) {
    this.localVolumes = {
      micVolume: options.localVolumes?.micVolume ?? DEFAULT_LOCAL_GAIN_DB,
      speakerVolume: options.localVolumes?.speakerVolume ?? DEFAULT_LOCAL_GAIN_DB,
    };
    this.noiseSuppression = options.noiseSuppression ?? DEFAULT_NOISE_SUPPRESSION_MODE;
  }

  get activeSession(): VoiceCallSession | null {
    return this.active;
  }

  async startCall(target: VoiceCallTarget, startOptions: VoiceCallStartOptions = {}): Promise<VoiceCallStartResult> {
    if (this.active && this.active.state !== "ended" && this.active.state !== "error") {
      if (!startOptions.replaceActive) throw new Error("Already in a call.");
      this.leave("replace_active");
    }
    if (this.pending) throw new Error("Already joining a call.");

    const session: VoiceCallSession = {
      target,
      state: "signaling",
      gateway: null,
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      sessionId: null,
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


  leave(reason = "user"): void {
    debugLog("voice.controller.leave", {
      reason,
      channelId: this.active?.target.channelId ?? this.pending?.target.channelId ?? null,
      state: this.active?.state ?? null,
      hasPending: Boolean(this.pending),
      hasGateway: Boolean(this.active?.gateway),
    });
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
    this.leave("disconnect");
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

  setLocalVolumes(volumes: LocalAudioVolumes): void {
    this.localVolumes = { ...volumes };
    this.active?.gateway?.setLocalVolumes?.(this.localVolumes);
  }

  setRemoteUserMuted(userId: string, muted: boolean): void {
    if (!userId || userId === this.options.selfUserId) return;
    if (muted) this.remoteMutedUserIds.add(userId);
    else this.remoteMutedUserIds.delete(userId);
    this.active?.gateway?.setRemoteUserMuted?.(userId, muted);
  }

  isRemoteUserMuted(userId: string): boolean {
    return this.remoteMutedUserIds.has(userId);
  }

  setNoiseSuppression(mode: NoiseSuppressionMode): void {
    this.noiseSuppression = mode;
    this.active?.gateway?.setNoiseSuppression?.(mode);
  }

  handleVoiceStateUpdate(update: VoiceStateUpdate): void {
    if (update.userId !== this.options.selfUserId) return;
    const active = this.active;
    if (active && update.channelId === active.target.channelId) {
      const changed = active.selfMute !== update.selfMute || active.selfDeaf !== update.selfDeaf;
      active.selfMute = update.selfMute;
      active.selfDeaf = update.selfDeaf;
      if (update.sessionId) active.sessionId = update.sessionId;
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

  private async connectSessionGateway(session: VoiceCallSession, cachedGatewayData?: VoiceGatewayJoinData): Promise<void> {
    if (this.active !== session) throw new Error("Call cancelled.");
    session.state = "signaling";
    this.emitState();

    const gatewayData = cachedGatewayData ?? await this.requestGatewayDataWhenSignalingReady(session, {
      guildId: session.target.guildId,
      channelId: session.target.channelId,
      selfMute: session.selfMute,
      selfDeaf: session.selfDeaf,
      selfVideo: false,
      preferredRegions: session.target.preferredRegions,
    });
    if (this.active !== session) throw new Error("Call cancelled.");
    session.sessionId = gatewayData.sessionId;
    session.lastJoinData = gatewayData;
    session.state = "connecting";
    this.emitState();

    const callbacks = this.gatewayCallbacks(session);
    const gateway = this.options.createGatewayConnection?.(gatewayData, callbacks)
      ?? new DiscordVoiceGatewayConnection(gatewayData, createDefaultVoiceAudioBackend(this.localVolumes, this.noiseSuppression), callbacks);
    session.gateway = gateway;
    gateway.setSelfVoiceState?.({ selfMute: session.selfMute, selfDeaf: session.selfDeaf });
    for (const userId of this.remoteMutedUserIds) gateway.setRemoteUserMuted?.(userId, true);
    gateway.setLocalVolumes?.(this.localVolumes);
    gateway.setNoiseSuppression?.(this.noiseSuppression);
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
    const terminal = isTerminalVoiceGatewayClose(error);
    const recoverable = isRecoverableVoiceGatewayClose(error);
    debugLog("voice.controller.gateway_close", {
      channelId: session.target.channelId,
      guildId: session.target.guildId,
      state: session.state,
      code: error.code,
      reason: error.closeReason,
      terminal,
      recoverable,
      alreadyRecovering: this.recoveringSession === session,
    });
    if (terminal) {
      this.endSession(session);
      return;
    }
    if (!recoverable) {
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
    const reusableJoinData = shouldReuseVoiceJoinData(cause) ? session.lastJoinData : null;
    const softRejoin = shouldSoftRejoinVoiceGateway(cause);
    debugLog("voice.controller.recover.start", {
      channelId: session.target.channelId,
      guildId: session.target.guildId,
      code: cause.code,
      reason: cause.closeReason,
      reuseJoinData: Boolean(reusableJoinData),
      softRejoin,
      sessionId: session.sessionId ?? null,
    });
    if (reusableJoinData) {
      try {
        await this.prepareVoiceGatewayRejoin(session, { leaveVoice: false });
        await this.connectSessionGateway(session, reusableJoinData);
        if (this.active !== session) return;
        session.state = "ready";
        debugLog("voice.controller.recover.success", { channelId: session.target.channelId, strategy: "reuse_join_data", sessionId: session.sessionId ?? null });
        this.emitState();
        return;
      } catch (error) {
        const asErr = error instanceof Error ? error : new Error(String(error));
        lastError = asErr;
        session.gateway?.disconnect();
        session.gateway = null;
        debugLog("voice.controller.recover.failed", { channelId: session.target.channelId, strategy: "reuse_join_data", error: asErr.message });
        if (!isRecoverableVoiceRecoveryError(asErr)) {
          if (this.active === session) this.failSession(session, asErr);
          return;
        }
      }
    }

    if (softRejoin) {
      try {
        await this.prepareVoiceGatewayRejoin(session, { leaveVoice: false });
        await this.connectSessionGateway(session);
        if (this.active !== session) return;
        session.state = "ready";
        debugLog("voice.controller.recover.success", { channelId: session.target.channelId, strategy: "soft_rejoin", sessionId: session.sessionId ?? null });
        this.emitState();
        return;
      } catch (error) {
        const asErr = error instanceof Error ? error : new Error(String(error));
        lastError = asErr;
        session.gateway?.disconnect();
        session.gateway = null;
        debugLog("voice.controller.recover.failed", { channelId: session.target.channelId, strategy: "soft_rejoin", error: asErr.message });
        if (!isRecoverableVoiceRecoveryError(asErr)) {
          if (this.active === session) this.failSession(session, asErr);
          return;
        }
      }
    }

    const recoveryAttempts = this.options.recoveryAttempts ?? VOICE_GATEWAY_RECOVERY_REJOIN_ATTEMPTS;
    for (let attempt = 0; attempt < recoveryAttempts; attempt++) {
      if (this.active !== session) return;
      try {
        debugLog("voice.controller.recover.fresh_attempt", { channelId: session.target.channelId, attempt: attempt + 1, attempts: recoveryAttempts });
        await this.prepareVoiceGatewayRejoin(session);
        await this.connectSessionGateway(session);
        if (this.active !== session) return;
        session.state = "ready";
        debugLog("voice.controller.recover.success", { channelId: session.target.channelId, strategy: "fresh_rejoin", attempt: attempt + 1, sessionId: session.sessionId ?? null });
        this.emitState();
        return;
      } catch (error) {
        const asErr = error instanceof Error ? error : new Error(String(error));
        lastError = asErr;
        session.gateway?.disconnect();
        session.gateway = null;
        debugLog("voice.controller.recover.failed", { channelId: session.target.channelId, strategy: "fresh_rejoin", attempt: attempt + 1, error: asErr.message });
        if (!isRecoverableVoiceRecoveryError(asErr)) break;
      }
    }

    if (this.active === session) this.failSession(session, lastError);
  }

  private async prepareVoiceGatewayRejoin(session: VoiceCallSession, options: { leaveVoice?: boolean } = {}): Promise<void> {
    debugLog("voice.controller.rejoin.prepare", { channelId: session.target.channelId, leaveVoice: options.leaveVoice !== false, state: session.state });
    if (this.pending) this.clearPending(new Error("Retrying Discord voice gateway."));
    session.gateway?.disconnect();
    session.gateway = null;
    session.state = "signaling";
    this.emitState();
    if (options.leaveVoice !== false) this.options.signaling.leaveVoice();
    const delay = Math.max(0, this.options.retryDelayMs ?? VOICE_GATEWAY_REJOIN_DELAY_MS);
    if (delay > 0) await sleep(delay);
  }

  private waitForGatewayData(target: VoiceCallTarget): Promise<VoiceGatewayJoinData> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearPending(new Error("Timed out waiting for Discord voice gateway details."));
      }, this.options.voiceReadyTimeoutMs ?? VOICE_READY_TIMEOUT_MS);
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
    debugLog("voice.controller.end_session", { channelId: session.target.channelId, state: session.state });
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
    debugLog("voice.controller.fail_session", { channelId: session.target.channelId, state: session.state, error: error.message });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldReuseVoiceJoinData(error: VoiceGatewayCloseError): boolean {
  return error.code === VOICE_GATEWAY_ABNORMAL_CLOSE_CODE || /connection ended|abnormal/i.test(error.closeReason);
}

function shouldSoftRejoinVoiceGateway(error: VoiceGatewayCloseError): boolean {
  return error.code === VOICE_GATEWAY_DISCONNECTED_CODE
    || error.code === 1000
    || /^disconnected\.?$/i.test(error.closeReason)
    || /connection closed normally/i.test(error.closeReason);
}

function isRecoverableVoiceRecoveryError(error: Error): boolean {
  return isRecoverableVoiceGatewayClose(error)
    || /timed out waiting for discord voice gateway details/i.test(error.message)
    || /timed out waiting for discord gateway to become ready/i.test(error.message)
    || /retrying discord gateway/i.test(error.message)
    || /gateway connection error/i.test(error.message);
}
