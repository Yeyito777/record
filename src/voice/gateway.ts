import { createSocket, type Socket as UdpSocket } from "dgram";

import { debugLog } from "../debuglog";
import { VOICE_CONNECT_TIMEOUT_MS, VOICE_GATEWAY_VERSION, OPUS_PAYLOAD_TYPE } from "./constants";
import { DaveVoiceEncryption } from "./dave";
import { asError, voiceGatewayCloseError } from "./errors";
import { buildVoiceIdentifyPayload } from "./payloads";
import { connectUdp, discoverUdpAddress, selectEncryptionMode } from "./rtp";
import { isDaveVoiceGatewayBinaryMessage, isObject, messageDataToBinaryBuffer, messageDataToString, snowflakeToString } from "./util";
import { NoopVoiceAudioBackend, type VoiceAudioBackend, type VoiceAudioContext, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "./types";

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
        decodeIncomingOpus: (ssrc, payload) => this.dave.decodeIncomingOpus(this.resolveIncomingSsrcUserId(ssrc), payload),
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
