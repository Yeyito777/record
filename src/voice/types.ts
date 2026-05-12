import type { Socket as UdpSocket } from "dgram";
import type { LocalAudioVolumes } from "../volume";

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
  setLocalVolumes?(volumes: LocalAudioVolumes): void;
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
  localVolumes?: LocalAudioVolumes;
  createGatewayConnection?: (data: VoiceGatewayJoinData, callbacks: VoiceGatewayConnectionCallbacks) => VoiceGatewayConnection;
  fetchPreferredRegions?: () => Promise<string[]>;
  ringRecipients?: (channelId: string, recipientIds: string[]) => Promise<void>;
  retryDelayMs?: number;
  onStateChange?: (session: VoiceCallSession | null) => void;
  onSpeakingChange?: (userId: string, speaking: boolean) => void;
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
  encodeOutgoingOpus?: (payload: Buffer) => Buffer | null;
  decodeIncomingOpus?: (ssrc: number, payload: Buffer) => Buffer | null;
  onIncomingAudio?: (ssrc: number) => void;
  onError: (error: Error) => void;
}

export interface VoiceAudioBackend {
  start(context: VoiceAudioContext): Promise<void> | void;
  stop(): void;
  setLocalVolumes?(volumes: LocalAudioVolumes): void;
}

export class NoopVoiceAudioBackend implements VoiceAudioBackend {
  start(): void {
    // Intentionally no-op. Useful for tests and unsupported platforms.
  }

  stop(): void {
    // Intentionally no-op.
  }
}
