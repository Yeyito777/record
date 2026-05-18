import type { StreamCreateEvent, StreamDeleteEvent, StreamServerUpdateEvent } from "./appgateway";
import { debugLog } from "./debuglog";
import { StreamMediaBackend } from "./stream";
import { DiscordVoiceGatewayConnection, type VoiceCallSession, type VoiceGatewayConnection } from "./voice";

const STREAM_START_TIMEOUT_MS = 10_000;

interface StreamControllerEffects {
  scheduleRender: () => void;
}

export class ScreenStreamController {
  private streamCreate: StreamCreateEvent | null = null;
  private serverUpdate: StreamServerUpdateEvent | null = null;
  private connection: VoiceGatewayConnection | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    readonly streamKey: string,
    private readonly voiceSession: VoiceCallSession,
    private readonly selfUserId: string,
    private readonly effects: StreamControllerEffects,
    private readonly onError: (error: Error) => void,
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
    const connection = this.connection;
    this.connection = null;
    this.started = false;
    connection?.disconnect();
    debugLog("stream.controller.stop", { streamKey: this.streamKey, reason });
  }

  private maybeConnect(): void {
    if (this.connection || !this.streamCreate || !this.serverUpdate?.endpoint) return;
    if (!this.resolveStart && !this.started) return;
    const sessionId = this.voiceSession.sessionId;
    if (!sessionId) {
      this.fail(new Error("Discord voice session is not ready for streaming."));
      return;
    }
    const connection = new DiscordVoiceGatewayConnection({
      guildId: this.streamCreate.rtcServerId,
      channelId: this.streamCreate.rtcChannelId,
      userId: this.selfUserId,
      sessionId,
      token: this.serverUpdate.token,
      endpoint: this.serverUpdate.endpoint,
      video: true,
      daveChannelId: daveChannelIdForStreamServer(this.streamCreate.rtcServerId),
    }, new StreamMediaBackend(), {
      onError: (error) => {
        this.onError(error);
        this.effects.scheduleRender();
      },
      onClose: (error) => {
        this.onError(error);
        this.stop("gateway_close");
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
      debugLog("stream.controller.ready", { streamKey: this.streamKey, mediaSessionId: connection.mediaSessionId });
      resolve?.();
    }).catch((error) => {
      if (this.connection !== connection) return;
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.stop("connect_failed");
    });
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
