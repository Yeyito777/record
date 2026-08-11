import type { StreamCreateEvent, StreamDeleteEvent, StreamServerUpdateEvent } from "../appgateway";
import { debugLog } from "../debuglog";
import { DiscordVoiceGatewayConnection, NoopVoiceAudioBackend, VoiceGatewayCloseError, isRecoverableVoiceGatewayClose, type IncomingVoiceRtpPacket, type VoiceCallSession, type VoiceGatewayConnection, type VoiceGatewayConnectionCallbacks, type VoiceGatewayJoinData } from "../voice";
import { daveChannelIdForStreamServer, parseStreamKey } from "./keys";
import { NoopWatchStreamPlayback, type WatchStreamPlayback } from "./playback";

const WATCH_STREAM_START_TIMEOUT_MS = 15_000;
const WATCH_STREAM_RECONNECT_ATTEMPTS = 20;
const WATCH_STREAM_RECONNECT_DELAY_MS = 750;
const WATCH_STREAM_FRESH_SERVER_RETRY_DELAY_MS = 1_000;

export interface WatchStreamStats {
  audioPackets: number;
  videoPackets: number;
  rtxPackets: number;
  firstPacketAt: number | null;
  lastPacketAt: number | null;
}

export interface WatchStreamControllerEffects {
  scheduleRender: () => void;
  watchStream?: (streamKey: string) => boolean;
  pingStreamServer?: (streamKey: string) => boolean;
}

type WatchStreamGatewayConnectionFactory = (
  data: VoiceGatewayJoinData,
  callbacks: VoiceGatewayConnectionCallbacks,
) => VoiceGatewayConnection;

export class WatchStreamController {
  private streamCreate: StreamCreateEvent | null = null;
  private serverUpdate: StreamServerUpdateEvent | null = null;
  private connection: VoiceGatewayConnection | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private freshServerAttempts = 0;
  private started = false;
  private needsFreshServerUpdate = false;
  private stats: WatchStreamStats = emptyStats();

  constructor(
    readonly streamKey: string,
    private readonly voiceSession: VoiceCallSession,
    private readonly selfUserId: string,
    private readonly effects: WatchStreamControllerEffects,
    private readonly onError: (error: Error) => void,
    private readonly createGatewayConnection: WatchStreamGatewayConnectionFactory = (data, callbacks) => new DiscordVoiceGatewayConnection(data, new NoopVoiceAudioBackend(), callbacks),
    private readonly playback: WatchStreamPlayback = new NoopWatchStreamPlayback(),
  ) {}

  get ownerUserId(): string | null {
    return parseStreamKey(this.streamKey)?.ownerUserId ?? null;
  }

  get currentStats(): WatchStreamStats {
    return { ...this.stats };
  }

  get active(): boolean {
    return this.started || Boolean(this.resolveStart) || Boolean(this.connection);
  }

  start(): Promise<void> {
    if (this.connection || this.started) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      this.startTimer = setTimeout(() => {
        this.fail(new Error("Timed out waiting for Discord stream watch details."));
      }, WATCH_STREAM_START_TIMEOUT_MS);
      this.startTimer.unref?.();
      const requested = this.effects.watchStream?.(this.streamKey) ?? true;
      debugLog("stream.watch.request", { streamKey: this.streamKey, requested });
      if (!requested) {
        this.fail(new Error("Discord gateway is not ready to watch that stream."));
        return;
      }
      this.maybeConnect();
    });
  }

  handleCreate(event: StreamCreateEvent): void {
    if (event.streamKey !== this.streamKey) return;
    this.streamCreate = event;
    debugLog("stream.watch.create", {
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
      debugLog("stream.watch.server_update_null", { streamKey: this.streamKey });
      if (this.started) this.scheduleReconnect("stream_server_reallocating", WATCH_STREAM_FRESH_SERVER_RETRY_DELAY_MS);
      return;
    }
    this.serverUpdate = event;
    this.needsFreshServerUpdate = false;
    this.freshServerAttempts = 0;
    debugLog("stream.watch.server_update", { streamKey: this.streamKey, endpoint: event.endpoint });
    this.maybeConnect();
  }

  handleDelete(event: StreamDeleteEvent): void {
    if (event.streamKey !== this.streamKey) return;
    debugLog("stream.watch.delete", {
      streamKey: this.streamKey,
      reason: event.reason,
      unavailable: event.unavailable,
      started: this.started,
      hasConnection: Boolean(this.connection),
    });
    const recoverable = this.started && shouldRecoverWatchDelete(event);
    const connection = this.connection;
    this.connection = null;
    connection?.disconnect();
    this.playback.stop();
    this.serverUpdate = null;
    this.needsFreshServerUpdate = true;
    if (recoverable) {
      // STREAM_WATCH against an unavailable stream produces STREAM_DELETE
      // (usually stream_not_found). Do not immediately issue another request
      // from that callback or the gateway response becomes a tight request /
      // delete loop. The reconnect timer performs the next bounded request.
      this.scheduleReconnect("stream_delete", WATCH_STREAM_FRESH_SERVER_RETRY_DELAY_MS);
      return;
    }
    const error = new Error(`Discord ended the watched stream: ${event.reason}`);
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
    const rejectStart = this.rejectStart;
    this.resolveStart = null;
    this.rejectStart = null;
    this.started = false;
    this.reconnectAttempts = 0;
    this.freshServerAttempts = 0;
    this.needsFreshServerUpdate = false;
    connection?.disconnect();
    this.playback.stop();
    rejectStart?.(new WatchStreamStartCancelledError(reason));
    debugLog("stream.watch.stop", { streamKey: this.streamKey, reason, stats: this.stats });
  }

  private maybeConnect(): void {
    if (this.connection || !this.streamCreate) return;
    if (!this.resolveStart && !this.started) return;
    const sessionId = this.voiceSession.sessionId;
    if (this.voiceSession.state !== "ready" || !sessionId) {
      if (this.started) {
        this.invalidateServerUpdate("voice_session_not_ready");
        this.scheduleReconnect("voice_session_not_ready", WATCH_STREAM_FRESH_SERVER_RETRY_DELAY_MS);
        return;
      }
      this.fail(new Error("Discord voice session is not ready for stream watching."));
      return;
    }
    if (!this.serverUpdate?.endpoint || this.needsFreshServerUpdate) {
      if (this.started) {
        this.requestFreshServerUpdate("awaiting_fresh_stream_server");
        this.scheduleReconnect("awaiting_fresh_stream_server", WATCH_STREAM_FRESH_SERVER_RETRY_DELAY_MS);
      }
      return;
    }

    const parsed = parseStreamKey(this.streamKey);
    const connection = this.createGatewayConnection({
      guildId: this.streamCreate.rtcServerId,
      channelId: this.streamCreate.rtcChannelId,
      userId: this.selfUserId,
      sessionId,
      token: this.serverUpdate.token,
      endpoint: this.serverUpdate.endpoint,
      video: true,
      streamReceive: {
        streamKey: this.streamKey,
        ownerUserId: parsed?.ownerUserId ?? null,
        quality: 100,
        pixelCount: 1920 * 1080,
      },
      daveChannelId: daveChannelIdForStreamServer(this.streamCreate.rtcServerId),
    }, {
      onIncomingRtp: (packet) => this.handleIncomingRtp(packet),
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
      return Promise.resolve(this.playback.start());
    }).then(() => {
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
      debugLog("stream.watch.ready", { streamKey: this.streamKey, mediaSessionId: connection.mediaSessionId });
      resolve?.();
    }).catch((error) => {
      if (this.connection !== connection) return;
      this.connection = null;
      connection.disconnect();
      this.playback.stop();
      const asErr = error instanceof Error ? error : new Error(String(error));
      if (isInvalidVoiceSessionClose(asErr)) this.invalidateServerUpdate("invalid_session");
      if (isRecoverableVoiceGatewayClose(asErr) && this.scheduleRecoverableReconnect(asErr, "connect_failed")) return;
      if (isRecoverableWatchConnectionError(asErr) && this.scheduleRecoverableConnectionError(asErr, "connect_failed")) return;
      this.fail(asErr);
      this.stop("connect_failed");
    });
  }

  private handleIncomingRtp(packet: IncomingVoiceRtpPacket): void {
    const now = Date.now();
    if (this.stats.firstPacketAt === null) this.stats.firstPacketAt = now;
    this.stats.lastPacketAt = now;
    if (packet.mediaType === "audio") this.stats.audioPackets += 1;
    else if (packet.mediaType === "video") this.stats.videoPackets += 1;
    else if (packet.mediaType === "rtx") this.stats.rtxPackets += 1;
    try {
      this.playback.handleIncomingRtp(packet);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.stats.audioPackets + this.stats.videoPackets + this.stats.rtxPackets === 1) {
      debugLog("stream.watch.first_rtp", {
        streamKey: this.streamKey,
        mediaType: packet.mediaType,
        payloadType: packet.payloadType,
        ssrc: packet.ssrc,
        userId: packet.userId,
        bytes: packet.packet.length,
      });
      this.effects.scheduleRender();
    }
  }

  private handleGatewayClose(connection: VoiceGatewayConnection, error: VoiceGatewayCloseError): void {
    if (this.connection === connection) this.connection = null;
    this.playback.stop();
    if (isInvalidVoiceSessionClose(error)) this.invalidateServerUpdate("invalid_session");
    else if (shouldRefreshWatchServerAfterClose(error)) this.invalidateServerUpdate("gateway_close");
    if (isRecoverableVoiceGatewayClose(error) && this.scheduleRecoverableReconnect(error, "gateway_close")) return;

    if (this.rejectStart) this.fail(error);
    else this.onError(error);
    this.stop("gateway_close");
  }

  private invalidateServerUpdate(reason: string): void {
    if (!this.serverUpdate && this.needsFreshServerUpdate) return;
    this.serverUpdate = null;
    this.needsFreshServerUpdate = true;
    debugLog("stream.watch.invalidate_server_update", { streamKey: this.streamKey, reason });
    this.requestFreshServerUpdate(reason);
  }

  private requestFreshServerUpdate(reason: string): boolean {
    this.freshServerAttempts += 1;
    const watched = this.effects.watchStream?.(this.streamKey) ?? false;
    const pinged = this.effects.pingStreamServer?.(this.streamKey) ?? false;
    debugLog("stream.watch.refresh_server", {
      streamKey: this.streamKey,
      reason,
      attempt: this.freshServerAttempts,
      watched,
      pinged,
    });
    return watched || pinged;
  }

  private scheduleRecoverableReconnect(error: VoiceGatewayCloseError, reason: string): boolean {
    if (this.reconnectAttempts >= WATCH_STREAM_RECONNECT_ATTEMPTS) return false;
    this.reconnectAttempts += 1;
    const requested = this.requestFreshServerUpdate(reason);
    debugLog("stream.watch.reconnect", {
      streamKey: this.streamKey,
      attempt: this.reconnectAttempts,
      code: error.code,
      reason: error.closeReason,
      trigger: reason,
      requested,
    });
    this.scheduleReconnect(reason, WATCH_STREAM_RECONNECT_DELAY_MS);
    return true;
  }

  private scheduleRecoverableConnectionError(error: Error, reason: string): boolean {
    if (this.reconnectAttempts >= WATCH_STREAM_RECONNECT_ATTEMPTS) return false;
    this.reconnectAttempts += 1;
    this.invalidateServerUpdate(reason);
    debugLog("stream.watch.reconnect", {
      streamKey: this.streamKey,
      attempt: this.reconnectAttempts,
      code: null,
      reason: error.message,
      trigger: reason,
    });
    this.scheduleReconnect(reason, WATCH_STREAM_FRESH_SERVER_RETRY_DELAY_MS);
    return true;
  }

  private scheduleReconnect(reason: string, delayMs: number): void {
    if (this.reconnectTimer) return;
    debugLog("stream.watch.reconnect_scheduled", { streamKey: this.streamKey, reason, delayMs });
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

export class WatchStreamStartCancelledError extends Error {
  constructor(readonly reason: string) {
    super(`Stream watch startup was cancelled (${reason}).`);
    this.name = "WatchStreamStartCancelledError";
  }
}

function isInvalidVoiceSessionClose(error: Error): error is VoiceGatewayCloseError {
  return error instanceof VoiceGatewayCloseError
    && (error.code === 4006 || /session is no longer valid/i.test(error.closeReason));
}

function shouldRecoverWatchDelete(event: StreamDeleteEvent): boolean {
  if (event.unavailable) return true;
  return !/^(stream_ended|stream_not_found|user_requested|unauthorized|invalid_channel|stream_full|safety_guild_rate_limited)$/i.test(event.reason);
}

function shouldRefreshWatchServerAfterClose(error: VoiceGatewayCloseError): boolean {
  return error.code === 1000
    || error.code === 1006
    || error.code === 4014
    || /connection closed normally|connection ended|disconnected/i.test(error.closeReason);
}

function isRecoverableWatchConnectionError(error: Error): boolean {
  return /timed out connecting to discord voice gateway/i.test(error.message)
    || /timed out waiting for discord stream watch details/i.test(error.message)
    || /websocket/i.test(error.message)
    || /network|connection/i.test(error.message);
}

function emptyStats(): WatchStreamStats {
  return { audioPackets: 0, videoPackets: 0, rtxPackets: 0, firstPacketAt: null, lastPacketAt: null };
}
