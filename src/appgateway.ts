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
  mapGuildChannel,
  type DiscordChannel,
  type DiscordChannelResponse,
  type DiscordMessage,
  type DiscordMessagePatch,
  type DiscordMessageResponse,
} from "./discord";

const API_BASE = "https://discord.com/api/v9";
const GATEWAY_VERSION = 9;
const GATEWAY_CAPABILITIES = 30717;
const GATEWAY_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.115 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

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

export interface AppGatewayCallbacks {
  onInitialNotifications: (notifications: InitialNotification[]) => void;
  onGuildMuteSettings?: (mutedByGuildId: Record<string, boolean>) => void;
  onGuildMuteSetting?: (guildId: string, muted: boolean) => void;
  onCurrentUserRoleIds?: (roleIdsByGuildId: Record<string, string[]>) => void;
  onCurrentUserGuildRoles?: (guildId: string, roleIds: string[]) => void;
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

export class AppGatewayClient {
  private gatewayUrl: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private manualDisconnect = false;
  private connecting = false;
  private reconnectAttempt = 0;
  private ready = false;
  private currentUserId: string | null = null;
  private guildChannelSubscription: GuildChannelSubscription | null = null;

  constructor(
    private readonly token: string,
    private readonly callbacks: AppGatewayCallbacks,
  ) {}

  start(): void {
    if (this.ws || this.connecting) return;
    this.manualDisconnect = false;
    void this.connect();
  }

  subscribeToGuildChannel(guildId: string | null | undefined, channelId: string | null | undefined): void {
    if (!guildId || !channelId || guildId === DIRECT_MESSAGES_GUILD_ID) {
      this.guildChannelSubscription = null;
      return;
    }

    this.guildChannelSubscription = { guildId, channelId };
    this.sendGuildChannelSubscription();
  }

  disconnect(): void {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.sessionId = null;
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

      const gatewayUrl = `${this.gatewayUrl}/?v=${GATEWAY_VERSION}&encoding=json`;
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
        return;
      case 7:
        this.scheduleReconnect(0);
        return;
      case 9:
        this.sessionId = null;
        this.scheduleReconnect(0);
        return;
      default:
        break;
    }

    if (payload.t === "READY") {
      this.reconnectAttempt = 0;
      this.ready = true;
      this.currentUserId = extractCurrentUserId(payload.d);
      this.sessionId = isObject(payload.d) && typeof payload.d.session_id === "string" ? payload.d.session_id : null;
      this.callbacks.onCurrentUserRoleIds?.(extractCurrentUserRoleIdsByGuildId(payload.d));
      this.callbacks.onGuildMuteSettings?.(extractGuildMuteSettings(payload.d));
      this.callbacks.onInitialNotifications(extractInitialNotifications(payload.d));
      this.sendGuildChannelSubscription();
      return;
    }

    if (payload.t === "RESUMED") {
      this.reconnectAttempt = 0;
      this.ready = true;
      this.sendGuildChannelSubscription();
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
    if (this.sessionId) {
      this.send({
        op: 6,
        d: {
          token: this.token,
          session_id: this.sessionId,
          seq: this.seq,
        },
      });
      return;
    }

    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: GATEWAY_CAPABILITIES,
        properties: createGatewayProperties(),
        presence: {
          activities: [],
          status: "online",
          since: null,
          afk: false,
        },
      },
    });
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
        case "TYPING_START": {
          if (!isObject(data) || typeof data.channel_id !== "string" || typeof data.user_id !== "string") break;
          this.callbacks.onTypingStart(data.channel_id, data.user_id, typingDisplayName(data));
          break;
        }
        case "GUILD_MEMBER_UPDATE": {
          if (!isObject(data) || typeof data.guild_id !== "string" || !Array.isArray(data.roles)) break;
          const user = isObject(data.user) ? data.user : null;
          if (!this.currentUserId || !user || user.id !== this.currentUserId) break;
          this.callbacks.onCurrentUserGuildRoles?.(data.guild_id, data.roles.filter((roleId): roleId is string => typeof roleId === "string"));
          break;
        }
        case "USER_GUILD_SETTINGS_UPDATE": {
          if (!isObject(data) || typeof data.guild_id !== "string" || typeof data.muted !== "boolean") break;
          this.callbacks.onGuildMuteSetting?.(data.guild_id, data.muted);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.callbacks.onError?.(asError(error, `Failed to handle Discord gateway event ${type ?? "unknown"}.`));
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
    this.closeSocket();
    if (manual) return;

    if (event.code === 4004) {
      this.callbacks.onError?.(new Error("Discord gateway authentication failed."));
      return;
    }

    this.scheduleReconnect();
  };

  private handleError = (): void => {
    if (this.manualDisconnect) return;
    this.callbacks.onError?.(new Error("Discord gateway connection error."));
  };

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.seq });
    }, Math.max(1_000, intervalMs));
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (this.manualDisconnect) return;
    if (this.reconnectTimer) return;

    this.closeSocket();
    const attempt = ++this.reconnectAttempt;
    const delayMs = delayOverride ?? Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1));
    this.callbacks.onReconnect?.(attempt, delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
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

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private closeSocket(): void {
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
      socket.close();
    }
  }
}

export function extractCurrentUserId(data: unknown): string | null {
  if (!isObject(data)) return null;
  const user = isObject(data.user) ? data.user : null;
  return user && typeof user.id === "string" ? user.id : null;
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

function typingDisplayName(data: Record<string, any>): string {
  const member = isObject(data.member) ? data.member : null;
  const user = isObject(data.user) ? data.user : null;
  const nick = member && typeof member.nick === "string" && member.nick.trim() ? member.nick : null;
  const globalName = user && typeof user.global_name === "string" && user.global_name.trim() ? user.global_name : null;
  const username = user && typeof user.username === "string" && user.username.trim() ? user.username : null;
  return nick ?? globalName ?? username ?? String(data.user_id);
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

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
