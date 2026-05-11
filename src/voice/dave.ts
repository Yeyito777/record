import { DAVE_PROTOCOL_VERSION, DAVESession, MediaType, type ProposalsOperationType } from "@snazzah/davey";

import { debugLog } from "../debuglog";
import { OPUS_SILENCE_FRAME } from "./constants";
import { asError } from "./errors";
import { isDaveEncryptedPayload, isObject, isUnencryptedDavePassthroughError, stripDavePadding } from "./util";

interface DaveVoiceEncryptionOptions {
  userId: string;
  channelId: string;
  sendJson: (payload: unknown) => void;
  sendBinary: (opcode: number, payload: Buffer) => void;
  onError?: (error: Error) => void;
}

export class DaveVoiceEncryption {
  private session: DAVESession | null = null;
  private protocolVersion = 0;
  private pendingTransitions = new Map<number, number>();
  private knownUserIds = new Set<string>();
  private externalSender: Buffer | null = null;
  private downgraded = false;
  private reinitializing = false;
  private lastTransitionId: number | null = null;
  private lastMediaErrorAt = 0;
  private lastMediaDebugAt = 0;
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
    if (!this.session?.ready) {
      this.logMediaDebug("encrypt_passthrough_not_ready", { protocolVersion: this.protocolVersion, payloadBytes: payload.length, users: this.safeUserIds() });
      return payload;
    }
    try {
      return this.session.encryptOpus(payload);
    } catch (error) {
      this.reportMediaError(asError(error, "Failed to DAVE-encrypt outgoing voice audio."));
      return null;
    }
  }

  decodeIncomingOpus(userId: string | null, payload: Buffer): Buffer | null {
    if (payload.equals(OPUS_SILENCE_FRAME)) return payload;
    if (!this.session) return this.protocolVersion === 0 ? payload : (isDaveEncryptedPayload(payload) ? null : payload);
    if (!userId) {
      this.logMediaDebug("missing_user", { payloadBytes: payload.length, encrypted: isDaveEncryptedPayload(payload) });
      return this.protocolVersion === 0 || !isDaveEncryptedPayload(payload) ? payload : null;
    }

    const canDecrypt = this.ready || (this.session.ready && this.session.canPassthrough(userId));
    if (!canDecrypt) {
      const encrypted = isDaveEncryptedPayload(payload);
      this.logMediaDebug("not_ready", { userId, sessionReady: this.session.ready, protocolVersion: this.protocolVersion, payloadBytes: payload.length, encrypted, users: this.safeUserIds() });
      return this.protocolVersion === 0 || !encrypted ? payload : null;
    }

    const encrypted = isDaveEncryptedPayload(payload);
    const normalizedPayload = encrypted ? stripDavePadding(payload) : payload;
    try {
      const decoded = this.session.decrypt(userId, MediaType.AUDIO, normalizedPayload);
      if (isDaveEncryptedPayload(decoded)) {
        this.logMediaDebug("encrypted_after_decrypt", { userId, payloadBytes: payload.length, normalizedBytes: normalizedPayload.length, decodedBytes: decoded.length, users: this.safeUserIds(), stats: this.safeDecryptionStats(userId) });
        this.reportMediaError(new Error(`DAVE decrypt returned encrypted-looking voice audio from ${userId}; dropping packet.`));
        return null;
      }
      return decoded;
    } catch (error) {
      if (isUnencryptedDavePassthroughError(error) && !encrypted) {
        this.enablePassthroughRecovery();
        return payload;
      }
      this.logMediaDebug("decrypt_error", { userId, error: error instanceof Error ? error.message : String(error), payloadBytes: payload.length, normalizedBytes: normalizedPayload.length, encrypted, users: this.safeUserIds(), stats: this.safeDecryptionStats(userId), canPassthrough: this.session.canPassthrough(userId) });
      this.reportMediaError(asError(error, `Failed to DAVE-decrypt voice audio from ${userId}.`));
      return null;
    }
  }

  private logMediaDebug(reason: string, data: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastMediaDebugAt < 2_000) return;
    this.lastMediaDebugAt = now;
    debugLog("voice.dave.media", { reason, ...data });
  }

  private safeUserIds(): string[] {
    try {
      return this.session?.getUserIds() ?? [];
    } catch {
      return [];
    }
  }

  private safeDecryptionStats(userId: string): unknown {
    try {
      return this.session?.getDecryptionStats(userId, MediaType.AUDIO) ?? null;
    } catch {
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
