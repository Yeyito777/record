/**
 * Read-only Discord gateway client for live app events.
 */

import { release } from "os";

import {
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

export interface AppGatewayCallbacks {
  onMessageCreate: (message: DiscordMessage) => void;
  onMessageUpdate: (patch: DiscordMessagePatch) => void;
  onMessageDelete: (channelId: string, messageId: string) => void;
  onMessageDeleteBulk: (channelId: string, messageIds: string[]) => void;
  onChannelCreate: (channel: DiscordChannel) => void;
  onChannelUpdate: (channel: DiscordChannel) => void;
  onChannelDelete: (channelId: string, guildId: string | null) => void;
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

  constructor(
    private readonly token: string,
    private readonly callbacks: AppGatewayCallbacks,
  ) {}

  start(): void {
    if (this.ws || this.connecting) return;
    this.manualDisconnect = false;
    void this.connect();
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
      this.sessionId = isObject(payload.d) && typeof payload.d.session_id === "string" ? payload.d.session_id : null;
      return;
    }

    if (payload.t === "RESUMED") {
      this.reconnectAttempt = 0;
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

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private closeSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
