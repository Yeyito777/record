import { describe, expect, test } from "bun:test";

import type { StreamCreateEvent, StreamDeleteEvent, StreamServerUpdateEvent } from "../appgateway";
import type { VoiceCallSession } from "../voice";
import type { WatchStreamPlayback } from "./playback";
import { WatchStreamService, type CreateManagedWatchStreamControllerOptions, type ManagedWatchStreamController, type WatchStreamNoticeKind, type WatchStreamNoticeOptions } from "./service";

class FakeController implements ManagedWatchStreamController {
  active = true;
  starts = 0;
  stops: string[] = [];
  creates: StreamCreateEvent[] = [];
  serverUpdates: StreamServerUpdateEvent[] = [];
  deletes: StreamDeleteEvent[] = [];
  startError: Error | null = null;

  constructor(readonly options: CreateManagedWatchStreamControllerOptions) {}

  get streamKey(): string {
    return this.options.streamKey;
  }

  async start(): Promise<void> {
    this.starts += 1;
    if (this.startError) throw this.startError;
  }

  stop(reason = "stop"): void {
    this.active = false;
    this.stops.push(reason);
  }

  handleCreate(event: StreamCreateEvent): void {
    if (event.streamKey === this.streamKey) this.creates.push(event);
  }

  handleServerUpdate(event: StreamServerUpdateEvent): void {
    if (event.streamKey === this.streamKey) this.serverUpdates.push(event);
  }

  handleDelete(event: StreamDeleteEvent): void {
    if (event.streamKey !== this.streamKey) return;
    this.deletes.push(event);
    this.active = false;
  }
}

function readySession(overrides: Partial<VoiceCallSession> = {}): VoiceCallSession {
  return {
    target: { guildId: "guild-1", channelId: "voice-1", displayName: "Voice" },
    state: "ready",
    gateway: null,
    startedAt: 1,
    selfMute: false,
    selfDeaf: false,
    sessionId: "voice-session",
    ...overrides,
  };
}

function streamCreate(owner = "friend"): StreamCreateEvent {
  return {
    streamKey: `guild:guild-1:voice-1:${owner}`,
    rtcServerId: "9001",
    rtcChannelId: "9002",
    region: "us-east",
    viewerIds: [],
    paused: false,
  };
}

function createHarness(overrides: { token?: string | null; selfUserId?: string | null; session?: VoiceCallSession | null; gatewayReady?: boolean } = {}) {
  let token = overrides.token === undefined ? "token" : overrides.token;
  let selfUserId = overrides.selfUserId === undefined ? "self" : overrides.selfUserId;
  let session = overrides.session === undefined ? readySession() : overrides.session;
  let gatewayReady = overrides.gatewayReady ?? true;
  const controllers: FakeController[] = [];
  const notices: Array<{ text: string; kind: WatchStreamNoticeKind; options?: WatchStreamNoticeOptions }> = [];
  const watched: string[] = [];
  const availability: Array<{ owner: string; available: boolean }> = [];
  const watching: Array<{ owner: string; active: boolean }> = [];
  const playbackOptions: Array<{ onEnded?: (error: Error | null) => void }> = [];
  let renders = 0;

  const service = new WatchStreamService({
    getToken: () => token,
    getSelfUserId: () => selfUserId,
    getVoiceSession: () => session,
    getSignaling: () => ({
      isReady: () => gatewayReady,
      watchStream: (streamKey) => {
        watched.push(streamKey);
        return true;
      },
      pingStreamServer: () => true,
    }),
    resolveVisibleUserId: (_voiceSession, target) => target.toLowerCase() === "friend" ? "friend" : null,
    displayNameForUser: (_channelId, userId) => userId === "friend" ? "Friendly" : userId,
    notify: (text, kind, options) => notices.push({ text, kind, options }),
    scheduleRender: () => { renders += 1; },
    onAvailabilityChange: (stream, available) => availability.push({ owner: stream.ownerUserId, available }),
    onWatchingChange: (stream, active) => watching.push({ owner: stream.ownerUserId, active }),
    createPlayback: (options) => {
      playbackOptions.push(options);
      return { start() {}, handleIncomingRtp() {}, stop() {} } satisfies WatchStreamPlayback;
    },
    createController: (options) => {
      const controller = new FakeController(options);
      controllers.push(controller);
      return controller;
    },
  });

  return {
    service,
    controllers,
    notices,
    watched,
    availability,
    watching,
    playbackOptions,
    get renders() { return renders; },
    setToken(value: string | null) { token = value; },
    setSession(value: VoiceCallSession | null) { session = value; },
    setGatewayReady(value: boolean) { gatewayReady = value; },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("watched stream service", () => {
  test("owns login, call, and gateway validation feedback", () => {
    const loggedOut = createHarness({ token: null });
    loggedOut.service.watch("friend");
    expect(loggedOut.notices.at(-1)?.text).toBe("Login required to watch a stream.");

    const noCall = createHarness({ session: null });
    noCall.service.watch("friend");
    expect(noCall.notices.at(-1)?.text).toBe("Join a call before using /watch.");

    const gatewayDown = createHarness({ gatewayReady: false });
    gatewayDown.service.watch("friend");
    expect(gatewayDown.notices.at(-1)?.text).toContain("gateway is still connecting");
  });

  test("tracks stream availability and seeds cached signaling into a new controller", async () => {
    const harness = createHarness();
    const create = streamCreate();
    const server: StreamServerUpdateEvent = { streamKey: create.streamKey, token: "stream-token", endpoint: "stream.example" };
    harness.service.handleCreate(create);
    harness.service.handleServerUpdate(server);

    expect(harness.service.hasTrackedStream("voice-1", "friend")).toBe(true);
    expect(harness.service.canWatch("voice-1", "friend")).toBe(true);
    expect(harness.availability).toEqual([{ owner: "friend", available: true }]);

    harness.service.watch();
    await flushPromises();

    expect(harness.controllers).toHaveLength(1);
    expect(harness.controllers[0]?.streamKey).toBe(create.streamKey);
    expect(harness.controllers[0]?.creates).toEqual([create]);
    expect(harness.controllers[0]?.serverUpdates).toEqual([server]);
    expect(harness.controllers[0]?.starts).toBe(1);
    expect(harness.watching).toEqual([{ owner: "friend", active: true }]);
    expect(harness.notices.at(-1)).toMatchObject({ text: "Watching Friendly's stream.", kind: "success" });
  });

  test("resolves a visible user and toggles the same stream off", async () => {
    const harness = createHarness();
    harness.service.watch("friend");
    await flushPromises();
    expect(harness.controllers[0]?.streamKey).toBe("guild:guild-1:voice-1:friend");

    harness.service.watch("friend");
    expect(harness.controllers[0]?.stops).toContain("command");
    expect(harness.service.activeStreamKey).toBeNull();
    expect(harness.notices.at(-1)?.text).toBe("Stopped watching stream.");
    expect(harness.watching.at(-1)).toEqual({ owner: "friend", active: false });
  });

  test("stops the watch when the player window ends", async () => {
    const harness = createHarness();
    harness.service.watch("friend");
    await flushPromises();
    harness.playbackOptions[0]?.onEnded?.(null);

    expect(harness.controllers[0]?.stops).toContain("playback_ended");
    expect(harness.service.activeStreamKey).toBeNull();
    expect(harness.notices.at(-1)?.text).toBe("Stopped watching Friendly's stream.");
  });

  test("routes stream deletion and clears availability and watching state", async () => {
    const harness = createHarness();
    const create = streamCreate();
    harness.service.handleCreate(create);
    harness.service.watch();
    await flushPromises();
    harness.service.handleDelete({ streamKey: create.streamKey, reason: "stream_ended", unavailable: false });

    expect(harness.service.hasTrackedStream("voice-1", "friend")).toBe(false);
    expect(harness.availability.at(-1)).toEqual({ owner: "friend", available: false });
    expect(harness.watching.at(-1)).toEqual({ owner: "friend", active: false });
  });

  test("rejects an exact stream key from another call and watching self", () => {
    const harness = createHarness();
    harness.service.watch("guild:other:voice-1:friend");
    expect(harness.notices.at(-1)?.text).toBe("That stream is not in the current call.");

    harness.service.watch("guild:guild-1:voice-1:self");
    expect(harness.notices.at(-1)?.text).toContain("/watch is for other users");
  });
});
