/**
 * Read-only Discord gateway client for live app events.
 */

import { release } from "os";

import {
  compareSnowflakesDesc,
  DIRECT_MESSAGES_GUILD_ID,
  mapDirectMessageChannel,
  mapDiscordMessage,
  mapDiscordMessagePatch,
  mapDiscordMessageReactionPatch,
  mapGuildChannel,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordChannelResponse,
  type DiscordMessage,
  type DiscordMessagePatch,
  type DiscordMessageResponse,
  type DiscordGuildMember,
  type DiscordPresenceStatus,
} from "./discord";
import { debugLog } from "./debuglog";
import { buildVoiceStatePayload, type VoiceServerUpdate, type VoiceSignalingClient, type VoiceStateRequest, type VoiceStateUpdate } from "./voice";

const API_BASE = "https://discord.com/api/v9";
const GATEWAY_VERSION = 9;
const GATEWAY_CAPABILITIES = 30717;
const GATEWAY_QOS_HEARTBEAT_VERSION = 29;
const GATEWAY_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.115 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const GATEWAY_RECONNECT_CLOSE_CODE = 4000;
const GATEWAY_RESUME_MAX_HEARTBEAT_ACK_AGE_MS = 3 * 60 * 1_000;

interface GatewayPayload {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

interface GuildChannelSubscription {
  guildId: string;
  channelId: string;
}

export interface InitialNotification {
  channelId: string;
  guildId: string | null;
  count: number;
}

export interface CallGatewayVoiceState {
  userId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  mute: boolean;
  deaf: boolean;
}

export interface CallGatewayEvent {
  channelId: string;
  ringingUserIds: string[];
  region: string | null;
  voiceStateUserIds: string[];
  voiceStates: CallGatewayVoiceState[];
  isActive: boolean;
}

export interface StreamCreateEvent {
  streamKey: string;
  rtcServerId: string;
  rtcChannelId: string;
  region: string | null;
  viewerIds: string[];
  paused: boolean;
}

export interface StreamServerUpdateEvent {
  streamKey: string;
  token: string;
  endpoint: string | null;
}

export interface StreamDeleteEvent {
  streamKey: string;
  reason: string;
  unavailable: boolean;
}

export interface AppGatewayCallbacks {
  onInitialNotifications: (notifications: InitialNotification[]) => void;
  onVoiceStateUpdate?: (update: VoiceStateUpdate) => void;
  onVoiceServerUpdate?: (update: VoiceServerUpdate) => void;
  onCallCreate?: (event: CallGatewayEvent) => void;
  onCallUpdate?: (event: CallGatewayEvent) => void;
  onCallDelete?: (channelId: string) => void;
  onStreamCreate?: (event: StreamCreateEvent) => void;
  onStreamServerUpdate?: (event: StreamServerUpdateEvent) => void;
  onStreamDelete?: (event: StreamDeleteEvent) => void;
  onGuildMuteSettings?: (mutedByGuildId: Record<string, boolean>) => void;
  onGuildMuteSetting?: (guildId: string, muted: boolean) => void;
  onChannelMuteSettings?: (mutedByChannelId: Record<string, boolean>, options?: { reset?: boolean }) => void;
  onCurrentUserRoleIds?: (roleIdsByGuildId: Record<string, string[]>) => void;
  onCurrentUserGuildRoles?: (guildId: string, roleIds: string[]) => void;
  onGuildMembersChunk?: (guildId: string, members: DiscordGuildMember[]) => void;
  onReadyGuilds?: (guilds: DiscordGuild[]) => void;
  onGuildCreate?: (guild: DiscordGuild) => void;
  onGuildUpdate?: (guild: DiscordGuild) => void;
  onGuildDelete?: (guildId: string) => void;
  onMessageCreate: (message: DiscordMessage) => void;
  onMessageUpdate: (patch: DiscordMessagePatch) => void;
  onMessageDelete: (channelId: string, messageId: string) => void;
  onMessageDeleteBulk: (channelId: string, messageIds: string[]) => void;
  onMessageAck: (channelId: string) => void;
  onChannelCreate: (channel: DiscordChannel) => void;
  onChannelUpdate: (channel: DiscordChannel) => void;
  onChannelDelete: (channelId: string, guildId: string | null) => void;
  onTypingStart: (channelId: string, userId: string, displayName: string) => void;
  onReconnect?: (attempt: number, delayMs: number) => void;
  onError?: (error: Error) => void;
}

export class AppGatewayClient implements VoiceSignalingClient {
  private gatewayUrl: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq: number | null = null;
  private lastHeartbeatAckAt: number | null = null;
  private sessionId: string | null = null;
  private manualDisconnect = false;
  private connecting = false;
  private reconnectAttempt = 0;
  private ready = false;
  private currentUserId: string | null = null;
  private guildChannelSubscription: GuildChannelSubscription | null = null;
  private guildSubscriptions = new Set<string>();
  private currentPresenceStatus: DiscordPresenceStatus;
  private currentVoiceChannelId: string | null = null;

  constructor(
    private readonly token: string,
    private readonly callbacks: AppGatewayCallbacks,
    initialPresenceStatus: DiscordPresenceStatus = "online",
  ) {
    this.currentPresenceStatus = initialPresenceStatus;
  }

  start(): void {
    if (this.ws || this.connecting) return;
    this.manualDisconnect = false;
    void this.connect();
  }

  isReady(): boolean {
    return this.ready && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  subscribeToGuildChannel(guildId: string | null | undefined, channelId: string | null | undefined): void {
    if (!guildId || !channelId || guildId === DIRECT_MESSAGES_GUILD_ID) {
      this.guildChannelSubscription = null;
      return;
    }

    this.guildChannelSubscription = { guildId, channelId };
    this.sendGuildChannelSubscription();
  }

  subscribeToGuild(guildId: string | null | undefined): void {
    if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return;
    this.guildSubscriptions.add(guildId);
    if (!this.ready) return;
    this.sendGuildSubscription(guildId);
  }

  updatePresenceStatus(status: DiscordPresenceStatus): boolean {
    this.currentPresenceStatus = status;
    if (!this.isReady()) return false;
    this.sendPresenceUpdate();
    return true;
  }

  requestVoiceState(request: VoiceStateRequest): boolean {
    if (!this.isReady()) return false;
    this.send(buildVoiceStatePayload(request));
    this.currentVoiceChannelId = request.channelId;
    return true;
  }

  createStream(request: { type: "call" | "guild"; guildId: string | null; channelId: string; preferredRegion?: string | null }): boolean {
    if (!this.isReady()) return false;
    const data: Record<string, unknown> = {
      type: request.type,
      guild_id: request.guildId,
      channel_id: request.channelId,
    };
    if (request.preferredRegion) data.preferred_region = request.preferredRegion;
    debugLog("app_gateway.stream_create.send", {
      type: request.type,
      guildId: request.guildId,
      channelId: request.channelId,
      preferredRegion: request.preferredRegion ?? null,
    });
    this.send({ op: 18, d: data });
    return true;
  }

  deleteStream(streamKey: string): boolean {
    if (!this.isReady()) return false;
    debugLog("app_gateway.stream_delete.send", { streamKey });
    this.send({ op: 19, d: { stream_key: streamKey } });
    return true;
  }

  watchStream(streamKey: string): boolean {
    if (!this.isReady()) return false;
    debugLog("app_gateway.stream_watch.send", { streamKey });
    this.send({ op: 20, d: { stream_key: streamKey } });
    return true;
  }

  pingStreamServer(streamKey: string): boolean {
    if (!this.isReady()) return false;
    debugLog("app_gateway.stream_ping.send", { streamKey });
    this.send({ op: 21, d: { stream_key: streamKey } });
    return true;
  }

  setStreamPaused(streamKey: string, paused: boolean): boolean {
    if (!this.isReady()) return false;
    debugLog("app_gateway.stream_paused.send", { streamKey, paused });
    this.send({ op: 22, d: { stream_key: streamKey, paused } });
    return true;
  }

  requestGuildMembers(guildId: string, userIds: readonly string[]): boolean {
    const ids = Array.from(new Set(userIds.filter((userId) => typeof userId === "string" && userId.trim())));
    if (!this.isReady() || !guildId || ids.length === 0) return false;
    this.send({
      op: 8,
      d: {
        guild_id: [guildId],
        query: null,
        limit: ids.length,
        presences: false,
        user_ids: ids,
        nonce: `record-members-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
    });
    debugLog("app_gateway.request_members", { guildId, count: ids.length });
    return true;
  }

  leaveVoice(): boolean {
    return this.requestVoiceState({
      guildId: null,
      channelId: null,
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
    });
  }

  disconnect(): void {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.seq = null;
    this.ready = false;
    this.reconnectAttempt = 0;
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.manualDisconnect) return;
    this.connecting = true;

    try {
      if (!this.gatewayUrl) {
        this.gatewayUrl = await fetchGatewayUrl();
      }
      if (this.manualDisconnect) return;

      const gatewayUrl = this.websocketUrl();
      debugLog("app_gateway.connect", { resume: Boolean(this.sessionId && this.resumeGatewayUrl), hasSessionId: Boolean(this.sessionId), hasResumeGatewayUrl: Boolean(this.resumeGatewayUrl) });
      this.ws = new WebSocket(gatewayUrl);
      this.ws.addEventListener("message", this.handleMessage);
      this.ws.addEventListener("close", this.handleClose);
      this.ws.addEventListener("error", this.handleError);
    } catch (error) {
      this.callbacks.onError?.(asError(error, "Failed to connect to Discord gateway."));
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private handleMessage = (event: MessageEvent<unknown>): void => {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(messageDataToString(event.data)) as GatewayPayload;
    } catch (error) {
      this.callbacks.onError?.(asError(error, "Failed to parse Discord gateway payload."));
      return;
    }

    if (typeof payload.s === "number") {
      this.seq = payload.s;
    }

    switch (payload.op) {
      case 10:
        this.handleHello(payload.d);
        return;
      case 11:
        this.lastHeartbeatAckAt = Date.now();
        return;
      case 7:
        debugLog("app_gateway.reconnect_requested", { hasSessionId: Boolean(this.sessionId), hasResumeGatewayUrl: Boolean(this.resumeGatewayUrl), seq: this.seq, heartbeatAckAgeMs: this.heartbeatAckAgeMs() });
        this.scheduleReconnect(0, GATEWAY_RECONNECT_CLOSE_CODE);
        return;
      case 9:
        this.handleInvalidSession(payload.d);
        return;
      default:
        break;
    }

    if (payload.t === "READY") {
      this.reconnectAttempt = 0;
      this.ready = true;
      this.currentUserId = extractCurrentUserId(payload.d);
      this.sessionId = isObject(payload.d) && typeof payload.d.session_id === "string" ? payload.d.session_id : null;
      this.resumeGatewayUrl = extractResumeGatewayUrl(payload.d) ?? this.resumeGatewayUrl;
      debugLog("app_gateway.ready", { userId: this.currentUserId, hasSessionId: Boolean(this.sessionId), hasResumeGatewayUrl: Boolean(this.resumeGatewayUrl) });
      this.callbacks.onCurrentUserRoleIds?.(extractCurrentUserRoleIdsByGuildId(payload.d));
      this.callbacks.onReadyGuilds?.(extractReadyGuilds(payload.d));
      this.callbacks.onGuildMuteSettings?.(extractGuildMuteSettings(payload.d));
      this.callbacks.onChannelMuteSettings?.(extractChannelMuteSettings(payload.d), { reset: true });
      this.callbacks.onInitialNotifications(extractInitialNotifications(payload.d));
      for (const voiceState of extractReadyVoiceStates(payload.d)) {
        this.rememberSelfVoiceState(voiceState);
        this.callbacks.onVoiceStateUpdate?.(voiceState);
      }
      this.sendPresenceUpdate();
      this.sendGuildSubscriptions();
      this.sendGuildChannelSubscription();
      return;
    }

    if (payload.t === "RESUMED") {
      this.reconnectAttempt = 0;
      this.ready = true;
      debugLog("app_gateway.resumed", { hasSessionId: Boolean(this.sessionId) });
      this.sendPresenceUpdate();
      this.sendGuildSubscriptions();
      this.sendGuildChannelSubscription();
      return;
    }

    if (payload.t === "READY_SUPPLEMENTAL") {
      for (const voiceState of extractReadyVoiceStates(payload.d)) {
        this.rememberSelfVoiceState(voiceState);
        this.callbacks.onVoiceStateUpdate?.(voiceState);
      }
      return;
    }

    this.handleDispatch(payload.t, payload.d);
  };

  private handleHello(data: unknown): void {
    const heartbeatInterval = isObject(data) && typeof data.heartbeat_interval === "number" ? data.heartbeat_interval : null;
    if (!heartbeatInterval) {
      this.callbacks.onError?.(new Error("Discord gateway did not provide a heartbeat interval."));
      this.scheduleReconnect();
      return;
    }

    this.startHeartbeat(heartbeatInterval);
    if (this.canResumeSession()) {
      this.sendResume();
      this.lastHeartbeatAckAt = Date.now();
      return;
    }

    this.sendIdentify();
  }

  private sendResume(): void {
    this.send({
      op: 6,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.seq,
      },
    });
  }

  private sendIdentify(): void {
    this.seq = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.lastHeartbeatAckAt = Date.now();
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: GATEWAY_CAPABILITIES,
        properties: createGatewayProperties(),
        presence: {
          activities: [],
          status: this.currentPresenceStatus,
          since: null,
          afk: false,
        },
      },
    });
  }

  private canResumeSession(): boolean {
    if (!this.sessionId) return false;
    const ageMs = this.heartbeatAckAgeMs();
    return ageMs === null || ageMs <= GATEWAY_RESUME_MAX_HEARTBEAT_ACK_AGE_MS;
  }

  private heartbeatAckAgeMs(): number | null {
    return this.lastHeartbeatAckAt === null ? null : Date.now() - this.lastHeartbeatAckAt;
  }

  private handleInvalidSession(data: unknown): void {
    const resumable = data === true;
    debugLog("app_gateway.invalid_session", { resumable, hasSessionId: Boolean(this.sessionId), hasResumeGatewayUrl: Boolean(this.resumeGatewayUrl), seq: this.seq, heartbeatAckAgeMs: this.heartbeatAckAgeMs() });
    if (!resumable || !this.canResumeSession()) {
      this.sessionId = null;
      this.resumeGatewayUrl = null;
      this.seq = null;
    }

    // Discord's OP 9 tells us whether the current app-gateway session can be
    // resumed. If it is still plausibly resumable, retry the resume path;
    // otherwise identify fresh. Fresh identifies while already in voice can make
    // Discord close the voice gateway with 4014 ("Disconnected"), so preserving
    // resumable session state matters.
    this.scheduleReconnect(resumable ? 0 : undefined, this.sessionId ? GATEWAY_RECONNECT_CLOSE_CODE : undefined);
  }

  private handleDispatch(type: string | null | undefined, data: unknown): void {
    try {
      switch (type) {
        case "MESSAGE_CREATE":
          this.callbacks.onMessageCreate(mapDiscordMessage(data as DiscordMessageResponse));
          break;
        case "MESSAGE_UPDATE":
          if (!isObject(data) || typeof data.id !== "string" || typeof data.channel_id !== "string") break;
          this.callbacks.onMessageUpdate(mapDiscordMessagePatch(data as Partial<DiscordMessageResponse> & { id: string; channel_id: string }));
          break;
        case "MESSAGE_REACTION_ADD":
          this.handleMessageReactionUpdate(data, "add");
          break;
        case "MESSAGE_REACTION_ADD_MANY":
          this.handleMessageReactionAddMany(data);
          break;
        case "MESSAGE_REACTION_REMOVE":
          this.handleMessageReactionUpdate(data, "remove");
          break;
        case "MESSAGE_REACTION_REMOVE_ALL":
          this.handleMessageReactionUpdate(data, "clear");
          break;
        case "MESSAGE_REACTION_REMOVE_EMOJI":
          this.handleMessageReactionUpdate(data, "clearEmoji");
          break;
        case "MESSAGE_DELETE": {
          if (!isObject(data) || typeof data.id !== "string" || typeof data.channel_id !== "string") break;
          this.callbacks.onMessageDelete(data.channel_id, data.id);
          break;
        }
        case "MESSAGE_DELETE_BULK": {
          if (!isObject(data) || typeof data.channel_id !== "string" || !Array.isArray(data.ids)) break;
          this.callbacks.onMessageDeleteBulk(data.channel_id, data.ids.filter((id): id is string => typeof id === "string"));
          break;
        }
        case "MESSAGE_ACK": {
          if (!isObject(data) || typeof data.channel_id !== "string") break;
          this.callbacks.onMessageAck(data.channel_id);
          break;
        }
        case "CHANNEL_CREATE":
          this.handleChannelCreateOrUpdate(data, "create");
          break;
        case "CHANNEL_UPDATE":
          this.handleChannelCreateOrUpdate(data, "update");
          break;
        case "CHANNEL_DELETE": {
          if (!isObject(data) || typeof data.id !== "string") break;
          this.callbacks.onChannelDelete(data.id, typeof data.guild_id === "string" ? data.guild_id : null);
          break;
        }
        case "GUILD_CREATE": {
          const guild = mapGatewayGuild(data);
          if (guild) this.callbacks.onGuildCreate?.(guild);
          for (const voiceState of extractGuildVoiceStates(data)) {
            this.callbacks.onVoiceStateUpdate?.(voiceState);
          }
          break;
        }
        case "GUILD_UPDATE": {
          const guild = mapGatewayGuild(data);
          if (guild) this.callbacks.onGuildUpdate?.(guild);
          break;
        }
        case "GUILD_DELETE": {
          if (!isObject(data) || typeof data.id !== "string") break;
          this.callbacks.onGuildDelete?.(data.id);
          break;
        }
        case "TYPING_START": {
          if (!isObject(data) || typeof data.channel_id !== "string" || typeof data.user_id !== "string") break;
          this.callbacks.onTypingStart(data.channel_id, data.user_id, typingDisplayName(data));
          break;
        }
        case "VOICE_STATE_UPDATE": {
          const update = mapVoiceStateUpdate(data);
          if (update) {
            this.rememberSelfVoiceState(update);
            this.callbacks.onVoiceStateUpdate?.(update);
          }
          break;
        }
        case "VOICE_SERVER_UPDATE": {
          const update = mapVoiceServerUpdate(data);
          if (update) this.callbacks.onVoiceServerUpdate?.(update);
          break;
        }
        case "CALL_CREATE": {
          const event = mapCallGatewayEvent(data);
          if (event) this.callbacks.onCallCreate?.(event);
          break;
        }
        case "CALL_UPDATE": {
          const event = mapCallGatewayEvent(data);
          if (event) this.callbacks.onCallUpdate?.(event);
          break;
        }
        case "CALL_DELETE": {
          if (!isObject(data) || typeof data.channel_id !== "string") break;
          this.callbacks.onCallDelete?.(data.channel_id);
          break;
        }
        case "STREAM_CREATE": {
          const event = mapStreamCreateEvent(data);
          if (event) {
            debugLog("app_gateway.stream_create", {
              streamKey: event.streamKey,
              rtcServerId: event.rtcServerId,
              rtcChannelId: event.rtcChannelId,
              paused: event.paused,
              viewerCount: event.viewerIds.length,
              region: event.region,
            });
            this.callbacks.onStreamCreate?.(event);
          }
          break;
        }
        case "STREAM_SERVER_UPDATE": {
          const event = mapStreamServerUpdateEvent(data);
          if (event) {
            debugLog("app_gateway.stream_server_update", {
              streamKey: event.streamKey,
              endpoint: event.endpoint,
              hasToken: Boolean(event.token),
            });
            this.callbacks.onStreamServerUpdate?.(event);
          }
          break;
        }
        case "STREAM_DELETE": {
          const event = mapStreamDeleteEvent(data);
          if (event) {
            debugLog("app_gateway.stream_delete", {
              streamKey: event.streamKey,
              reason: event.reason,
              unavailable: event.unavailable,
            });
            this.callbacks.onStreamDelete?.(event);
          }
          break;
        }
        case "GUILD_MEMBER_UPDATE": {
          if (!isObject(data) || typeof data.guild_id !== "string" || !Array.isArray(data.roles)) break;
          const user = isObject(data.user) ? data.user : null;
          if (!this.currentUserId || !user || user.id !== this.currentUserId) break;
          this.callbacks.onCurrentUserGuildRoles?.(data.guild_id, data.roles.filter((roleId): roleId is string => typeof roleId === "string"));
          break;
        }
        case "GUILD_MEMBERS_CHUNK": {
          const chunk = mapGuildMembersChunk(data);
          if (chunk) this.callbacks.onGuildMembersChunk?.(chunk.guildId, chunk.members);
          break;
        }
        case "USER_GUILD_SETTINGS_UPDATE": {
          if (!isObject(data)) break;
          if (typeof data.guild_id === "string" && typeof data.muted === "boolean") {
            this.callbacks.onGuildMuteSetting?.(data.guild_id, data.muted);
            break;
          }
          const mutedByChannelId = channelMuteSettingsFromEntry(data);
          if (Object.keys(mutedByChannelId).length > 0) {
            this.callbacks.onChannelMuteSettings?.(mutedByChannelId);
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.callbacks.onError?.(asError(error, `Failed to handle Discord gateway event ${type ?? "unknown"}.`));
    }
  }

  private handleMessageReactionUpdate(data: unknown, type: "add" | "remove" | "clear" | "clearEmoji"): void {
    const patch = mapDiscordMessageReactionPatch(data, type, this.currentUserId);
    if (patch) this.callbacks.onMessageUpdate(patch);
  }

  private handleMessageReactionAddMany(data: unknown): void {
    if (!isObject(data) || !Array.isArray(data.reactions)) return;
    for (const reaction of data.reactions) {
      if (!isObject(reaction) || !Array.isArray(reaction.users)) continue;
      for (const userId of reaction.users) {
        const patch = mapDiscordMessageReactionPatch({
          ...data,
          user_id: userId,
          emoji: reaction.emoji,
        }, "add", this.currentUserId);
        if (patch) this.callbacks.onMessageUpdate(patch);
      }
    }
  }

  private handleChannelCreateOrUpdate(data: unknown, event: "create" | "update"): void {
    if (!isObject(data) || typeof data.id !== "string" || typeof data.type !== "number") return;

    const rawChannel = data as DiscordChannelResponse;
    const channel = typeof rawChannel.guild_id === "string"
      ? mapGuildChannel(rawChannel, rawChannel.guild_id)
      : mapDirectMessageChannel(rawChannel, -1);
    if (!channel) return;

    if (event === "create") {
      this.callbacks.onChannelCreate(channel);
    } else {
      this.callbacks.onChannelUpdate(channel);
    }
  }

  private handleClose = (event: CloseEvent): void => {
    const manual = this.manualDisconnect;
    const wasReady = this.ready;
    const resetSession = isNonResumableGatewayCloseCode(event.code);
    debugLog("app_gateway.close", { code: event.code, reason: event.reason || null, manualDisconnect: manual, wasReady, resetSession });
    if (resetSession) {
      this.sessionId = null;
      this.resumeGatewayUrl = null;
      this.seq = null;
    }
    this.closeSocket();
    if (manual) return;

    if (event.code === 4004) {
      debugLog("app_gateway.auth_failed", { wasReady });
      this.callbacks.onError?.(new Error("Discord gateway authentication failed."));
      return;
    }

    this.scheduleReconnect();
  };

  private handleError = (): void => {
    if (this.manualDisconnect) return;
    debugLog("app_gateway.error", {});
    this.callbacks.onError?.(new Error("Discord gateway connection error."));
  };

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, Math.max(1_000, intervalMs));
  }

  private sendHeartbeat(): void {
    const reasons = ["foregrounded"];
    if (this.currentVoiceChannelId) reasons.push("rtc_connected");
    this.send({
      op: 40,
      d: {
        seq: this.seq,
        qos: {
          active: true,
          ver: GATEWAY_QOS_HEARTBEAT_VERSION,
          reasons,
        },
      },
    });
  }

  private rememberSelfVoiceState(update: VoiceStateUpdate): void {
    if (update.userId !== this.currentUserId) return;
    this.currentVoiceChannelId = update.channelId;
  }

  private scheduleReconnect(delayOverride?: number, closeCode?: number): void {
    if (this.manualDisconnect) return;
    if (this.reconnectTimer) return;

    this.closeSocket(closeCode);
    const attempt = ++this.reconnectAttempt;
    const delayMs = delayOverride ?? Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1));
    debugLog("app_gateway.reconnect", { attempt, delayMs, closeCode: closeCode ?? null, hasSessionId: Boolean(this.sessionId), hasResumeGatewayUrl: Boolean(this.resumeGatewayUrl), seq: this.seq, heartbeatAckAgeMs: this.heartbeatAckAgeMs() });
    this.callbacks.onReconnect?.(attempt, delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private sendPresenceUpdate(): void {
    this.send({
      op: 3,
      d: {
        status: this.currentPresenceStatus,
        afk: false,
        since: 0,
        activities: [],
      },
    });
  }

  private sendGuildChannelSubscription(): void {
    if (!this.ready || !this.guildChannelSubscription) return;
    const { guildId, channelId } = this.guildChannelSubscription;
    this.send({
      op: 37,
      d: {
        subscriptions: {
          [guildId]: {
            typing: true,
            activities: true,
            threads: true,
            channels: {
              [channelId]: [[0, 99]],
            },
          },
        },
      },
    });
  }

  private sendGuildSubscription(guildId: string): void {
    this.send({
      op: 37,
      d: {
        subscriptions: {
          [guildId]: {
            typing: true,
            activities: true,
            threads: true,
          },
        },
      },
    });
  }

  private sendGuildSubscriptions(): void {
    for (const guildId of this.guildSubscriptions) this.sendGuildSubscription(guildId);
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private closeSocket(closeCode?: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ready = false;
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;

    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    socket.removeEventListener("error", this.handleError);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(closeCode);
    }
  }

  private websocketUrl(): string {
    const base = this.sessionId && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.gatewayUrl;
    if (!base) throw new Error("Discord gateway URL is not available.");
    const separator = base.includes("?") ? "&" : "/?";
    return `${base}${separator}v=${GATEWAY_VERSION}&encoding=json`;
  }
}

function isNonResumableGatewayCloseCode(code: number): boolean {
  return code === 4007 // Invalid seq.
    || code === 4009; // Session timed out.
}

export function extractCurrentUserId(data: unknown): string | null {
  if (!isObject(data)) return null;
  const user = isObject(data.user) ? data.user : null;
  return user && typeof user.id === "string" ? user.id : null;
}

export function extractResumeGatewayUrl(data: unknown): string | null {
  if (!isObject(data) || typeof data.resume_gateway_url !== "string") return null;
  return normalizeGatewayBaseUrl(data.resume_gateway_url);
}

function normalizeGatewayBaseUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function mapVoiceStateUpdate(data: unknown, fallbackGuildId: string | null = null): VoiceStateUpdate | null {
  if (!isObject(data) || typeof data.user_id !== "string") return null;
  const displayName = voiceStateDisplayName(data);
  const roleIds = voiceStateRoleIds(data);
  return {
    userId: data.user_id,
    channelId: typeof data.channel_id === "string" ? data.channel_id : null,
    guildId: typeof data.guild_id === "string" ? data.guild_id : fallbackGuildId,
    sessionId: typeof data.session_id === "string" ? data.session_id : null,
    ...(displayName ? { displayName } : {}),
    ...(roleIds ? { roleIds } : {}),
    selfMute: Boolean(data.self_mute),
    selfDeaf: Boolean(data.self_deaf),
    mute: Boolean(data.mute),
    deaf: Boolean(data.deaf),
  };
}

function voiceStateDisplayName(data: Record<string, any>): string | null {
  const member = isObject(data.member) ? data.member : null;
  const memberUser = member && isObject(member.user) ? member.user : null;
  const user = isObject(data.user) ? data.user : null;
  return displayNameField(memberUser?.global_name)
    ?? displayNameField(memberUser?.display_name)
    ?? displayNameField(memberUser?.username)
    ?? displayNameField(user?.global_name)
    ?? displayNameField(user?.display_name)
    ?? displayNameField(user?.username)
    ?? displayNameField(member?.nick);
}

function voiceStateRoleIds(data: Record<string, any>): string[] | null {
  const member = isObject(data.member) ? data.member : null;
  if (!member || !Array.isArray(member.roles)) return null;
  return member.roles.filter((roleId): roleId is string => typeof roleId === "string");
}

export function extractGuildVoiceStates(data: unknown): VoiceStateUpdate[] {
  if (!isObject(data) || typeof data.id !== "string" || !Array.isArray(data.voice_states)) return [];
  return data.voice_states
    .map((rawVoiceState) => mapVoiceStateUpdate(rawVoiceState, data.id))
    .filter((update): update is VoiceStateUpdate => update !== null);
}

export function extractReadyVoiceStates(data: unknown): VoiceStateUpdate[] {
  if (!isObject(data) || !Array.isArray(data.guilds)) return [];
  const updates: VoiceStateUpdate[] = [];
  for (const guild of data.guilds) {
    updates.push(...extractGuildVoiceStates(guild));
  }
  return updates;
}

export function mapVoiceServerUpdate(data: unknown): VoiceServerUpdate | null {
  if (!isObject(data) || typeof data.token !== "string") return null;
  return {
    token: data.token,
    endpoint: typeof data.endpoint === "string" ? data.endpoint : null,
    guildId: typeof data.guild_id === "string" ? data.guild_id : null,
  };
}

export function mapCallGatewayEvent(data: unknown): CallGatewayEvent | null {
  if (!isObject(data) || typeof data.channel_id !== "string") return null;
  const voiceStates = Array.isArray(data.voice_states)
    ? data.voice_states
      .map(mapCallGatewayVoiceState)
      .filter((state): state is CallGatewayVoiceState => state !== null)
    : [];
  const voiceStateUserIds = voiceStates.map((state) => state.userId);
  return {
    channelId: data.channel_id,
    ringingUserIds: Array.isArray(data.ringing)
      ? data.ringing.map(snowflakeToString).filter((userId): userId is string => Boolean(userId))
      : [],
    region: typeof data.region === "string" ? data.region : null,
    voiceStateUserIds,
    voiceStates,
    isActive: typeof data.message_id === "string" || voiceStateUserIds.length > 0,
  };
}

export function mapStreamCreateEvent(data: unknown): StreamCreateEvent | null {
  if (!isObject(data) || typeof data.stream_key !== "string") return null;
  const rtcServerId = snowflakeToString(data.rtc_server_id);
  const rtcChannelId = snowflakeToString(data.rtc_channel_id);
  if (!rtcServerId || !rtcChannelId) return null;
  return {
    streamKey: data.stream_key,
    rtcServerId,
    rtcChannelId,
    region: typeof data.region === "string" ? data.region : null,
    viewerIds: Array.isArray(data.viewer_ids)
      ? data.viewer_ids.map(snowflakeToString).filter((id): id is string => Boolean(id))
      : [],
    paused: Boolean(data.paused),
  };
}

export function mapStreamServerUpdateEvent(data: unknown): StreamServerUpdateEvent | null {
  if (!isObject(data) || typeof data.stream_key !== "string" || typeof data.token !== "string") return null;
  return {
    streamKey: data.stream_key,
    token: data.token,
    endpoint: typeof data.endpoint === "string" ? data.endpoint : null,
  };
}

export function mapStreamDeleteEvent(data: unknown): StreamDeleteEvent | null {
  if (!isObject(data) || typeof data.stream_key !== "string") return null;
  return {
    streamKey: data.stream_key,
    reason: typeof data.reason === "string" ? data.reason : "unknown",
    unavailable: Boolean(data.unavailable),
  };
}

function mapCallGatewayVoiceState(data: unknown): CallGatewayVoiceState | null {
  if (!isObject(data)) return null;
  const userId = snowflakeToString(data.user_id);
  if (!userId) return null;
  return {
    userId,
    selfMute: Boolean(data.self_mute),
    selfDeaf: Boolean(data.self_deaf),
    mute: Boolean(data.mute),
    deaf: Boolean(data.deaf),
  };
}

export function mapGuildMembersChunk(data: unknown): { guildId: string; members: DiscordGuildMember[] } | null {
  if (!isObject(data) || typeof data.guild_id !== "string" || !Array.isArray(data.members)) return null;
  return {
    guildId: data.guild_id,
    members: data.members.map(mapGatewayMember).filter((member): member is DiscordGuildMember => member !== null),
  };
}

function mapGatewayMember(data: unknown): DiscordGuildMember | null {
  if (!isObject(data)) return null;
  const user = isObject(data.user) ? data.user : null;
  const userId = typeof user?.id === "string" ? user.id : typeof data.user_id === "string" ? data.user_id : null;
  if (!userId) return null;

  const username = displayNameField(user?.username)
    ?? displayNameField(user?.global_name)
    ?? displayNameField(user?.display_name)
    ?? displayNameField(data.nick)
    ?? userId;
  const displayName = displayNameField(user?.global_name)
    ?? displayNameField(user?.display_name)
    ?? displayNameField(user?.username)
    ?? displayNameField(data.nick)
    ?? username;

  return {
    id: userId,
    username,
    displayName,
    bot: Boolean(user?.bot),
    ...(typeof user?.avatar === "string" ? { avatar: user.avatar } : {}),
    roleIds: Array.isArray(data.roles) ? data.roles.filter((roleId): roleId is string => typeof roleId === "string") : undefined,
  };
}

function mapGatewayGuild(data: unknown): DiscordGuild | null {
  if (!isObject(data)) return null;
  const properties = isObject(data.properties) ? data.properties : data;
  const id = typeof data.id === "string"
    ? data.id
    : typeof properties.id === "string"
      ? properties.id
      : null;
  const name = typeof properties.name === "string" ? properties.name : null;
  if (!id || !name) return null;
  return {
    id,
    name,
    icon: typeof properties.icon === "string" ? properties.icon : null,
  };
}

export function extractReadyGuilds(data: unknown): DiscordGuild[] {
  if (!isObject(data) || !Array.isArray(data.guilds)) return [];
  return data.guilds
    .map(mapGatewayGuild)
    .filter((guild): guild is DiscordGuild => guild !== null);
}

export function extractCurrentUserRoleIdsByGuildId(data: unknown): Record<string, string[]> {
  if (!isObject(data)) return {};
  const guilds = Array.isArray(data.guilds) ? data.guilds : [];
  const mergedMembers = Array.isArray(data.merged_members) ? data.merged_members : [];
  const rolesByGuildId: Record<string, string[]> = {};

  guilds.forEach((guild, index) => {
    if (!isObject(guild) || typeof guild.id !== "string") return;
    const guildMembers = mergedMembers[index];
    if (!Array.isArray(guildMembers)) return;
    const currentMember = guildMembers.find((member) => isObject(member) && Array.isArray(member.roles));
    if (!isObject(currentMember) || !Array.isArray(currentMember.roles)) return;
    rolesByGuildId[guild.id] = currentMember.roles.filter((roleId): roleId is string => typeof roleId === "string");
  });

  return rolesByGuildId;
}

export function extractGuildMuteSettings(data: unknown): Record<string, boolean> {
  if (!isObject(data)) return {};
  const settings = isObject(data.user_guild_settings) && Array.isArray(data.user_guild_settings.entries)
    ? data.user_guild_settings.entries
    : [];
  const mutedByGuildId: Record<string, boolean> = {};
  for (const setting of settings) {
    if (!isObject(setting) || typeof setting.guild_id !== "string" || typeof setting.muted !== "boolean") continue;
    mutedByGuildId[setting.guild_id] = setting.muted;
  }
  return mutedByGuildId;
}

function channelMuteSettingsFromOverrides(channelOverrides: unknown): Record<string, boolean> {
  const mutedByChannelId: Record<string, boolean> = {};

  if (Array.isArray(channelOverrides)) {
    for (const override of channelOverrides) {
      if (!isObject(override) || typeof override.channel_id !== "string" || typeof override.muted !== "boolean") continue;
      mutedByChannelId[override.channel_id] = override.muted;
    }
    return mutedByChannelId;
  }

  if (isObject(channelOverrides)) {
    for (const [channelId, override] of Object.entries(channelOverrides)) {
      if (!isObject(override) || typeof override.muted !== "boolean") continue;
      mutedByChannelId[channelId] = override.muted;
    }
  }

  return mutedByChannelId;
}

function channelMuteSettingsFromEntry(entry: unknown): Record<string, boolean> {
  if (!isObject(entry)) return {};
  return channelMuteSettingsFromOverrides(entry.channel_overrides);
}

export function extractChannelMuteSettings(data: unknown): Record<string, boolean> {
  if (!isObject(data)) return {};
  const settings = isObject(data.user_guild_settings) && Array.isArray(data.user_guild_settings.entries)
    ? data.user_guild_settings.entries
    : [];
  const mutedByChannelId: Record<string, boolean> = {};
  for (const setting of settings) {
    if (!isObject(setting) || typeof setting.guild_id === "string") continue;
    Object.assign(mutedByChannelId, channelMuteSettingsFromEntry(setting));
  }
  return mutedByChannelId;
}

export function extractInitialNotifications(data: unknown): InitialNotification[] {
  if (!isObject(data)) return [];

  const channels = new Map<string, { guildId: string | null; lastMessageId: string | null }>();
  for (const guild of Array.isArray(data.guilds) ? data.guilds : []) {
    if (!isObject(guild) || typeof guild.id !== "string") continue;
    for (const channel of Array.isArray(guild.channels) ? guild.channels : []) {
      collectReadyChannel(channels, channel, guild.id);
    }
    for (const thread of Array.isArray(guild.threads) ? guild.threads : []) {
      collectReadyChannel(channels, thread, guild.id);
    }
  }
  for (const channel of Array.isArray(data.private_channels) ? data.private_channels : []) {
    collectReadyChannel(channels, channel, DIRECT_MESSAGES_GUILD_ID);
  }

  const readStateEntries = isObject(data.read_state) && Array.isArray(data.read_state.entries)
    ? data.read_state.entries
    : Array.isArray(data.read_state)
      ? data.read_state
      : [];
  const notifications: InitialNotification[] = [];
  for (const readState of readStateEntries) {
    if (!isObject(readState) || typeof readState.id !== "string") continue;
    const channel = channels.get(readState.id);
    const count = initialNotificationCount(readState, channel ?? null);
    if (count <= 0) continue;
    notifications.push({
      channelId: readState.id,
      guildId: channel?.guildId ?? null,
      count,
    });
  }
  return notifications;
}

function collectReadyChannel(
  channels: Map<string, { guildId: string | null; lastMessageId: string | null }>,
  channel: unknown,
  guildId: string | null,
): void {
  if (!isObject(channel) || typeof channel.id !== "string") return;
  channels.set(channel.id, {
    guildId,
    lastMessageId: typeof channel.last_message_id === "string" ? channel.last_message_id : null,
  });
}

function initialNotificationCount(
  readState: Record<string, any>,
  channel: { guildId: string | null; lastMessageId: string | null } | null,
): number {
  if (!channel) return 0;
  if (channel.guildId !== DIRECT_MESSAGES_GUILD_ID) {
    return typeof readState.mention_count === "number" && readState.mention_count > 0
      ? readState.mention_count
      : 0;
  }
  if (
    channel.lastMessageId
    && typeof readState.last_message_id === "string"
    && compareSnowflakesDesc(channel.lastMessageId, readState.last_message_id) < 0
  ) {
    return 1;
  }
  return 0;
}

export function typingDisplayName(data: Record<string, any>): string {
  const user = isObject(data.user) ? data.user : null;
  const member = isObject(data.member) ? data.member : null;
  const memberUser = member && isObject(member.user) ? member.user : null;

  const globalName = displayNameField(user?.global_name) ?? displayNameField(memberUser?.global_name);
  const username = displayNameField(user?.username) ?? displayNameField(memberUser?.username);
  const nickname = displayNameField(member?.nick);
  return globalName ?? username ?? nickname ?? String(data.user_id);
}

function displayNameField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function createGatewayProperties(): Record<string, unknown> {
  const locale = (process.env.LC_ALL ?? process.env.LANG ?? "en_US").split(".")[0] || "en_US";
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "x64";

  return {
    os: "Linux",
    browser: "Discord Client",
    release_channel: "stable",
    os_version: release(),
    os_arch: arch,
    app_arch: arch,
    system_locale: locale,
    has_client_mods: false,
    browser_user_agent: GATEWAY_USER_AGENT,
    browser_version: "138.0.7204.251",
    runtime_environment: "native",
    client_build_number: null,
    native_build_number: null,
    client_event_source: null,
    client_app_state: "unfocused",
    is_fast_connect: false,
  };
}

async function fetchGatewayUrl(): Promise<string> {
  const response = await fetch(`${API_BASE}/gateway`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Discord gateway URL (${response.status}).`);
  }

  const body = await response.json() as { url?: string };
  if (!body.url) {
    throw new Error("Discord gateway response did not include a websocket URL.");
  }

  return body.url;
}

function messageDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return String(data);
}

function snowflakeToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return null;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
