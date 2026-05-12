import { createSocket, type Socket as UdpSocket } from "dgram";
import { resolve4 } from "dns/promises";

import { debugLog } from "../debuglog";
import { VOICE_CONNECT_TIMEOUT_MS, VOICE_GATEWAY_VERSION, OPUS_PAYLOAD_TYPE } from "./constants";
import { DaveVoiceEncryption } from "./dave";
import { asError, voiceGatewayCloseError } from "./errors";
import { buildVoiceIdentifyPayload } from "./payloads";
import { connectUdp, discoverUdpAddress, selectEncryptionMode } from "./rtp";
import { isDaveVoiceGatewayBinaryMessage, isObject, messageDataToBinaryBuffer, messageDataToString, snowflakeToString } from "./util";
import { NoopVoiceAudioBackend, type VoiceAudioBackend, type VoiceAudioContext, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "./types";

interface VoiceGatewayWebSocketTarget {
  url: string;
  endpoint: string;
  via: "hostname" | "ipv4_literal";
  resolvedIp?: string;
  headers?: HeadersInit;
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
  private connectStage = "idle";
  private audioContext: VoiceAudioContext | null = null;
  private selfMute = false;
  private selfDeaf = false;
  private readonly ssrcToUserId = new Map<number, string>();
  private readonly remoteUserIds = new Set<string>();
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
    this.connectStage = "websocket_connecting";
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.connectTimer = setTimeout(() => {
        debugLog("voice.gateway.timeout", { stage: this.connectStage, endpoint: this.safeEndpoint() });
        this.rejectReady(new Error("Timed out connecting to Discord voice gateway."));
        this.disconnect();
      }, VOICE_CONNECT_TIMEOUT_MS);
      this.connectTimer.unref?.();

      void this.openWebSocket().catch((error) => {
        if (this.disconnected) return;
        this.rejectReady(asError(error, "Failed to open Discord voice gateway websocket."));
      });
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
      ws.removeEventListener("open", this.handleOpen);
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

  private async openWebSocket(): Promise<void> {
    const target = await this.resolveWebSocketTarget();
    if (this.disconnected) return;
    debugLog("voice.gateway.connect", {
      endpoint: target.endpoint,
      version: VOICE_GATEWAY_VERSION,
      channelId: this.data.channelId,
      guildId: this.data.guildId,
      via: target.via,
      resolvedIp: target.resolvedIp ?? null,
    });
    this.ws = target.headers
      ? new WebSocket(target.url, { headers: target.headers } as unknown as string[])
      : new WebSocket(target.url);
    this.ws.addEventListener("open", this.handleOpen);
    this.ws.addEventListener("message", this.handleMessage);
    this.ws.addEventListener("close", this.handleClose);
    this.ws.addEventListener("error", this.handleError);
  }

  private async resolveWebSocketTarget(): Promise<VoiceGatewayWebSocketTarget> {
    const endpoint = this.safeEndpoint();
    const fallback = { url: `wss://${endpoint}/?v=${VOICE_GATEWAY_VERSION}`, endpoint, via: "hostname" as const };

    // Bun's client WebSocket currently hangs on some Discord media endpoints
    // when DNS returns broken/unreachable IPv6 addresses first. The normal app
    // gateway is Cloudflare too, but these c-*.discord.media hosts are where we
    // have observed the stall. Connect to a resolved IPv4 literal while keeping
    // the HTTP Host header set to Discord's endpoint, matching what browsers do
    // after DNS selection and avoiding the IPv6 blackhole.
    if (!isBunRuntime()) return fallback;

    let parsed: URL;
    try {
      parsed = new URL(`wss://${endpoint}`);
    } catch (error) {
      debugLog("voice.gateway.endpoint_parse_error", { endpoint, error: error instanceof Error ? error.message : String(error) });
      return fallback;
    }

    if (!parsed.hostname || isIpLiteral(parsed.hostname)) return fallback;

    try {
      const addresses = await resolve4(parsed.hostname);
      const resolvedIp = addresses[0];
      if (!resolvedIp) return fallback;
      const port = parsed.port ? `:${parsed.port}` : "";
      return {
        url: `wss://${resolvedIp}${port}/?v=${VOICE_GATEWAY_VERSION}`,
        endpoint: parsed.host,
        via: "ipv4_literal",
        resolvedIp,
        headers: { Host: parsed.host },
      };
    } catch (error) {
      debugLog("voice.gateway.resolve4_error", { endpoint, error: error instanceof Error ? error.message : String(error) });
      return fallback;
    }
  }

  private handleOpen = (): void => {
    this.connectStage = "websocket_open";
    debugLog("voice.gateway.open", { endpoint: this.safeEndpoint() });
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
    debugLog("voice.gateway.message", { op: payload.op, seq: payload.seq ?? null, stage: this.connectStage });

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
    if (userId !== this.data.userId) this.remoteUserIds.add(userId);
    if (ssrc !== null) {
      const previous = this.ssrcToUserId.get(ssrc);
      this.ssrcToUserId.set(ssrc, userId);
      if (previous !== userId) debugLog("voice.playback.ssrc_map", { ssrc, userId, source: "speaking" });
    }
    const speaking = typeof data.speaking === "number" ? data.speaking !== 0 : Boolean(data.speaking);
    // Our local capture path is the authoritative source for the current user.
    // Discord may echo stale SPEAKING frames for self, which made the call
    // widget clear the green speaking ring immediately after we set it locally.
    if (userId !== this.data.userId) this.callbacks.onSpeakingChange?.(userId, speaking);
    this.dave.addKnownUsers([userId]);
  }

  private handleClientsConnect(data: unknown): void {
    if (!isObject(data) || !Array.isArray(data.user_ids)) return;
    const userIds = data.user_ids.map(snowflakeToString).filter((userId): userId is string => Boolean(userId));
    for (const userId of userIds) {
      if (userId !== this.data.userId) this.remoteUserIds.add(userId);
    }
    this.dave.addKnownUsers(userIds);
  }

  private handleClientDisconnect(data: unknown): void {
    if (!isObject(data)) return;
    const disconnectedUserId = snowflakeToString(data.user_id);
    if (!disconnectedUserId) return;
    this.remoteUserIds.delete(disconnectedUserId);
    this.dave.removeKnownUser(disconnectedUserId);
    for (const [ssrc, userId] of this.ssrcToUserId) {
      if (userId === disconnectedUserId) this.ssrcToUserId.delete(ssrc);
    }
  }

  private handleHello(data: unknown): void {
    const interval = isObject(data) && typeof data.heartbeat_interval === "number" ? data.heartbeat_interval : null;
    if (!interval) {
      debugLog("voice.gateway.hello_invalid", { dataType: typeof data });
      this.rejectReady(new Error("Discord voice gateway did not send a heartbeat interval."));
      return;
    }

    this.connectStage = "hello";
    debugLog("voice.gateway.hello", { heartbeatInterval: interval });
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
      debugLog("voice.gateway.ready_invalid", { hasIp: Boolean(ip), port, hasSsrc: Boolean(ssrc), modeCount: modes.length });
      this.rejectReady(new Error("Discord voice gateway sent incomplete UDP details."));
      return;
    }

    this.connectStage = "udp_discovery";
    debugLog("voice.gateway.ready", { ip, port, ssrc, modeCount: modes.length, modes });
    this.ssrc = ssrc;
    try {
      const udp = createSocket("udp4");
      this.udp = udp;
      await connectUdp(udp, ip, port);
      const discovery = await discoverUdpAddress(udp, ssrc);
      this.selectedMode = selectEncryptionMode(modes);
      debugLog("voice.gateway.udp_discovered", { address: discovery.address, port: discovery.port, selectedMode: this.selectedMode });
      this.selectProtocol(discovery.address, discovery.port, this.selectedMode);
    } catch (error) {
      debugLog("voice.gateway.udp_error", { error: error instanceof Error ? error.message : String(error) });
      this.rejectReady(asError(error, "Failed to initialize Discord voice UDP."));
      this.disconnect();
    }
  }

  private async handleSessionDescription(data: unknown): Promise<void> {
    if (!isObject(data) || !Array.isArray(data.secret_key) || typeof data.mode !== "string") {
      debugLog("voice.gateway.session_description_invalid", { hasSecretKey: isObject(data) && Array.isArray(data.secret_key), mode: isObject(data) ? data.mode : null });
      this.rejectReady(new Error("Discord voice gateway sent an invalid session description."));
      return;
    }

    this.connectStage = "session_description";
    this.mediaSessionId = typeof data.media_session_id === "string" ? data.media_session_id : null;
    this.selectedMode = data.mode;
    this.secretKey = Buffer.from(data.secret_key.filter((byte): byte is number => typeof byte === "number"));
    debugLog("voice.gateway.session_description", { mode: this.selectedMode, mediaSessionId: this.mediaSessionId, daveProtocolVersion: typeof data.dave_protocol_version === "number" ? data.dave_protocol_version : null });
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
        decodeIncomingOpus: (ssrc, payload) => this.dave.decodeIncomingOpus(this.resolveIncomingSsrcUserId(ssrc), payload),
        onIncomingAudio: (ssrc) => this.handleIncomingAudio(ssrc),
        onError: (error) => this.reportError(error),
      };
      this.audioContext = audioContext;
      try {
        await this.audio.start(audioContext);
      } catch (error) {
        this.reportError(asError(error, "Voice audio backend failed to start."));
      }
    }

    this.connectStage = "ready";
    this.resolveReady();
  }

  private resolveIncomingSsrcUserId(ssrc: number): string | null {
    const mappedUserId = this.ssrcToUserId.get(ssrc);
    if (mappedUserId) return mappedUserId;
    if (this.remoteUserIds.size !== 1) {
      debugLog("voice.playback.ssrc_unmapped", { ssrc, remoteUserIds: [...this.remoteUserIds] });
      return null;
    }
    const [inferredUserId] = [...this.remoteUserIds];
    this.ssrcToUserId.set(ssrc, inferredUserId);
    debugLog("voice.playback.ssrc_map", { ssrc, userId: inferredUserId, source: "single_remote_fallback" });
    return inferredUserId;
  }

  private handleIncomingAudio(ssrc: number): void {
    const userId = this.resolveIncomingSsrcUserId(ssrc);
    if (!userId || userId === this.data.userId) return;
    this.callbacks.onSpeakingChange?.(userId, true);
  }

  private identify(): void {
    this.connectStage = "identified";
    debugLog("voice.gateway.identify", { channelId: this.data.channelId, guildId: this.data.guildId, hasSessionId: Boolean(this.data.sessionId) });
    this.send(buildVoiceIdentifyPayload(this.data, this.dave.advertisedProtocolVersion));
  }

  private selectProtocol(address: string, port: number, mode: string): void {
    this.connectStage = "select_protocol";
    debugLog("voice.gateway.select_protocol", { address, port, mode });
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
    debugLog("voice.gateway.close", { code: event.code, reason: event.reason, wasClean: event.wasClean, stage: this.connectStage });
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
    debugLog("voice.gateway.error", { stage: this.connectStage, endpoint: this.safeEndpoint() });
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

  private safeEndpoint(): string {
    return this.data.endpoint.replace(/^wss?:\/\//, "");
  }
}

function isBunRuntime(): boolean {
  return typeof Bun !== "undefined";
}

function isIpLiteral(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
}
