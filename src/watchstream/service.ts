import type { StreamCreateEvent, StreamDeleteEvent, StreamServerUpdateEvent } from "../appgateway";
import type { VoiceCallSession } from "../voice";
import { WatchStreamController } from "./controller";
import { buildStreamKeyForVoiceSession, parseStreamKey, streamKeyMatchesVoiceSession, type ParsedStreamKey } from "./keys";
import { createDefaultWatchStreamPlayback, type CreateWatchStreamPlaybackOptions, type WatchStreamPlayback } from "./playback";

export interface WatchStreamSignaling {
  isReady(): boolean;
  watchStream(streamKey: string): boolean;
  pingStreamServer(streamKey: string): boolean;
}

export type WatchStreamNoticeKind = "muted" | "success" | "warning" | "error";

export interface WatchStreamNoticeOptions {
  loading?: boolean;
}

export interface ManagedWatchStreamController {
  readonly streamKey: string;
  readonly active: boolean;
  start(): Promise<void>;
  stop(reason?: string): void;
  handleCreate(event: StreamCreateEvent): void;
  handleServerUpdate(event: StreamServerUpdateEvent): void;
  handleDelete(event: StreamDeleteEvent): void;
}

export interface CreateManagedWatchStreamControllerOptions {
  streamKey: string;
  voiceSession: VoiceCallSession;
  selfUserId: string;
  playback: WatchStreamPlayback;
  watchStream: (streamKey: string) => boolean;
  pingStreamServer: (streamKey: string) => boolean;
  scheduleRender: () => void;
  onError: (error: Error) => void;
}

export interface WatchStreamServiceOptions {
  getToken: () => string | null | undefined;
  getSelfUserId: () => string | null | undefined;
  getVoiceSession: () => VoiceCallSession | null;
  getSignaling: () => WatchStreamSignaling | null;
  resolveVisibleUserId: (session: VoiceCallSession, target: string) => string | null;
  displayNameForUser: (channelId: string, userId: string, fallback: string) => string;
  notify: (text: string, kind: WatchStreamNoticeKind, options?: WatchStreamNoticeOptions) => void;
  scheduleRender: () => void;
  onAvailabilityChange?: (stream: ParsedStreamKey, available: boolean) => void;
  onWatchingChange?: (stream: ParsedStreamKey, watching: boolean) => void;
  createPlayback?: (options: CreateWatchStreamPlaybackOptions) => WatchStreamPlayback;
  createController?: (options: CreateManagedWatchStreamControllerOptions) => ManagedWatchStreamController;
}

interface TrackedStreamState {
  create: StreamCreateEvent;
  serverUpdate: StreamServerUpdateEvent | null;
}

interface ResolvedWatchStream {
  streamKey: string;
  ownerUserId: string | null;
}

/**
 * Owns the complete application lifecycle for watching remote Discord streams.
 * Session/UI code only supplies state lookups and reacts to availability changes.
 */
export class WatchStreamService {
  private readonly availableStreamsByKey = new Map<string, TrackedStreamState>();
  private controller: ManagedWatchStreamController | null = null;

  constructor(private readonly options: WatchStreamServiceOptions) {}

  get activeStreamKey(): string | null {
    return this.controller?.streamKey ?? null;
  }

  hasTrackedStream(channelId: string, userId: string): boolean {
    for (const stream of this.availableStreamsByKey.values()) {
      const parsed = parseStreamKey(stream.create.streamKey);
      if (parsed?.channelId === channelId && parsed.ownerUserId === userId) return true;
    }
    return false;
  }

  canWatch(channelId: string, userId: string, streamingHint = false): boolean {
    if (userId === this.options.getSelfUserId()) return false;
    const session = this.options.getVoiceSession();
    if (!session || session.state !== "ready" || session.target.channelId !== channelId) return false;
    return streamingHint || this.hasTrackedStream(channelId, userId);
  }

  isWatching(channelId: string, userId: string): boolean {
    const parsed = this.controller ? parseStreamKey(this.controller.streamKey) : null;
    return parsed?.channelId === channelId && parsed.ownerUserId === userId;
  }

  handleCreate(event: StreamCreateEvent): void {
    const current = this.availableStreamsByKey.get(event.streamKey);
    this.availableStreamsByKey.set(event.streamKey, { create: event, serverUpdate: current?.serverUpdate ?? null });
    this.controller?.handleCreate(event);
    const parsed = parseStreamKey(event.streamKey);
    if (parsed) this.options.onAvailabilityChange?.(parsed, true);
  }

  handleServerUpdate(event: StreamServerUpdateEvent): void {
    const current = this.availableStreamsByKey.get(event.streamKey);
    if (current) this.availableStreamsByKey.set(event.streamKey, { ...current, serverUpdate: event });
    this.controller?.handleServerUpdate(event);
  }

  handleDelete(event: StreamDeleteEvent): void {
    const parsed = parseStreamKey(event.streamKey);
    const controller = this.controller;
    controller?.handleDelete(event);
    if (controller?.streamKey === event.streamKey && !controller.active) {
      this.controller = null;
      if (parsed) this.options.onWatchingChange?.(parsed, false);
    }
    this.availableStreamsByKey.delete(event.streamKey);
    if (parsed) this.options.onAvailabilityChange?.(parsed, false);
  }

  watch(target: string | null = null): void {
    const normalizedTarget = normalizeWatchTarget(target);
    if (normalizedTarget && this.controller?.streamKey === normalizedTarget) {
      this.stop();
      return;
    }

    const token = this.options.getToken();
    const selfUserId = this.options.getSelfUserId();
    if (!token || !selfUserId) {
      this.notice("Login required to watch a stream.", "warning");
      return;
    }

    const session = this.options.getVoiceSession();
    if (!session || session.state !== "ready") {
      this.notice("Join a call before using /watch.", "warning");
      return;
    }
    if (!session.sessionId) {
      this.notice("Discord voice session is still connecting; try /watch again in a moment.", "warning");
      return;
    }

    const signaling = this.options.getSignaling();
    if (!signaling?.isReady()) {
      this.notice("Discord gateway is still connecting; try again in a moment.", "warning");
      return;
    }

    const resolved = this.resolveStream(session, target);
    if (!resolved) {
      this.notice(this.ambiguityNotice(session, target), "warning");
      return;
    }
    if (resolved.ownerUserId === selfUserId) {
      this.notice("Use /stream to control your own stream; /watch is for other users' streams.", "warning");
      return;
    }
    if (this.controller?.streamKey === resolved.streamKey) {
      this.stop();
      return;
    }

    this.stop({ silent: true });
    const ownerLabel = resolved.ownerUserId
      ? this.options.displayNameForUser(session.target.channelId, resolved.ownerUserId, resolved.ownerUserId)
      : "stream";

    let controller!: ManagedWatchStreamController;
    const playback = (this.options.createPlayback ?? createDefaultWatchStreamPlayback)({
      title: `record stream — ${ownerLabel}`,
      onEnded: (error) => {
        if (this.controller !== controller) return;
        this.controller = null;
        controller.stop("playback_ended");
        this.notifyWatchingChange(controller.streamKey, false);
        if (error) this.options.notify(`Stream playback ended: ${error.message}`, "warning");
        else this.options.notify(`Stopped watching ${ownerLabel}'s stream.`, "muted");
        this.options.scheduleRender();
      },
    });
    controller = (this.options.createController ?? createDefaultController)({
      streamKey: resolved.streamKey,
      voiceSession: session,
      selfUserId,
      playback,
      watchStream: (streamKey) => this.options.getSignaling()?.watchStream(streamKey) ?? false,
      pingStreamServer: (streamKey) => this.options.getSignaling()?.pingStreamServer(streamKey) ?? false,
      scheduleRender: this.options.scheduleRender,
      onError: (error) => this.options.notify(`Stream watch: ${error.message}`, "warning"),
    });
    this.controller = controller;
    this.notifyWatchingChange(controller.streamKey, true);

    const tracked = this.availableStreamsByKey.get(resolved.streamKey);
    if (tracked) {
      controller.handleCreate(tracked.create);
      if (tracked.serverUpdate) controller.handleServerUpdate(tracked.serverUpdate);
    }

    this.options.notify(`Joining ${ownerLabel}'s stream…`, "muted", { loading: true });
    this.options.scheduleRender();

    void controller.start().then(() => {
      if (this.controller !== controller) return;
      this.options.notify(`Watching ${ownerLabel}'s stream.`, "success");
      this.options.scheduleRender();
    }).catch((error) => {
      if (this.controller !== controller) return;
      this.controller = null;
      controller.stop("start_failed");
      this.notifyWatchingChange(controller.streamKey, false);
      const message = error instanceof Error ? error.message : String(error);
      this.options.notify(`Failed to watch stream: ${message}`, "error");
      this.options.scheduleRender();
    });
  }

  stop(options: { silent?: boolean; reason?: string } = {}): void {
    const controller = this.controller;
    if (!controller) {
      if (!options.silent) this.notice("No active watched stream.", "muted");
      return;
    }
    this.controller = null;
    controller.stop(options.reason ?? "command");
    this.notifyWatchingChange(controller.streamKey, false);
    if (!options.silent) this.options.notify("Stopped watching stream.", "muted");
    this.options.scheduleRender();
  }

  disconnect(reason = "gateway_disconnect"): void {
    const controller = this.controller;
    this.controller = null;
    controller?.stop(reason);
    if (controller) this.notifyWatchingChange(controller.streamKey, false);
    this.availableStreamsByKey.clear();
  }

  private resolveStream(session: VoiceCallSession, target: string | null | undefined): ResolvedWatchStream | null {
    const normalizedTarget = normalizeWatchTarget(target);
    if (normalizedTarget && parseStreamKey(normalizedTarget)) {
      if (!streamKeyMatchesVoiceSession(normalizedTarget, session)) return null;
      return { streamKey: normalizedTarget, ownerUserId: parseStreamKey(normalizedTarget)?.ownerUserId ?? null };
    }

    if (!normalizedTarget) {
      const streams = this.trackedStreamsForSession(session);
      if (streams.length !== 1) return null;
      const streamKey = streams[0]?.create.streamKey;
      return streamKey ? { streamKey, ownerUserId: parseStreamKey(streamKey)?.ownerUserId ?? null } : null;
    }

    const ownerUserId = this.resolveTargetUserId(session, normalizedTarget);
    if (!ownerUserId) return null;
    return { streamKey: buildStreamKeyForVoiceSession(session, ownerUserId), ownerUserId };
  }

  private resolveTargetUserId(session: VoiceCallSession, target: string): string | null {
    if (/^\d{5,25}$/.test(target)) return target;
    const needle = target.toLowerCase();
    for (const stream of this.trackedStreamsForSession(session)) {
      const parsed = parseStreamKey(stream.create.streamKey);
      if (!parsed) continue;
      const displayName = this.options.displayNameForUser(session.target.channelId, parsed.ownerUserId, parsed.ownerUserId).toLowerCase();
      if (displayName === needle || displayName.includes(needle)) return parsed.ownerUserId;
    }
    return this.options.resolveVisibleUserId(session, target);
  }

  private ambiguityNotice(session: VoiceCallSession, target: string | null | undefined): string {
    const normalizedTarget = normalizeWatchTarget(target);
    if (normalizedTarget) {
      if (parseStreamKey(normalizedTarget)) return "That stream is not in the current call.";
      return "Use /watch with a user id, @mention, exact stream_key, or a visible streamer name.";
    }
    const streams = this.trackedStreamsForSession(session);
    if (streams.length === 0) return "No active streams found in this call yet.";
    const labels = streams.slice(0, 5).map((stream) => {
      const owner = parseStreamKey(stream.create.streamKey)?.ownerUserId ?? "unknown";
      return `${this.options.displayNameForUser(session.target.channelId, owner, owner)} (${stream.create.streamKey})`;
    });
    const suffix = streams.length > labels.length ? `, and ${streams.length - labels.length} more` : "";
    return `Multiple streams are live; use /watch <user_id|stream_key>. Streams: ${labels.join(", ")}${suffix}`;
  }

  private trackedStreamsForSession(session: VoiceCallSession): TrackedStreamState[] {
    const selfUserId = this.options.getSelfUserId();
    return Array.from(this.availableStreamsByKey.values()).filter((stream) => {
      const parsed = parseStreamKey(stream.create.streamKey);
      if (!parsed || parsed.ownerUserId === selfUserId) return false;
      return streamKeyMatchesVoiceSession(stream.create.streamKey, session);
    });
  }

  private notifyWatchingChange(streamKey: string, watching: boolean): void {
    const parsed = parseStreamKey(streamKey);
    if (parsed) this.options.onWatchingChange?.(parsed, watching);
  }

  private notice(text: string, kind: WatchStreamNoticeKind): void {
    this.options.notify(text, kind);
    this.options.scheduleRender();
  }
}

export function normalizeWatchTarget(target: string | null | undefined): string | null {
  const trimmed = target?.trim();
  if (!trimmed) return null;
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  return mention?.[1] ?? trimmed;
}

function createDefaultController(options: CreateManagedWatchStreamControllerOptions): ManagedWatchStreamController {
  return new WatchStreamController(options.streamKey, options.voiceSession, options.selfUserId, {
    scheduleRender: options.scheduleRender,
    watchStream: options.watchStream,
    pingStreamServer: options.pingStreamServer,
  }, options.onError, undefined, options.playback);
}
