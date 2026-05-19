#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { AppGatewayClient, type StreamCreateEvent, type StreamDeleteEvent, type StreamServerUpdateEvent } from "../../src/appgateway";
import { loadConfig, loadSavedLogins } from "../../src/config";
import { fetchDirectMessages, ringDirectMessageCall } from "../../src/discord";
import { StreamMediaBackend } from "../../src/stream";
import { createInitialState } from "../../src/state";
import { DiscordVoiceGatewayConnection, VoiceCallController, type VoiceCallSession, type VoiceStateUpdate, type VoiceServerUpdate } from "../../src/voice";

const selfUserId = process.env.RECORD_TEST_SELF_USER_ID ?? "1031059414846808234"; // paramount
const targetUserId = process.argv[2] ?? process.env.RECORD_TEST_TARGET_USER_ID ?? "310543961825738754"; // yeyito
const runMs = Number(process.argv[3] ?? process.env.RECORD_TEST_RUN_MS ?? "90000");

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
function daveChannelIdForStreamServer(rtcServerId: string): string {
  try { return (BigInt(rtcServerId) - 1n).toString(); } catch { return rtcServerId; }
}

const xdg = process.env.XDG_CONFIG_HOME;
if (!xdg) throw new Error("XDG_CONFIG_HOME must point at the worktree config");
mkdirSync(join(xdg, "record"), { recursive: true });

const config = loadConfig();
const saved = loadSavedLogins();
const token = saved.paramount ?? saved["paramount.available"] ?? config.token;
if (!token) throw new Error("No token found for saved login 'paramount', 'paramount.available', or config.token");

const dms = await fetchDirectMessages(token);
const dm = dms.find((channel) => (channel.recipients ?? []).some((recipient) => recipient.id === targetUserId));
if (!dm) throw new Error(`Could not find DM with target user ${targetUserId}`);
log("dm.found", { channelId: dm.id, name: dm.name, recipients: dm.recipients?.map((r) => r.id) });

const state = createInitialState(token, "stream-live-test", saved);
state.auth.status = "authenticated";
state.auth.savedToken = token;
state.auth.user = { id: selfUserId, username: "paramount", displayName: "Paramount", avatar: null };
state.channelList.activeChannel = dm;
state.channelList.activeChannelId = dm.id;
state.channelList.guildId = "@me";

let voiceController: VoiceCallController | null = null;
let voiceSession: VoiceCallSession | null = null;
let streamCreate: StreamCreateEvent | null = null;
let streamServer: StreamServerUpdateEvent | null = null;
let streamConnection: DiscordVoiceGatewayConnection | null = null;
let streamStarted = false;
const streamKey = `call:${dm.id}:${selfUserId}`;

function maybeStartStreamConnection() {
  if (streamConnection || !streamCreate || !streamServer?.endpoint || !voiceSession?.sessionId) return;
  log("stream.voice.connect", { streamKey, rtcServerId: streamCreate.rtcServerId, rtcChannelId: streamCreate.rtcChannelId, endpoint: streamServer.endpoint });
  const connection = new DiscordVoiceGatewayConnection({
    guildId: streamCreate.rtcServerId,
    channelId: streamCreate.rtcChannelId,
    userId: selfUserId,
    sessionId: voiceSession.sessionId,
    token: streamServer.token,
    endpoint: streamServer.endpoint,
    video: true,
    daveChannelId: daveChannelIdForStreamServer(streamCreate.rtcServerId),
  }, new StreamMediaBackend(), {
    onError: (error) => log("stream.voice.error", { message: error.message }),
    onSpeakingChange: (userId, speaking) => log("stream.speaking", { userId, speaking }),
    onClose: (error) => log("stream.voice.close", { code: error.code, message: error.message, closeReason: error.closeReason }),
  });
  streamConnection = connection;
  connection.connect().then(() => {
    streamStarted = true;
    log("stream.voice.ready", { mediaSessionId: connection.mediaSessionId });
  }).catch((error) => {
    log("stream.voice.connect_failed", { message: error instanceof Error ? error.message : String(error) });
  });
}

const appGateway = new AppGatewayClient(token, {
  onInitialNotifications() {},
  onVoiceStateUpdate(update: VoiceStateUpdate) {
    log("voice_state", { userId: update.userId, channelId: update.channelId, sessionId: update.sessionId });
    voiceController?.handleVoiceStateUpdate(update);
  },
  onVoiceServerUpdate(update: VoiceServerUpdate) {
    log("voice_server", { guildId: update.guildId, endpoint: update.endpoint });
    voiceController?.handleVoiceServerUpdate(update);
  },
  onReconnect(attempt, delayMs) { log("gateway.reconnect", { attempt, delayMs }); },
  onError(error) { log("gateway.error", { message: error.message }); },
  onStreamCreate(event) {
    log("stream.create", { streamKey: event.streamKey, rtcChannelId: event.rtcChannelId, rtcServerId: event.rtcServerId, viewers: event.viewerIds, paused: event.paused });
    if (event.streamKey === streamKey) { streamCreate = event; maybeStartStreamConnection(); }
  },
  onStreamServerUpdate(event) {
    log("stream.server_update", { streamKey: event.streamKey, endpoint: event.endpoint });
    if (event.streamKey === streamKey) { streamServer = event; maybeStartStreamConnection(); }
  },
  onStreamDelete(event: StreamDeleteEvent) { log("stream.delete", { streamKey: event.streamKey, reason: event.reason }); },
});

voiceController = new VoiceCallController({
  selfUserId,
  signaling: appGateway,
  localVolumes: state.audio,
  noiseSuppression: state.noiseSuppression,
  ringRecipients: (channelId, recipientIds) => ringDirectMessageCall(token, channelId, recipientIds),
  onStateChange(session) {
    voiceSession = session;
    log("voice.state", { state: session?.state ?? "idle", channelId: session?.target.channelId ?? null, sessionId: session?.sessionId ?? null });
  },
  onSpeakingChange(userId, speaking) { log("speaking", { userId, speaking }); },
  onError(error) { log("voice.error", { message: error.message }); },
});

try {
  appGateway.start();
  await waitFor(() => appGateway.isReady(), 20000, "app gateway ready");
  log("gateway.ready");

  const recipientIds = (dm.recipients ?? []).filter((r) => r.id !== selfUserId).map((r) => r.id);
  log("call.start", { channelId: dm.id, recipientIds });
  const result = await voiceController.startCall({ guildId: null, channelId: dm.id, recipientIds, displayName: dm.name, ringRecipients: true });
  voiceSession = result.session;
  log("call.ready", { sessionId: voiceSession.sessionId });

  await sleep(3000);
  log("stream.create.request", { streamKey });
  if (!appGateway.createStream({ type: "call", guildId: null, channelId: dm.id })) throw new Error("app gateway not ready for createStream");
  appGateway.setStreamPaused(streamKey, false);
  await waitFor(() => streamStarted, 30000, "stream voice ready");

  await sleep(runMs);
  log("done");
} finally {
  streamConnection?.disconnect();
  appGateway.deleteStream(streamKey);
  voiceController?.leave();
  appGateway.disconnect();
}
