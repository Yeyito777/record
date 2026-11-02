/**
 * The Discord bridge's gateway connection: record's own (src/appgateway.ts)
 * on the wire, payload for payload (the identify with its capabilities,
 * properties and presence, the op 40 heartbeat, resuming, op 37
 * subscriptions, op 8 member lookups at most one a second), without the
 * voice, call and stream code it carries, so the bridge loads none of it.
 * It never sends a voice state (op 4). Its presence is the provider's: the
 * identify carries it, and a presence update (op 3) goes out only when the
 * provider's wanted presence changes (`setPresence`).
 *
 * Dispatches go to the provider raw (`t`, `d`); READY is parsed once and
 * handed over whole, for the provider to keep what it needs.
 */

import { release } from "node:os";

import { normalizeToken } from "../../../token";

const API_BASE = "https://discord.com/api/v9";
const GATEWAY_VERSION = 9;
const GATEWAY_CAPABILITIES = 30717;
const GATEWAY_QOS_HEARTBEAT_VERSION = 29;
const GATEWAY_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.115 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const GATEWAY_RECONNECT_CLOSE_CODE = 4000;
const GATEWAY_RESUME_MAX_HEARTBEAT_ACK_AGE_MS = 3 * 60 * 1_000;
const MEMBER_REQUEST_INTERVAL_MS = 1_000;
const MAX_MEMBER_REQUEST_USER_IDS = 100;

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

export interface GatewayHandlers {
  /** READY (a fresh session) or RESUMED (`data` null): events flow again. */
  ready(data: any | null): void;
  dispatch(type: string, data: any): void;
  /** The connection dropped; it reconnects by itself unless `fatal`. */
  lost(fatal: boolean, code: number | null): void;
  /** READY carried a refreshed token (record's AUTH_TOKEN_REFRESH). */
  token?(token: string): void;
  /** Every heartbeat (about every 41 s while connected): a moment to look around. */
  tick?(): void;
}

export interface Presence {
  status: PresenceStatus;
  afk: boolean;
}

export interface GatewayOptions {
  /** The presence the identify carries. */
  presence: () => Presence;
  /** Defaults: the global fetch and WebSocket (fixtures pass the demo's). */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  now?: () => number;
}

/** record's identify properties (appgateway.ts createGatewayProperties). */
export function gatewayProperties(): Record<string, unknown> {
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

export class DiscordGateway {
  private gatewayUrl: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private lastHeartbeatAckAt: number | null = null;
  private heartbeatAwaitingAck = false;
  private reconnectAttempt = 0;
  private stopped = true;
  private connecting = false;
  private isReady = false;
  /** Guild → the channel subscribed in it (op 37), re-sent after a resume. */
  private readonly subscriptions = new Map<string, string | null>();
  private readonly memberQueue = new Map<string, Set<string>>();
  private memberTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMemberRequestAt = 0;
  /** READY's size in characters (the log; the bridge's largest parse). */
  readyChars = 0;
  /** The presence this session has: the identify's, or the last op 3. */
  private presence: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly now: () => number;

  constructor(private token: string, private readonly handlers: GatewayHandlers, private readonly options: GatewayOptions) {
    this.fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch;
    this.WebSocketImpl = options.WebSocket ?? WebSocket;
    this.now = options.now ?? Date.now;
  }

  get ready(): boolean {
    return this.isReady && this.ws !== null && this.ws.readyState === this.WebSocketImpl.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeSocket(1000);
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.seq = null;
  }

  /**
   * The app shows a channel of `guildId`: typing, threads and the member list
   * there (record's subscribeToGuildChannel). Sent once per guild and channel.
   */
  subscribe(guildId: string, channelId: string | null): void {
    if (this.subscriptions.has(guildId) && this.subscriptions.get(guildId) === channelId) return;
    this.subscriptions.set(guildId, channelId);
    if (this.ready) this.sendSubscription(guildId, channelId);
  }

  /** Member names and roles for these users (merged per guild, one request a second). */
  requestMembers(guildId: string, userIds: readonly string[]): void {
    if (!this.ready || userIds.length === 0) return;
    const queued = this.memberQueue.get(guildId) ?? new Set<string>();
    for (const id of userIds) queued.add(id);
    this.memberQueue.set(guildId, queued);
    this.scheduleMembers(0);
  }

  private scheduleMembers(delay: number): void {
    if (this.memberTimer) return;
    const wait = Math.max(delay, this.lastMemberRequestAt + MEMBER_REQUEST_INTERVAL_MS - this.now());
    this.memberTimer = setTimeout(() => {
      this.memberTimer = null;
      this.sendMembers();
    }, Math.max(0, wait));
  }

  private sendMembers(): void {
    if (!this.ready) {
      this.memberQueue.clear();
      return;
    }
    const next = this.memberQueue.entries().next();
    if (next.done) return;
    const [guildId, queued] = next.value;
    const ids = [...queued].slice(0, MAX_MEMBER_REQUEST_USER_IDS);
    for (const id of ids) queued.delete(id);
    this.memberQueue.delete(guildId);
    if (queued.size > 0) this.memberQueue.set(guildId, queued);
    this.lastMemberRequestAt = this.now();
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
    if (this.memberQueue.size > 0) this.scheduleMembers(MEMBER_REQUEST_INTERVAL_MS);
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    try {
      if (!this.gatewayUrl) {
        const response = await this.fetchImpl(`${API_BASE}/gateway`);
        if (!response.ok) throw new Error(`gateway url HTTP ${response.status}`);
        const body = await response.json() as { url?: string };
        if (!body.url) throw new Error("no gateway url");
        this.gatewayUrl = body.url;
      }
      if (this.stopped) return;
      const base = this.sessionId && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.gatewayUrl;
      const separator = base.includes("?") ? "&" : "/?";
      const ws = new this.WebSocketImpl(`${base}${separator}v=${GATEWAY_VERSION}&encoding=json`);
      this.ws = ws;
      ws.addEventListener("message", this.onMessage);
      ws.addEventListener("close", this.onClose);
      ws.addEventListener("error", this.onError);
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    let payload: { op: number; t?: string | null; s?: number | null; d?: any };
    const text = messageText(event.data);
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (payload.t === "READY") this.readyChars = text.length;
    if (typeof payload.s === "number") this.seq = payload.s;
    switch (payload.op) {
      case 10:
        this.hello(payload.d);
        return;
      case 11:
        this.lastHeartbeatAckAt = this.now();
        this.heartbeatAwaitingAck = false;
        return;
      case 1:
        this.sendHeartbeat();
        return;
      case 7:
        this.scheduleReconnect(0, GATEWAY_RECONNECT_CLOSE_CODE);
        return;
      case 9: {
        const resumable = payload.d === true;
        if (!resumable || !this.canResume()) {
          this.sessionId = null;
          this.resumeGatewayUrl = null;
          this.seq = null;
        }
        this.scheduleReconnect(resumable ? 0 : undefined, this.sessionId ? GATEWAY_RECONNECT_CLOSE_CODE : undefined);
        return;
      }
      case 0:
        break;
      default:
        return;
    }
    const type = payload.t ?? "";
    if (type === "READY") {
      const data = payload.d ?? {};
      this.reconnectAttempt = 0;
      this.isReady = true;
      this.sessionId = typeof data.session_id === "string" ? data.session_id : null;
      this.resumeGatewayUrl = gatewayBase(data.resume_gateway_url) ?? this.resumeGatewayUrl;
      const refreshed = typeof data.auth_token === "string" ? normalizeToken(data.auth_token) : "";
      if (refreshed && refreshed !== this.token) {
        this.token = refreshed;
        this.handlers.token?.(this.token);
      }
      this.handlers.ready(data);
      this.sendSubscriptions();
      return;
    }
    if (type === "RESUMED") {
      this.reconnectAttempt = 0;
      this.isReady = true;
      this.handlers.ready(null);
      this.sendSubscriptions();
      return;
    }
    try {
      this.handlers.dispatch(type, payload.d);
    } catch {
      // One bad event never takes the connection down.
    }
  };

  private hello(data: any): void {
    const interval = typeof data?.heartbeat_interval === "number" ? data.heartbeat_interval : null;
    if (!interval) {
      this.scheduleReconnect();
      return;
    }
    this.startHeartbeat(interval);
    if (this.canResume()) {
      this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
      this.lastHeartbeatAckAt = this.now();
      return;
    }
    this.seq = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.lastHeartbeatAckAt = this.now();
    const presence = this.options.presence();
    this.presence = JSON.stringify(presence);
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: GATEWAY_CAPABILITIES,
        properties: gatewayProperties(),
        presence: { activities: [], status: presence.status, since: null, afk: presence.afk },
      },
    });
  }

  private canResume(): boolean {
    if (!this.sessionId) return false;
    const age = this.lastHeartbeatAckAt === null ? null : this.now() - this.lastHeartbeatAckAt;
    return age === null || age <= GATEWAY_RESUME_MAX_HEARTBEAT_ACK_AGE_MS;
  }

  private readonly onClose = (event: CloseEvent): void => {
    if (event.code === 4007 || event.code === 4009) {
      this.sessionId = null;
      this.resumeGatewayUrl = null;
      this.seq = null;
    }
    this.closeSocket();
    if (this.stopped) return;
    // 4004: the token was refused; 4010-4014: nothing a retry would fix.
    const fatal = event.code === 4004 || (event.code >= 4010 && event.code <= 4014);
    this.handlers.lost(fatal, event.code);
    if (fatal) {
      this.stopped = true;
      return;
    }
    this.scheduleReconnect();
  };

  private readonly onError = (): void => {
    // A close follows.
  };

  private startHeartbeat(interval: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatAwaitingAck = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatAwaitingAck) {
        // No ACK since the last one: a zombie connection (sleep, a network change).
        this.scheduleReconnect(0, GATEWAY_RECONNECT_CLOSE_CODE);
        return;
      }
      this.heartbeatAwaitingAck = true;
      this.sendHeartbeat();
      this.handlers.tick?.();
    }, Math.max(1_000, interval));
  }

  private sendHeartbeat(): void {
    this.send({ op: 40, d: { seq: this.seq, qos: { active: true, ver: GATEWAY_QOS_HEARTBEAT_VERSION, reasons: ["foregrounded"] } } });
  }

  private scheduleReconnect(delay?: number, closeCode?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const wasOpen = this.ws !== null;
    this.closeSocket(closeCode);
    if (wasOpen) this.handlers.lost(false, closeCode ?? null);
    const attempt = ++this.reconnectAttempt;
    const wait = delay ?? Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  /**
   * The session's presence should be `presence`: a presence update (op 3,
   * record's sendPresenceUpdate) when it differs from what the session has.
   */
  setPresence(presence: Presence): void {
    const key = JSON.stringify(presence);
    if (key === this.presence || !this.ready) return;
    this.presence = key;
    this.send({ op: 3, d: { status: presence.status, afk: presence.afk, since: 0, activities: [] } });
  }

  /** Reconnect now (the network came back, the screen woke and the link looks stale). */
  nudge(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempt = 0;
      void this.connect();
    }
  }

  private sendSubscription(guildId: string, channelId: string | null): void {
    this.send({
      op: 37,
      d: {
        subscriptions: {
          [guildId]: channelId
            ? { typing: true, activities: true, threads: true, channels: { [channelId]: [[0, 99]] } }
            : { typing: true, activities: true, threads: true },
        },
      },
    });
  }

  private sendSubscriptions(): void {
    for (const [guildId, channelId] of this.subscriptions) this.sendSubscription(guildId, channelId);
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private closeSocket(code?: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.memberTimer) clearTimeout(this.memberTimer);
    this.memberTimer = null;
    this.memberQueue.clear();
    this.isReady = false;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeEventListener("message", this.onMessage);
    ws.removeEventListener("close", this.onClose);
    ws.removeEventListener("error", this.onError);
    if (ws.readyState === this.WebSocketImpl.OPEN || ws.readyState === this.WebSocketImpl.CONNECTING) ws.close(code);
  }
}

function gatewayBase(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return String(data);
}
