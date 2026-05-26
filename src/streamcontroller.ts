import type { StreamCreateEvent, StreamDeleteEvent, StreamServerUpdateEvent } from "./appgateway";
import { debugLog } from "./debuglog";
import { StreamMediaBackend } from "./stream";
import { DiscordVoiceGatewayConnection, VoiceGatewayCloseError, isRecoverableVoiceGatewayClose, type VoiceCallSession, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "./voice";

const STREAM_START_TIMEOUT_MS = 10_000;
const STREAM_GATEWAY_RECONNECT_ATTEMPTS = 30;
const STREAM_GATEWAY_RECONNECT_DELAY_MS = 500;
const STREAM_FRESH_SERVER_RETRY_DELAY_MS = 1_000;

type StreamGatewayConnectionFactory = (
  data: VoiceGatewayJoinData,
  callbacks: VoiceGatewayConnectionCallbacks,
) => VoiceGatewayConnection;

interface StreamControllerEffects {
  scheduleRender: () => void;
  refreshStreamServer?: (streamKey: string, reason: string, attempt: number) => boolean;
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
  private freshServerAttempts = 0;
  private needsFreshServerUpdate = false;
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
    debugLog("stream.controller.create", {
      streamKey: this.streamKey,
      rtcServerId: event.rtcServerId,
      rtcChannelId: event.rtcChannelId,
      paused: event.paused,
    });
    this.maybeConnect();
  }

  handleServerUpdate(event: StreamServerUpdateEvent): void {
    if (event.streamKey !== this.streamKey) return;
    if (!event.endpoint) {
      this.connection?.disconnect();
      this.connection = null;
      this.serverUpdate = null;
      this.needsFreshServerUpdate = true;
      debugLog("stream.controller.server_update_null", { streamKey: this.streamKey });
      if (this.started) this.scheduleReconnect("stream_server_reallocating", STREAM_FRESH_SERVER_RETRY_DELAY_MS);
      return;
    }
    this.serverUpdate = event;
    this.needsFreshServerUpdate = false;
    this.freshServerAttempts = 0;
    debugLog("stream.controller.server_update", { streamKey: this.streamKey, endpoint: event.endpoint });
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
    this.freshServerAttempts = 0;
    this.needsFreshServerUpdate = false;
    connection?.disconnect();
    debugLog("stream.controller.stop", { streamKey: this.streamKey, reason });
  }

  private maybeConnect(): void {
    if (this.connection || !this.streamCreate) return;
    if (!this.resolveStart && !this.started) return;
    const sessionId = this.voiceSession.sessionId;
    if (this.voiceSession.state !== "ready" || !sessionId) {
      if (this.started) {
        // A stream gateway token is coupled to the currently-valid voice
        // session.  If the parent call drops/rejoins, continuing to identify to
        // the old stream server usually produces a 4006 invalid-session loop.
        // Throw away the cached stream server details and ask Discord for a
        // fresh allocation once the parent call is healthy again.
        this.invalidateServerUpdate("voice_session_not_ready");
        this.scheduleReconnect("voice_session_not_ready", STREAM_FRESH_SERVER_RETRY_DELAY_MS);
        return;
      }
      this.fail(new Error("Discord voice session is not ready for streaming."));
      return;
    }
    if (!this.serverUpdate?.endpoint || this.needsFreshServerUpdate) {
      if (this.started) {
        this.requestFreshServerUpdate("awaiting_fresh_stream_server");
        this.scheduleReconnect("awaiting_fresh_stream_server", STREAM_FRESH_SERVER_RETRY_DELAY_MS);
      }
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
      if (isInvalidVoiceSessionClose(asErr)) this.invalidateServerUpdate("invalid_session");
      if (isRecoverableVoiceGatewayClose(asErr) && this.scheduleRecoverableReconnect(asErr, "connect_failed")) return;
      this.fail(asErr);
      this.stop("connect_failed");
    });
  }

  private handleGatewayClose(connection: VoiceGatewayConnection, error: VoiceGatewayCloseError): void {
    if (this.connection === connection) this.connection = null;
    if (isInvalidVoiceSessionClose(error)) this.invalidateServerUpdate("invalid_session");
    if (isRecoverableVoiceGatewayClose(error) && this.scheduleRecoverableReconnect(error, "gateway_close")) return;

    if (this.rejectStart) this.fail(error);
    else this.onError(error);
    this.stop("gateway_close");
  }

  private invalidateServerUpdate(reason: string): void {
    if (!this.serverUpdate && this.needsFreshServerUpdate) return;
    this.serverUpdate = null;
    this.needsFreshServerUpdate = true;
    debugLog("stream.controller.invalidate_server_update", { streamKey: this.streamKey, reason });
    this.requestFreshServerUpdate(reason);
  }

  private requestFreshServerUpdate(reason: string): boolean {
    if (!this.started) return false;
    this.freshServerAttempts += 1;
    let requested = false;
    let method: "refresh" | "ping" | "none" = "none";
    if (this.effects.refreshStreamServer) {
      method = "refresh";
      requested = this.effects.refreshStreamServer(this.streamKey, reason, this.freshServerAttempts);
    } else if (this.effects.pingStreamServer) {
      method = "ping";
      requested = this.effects.pingStreamServer(this.streamKey);
    }
    debugLog("stream.controller.refresh_server", {
      streamKey: this.streamKey,
      reason,
      attempt: this.freshServerAttempts,
      method,
      requested,
    });
    return requested;
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
    this.scheduleReconnect(reason, STREAM_GATEWAY_RECONNECT_DELAY_MS);
    return true;
  }

  private scheduleReconnect(reason: string, delayMs: number): void {
    if (this.reconnectTimer) return;
    debugLog("stream.controller.reconnect_scheduled", { streamKey: this.streamKey, reason, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.maybeConnect();
    }, delayMs);
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

function isInvalidVoiceSessionClose(error: Error): error is VoiceGatewayCloseError {
  return error instanceof VoiceGatewayCloseError
    && (error.code === 4006 || /session is no longer valid/i.test(error.closeReason));
}

function daveChannelIdForStreamServer(rtcServerId: string): string {
  try {
    return (BigInt(rtcServerId) - 1n).toString();
  } catch {
    return rtcServerId;
  }
}
