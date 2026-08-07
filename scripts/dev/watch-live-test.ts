#!/usr/bin/env bun
// watch-live-test — headless /watch verification harness.
//
// Logs in with the paramount saved login, calls the target user's DM, waits for
// the target to go live, then watches the stream and verifies that video RTP
// actually reaches playback. Instead of opening a player window it forwards the
// stream into ffmpeg and dumps decoded frames as PNGs for inspection.
//
// Usage:
//   XDG_CONFIG_HOME=<worktree>/config bun run scripts/dev/watch-live-test.ts [targetUserId] [runMs] [frameDir]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type Socket as UdpSocket } from "node:dgram";

import { AppGatewayClient, type StreamCreateEvent, type StreamServerUpdateEvent } from "../../src/appgateway";
import { loadConfig, loadSavedLogins } from "../../src/config";
import { fetchDirectMessages, ringDirectMessageCall } from "../../src/discord";
import { createInitialState } from "../../src/state";
import { VoiceCallController, type IncomingVoiceRtpPacket, type VoiceCallSession, type VoiceStateUpdate, type VoiceServerUpdate } from "../../src/voice";
import { reserveUdpPort } from "../../src/voice/rtp";
import { WatchStreamController, buildWatchStreamPlaybackSdp, type WatchStreamPlayback } from "../../src/watchstream";

const selfUserId = process.env.RECORD_TEST_SELF_USER_ID ?? "1031059414846808234"; // paramount
const targetUserId = process.argv[2] ?? process.env.RECORD_TEST_TARGET_USER_ID ?? "310543961825738754"; // yeyito
const runMs = Number(process.argv[3] ?? process.env.RECORD_TEST_RUN_MS ?? "45000");
const frameDir = process.argv[4] ?? process.env.RECORD_TEST_FRAME_DIR ?? "/tmp/record-watch-live-test";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const xdg = process.env.XDG_CONFIG_HOME;
if (!xdg) throw new Error("XDG_CONFIG_HOME must point at the worktree config");
mkdirSync(join(xdg, "record"), { recursive: true });
mkdirSync(frameDir, { recursive: true });

const config = loadConfig();
const saved = loadSavedLogins();
const token = saved.paramount ?? saved["paramount.available"] ?? config.token;
if (!token) throw new Error("No token found for saved login 'paramount', 'paramount.available', or config.token");

const dms = await fetchDirectMessages(token);
const dm = dms.find((channel) => (channel.recipients ?? []).some((recipient) => recipient.id === targetUserId));
if (!dm) throw new Error(`Could not find DM with target user ${targetUserId}`);
log("dm.found", { channelId: dm.id, recipients: dm.recipients?.map((r) => r.id) });

const state = createInitialState(token, "watch-live-test", saved);
state.auth.status = "authenticated";
state.auth.savedToken = token;
state.auth.user = { id: selfUserId, username: "paramount", globalName: "Paramount", discriminator: "0", avatar: null, bot: false, email: null, verified: null };

const streamKey = `call:${dm.id}:${targetUserId}`;
let voiceController: VoiceCallController | null = null;
let voiceSession: VoiceCallSession | null = null;
let watchController: WatchStreamController | null = null;
let streamCreate: StreamCreateEvent | null = null;
let streamServer: StreamServerUpdateEvent | null = null;

// Forwards watched RTP into ffmpeg via the same SDP the real playback uses, but
// dumps decoded frames as PNGs instead of opening a player window.
class FfmpegFrameDumpPlayback implements WatchStreamPlayback {
  private udp: UdpSocket | null = null;
  private proc: ChildProcess | null = null;
  private tempDir: string | null = null;
  private videoPort: number | null = null;
  private audioPort: number | null = null;
  forwarded = 0;

  constructor(private readonly outDir: string) {}

  async start(): Promise<void> {
    if (this.proc) return;
    this.videoPort = await reserveUdpPort();
    this.audioPort = await reserveUdpPort();
    this.udp = createSocket("udp4");
    this.tempDir = mkdtempSync(join(tmpdir(), "record-watch-live-test-"));
    const sdpPath = join(this.tempDir, "stream.sdp");
    writeFileSync(sdpPath, buildWatchStreamPlaybackSdp(this.videoPort, this.audioPort));
    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-protocol_whitelist", "file,udp,rtp",
      "-fflags", "nobuffer",
      "-i", sdpPath,
      "-map", "0:v:0", "-vf", "fps=1", "-fps_mode", "vfr", join(this.outDir, "frame-%03d.png"),
    ];
    log("ffmpeg.start", { args });
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    proc.stderr?.on("data", (chunk) => log("ffmpeg.stderr", { line: chunk.toString().trim().slice(0, 400) }));
    proc.on("exit", (code, signal) => log("ffmpeg.exit", { code, signal }));
  }

  handleIncomingRtp(packet: IncomingVoiceRtpPacket): void {
    if (!this.udp) return;
    const port = packet.mediaType === "video" && packet.payloadType === 101
      ? this.videoPort
      : packet.mediaType === "audio" && packet.payloadType === 120
        ? this.audioPort
        : null;
    if (port === null) return;
    this.udp.send(packet.packet, port, "127.0.0.1");
    this.forwarded += 1;
  }

  stop(): void {
    try { this.proc?.kill("SIGTERM"); } catch {}
    this.proc = null;
    try { this.udp?.close(); } catch {}
    this.udp = null;
    if (this.tempDir) {
      try { rmSync(this.tempDir, { recursive: true, force: true }); } catch {}
      this.tempDir = null;
    }
  }
}

const appGateway = new AppGatewayClient(token, {
  onInitialNotifications() {},
  onVoiceStateUpdate(update: VoiceStateUpdate) { voiceController?.handleVoiceStateUpdate(update); },
  onVoiceServerUpdate(update: VoiceServerUpdate) { voiceController?.handleVoiceServerUpdate(update); },
  onReconnect(attempt, delayMs) { log("gateway.reconnect", { attempt, delayMs }); },
  onError(error) { log("gateway.error", { message: error.message }); },
  onStreamCreate(event) {
    log("stream.create", { streamKey: event.streamKey, rtcServerId: event.rtcServerId, paused: event.paused });
    if (event.streamKey === streamKey) streamCreate = event;
    watchController?.handleCreate(event);
  },
  onStreamServerUpdate(event) {
    log("stream.server_update", { streamKey: event.streamKey, endpoint: event.endpoint });
    if (event.streamKey === streamKey) streamServer = event;
    watchController?.handleServerUpdate(event);
  },
  onStreamDelete(event) {
    log("stream.delete", { streamKey: event.streamKey, reason: event.reason });
    watchController?.handleDelete(event);
  },
  onMessageCreate() {},
  onMessageUpdate() {},
  onMessageDelete() {},
  onMessageDeleteBulk() {},
  onMessageAck() {},
  onChannelCreate() {},
  onChannelUpdate() {},
  onChannelDelete() {},
  onTypingStart() {},
});

voiceController = new VoiceCallController({
  selfUserId,
  signaling: appGateway,
  localVolumes: state.audio,
  noiseSuppression: "off",
  ringRecipients: (channelId, recipientIds) => ringDirectMessageCall(token, channelId, recipientIds),
  onStateChange(session) {
    voiceSession = session;
    log("voice.state", { state: session?.state ?? "idle", sessionId: session?.sessionId ?? null });
  },
  onSpeakingChange() {},
  onError(error) { log("voice.error", { message: error.message }); },
});

try {
  appGateway.start();
  await waitFor(() => appGateway.isReady(), 20_000, "app gateway ready");
  log("gateway.ready");

  const recipientIds = (dm.recipients ?? []).filter((r) => r.id !== selfUserId).map((r) => r.id);
  const result = await voiceController.startCall({ guildId: null, channelId: dm.id, recipientIds, displayName: dm.name, ringRecipients: true });
  voiceSession = result.session;
  log("call.ready", { sessionId: voiceSession.sessionId });

  log("stream.waiting", { streamKey });
  await waitFor(() => Boolean(streamCreate), 120_000, `target stream ${streamKey}`);

  const playback = new FfmpegFrameDumpPlayback(frameDir);

  watchController = new WatchStreamController(streamKey, voiceSession!, selfUserId, {
    scheduleRender: () => {},
    watchStream: (key) => appGateway.watchStream(key),
    pingStreamServer: (key) => appGateway.pingStreamServer(key),
  }, (error) => log("watch.error", { message: error.message }), undefined, playback);

  if (streamCreate) watchController.handleCreate(streamCreate);
  if (streamServer) watchController.handleServerUpdate(streamServer);

  await watchController.start();
  log("watch.ready");

  const statsEvery = setInterval(() => {
    log("watch.stats", { ...watchController?.currentStats, forwarded: playback.forwarded });
  }, 5_000);

  await sleep(runMs);
  clearInterval(statsEvery);
  const stats = watchController.currentStats;
  log("done", { ...stats, forwarded: playback.forwarded, frameDir, ok: stats.videoPackets > 0 && playback.forwarded > 0 });
  process.exitCode = stats.videoPackets > 0 && playback.forwarded > 0 ? 0 : 1;
} finally {
  watchController?.stop("test_done");
  voiceController?.leave();
  appGateway.disconnect();
}
