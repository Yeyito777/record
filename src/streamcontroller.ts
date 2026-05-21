import type { StreamCreateEvent, StreamDeleteEvent, StreamServerUpdateEvent } from "./appgateway";
import { debugLog } from "./debuglog";
import { StreamMediaBackend } from "./stream";
import { DiscordVoiceGatewayConnection, VoiceGatewayCloseError, isRecoverableVoiceGatewayClose, type VoiceCallSession, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "./voice";

const STREAM_START_TIMEOUT_MS = 10_000;
const STREAM_GATEWAY_RECONNECT_ATTEMPTS = 30;
const STREAM_GATEWAY_RECONNECT_DELAY_MS = 500;

type StreamGatewayConnectionFactory = (
  data: VoiceGatewayJoinData,
  callbacks: VoiceGatewayConnectionCallbacks,
) => VoiceGatewayConnection;

interface StreamControllerEffects {
  scheduleRender: () => void;
  pingStreamServer?: (streamKey: string) => boolean;
}

export class ScreenStreamController {
  private streamCreate: StreamCreateEvent | null = null;
  private serverUpdate: StreamServerUpdateEvent | null = null;
  private connection: VoiceGatewayConnection | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private started = false;

  constructor(
    readonly streamKey: string,
    private readonly voiceSession: VoiceCallSession,
    private readonly selfUserId: string,
    private readonly effects: StreamControllerEffects,
    private readonly onError: (error: Error) => void,
    private readonly createGatewayConnection: StreamGatewayConnectionFactory = (data, callbacks) => new DiscordVoiceGatewayConnection(data, new StreamMediaBackend(), callbacks),
  ) {}

  start(): Promise<void> {
    if (this.connection || this.started) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      this.startTimer = setTimeout(() => {
        this.fail(new Error("Timed out waiting for Discord stream server details."));
      }, STREAM_START_TIMEOUT_MS);
      this.startTimer.unref?.();
      this.maybeConnect();
    });
  }

  handleCreate(event: StreamCreateEvent): void {
    if (event.streamKey !== this.streamKey) return;
    this.streamCreate = event;
    this.maybeConnect();
  }

  handleServerUpdate(event: StreamServerUpdateEvent): void {
    if (event.streamKey !== this.streamKey) return;
    if (!event.endpoint) {
      this.connection?.disconnect();
      this.connection = null;
      this.serverUpdate = null;
      return;
    }
    this.serverUpdate = event;
    this.maybeConnect();
  }

  handleDelete(event: StreamDeleteEvent): void {
    if (event.streamKey !== this.streamKey) return;
    const error = new Error(`Discord ended the stream: ${event.reason}`);
    if (this.rejectStart) this.fail(error);
    else this.onError(error);
    this.stop("stream_delete");
  }

  stop(reason = "stop"): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const connection = this.connection;
    this.connection = null;
    this.started = false;
    this.reconnectAttempts = 0;
    connection?.disconnect();
    debugLog("stream.controller.stop", { streamKey: this.streamKey, reason });
  }

  private maybeConnect(): void {
    if (this.connection || !this.streamCreate || !this.serverUpdate?.endpoint) return;
    if (!this.resolveStart && !this.started) return;
    const sessionId = this.voiceSession.sessionId;
    if (this.voiceSession.state !== "ready" || !sessionId) {
      if (this.started) {
        this.scheduleReconnect("voice_session_not_ready");
        return;
      }
      this.fail(new Error("Discord voice session is not ready for streaming."));
      return;
    }
    const connection = this.createGatewayConnection({
      guildId: this.streamCreate.rtcServerId,
      channelId: this.streamCreate.rtcChannelId,
      userId: this.selfUserId,
      sessionId,
      token: this.serverUpdate.token,
      endpoint: this.serverUpdate.endpoint,
      video: true,
      daveChannelId: daveChannelIdForStreamServer(this.streamCreate.rtcServerId),
    }, {
      onError: (error) => {
        this.onError(error);
        this.effects.scheduleRender();
      },
      onClose: (error) => {
        this.handleGatewayClose(connection, error);
        this.effects.scheduleRender();
      },
    });
    this.connection = connection;
    void connection.connect().then(() => {
      if (this.connection !== connection) return;
      if (this.startTimer) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
      }
      const resolve = this.resolveStart;
      this.resolveStart = null;
      this.rejectStart = null;
      this.started = true;
      this.reconnectAttempts = 0;
      debugLog("stream.controller.ready", { streamKey: this.streamKey, mediaSessionId: connection.mediaSessionId });
      resolve?.();
    }).catch((error) => {
      if (this.connection !== connection) return;
      this.connection = null;
      connection.disconnect();
      const asErr = error instanceof Error ? error : new Error(String(error));
      if (isRecoverableVoiceGatewayClose(asErr) && this.scheduleRecoverableReconnect(asErr, "connect_failed")) return;
      this.fail(asErr);
      this.stop("connect_failed");
    });
  }

  private handleGatewayClose(connection: VoiceGatewayConnection, error: VoiceGatewayCloseError): void {
    if (this.connection === connection) this.connection = null;
    if (isRecoverableVoiceGatewayClose(error) && this.scheduleRecoverableReconnect(error, "gateway_close")) return;

    if (this.rejectStart) this.fail(error);
    else this.onError(error);
    this.stop("gateway_close");
  }

  private scheduleRecoverableReconnect(error: VoiceGatewayCloseError, reason: string): boolean {
    if (this.reconnectAttempts >= STREAM_GATEWAY_RECONNECT_ATTEMPTS) return false;
    this.reconnectAttempts += 1;
    const pinged = this.effects.pingStreamServer?.(this.streamKey) ?? false;
    debugLog("stream.controller.reconnect", {
      streamKey: this.streamKey,
      attempt: this.reconnectAttempts,
      code: error.code,
      reason: error.closeReason,
      trigger: reason,
      pinged,
    });
    this.scheduleReconnect(reason);
    return true;
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) return;
    debugLog("stream.controller.reconnect_scheduled", { streamKey: this.streamKey, reason, delayMs: STREAM_GATEWAY_RECONNECT_DELAY_MS });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.maybeConnect();
    }, STREAM_GATEWAY_RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }

  private fail(error: Error): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const reject = this.rejectStart;
    this.resolveStart = null;
    this.rejectStart = null;
    reject?.(error);
  }
}

function daveChannelIdForStreamServer(rtcServerId: string): string {
  try {
    return (BigInt(rtcServerId) - 1n).toString();
  } catch {
    return rtcServerId;
  }
}
