import type { Socket as UdpSocket } from "dgram";
import type { LocalAudioVolumes, NoiseSuppressionMode } from "../volume";

export type VoiceConnectionState = "idle" | "signaling" | "connecting" | "ready" | "ended" | "error";

export interface VoiceStateUpdate {
  userId: string;
  channelId: string | null;
  guildId: string | null;
  sessionId: string | null;
  displayName?: string;
  roleIds?: string[];
  selfMute: boolean;
  selfDeaf: boolean;
  selfStream?: boolean;
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
  video?: boolean;
  streamReceive?: VoiceGatewayStreamReceive;
  daveChannelId?: string;
  maxDaveProtocolVersion?: number;
}

export interface VoiceGatewayStreamReceive {
  streamKey: string;
  ownerUserId?: string | null;
  quality?: number;
  pixelCount?: number;
}

export interface IncomingVoiceRtpPacket {
  mediaType: "audio" | "video" | "rtx" | "unknown";
  packet: Buffer;
  payload: Buffer;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  userId: string | null;
  streamKey: string | null;
  trackMid?: string;
  trackType?: string;
}

export interface VoiceGatewayOutboundStream {
  type: "screen" | "video";
  rid: string;
  quality: number;
  ssrc?: number;
  rtxSsrc?: number;
  active?: boolean;
  maxBitrate?: number;
  maxFramerate?: number;
  maxResolution?: { width: number; height: number };
}

export interface VoiceGatewayConnection {
  connect(): Promise<void>;
  disconnect(): void;
  setSelfVoiceState?(state: { selfMute: boolean; selfDeaf: boolean }): void;
  setRemoteUserMuted?(userId: string, muted: boolean): void;
  setRemoteUserVolume?(userId: string, volumePercent: number): void;
  setLocalVolumes?(volumes: LocalAudioVolumes): void;
  setNoiseSuppression?(mode: NoiseSuppressionMode): void;
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
  /** Remote users confirmed present by the active voice-gateway session. */
  onParticipantsConnect?: (userIds: string[]) => void;
  /** A remote user confirmed departed by the active voice-gateway session. */
  onParticipantDisconnect?: (userId: string) => void;
  onIncomingRtp?: (packet: IncomingVoiceRtpPacket) => void;
}

export interface VoiceCallSession {
  target: VoiceCallTarget;
  state: VoiceConnectionState;
  gateway: VoiceGatewayConnection | null;
  startedAt: number;
  selfMute: boolean;
  selfDeaf: boolean;
  sessionId?: string | null;
  lastJoinData?: VoiceGatewayJoinData | null;
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
  localVolumes?: LocalAudioVolumes;
  noiseSuppression?: NoiseSuppressionMode;
  createGatewayConnection?: (data: VoiceGatewayJoinData, callbacks: VoiceGatewayConnectionCallbacks) => VoiceGatewayConnection;
  fetchPreferredRegions?: () => Promise<string[]>;
  ringRecipients?: (channelId: string, recipientIds: string[]) => Promise<void>;
  retryDelayMs?: number;
  voiceReadyTimeoutMs?: number;
  recoveryAttempts?: number;
  onStateChange?: (session: VoiceCallSession | null) => void;
  onSpeakingChange?: (userId: string, speaking: boolean) => void;
  onParticipantsConnect?: (userIds: string[]) => void;
  onParticipantDisconnect?: (userId: string) => void;
  onError?: (error: Error) => void;
}

export interface PendingVoiceJoin {
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
  sendSpeakingFlags?: (flags: number) => void;
  videoSsrc?: number;
  videoRtxSsrc?: number;
  videoPayloadType?: number;
  sendVideo?: () => void;
  sendOpusFrame?: (payload: Buffer, frameDurationMs: number) => void;
  sendEncodedVideoFrame?: (payload: Buffer, frameDurationMs: number, keyframe?: boolean) => void;
  encodeOutgoingOpus?: (payload: Buffer) => Buffer | null;
  encodeOutgoingVideo?: (payload: Buffer, codec?: "H264" | "VP8" | "VP9" | "H265" | "AV1") => Buffer | null;
  decodeIncomingOpus?: (ssrc: number, payload: Buffer) => Buffer | null;
  shouldDropIncomingAudio?: (ssrc: number) => boolean;
  onIncomingAudio?: (ssrc: number) => void;
  onError: (error: Error) => void;
}

export interface VoiceAudioBackend {
  start(context: VoiceAudioContext): Promise<void> | void;
  stop(): void;
  setRemoteSsrcVolume?(ssrc: number, volumePercent: number): void;
  setLocalVolumes?(volumes: LocalAudioVolumes): void;
  setNoiseSuppression?(mode: NoiseSuppressionMode): void;
}

export class NoopVoiceAudioBackend implements VoiceAudioBackend {
  start(): void {
    // Intentionally no-op. Useful for tests and unsupported platforms.
  }

  stop(): void {
    // Intentionally no-op.
  }
}
