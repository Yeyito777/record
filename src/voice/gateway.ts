import { randomUUID } from "crypto";
import { createSocket, type Socket as UdpSocket } from "dgram";
import { resolve4 } from "dns/promises";
import {
  Audio,
  H264RtpPacketizer,
  PacingHandler,
  PeerConnection,
  RtcpNackResponder,
  RtcpSrReporter,
  RtpPacketizationConfig,
  RtpPacketizer,
  Video,
  type PeerConnection as NodePeerConnection,
  type Track,
} from "@lng2004/node-datachannel";

import { debugLog } from "../debuglog";
import { VOICE_CONNECT_TIMEOUT_MS, VOICE_GATEWAY_VERSION, OPUS_PAYLOAD_TYPE } from "./constants";
import { DaveVoiceEncryption } from "./dave";
import { asError, voiceGatewayCloseError } from "./errors";
import { buildMediaSinkWantsPayload, buildVoiceIdentifyPayload, buildVoiceResumePayload } from "./payloads";
import { connectUdp, discoverUdpAddress, parsePlainRtpPacket, selectEncryptionMode } from "./rtp";
import { isDaveVoiceGatewayBinaryMessage, isObject, messageDataToBinaryBuffer, messageDataToString, snowflakeToString } from "./util";
import { NoopVoiceAudioBackend, VoiceGatewayCloseError, type VoiceAudioBackend, type VoiceAudioContext, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "./types";
import { DEFAULT_REMOTE_USER_VOLUME_PERCENT, normalizeRemoteUserVolumePercent, type LocalAudioVolumes, type NoiseSuppressionMode } from "../volume";

const VIDEO_PAYLOAD_TYPE_H264 = 101;
const VIDEO_RTX_PAYLOAD_TYPE_H264 = 102;
const SPEAKING_FLAG_VOICE = 1 << 0;
const SPEAKING_FLAG_SOUNDSHARE = 1 << 1;
const REMOTE_SSRC_VOLUME_RESET_DELAY_MS = 750;
const WEBRTC_VIDEO_STATS_INTERVAL_MS = 5_000;
const HEARTBEAT_ACK_GRACE_MULTIPLIER = 1.5;

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
  private connectMode: "identify" | "resume" = "identify";
  private resumeInProgress = false;
  private resumeCause: VoiceGatewayCloseError | null = null;
  private heartbeatIntervalMs = 0;
  private heartbeatAckPending = false;
  private lastHeartbeatNonce: number | null = null;
  private lastHeartbeatSentAt = 0;
  private lastHeartbeatAckAt = 0;
  private audioContext: VoiceAudioContext | null = null;
  private selfMute = false;
  private selfDeaf = false;
  private videoSsrc: number | null = null;
  private videoRtxSsrc: number | null = null;
  private videoCodec: string | null = null;
  private readonly ssrcToUserId = new Map<number, string>();
  private readonly authoritativeAudioSsrcs = new Set<number>();
  private readonly staleVolumeAudioSsrcs = new Set<number>();
  private readonly remoteSsrcVolumeResetTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly remoteUserIds = new Set<string>();
  private readonly remoteMutedUserIds = new Set<string>();
  private readonly remoteUserVolumes = new Map<string, number>();
  private readonly dave: DaveVoiceEncryption;
  private webRtc: NodePeerConnection | null = null;
  private webRtcAudioTrack: Track | null = null;
  private webRtcVideoTrack: Track | null = null;
  private webRtcAudioPacketizer: RtpPacketizer | null = null;
  private webRtcVideoPacketizer: RtpPacketizer | null = null;
  private webRtcVideoFramesSent = 0;
  private webRtcVideoFramesDropped = 0;
  private webRtcVideoSendFalseFrames = 0;
  private webRtcVideoBytesSent = 0;
  private webRtcLastPeerBytesSent = 0;
  private webRtcLastVideoStatsAt = 0;
  private webRtcLastVideoStatsFrames = 0;
  private webRtcLastVideoStatsDropped = 0;
  private webRtcLastVideoStatsSendFalse = 0;
  mediaSessionId: string | null = null;

  private get receiveOnlyStream(): boolean {
    return Boolean(this.data.streamReceive);
  }

  private get usesWebRtcVideo(): boolean {
    return Boolean(this.data.video || this.data.streamReceive);
  }

  constructor(
    private readonly data: VoiceGatewayJoinData,
    private readonly audio: VoiceAudioBackend = new NoopVoiceAudioBackend(),
    private readonly callbacks: VoiceGatewayConnectionCallbacks = {},
  ) {
    this.dave = new DaveVoiceEncryption({
      userId: data.userId,
      channelId: data.daveChannelId ?? data.channelId,
      sendJson: (payload) => this.send(payload),
      sendBinary: (opcode, payload) => this.sendBinary(opcode, payload),
      onError: callbacks.onError,
    });
  }

  connect(): Promise<void> {
    if (this.ws) return Promise.resolve();
    this.disconnected = false;
    this.connectMode = "identify";
    this.connectStage = "websocket_connecting";
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.startConnectTimer("connect");

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

  setRemoteUserMuted(userId: string, muted: boolean): void {
    if (!userId || userId === this.data.userId) return;
    if (muted) {
      this.remoteMutedUserIds.add(userId);
      this.callbacks.onSpeakingChange?.(userId, false);
    } else {
      this.remoteMutedUserIds.delete(userId);
    }
  }

  setRemoteUserVolume(userId: string, volumePercent: number): void {
    if (!userId || userId === this.data.userId) return;
    const normalized = normalizeRemoteUserVolumePercent(volumePercent);
    if (normalized === DEFAULT_REMOTE_USER_VOLUME_PERCENT) this.remoteUserVolumes.delete(userId);
    else this.remoteUserVolumes.set(userId, normalized);
    for (const [ssrc, mappedUserId] of this.ssrcToUserId) {
      if (mappedUserId === userId && this.authoritativeAudioSsrcs.has(ssrc)) {
        this.audio.setRemoteSsrcVolume?.(ssrc, normalized);
      }
    }
  }

  setLocalVolumes(volumes: LocalAudioVolumes): void {
    this.audio.setLocalVolumes?.(volumes);
  }

  setNoiseSuppression(mode: NoiseSuppressionMode): void {
    this.audio.setNoiseSuppression?.(mode);
  }

  disconnect(): void {
    this.disconnected = true;
    this.resumeInProgress = false;
    this.resumeCause = null;
    this.clearConnectTimer();
    this.clearHeartbeatTimer();
    for (const timer of this.remoteSsrcVolumeResetTimers.values()) clearTimeout(timer);
    this.remoteSsrcVolumeResetTimers.clear();
    this.audio.stop();
    this.audioStarted = false;
    this.speaking = false;
    this.audioContext = null;
    if (this.webRtc) {
      try { this.webRtc.close(); } catch {}
      this.webRtc = null;
      this.webRtcAudioTrack = null;
      this.webRtcVideoTrack = null;
      this.webRtcAudioPacketizer = null;
      this.webRtcVideoPacketizer = null;
      this.webRtcVideoFramesSent = 0;
      this.webRtcVideoFramesDropped = 0;
      this.webRtcVideoSendFalseFrames = 0;
      this.webRtcVideoBytesSent = 0;
      this.webRtcLastPeerBytesSent = 0;
      this.webRtcLastVideoStatsAt = 0;
      this.webRtcLastVideoStatsFrames = 0;
      this.webRtcLastVideoStatsDropped = 0;
      this.webRtcLastVideoStatsSendFalse = 0;
    }
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
      this.removeWebSocketListeners(ws);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }

  private startConnectTimer(kind: "connect" | "resume"): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      debugLog("voice.gateway.timeout", { stage: this.connectStage, endpoint: this.safeEndpoint(), kind });
      if (kind === "resume") {
        this.finishResumeFailed(new VoiceGatewayCloseError(1006, "Resume timed out."));
        return;
      }
      this.rejectReady(new Error("Timed out connecting to Discord voice gateway."));
      this.disconnect();
    }, VOICE_CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatAckPending = false;
    this.lastHeartbeatNonce = null;
    this.lastHeartbeatSentAt = 0;
  }

  private removeWebSocketListeners(ws: WebSocket): void {
    ws.removeEventListener("message", this.handleMessage);
    ws.removeEventListener("open", this.handleOpen);
    ws.removeEventListener("close", this.handleClose);
    ws.removeEventListener("error", this.handleError);
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
        this.handleHeartbeatAck(payload.d);
        break;
      case 9:
        this.handleResumed();
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
      case 14:
        this.handleSessionUpdate(payload.d);
        break;
      case 12:
        this.handleVideo(payload.d);
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
    if (userId !== this.data.userId) {
      this.remoteUserIds.add(userId);
      // SPEAKING can precede or replace CLIENTS_CONNECT during reconnects. Emit
      // presence even for a previously seen user so a delayed app-gateway
      // disconnect cannot leave the visible roster regressed. This callback is
      // also emitted for locally muted users; only the speaking callback below
      // is suppressed by local mute.
      this.callbacks.onParticipantsConnect?.([userId]);
    }
    if (ssrc !== null) {
      const previous = this.rememberAuthoritativeAudioSsrc(ssrc, userId);
      if (previous !== userId) debugLog("voice.playback.ssrc_map", { ssrc, userId, source: "speaking" });
    }
    const speaking = typeof data.speaking === "number" ? data.speaking !== 0 : Boolean(data.speaking);
    // Our local capture path is the authoritative source for the current user.
    // Discord may echo stale SPEAKING frames for self, which made the call
    // widget clear the green speaking ring immediately after we set it locally.
    if (userId !== this.data.userId && !this.remoteMutedUserIds.has(userId)) this.callbacks.onSpeakingChange?.(userId, speaking);
    this.dave.addKnownUsers([userId]);
  }

  private handleClientsConnect(data: unknown): void {
    if (!isObject(data) || !Array.isArray(data.user_ids)) return;
    const userIds = data.user_ids.map(snowflakeToString).filter((userId): userId is string => Boolean(userId));
    const remoteUserIds = Array.from(new Set(userIds.filter((userId) => userId !== this.data.userId)));
    for (const userId of remoteUserIds) this.remoteUserIds.add(userId);
    // Emit the complete event rather than only newly seen users. The app-gateway
    // roster can briefly regress on delayed VOICE_STATE_UPDATE disconnects, and
    // this active-session snapshot is what repairs it.
    if (remoteUserIds.length > 0) this.callbacks.onParticipantsConnect?.(remoteUserIds);
    this.dave.addKnownUsers(userIds);
  }

  private handleHeartbeatAck(data: unknown): void {
    const ackNonce = isObject(data) && isObject(data.d) && typeof data.d.t === "number"
      ? data.d.t
      : isObject(data) && typeof data.t === "number"
        ? data.t
        : null;
    const now = Date.now();
    const rttMs = this.lastHeartbeatSentAt ? now - this.lastHeartbeatSentAt : null;
    this.heartbeatAckPending = false;
    this.lastHeartbeatAckAt = now;
    if (ackNonce !== null && this.lastHeartbeatNonce !== null && ackNonce !== this.lastHeartbeatNonce) {
      debugLog("voice.gateway.heartbeat_ack_mismatch", { rttMs, stage: this.connectStage });
    }
  }

  private handleResumed(): void {
    this.clearConnectTimer();
    this.resumeInProgress = false;
    this.resumeCause = null;
    this.connectStage = "ready";
    debugLog("voice.gateway.resumed", { endpoint: this.safeEndpoint(), seqAck: this.seq });
    if (this.data.video && !this.receiveOnlyStream) this.sendVideo();
    else if (this.speaking) this.sendSpeaking(true);
  }

  private handleClientDisconnect(data: unknown): void {
    if (!isObject(data)) return;
    const disconnectedUserId = snowflakeToString(data.user_id);
    if (!disconnectedUserId) return;
    this.remoteUserIds.delete(disconnectedUserId);
    if (disconnectedUserId !== this.data.userId) this.callbacks.onParticipantDisconnect?.(disconnectedUserId);
    this.dave.removeKnownUser(disconnectedUserId);
    for (const [ssrc, userId] of this.ssrcToUserId) {
      if (userId === disconnectedUserId) {
        if (this.authoritativeAudioSsrcs.has(ssrc)) this.scheduleRemoteSsrcVolumeReset(ssrc);
        this.ssrcToUserId.delete(ssrc);
        this.authoritativeAudioSsrcs.delete(ssrc);
      }
    }
  }

  private handleSessionUpdate(data: unknown): void {
    if (!isObject(data)) return;
    const previousMediaSessionId = this.mediaSessionId;
    if (typeof data.media_session_id === "string") this.mediaSessionId = data.media_session_id;
    if (typeof data.video_codec === "string") this.videoCodec = data.video_codec;
    debugLog("voice.gateway.session_update", {
      mediaSessionId: this.mediaSessionId,
      previousMediaSessionId,
      audioCodec: typeof data.audio_codec === "string" ? data.audio_codec : null,
      videoCodec: this.videoCodec,
      keyframeInterval: typeof data.keyframe_interval === "number" ? data.keyframe_interval : null,
    });
  }

  private handleVideo(data: unknown): void {
    if (!isObject(data)) return;
    const userId = snowflakeToString(data.user_id);
    const audioSsrc = typeof data.audio_ssrc === "number" ? data.audio_ssrc : null;
    if (userId && audioSsrc !== null) this.rememberAuthoritativeAudioSsrc(audioSsrc, userId);
    if (userId && userId !== this.data.userId) {
      this.remoteUserIds.add(userId);
      this.callbacks.onParticipantsConnect?.([userId]);
    }

    const videoSsrc = typeof data.video_ssrc === "number" ? data.video_ssrc : null;
    const rtxSsrc = typeof data.rtx_ssrc === "number" ? data.rtx_ssrc : null;
    if (userId && videoSsrc !== null) this.ssrcToUserId.set(videoSsrc, userId);
    if (userId && rtxSsrc !== null) this.ssrcToUserId.set(rtxSsrc, userId);

    const stream = this.pickIncomingVideoStream(data.streams, userId, videoSsrc, rtxSsrc);
    if (!stream) return;
    this.videoSsrc = stream.ssrc;
    this.videoRtxSsrc = stream.rtxSsrc ?? null;
    if (userId) {
      this.ssrcToUserId.set(stream.ssrc, userId);
      if (stream.rtxSsrc !== undefined) this.ssrcToUserId.set(stream.rtxSsrc, userId);
    }
    debugLog("voice.gateway.incoming_video_stream", {
      streamKey: this.data.streamReceive?.streamKey ?? null,
      userId,
      videoSsrc: this.videoSsrc,
      videoRtxSsrc: this.videoRtxSsrc,
      quality: stream.quality ?? null,
      rid: stream.rid ?? null,
    });
    if (this.receiveOnlyStream) this.sendMediaSinkWants(stream.ssrc);
  }

  private pickIncomingVideoStream(streams: unknown, userId: string | null, fallbackSsrc: number | null, fallbackRtxSsrc: number | null): { ssrc: number; rtxSsrc?: number; quality?: number; rid?: string } | null {
    const receive = this.data.streamReceive;
    if (!receive) return null;
    if (receive.ownerUserId && userId && userId !== receive.ownerUserId) return null;

    if (Array.isArray(streams)) {
      const candidates = streams.filter(isObject);
      const preferred = candidates.find((candidate) => (candidate.type === "screen" || candidate.type === "video") && (candidate.rid === "100" || candidate.quality === 100))
        ?? candidates.find((candidate) => candidate.type === "screen" || candidate.type === "video")
        ?? candidates[0];
      if (preferred && typeof preferred.ssrc === "number") {
        return {
          ssrc: preferred.ssrc,
          rtxSsrc: typeof preferred.rtx_ssrc === "number" ? preferred.rtx_ssrc : undefined,
          quality: typeof preferred.quality === "number" ? preferred.quality : undefined,
          rid: typeof preferred.rid === "string" ? preferred.rid : undefined,
        };
      }
    }

    return fallbackSsrc === null ? null : { ssrc: fallbackSsrc, rtxSsrc: fallbackRtxSsrc ?? undefined };
  }

  private rememberReadyVideoStream(streams: unknown): void {
    if (!Array.isArray(streams)) return;
    const stream = streams.find((candidate) => isObject(candidate) && (candidate.type === "screen" || candidate.type === "video") && (candidate.rid === "100" || candidate.quality === 100))
      ?? streams.find((candidate) => isObject(candidate) && (candidate.type === "screen" || candidate.type === "video"));
    if (!isObject(stream)) return;
    if (typeof stream.ssrc === "number") this.videoSsrc = stream.ssrc;
    if (typeof stream.rtx_ssrc === "number") this.videoRtxSsrc = stream.rtx_ssrc;
    debugLog("voice.gateway.video_stream", { videoSsrc: this.videoSsrc, videoRtxSsrc: this.videoRtxSsrc, rid: stream.rid ?? null, quality: stream.quality ?? null });
    if (this.receiveOnlyStream && this.videoSsrc !== null) this.sendMediaSinkWants(this.videoSsrc);
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
    this.clearHeartbeatTimer();
    this.heartbeatIntervalMs = Math.max(1_000, interval);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    if (this.connectMode === "resume") this.resume();
    else this.identify();
  }

  private async handleReady(data: unknown): Promise<void> {
    if (!isObject(data)) return;
    const ip = typeof data.ip === "string" ? data.ip : null;
    const port = typeof data.port === "number" ? data.port : Number(data.port);
    const ssrc = typeof data.ssrc === "number" ? data.ssrc : null;
    const modes = Array.isArray(data.modes) ? data.modes.filter((mode): mode is string => typeof mode === "string") : [];
    this.rememberReadyVideoStream(data.streams);
    if (!ip || !Number.isFinite(port) || !ssrc) {
      debugLog("voice.gateway.ready_invalid", { hasIp: Boolean(ip), port, hasSsrc: Boolean(ssrc), modeCount: modes.length });
      this.rejectReady(new Error("Discord voice gateway sent incomplete UDP details."));
      return;
    }

    this.connectStage = "udp_discovery";
    debugLog("voice.gateway.ready", { ip, port, ssrc, modeCount: modes.length, modes, streams: this.usesWebRtcVideo && Array.isArray(data.streams) ? data.streams : undefined, experiments: this.usesWebRtcVideo && Array.isArray(data.experiments) ? data.experiments : undefined });
    this.ssrc = ssrc;
    if (this.usesWebRtcVideo) {
      this.send({ op: 16, d: {} });
      this.startWebRtcSelectProtocol(ssrc);
      return;
    }
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
    if (this.data.video && isObject(data) && typeof data.sdp === "string") {
      await this.handleWebRtcSessionDescription(data);
      return;
    }
    if (!isObject(data) || !Array.isArray(data.secret_key) || typeof data.mode !== "string") {
      debugLog("voice.gateway.session_description_invalid", { hasSecretKey: isObject(data) && Array.isArray(data.secret_key), mode: isObject(data) ? data.mode : null });
      this.rejectReady(new Error("Discord voice gateway sent an invalid session description."));
      return;
    }

    this.connectStage = "session_description";
    this.mediaSessionId = typeof data.media_session_id === "string" ? data.media_session_id : null;
    this.videoCodec = typeof data.video_codec === "string" ? data.video_codec : null;
    this.selectedMode = data.mode;
    this.secretKey = Buffer.from(data.secret_key.filter((byte): byte is number => typeof byte === "number"));
    debugLog("voice.gateway.session_description", { mode: this.selectedMode, mediaSessionId: this.mediaSessionId, audioCodec: typeof data.audio_codec === "string" ? data.audio_codec : null, videoCodec: this.videoCodec, daveProtocolVersion: typeof data.dave_protocol_version === "number" ? data.dave_protocol_version : null });
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
        sendSpeakingFlags: (flags) => this.sendSpeakingFlags(flags),
        videoSsrc: this.videoSsrc ?? undefined,
        videoRtxSsrc: this.videoRtxSsrc ?? undefined,
        videoPayloadType: VIDEO_PAYLOAD_TYPE_H264,
        sendVideo: () => this.sendVideo(),
        encodeOutgoingOpus: (payload) => this.usesWebRtcVideo && !this.dave.ready ? null : this.dave.encodeOutgoingOpus(payload),
        encodeOutgoingVideo: (payload, codec) => this.usesWebRtcVideo && !this.dave.ready ? null : this.dave.encodeOutgoingVideo(payload, codec),
        decodeIncomingOpus: (ssrc, payload) => this.dave.decodeIncomingOpus(this.resolveIncomingSsrcUserId(ssrc), payload),
        shouldDropIncomingAudio: (ssrc) => this.shouldDropIncomingAudio(ssrc),
        onIncomingAudio: (ssrc) => this.handleIncomingAudio(ssrc),
        onError: (error) => this.reportError(error),
      };
      this.audioContext = audioContext;
      try {
        await this.audio.start(audioContext);
      } catch (error) {
        const startError = asError(error, "Voice audio backend failed to start.");
        if (this.data.video) {
          this.rejectReady(startError);
          this.disconnect();
          return;
        }
        this.reportError(startError);
      }
    }

    this.connectStage = "ready";
    this.resolveReady();
  }

  private resolveIncomingSsrcUserId(ssrc: number): string | null {
    const mappedUserId = this.ssrcToUserId.get(ssrc);
    if (mappedUserId) return mappedUserId;
    const streamOwnerUserId = this.data.streamReceive?.ownerUserId;
    if (streamOwnerUserId) {
      this.rememberAuthoritativeAudioSsrc(ssrc, streamOwnerUserId);
      debugLog("voice.playback.ssrc_map", { ssrc, userId: streamOwnerUserId, source: "stream_owner_fallback" });
      return streamOwnerUserId;
    }
    if (this.remoteUserIds.size !== 1) {
      debugLog("voice.playback.ssrc_unmapped", { ssrc, remoteUserIds: [...this.remoteUserIds] });
      return null;
    }
    const [inferredUserId] = [...this.remoteUserIds];
    this.ssrcToUserId.set(ssrc, inferredUserId);
    debugLog("voice.playback.ssrc_map", { ssrc, userId: inferredUserId, source: "single_remote_fallback" });
    return inferredUserId;
  }

  private rememberAuthoritativeAudioSsrc(ssrc: number, userId: string): string | undefined {
    const previous = this.ssrcToUserId.get(ssrc);
    const resetTimer = this.remoteSsrcVolumeResetTimers.get(ssrc);
    if (resetTimer) clearTimeout(resetTimer);
    this.remoteSsrcVolumeResetTimers.delete(ssrc);
    this.staleVolumeAudioSsrcs.delete(ssrc);
    this.ssrcToUserId.set(ssrc, userId);
    this.authoritativeAudioSsrcs.add(ssrc);
    this.audio.setRemoteSsrcVolume?.(ssrc, this.remoteUserVolumes.get(userId) ?? DEFAULT_REMOTE_USER_VOLUME_PERCENT);
    return previous;
  }

  private scheduleRemoteSsrcVolumeReset(ssrc: number): void {
    const existing = this.remoteSsrcVolumeResetTimers.get(ssrc);
    if (existing) clearTimeout(existing);
    this.staleVolumeAudioSsrcs.add(ssrc);
    const timer = setTimeout(() => {
      this.remoteSsrcVolumeResetTimers.delete(ssrc);
      if (this.authoritativeAudioSsrcs.has(ssrc) || !this.staleVolumeAudioSsrcs.delete(ssrc)) return;
      this.audio.setRemoteSsrcVolume?.(ssrc, DEFAULT_REMOTE_USER_VOLUME_PERCENT);
    }, REMOTE_SSRC_VOLUME_RESET_DELAY_MS);
    timer.unref?.();
    this.remoteSsrcVolumeResetTimers.set(ssrc, timer);
  }

  private shouldDropIncomingAudio(ssrc: number): boolean {
    if (!this.authoritativeAudioSsrcs.has(ssrc) && this.staleVolumeAudioSsrcs.has(ssrc)) return true;
    const userId = this.resolveIncomingSsrcUserId(ssrc);
    if (!userId) return this.remoteUserVolumes.size > 0;
    if (userId === this.data.userId) return false;
    if (this.remoteMutedUserIds.has(userId)) return true;
    if (this.authoritativeAudioSsrcs.has(ssrc)) return false;
    return (this.remoteUserVolumes.get(userId) ?? DEFAULT_REMOTE_USER_VOLUME_PERCENT) !== DEFAULT_REMOTE_USER_VOLUME_PERCENT;
  }

  private handleIncomingAudio(ssrc: number): void {
    const userId = this.resolveIncomingSsrcUserId(ssrc);
    if (!userId || userId === this.data.userId || this.remoteMutedUserIds.has(userId)) return;
    this.callbacks.onSpeakingChange?.(userId, true);
  }

  private identify(): void {
    this.connectStage = "identified";
    const maxDaveProtocolVersion = this.data.maxDaveProtocolVersion ?? this.dave.advertisedProtocolVersion;
    debugLog("voice.gateway.identify", { channelId: this.data.channelId, guildId: this.data.guildId, hasSessionId: Boolean(this.data.sessionId), video: this.usesWebRtcVideo, receiveStream: this.data.streamReceive?.streamKey ?? null, maxDaveProtocolVersion });
    this.send(buildVoiceIdentifyPayload(this.data, maxDaveProtocolVersion));
  }

  private resume(): void {
    this.connectStage = "resuming";
    debugLog("voice.gateway.resume", { channelId: this.data.channelId, guildId: this.data.guildId, seqAck: this.seq });
    this.send(buildVoiceResumePayload(this.data, this.seq));
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
            ...(this.usesWebRtcVideo ? [{ name: "H264", type: "video", priority: 1000, payload_type: VIDEO_PAYLOAD_TYPE_H264, rtx_payload_type: VIDEO_RTX_PAYLOAD_TYPE_H264, encode: !this.receiveOnlyStream, decode: true }] : []),
        ],
      },
    });
  }

  private startWebRtcSelectProtocol(audioSsrc: number): void {
    this.connectStage = "webrtc_offer";
    const direction = this.receiveOnlyStream ? "RecvOnly" : "SendRecv";
    const audio = new Audio("0", direction);
    const video = new Video("1", direction);
    audio.addOpusCodec(OPUS_PAYLOAD_TYPE);
    video.addH264Codec(VIDEO_PAYLOAD_TYPE_H264);
    video.addRTXCodec(VIDEO_RTX_PAYLOAD_TYPE_H264, VIDEO_PAYLOAD_TYPE_H264, 90_000);

    const pc = new PeerConnection("", { iceServers: ["stun:stun.l.google.com:19302"] });
    this.webRtc = pc;
    const audioTrack = pc.addTrack(audio);
    const videoTrack = pc.addTrack(video);
    this.webRtcAudioTrack = audioTrack;
    this.webRtcVideoTrack = videoTrack;
    pc.onStateChange((state) => debugLog("voice.gateway.webrtc_state", { state }));
    audioTrack.onOpen(() => debugLog("voice.gateway.webrtc_track_open", { mid: safeTrackString(audioTrack, "mid"), type: safeTrackString(audioTrack, "type") }));
    audioTrack.onClosed(() => debugLog("voice.gateway.webrtc_track_closed", { mid: "0", type: "audio" }));
    audioTrack.onError((error) => debugLog("voice.gateway.webrtc_track_error", { mid: "0", type: "audio", error }));
    videoTrack.onOpen(() => debugLog("voice.gateway.webrtc_track_open", { mid: safeTrackString(videoTrack, "mid"), type: safeTrackString(videoTrack, "type") }));
    videoTrack.onClosed(() => debugLog("voice.gateway.webrtc_track_closed", { mid: "1", type: "video" }));
    videoTrack.onError((error) => debugLog("voice.gateway.webrtc_track_error", { mid: "1", type: "video", error }));
    pc.onTrack((track) => this.registerIncomingWebRtcTrack(track));
    pc.onLocalDescription((sdp) => {
      if (this.webRtc !== pc || this.disconnected) return;
      const rtcConnectionId = randomUUID();
      debugLog("voice.gateway.select_protocol_webrtc", { rtcConnectionId, audioSsrc, videoSsrc: this.videoSsrc, receiveOnly: this.receiveOnlyStream, audioTrackOpen: safeTrackOpen(audioTrack), videoTrackOpen: safeTrackOpen(videoTrack) });
      this.connectStage = "select_protocol";
      this.send({
        op: 1,
        d: {
          protocol: "webrtc",
          codecs: [
            { name: "opus", type: "audio", priority: 1000, payload_type: OPUS_PAYLOAD_TYPE, clockRate: 48_000, channels: 2 },
            { name: "H264", type: "video", priority: 1000, payload_type: VIDEO_PAYLOAD_TYPE_H264, rtx_payload_type: VIDEO_RTX_PAYLOAD_TYPE_H264, clockRate: 90_000, encode: true, decode: true },
          ],
          data: sdp,
          sdp,
          rtc_connection_id: rtcConnectionId,
        },
      });
    });
    pc.setLocalDescription();
  }

  private async handleWebRtcSessionDescription(data: Record<string, unknown>): Promise<void> {
    const sdp = typeof data.sdp === "string" ? data.sdp : "";
    this.connectStage = "session_description";
    this.mediaSessionId = typeof data.media_session_id === "string" ? data.media_session_id : null;
    this.videoCodec = typeof data.video_codec === "string" ? data.video_codec : "H264";
    this.selectedMode = "webrtc";
    debugLog("voice.gateway.session_description", { mode: "webrtc", mediaSessionId: this.mediaSessionId, audioCodec: typeof data.audio_codec === "string" ? data.audio_codec : null, videoCodec: this.videoCodec, daveProtocolVersion: typeof data.dave_protocol_version === "number" ? data.dave_protocol_version : null });
    this.dave.handleSessionDescription(data);

    if (!this.webRtc || this.ssrc === null || (!this.receiveOnlyStream && this.videoSsrc === null)) {
      this.rejectReady(new Error("Discord voice WebRTC session became ready before media tracks were initialized."));
      return;
    }
    if (!this.receiveOnlyStream) this.configureWebRtcPacketizers(this.ssrc, this.videoSsrc as number);
    this.webRtc.setRemoteDescription(buildDiscordWebRtcAnswer(sdp, { receiveOnly: this.receiveOnlyStream }), "answer");

    if (!this.receiveOnlyStream && !this.audioStarted) {
      this.audioStarted = true;
      const audioContext: VoiceAudioContext = {
        udp: createSocket("udp4"),
        mode: "webrtc",
        secretKey: Buffer.alloc(0),
        ssrc: this.ssrc,
        selfMute: this.selfMute,
        selfDeaf: this.selfDeaf,
        sendSpeaking: (speaking) => this.sendSpeaking(speaking),
        sendSpeakingFlags: (flags) => this.sendSpeakingFlags(flags),
        videoSsrc: this.videoSsrc ?? undefined,
        videoRtxSsrc: this.videoRtxSsrc ?? undefined,
        videoPayloadType: VIDEO_PAYLOAD_TYPE_H264,
        sendVideo: () => this.sendVideo(),
        sendOpusFrame: (payload, frameDurationMs) => this.sendWebRtcAudioFrame(payload, frameDurationMs),
        sendEncodedVideoFrame: (payload, frameDurationMs, keyframe) => this.sendWebRtcVideoFrame(payload, frameDurationMs, keyframe),
        encodeOutgoingOpus: (payload) => this.usesWebRtcVideo && !this.dave.ready ? null : this.dave.encodeOutgoingOpus(payload),
        encodeOutgoingVideo: (payload, codec) => this.usesWebRtcVideo && !this.dave.ready ? null : this.dave.encodeOutgoingVideo(payload, codec),
        onError: (error) => this.reportError(error),
      };
      this.audioContext = audioContext;
      try {
        await this.audio.start(audioContext);
      } catch (error) {
        const startError = asError(error, "Voice audio backend failed to start.");
        this.rejectReady(startError);
        this.disconnect();
        return;
      }
    }

    this.connectStage = "ready";
    this.resolveReady();
  }

  private configureWebRtcPacketizers(audioSsrc: number, videoSsrc: number): void {
    const audioConfig = new RtpPacketizationConfig(audioSsrc, "", OPUS_PAYLOAD_TYPE, 48_000);
    audioConfig.playoutDelayId = 5;
    audioConfig.playoutDelayMin = 0;
    audioConfig.playoutDelayMax = 1;
    const audioPacketizer = new RtpPacketizer(audioConfig);
    audioPacketizer.addToChain(new RtcpSrReporter(audioConfig));
    audioPacketizer.addToChain(new RtcpNackResponder());
    this.webRtcAudioPacketizer = audioPacketizer;
    this.webRtcAudioTrack?.setMediaHandler(audioPacketizer);

    const videoConfig = new RtpPacketizationConfig(videoSsrc, "", VIDEO_PAYLOAD_TYPE_H264, 90_000);
    videoConfig.playoutDelayId = 5;
    videoConfig.playoutDelayMin = 0;
    videoConfig.playoutDelayMax = 10;
    const videoPacketizer = new H264RtpPacketizer("StartSequence", videoConfig);
    videoPacketizer.addToChain(new RtcpSrReporter(videoConfig));
    videoPacketizer.addToChain(new RtcpNackResponder());
    videoPacketizer.addToChain(new PacingHandler(25 * 1000 * 1000, 1));
    this.webRtcVideoPacketizer = videoPacketizer;
    this.webRtcVideoTrack?.setMediaHandler(videoPacketizer);
  }

  private registerIncomingWebRtcTrack(track: Track): void {
    const trackMid = safeTrackString(track, "mid");
    const trackType = safeTrackString(track, "type");
    debugLog("voice.gateway.webrtc_track", { mid: trackMid, type: trackType, streamKey: this.data.streamReceive?.streamKey ?? null });
    track.onMessage((message) => {
      const packet = Buffer.isBuffer(message) ? message : Buffer.from(message);
      const parsed = parsePlainRtpPacket(packet);
      if (!parsed) {
        debugLog("voice.gateway.webrtc_track_packet_invalid", { mid: trackMid, type: trackType, bytes: packet.length });
        return;
      }
      const mediaType = incomingMediaType(parsed.payloadType, trackType);
      const userId = this.resolveIncomingSsrcUserId(parsed.ssrc);
      this.callbacks.onIncomingRtp?.({
        mediaType,
        packet,
        payload: parsed.payload,
        payloadType: parsed.payloadType,
        sequence: parsed.sequence,
        timestamp: parsed.timestamp,
        ssrc: parsed.ssrc,
        userId,
        streamKey: this.data.streamReceive?.streamKey ?? null,
        trackMid,
        trackType,
      });
    });
  }

  private sendMediaSinkWants(videoSsrc: number): void {
    const receive = this.data.streamReceive;
    if (!receive || !Number.isFinite(videoSsrc)) return;
    const quality = receive.quality ?? 100;
    const pixelCount = receive.pixelCount ?? 1920 * 1080;
    debugLog("voice.gateway.media_sink_wants", { streamKey: receive.streamKey, videoSsrc, quality, pixelCount });
    this.send(buildMediaSinkWantsPayload(videoSsrc, { quality }));
  }

  private sendWebRtcAudioFrame(payload: Buffer, frameDurationMs: number): void {
    if (!this.webRtcAudioPacketizer || !this.webRtcAudioTrack || this.webRtc?.state() !== "connected") return;
    this.webRtcAudioTrack.sendMessageBinary(payload);
    this.webRtcAudioPacketizer.rtpConfig.timestamp += Math.round((frameDurationMs * this.webRtcAudioPacketizer.rtpConfig.clockRate) / 1000);
  }

  private sendWebRtcVideoFrame(payload: Buffer, frameDurationMs: number, keyframe = false): void {
    if (!this.webRtcVideoPacketizer || !this.webRtcVideoTrack || this.webRtc?.state() !== "connected") return;
    const timestampIncrement = Math.round((frameDurationMs * this.webRtcVideoPacketizer.rtpConfig.clockRate) / 1000);
    let sent = false;
    try {
      sent = this.webRtcVideoTrack.sendMessageBinary(payload);
    } catch (error) {
      this.webRtcVideoFramesDropped += 1;
      this.webRtcVideoPacketizer.rtpConfig.timestamp += timestampIncrement;
      debugLog("voice.gateway.webrtc_video_send_error", { message: error instanceof Error ? error.message : String(error), keyframe, payloadBytes: payload.length });
      this.maybeLogWebRtcVideoStats();
      return;
    }
    this.webRtcVideoPacketizer.rtpConfig.timestamp += timestampIncrement;
    this.webRtcVideoFramesSent += 1;
    if (!sent) this.webRtcVideoSendFalseFrames += 1;
    this.webRtcVideoBytesSent += payload.length;
    this.maybeLogWebRtcVideoStats();
  }

  private maybeLogWebRtcVideoStats(): void {
    const now = Date.now();
    if (now - this.webRtcLastVideoStatsAt < WEBRTC_VIDEO_STATS_INTERVAL_MS) return;
    const elapsedSeconds = this.webRtcLastVideoStatsAt === 0 ? 0 : (now - this.webRtcLastVideoStatsAt) / 1000;
    const sentDelta = this.webRtcVideoFramesSent - this.webRtcLastVideoStatsFrames;
    const droppedDelta = this.webRtcVideoFramesDropped - this.webRtcLastVideoStatsDropped;
    const sendFalseDelta = this.webRtcVideoSendFalseFrames - this.webRtcLastVideoStatsSendFalse;
    const peerBytesSent = safePeerBytesSent(this.webRtc);
    const peerBytesDelta = peerBytesSent === null ? null : peerBytesSent - this.webRtcLastPeerBytesSent;
    const selectedCandidatePair = safeSelectedCandidatePair(this.webRtc);
    debugLog("voice.gateway.webrtc_video_stats", {
      submittedFrames: this.webRtcVideoFramesSent,
      droppedFrames: this.webRtcVideoFramesDropped,
      sendFalseFrames: this.webRtcVideoSendFalseFrames,
      submittedFps: elapsedSeconds > 0 ? sentDelta / elapsedSeconds : null,
      droppedFps: elapsedSeconds > 0 ? droppedDelta / elapsedSeconds : null,
      sendFalseFps: elapsedSeconds > 0 ? sendFalseDelta / elapsedSeconds : null,
      bufferedBytes: safeTrackBufferedAmount(this.webRtcVideoTrack),
      submittedVideoBytes: this.webRtcVideoBytesSent,
      peerBytesSent,
      peerBitrateKbps: elapsedSeconds > 0 && peerBytesDelta !== null ? (peerBytesDelta * 8) / elapsedSeconds / 1000 : null,
      peerRttMs: safePeerRttMs(this.webRtc),
      audioTrackOpen: safeTrackOpen(this.webRtcAudioTrack),
      videoTrackOpen: safeTrackOpen(this.webRtcVideoTrack),
      localCandidateType: selectedCandidatePair?.local.type ?? null,
      remoteCandidateType: selectedCandidatePair?.remote.type ?? null,
    });
    this.webRtcLastVideoStatsAt = now;
    this.webRtcLastVideoStatsFrames = this.webRtcVideoFramesSent;
    this.webRtcLastVideoStatsDropped = this.webRtcVideoFramesDropped;
    this.webRtcLastVideoStatsSendFalse = this.webRtcVideoSendFalseFrames;
    if (peerBytesSent !== null) this.webRtcLastPeerBytesSent = peerBytesSent;
  }

  private sendSpeaking(speaking: boolean): void {
    if (this.ssrc === null) return;
    this.speaking = speaking;
    this.callbacks.onSpeakingChange?.(this.data.userId, speaking);
    this.send({
      op: 5,
      d: {
        speaking: speaking ? SPEAKING_FLAG_VOICE : 0,
        delay: 0,
        ssrc: this.ssrc,
      },
    });
  }

  private sendSpeakingFlags(flags: number): void {
    if (this.ssrc === null) return;
    this.speaking = flags !== 0;
    this.callbacks.onSpeakingChange?.(this.data.userId, (flags & SPEAKING_FLAG_VOICE) !== 0);
    this.send({ op: 5, d: { speaking: flags, delay: 0, ssrc: this.ssrc } });
  }

  private sendVideo(): void {
    if (this.ssrc === null || this.videoSsrc === null) return;
    const rtxSsrc = this.videoRtxSsrc ?? (this.videoSsrc + 1);
    const stream = {
      type: "screen",
      rid: "100",
      ssrc: this.videoSsrc,
      rtx_ssrc: rtxSsrc,
      quality: 100,
      active: true,
      max_bitrate: 10_000_000,
      max_framerate: 30,
      max_resolution: { type: "fixed", width: 1920, height: 1080 },
    };
    debugLog("voice.gateway.video", { audioSsrc: this.ssrc, videoSsrc: this.videoSsrc, rtxSsrc, streamType: stream.type, rid: stream.rid });
    this.send({
      op: 12,
      d: {
        audio_ssrc: this.ssrc,
        video_ssrc: this.videoSsrc,
        rtx_ssrc: rtxSsrc,
        streams: [stream],
      },
    });
    this.sendSpeakingFlags(SPEAKING_FLAG_SOUNDSHARE);
  }

  private sendHeartbeat(): void {
    const now = Date.now();
    if (this.heartbeatAckPending && this.lastHeartbeatSentAt && this.heartbeatIntervalMs > 0 && now - this.lastHeartbeatSentAt > this.heartbeatIntervalMs * HEARTBEAT_ACK_GRACE_MULTIPLIER) {
      debugLog("voice.gateway.heartbeat_missed", { stage: this.connectStage, msSinceLastHeartbeat: now - this.lastHeartbeatSentAt, seqAck: this.seq });
      if (!this.resumeInProgress && this.readyReject === null) {
        this.startResume(new VoiceGatewayCloseError(1006, "Heartbeat ACK timed out."));
      }
      return;
    }
    const nonce = now;
    this.lastHeartbeatNonce = nonce;
    this.lastHeartbeatSentAt = now;
    this.heartbeatAckPending = true;
    this.send({ op: 3, d: { t: nonce, seq_ack: this.seq } });
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
    if (this.resumeInProgress) {
      this.finishResumeFailed(error);
      return;
    }
    if (!this.readyReject && this.shouldResumeAfterClose(error)) {
      this.startResume(error);
      return;
    }
    if (this.readyReject) {
      this.rejectReady(error, { report: false });
    } else if (this.callbacks.onClose) {
      this.callbacks.onClose(error);
    } else {
      this.reportError(error);
    }
    this.disconnect();
  };

  private shouldResumeAfterClose(error: VoiceGatewayCloseError): boolean {
    if (!this.data.sessionId || !this.data.token || !this.data.guildId) return false;
    if (this.connectStage !== "ready") return false;
    return error.code === 1006 || error.code === 4013 || error.code === 4015 || /connection ended|abnormal|heartbeat ack timed out|webrtc crashed|voice server crashed/i.test(error.closeReason);
  }

  private startResume(cause: VoiceGatewayCloseError): void {
    if (this.disconnected || this.resumeInProgress) return;
    this.resumeInProgress = true;
    this.resumeCause = cause;
    this.connectMode = "resume";
    this.connectStage = "resume_connecting";
    debugLog("voice.gateway.resume_start", { code: cause.code, reason: cause.closeReason, seqAck: this.seq, endpoint: this.safeEndpoint() });

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.removeWebSocketListeners(ws);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch {}
      }
    }
    this.clearHeartbeatTimer();
    this.startConnectTimer("resume");
    void this.openWebSocket().catch((error) => {
      if (this.disconnected || !this.resumeInProgress) return;
      this.finishResumeFailed(asError(error, "Failed to open Discord voice gateway resume websocket."));
    });
  }

  private finishResumeFailed(error: Error): void {
    if (this.disconnected) return;
    const cause = this.resumeCause;
    debugLog("voice.gateway.resume_failed", { error: error.message, originalCode: cause?.code ?? null, originalReason: cause?.closeReason ?? null });
    this.resumeInProgress = false;
    this.resumeCause = null;
    const reported = error instanceof VoiceGatewayCloseError && error.code === 4006
      ? error
      : cause ?? (error instanceof VoiceGatewayCloseError ? error : new VoiceGatewayCloseError(1006, error.message));
    if (this.callbacks.onClose) this.callbacks.onClose(reported);
    else this.reportError(reported);
    this.disconnect();
  }

  private handleError = (): void => {
    if (this.disconnected) return;
    const error = new Error("Discord voice gateway connection error.");
    debugLog("voice.gateway.error", { stage: this.connectStage, endpoint: this.safeEndpoint() });
    if (this.resumeInProgress) {
      this.finishResumeFailed(error);
      return;
    }
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

function safePeerBytesSent(peerConnection: NodePeerConnection | null): number | null {
  if (!peerConnection) return null;
  try {
    const bytes = peerConnection.bytesSent();
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function safePeerRttMs(peerConnection: NodePeerConnection | null): number | null {
  if (!peerConnection) return null;
  try {
    const rtt = peerConnection.rtt();
    return Number.isFinite(rtt) ? rtt * 1000 : null;
  } catch {
    return null;
  }
}

function safeSelectedCandidatePair(peerConnection: NodePeerConnection | null): { local: { type?: string }; remote: { type?: string } } | null {
  if (!peerConnection) return null;
  try {
    return peerConnection.getSelectedCandidatePair();
  } catch {
    return null;
  }
}

function safeTrackString(track: Track, method: "mid" | "type"): string | undefined {
  try {
    const value = track[method]();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeTrackOpen(track: Track | null): boolean | null {
  if (!track) return null;
  try {
    return track.isOpen();
  } catch {
    return null;
  }
}

function safeTrackBufferedAmount(track: Track | null): number | null {
  if (!track) return null;
  try {
    return track.bufferedAmount();
  } catch {
    return null;
  }
}

function incomingMediaType(payloadType: number, trackType: string | undefined): "audio" | "video" | "rtx" | "unknown" {
  if (payloadType === OPUS_PAYLOAD_TYPE || trackType === "audio") return "audio";
  if (payloadType === VIDEO_RTX_PAYLOAD_TYPE_H264) return "rtx";
  if (payloadType === VIDEO_PAYLOAD_TYPE_H264 || trackType === "video") return "video";
  return "unknown";
}

export function buildDiscordWebRtcAnswer(sdp: string, options: { receiveOnly?: boolean } = {}): string {
  let ip = "";
  let port = "";
  let iceUsername = "";
  let icePassword = "";
  let fingerprint = "";
  let candidate = "";
  for (const rawLine of sdp.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("c=")) ip = line;
    else if (line.startsWith("a=rtcp:")) port = line.slice("a=rtcp:".length).split(/\s+/, 1)[0] ?? "";
    else if (line.startsWith("a=ice-ufrag")) iceUsername = line;
    else if (line.startsWith("a=ice-pwd")) icePassword = line;
    else if (line.startsWith("a=fingerprint")) fingerprint = line;
    else if (line.startsWith("a=candidate")) candidate = line;
  }
  // This SDP is installed as the *remote* answer to our local offer.  When we
  // are publishing a stream Discord is a receiver, so the remote answer must be
  // recvonly.  Marking it inactive makes libdatachannel keep the local tracks
  // effectively closed: Track.send() returns false for every frame, which looks
  // like intermittent/black stream drops to viewers even though the encoder is
  // producing frames.
  const remoteDirection = options.receiveOnly ? "sendonly" : "recvonly";
  const audioSection = `
m=audio ${port} UDP/TLS/RTP/SAVPF ${OPUS_PAYLOAD_TYPE}
${ip}
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=setup:passive
a=mid:0
a=maxptime:60
a=${remoteDirection}
${iceUsername}
${icePassword}
${fingerprint}
${candidate}
a=rtcp-mux
a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/48000/2
a=fmtp:${OPUS_PAYLOAD_TYPE} minptime=10;useinbandfec=1;usedtx=1
a=rtcp-fb:${OPUS_PAYLOAD_TYPE} transport-cc
a=rtcp-fb:${OPUS_PAYLOAD_TYPE} nack
a=ice-lite
`.trim();
  const videoSection = `
m=video ${port} UDP/TLS/RTP/SAVPF ${VIDEO_PAYLOAD_TYPE_H264} ${VIDEO_RTX_PAYLOAD_TYPE_H264}
${ip}
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:14 urn:ietf:params:rtp-hdrext:toffset
a=extmap:13 urn:3gpp:video-orientation
a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay
a=setup:passive
a=mid:1
a=${remoteDirection}
${iceUsername}
${icePassword}
${fingerprint}
${candidate}
a=rtcp-mux
a=ice-lite
a=rtpmap:${VIDEO_PAYLOAD_TYPE_H264} H264/90000
a=rtpmap:${VIDEO_RTX_PAYLOAD_TYPE_H264} rtx/90000
a=fmtp:${VIDEO_RTX_PAYLOAD_TYPE_H264} apt=${VIDEO_PAYLOAD_TYPE_H264}
a=rtcp-fb:${VIDEO_PAYLOAD_TYPE_H264} ccm fir
a=rtcp-fb:${VIDEO_PAYLOAD_TYPE_H264} nack
a=rtcp-fb:${VIDEO_PAYLOAD_TYPE_H264} nack pli
a=rtcp-fb:${VIDEO_PAYLOAD_TYPE_H264} goog-remb
a=rtcp-fb:${VIDEO_PAYLOAD_TYPE_H264} transport-cc
`.trim();
  return [audioSection, videoSection].join("\n");
}
