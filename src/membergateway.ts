/**
 * Minimal Discord gateway client for guild member list subscriptions.
 *
 * Modeled after Endcord's gateway-driven member list flow:
 * - GET /gateway
 * - open websocket with ?v=9&encoding=json
 * - IDENTIFY with user token + client properties
 * - subscribe with op 37 for the active guild/channel
 * - consume GUILD_MEMBER_LIST_UPDATE payloads
 */

import { release } from "os";

import { debugLog } from "./debuglog";
import type { DiscordGuildMember } from "./discord";

const API_BASE = "https://discord.com/api/v9";
const GATEWAY_VERSION = 9;
const GATEWAY_CAPABILITIES = 30717;
const GATEWAY_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.115 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";

interface GatewayPayload {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

interface MemberListCallbacks {
  onMembers: (members: DiscordGuildMember[]) => void;
  onError: (error: Error) => void;
}

interface ActiveSubscription extends MemberListCallbacks {
  guildId: string;
  channelId: string;
  listId: string | null;
  waitingForSync: boolean;
  rows: GatewayMemberListRow[];
}

export type GatewayMemberListRow =
  | { type: "group"; id: string }
  | { type: "member"; member: DiscordGuildMember };

export class MemberListGatewayClient {
  private gatewayUrl: string | null = null;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 0;
  private seq: number | null = null;
  private manualDisconnect = false;
  private reconnectPromise: Promise<void> | null = null;
  private subscription: ActiveSubscription | null = null;

  constructor(private readonly token: string) {}

  async subscribe(guildId: string, channelId: string, callbacks: MemberListCallbacks): Promise<void> {
    debugLog("member_gateway.subscribe", { guildId, channelId, ready: this.ready, hasSocket: Boolean(this.ws), socketState: this.ws?.readyState ?? null });
    const current = this.subscription;
    if (current && current.guildId === guildId && current.channelId === channelId) {
      current.onMembers = callbacks.onMembers;
      current.onError = callbacks.onError;
      if (current.listId) {
        debugLog("member_gateway.cache_replay", { guildId, channelId, listId: current.listId, rows: current.rows.length });
        callbacks.onMembers(extractGatewayMembers(current.rows));
        return;
      }
    } else {
      const canReplayGuildRows = current?.guildId === guildId && current.rows.length > 0;
      debugLog("member_gateway.subscription_target", {
        guildId,
        channelId,
        previousGuildId: current?.guildId ?? null,
        previousChannelId: current?.channelId ?? null,
        replayRows: canReplayGuildRows ? current.rows.length : 0,
      });
      this.subscription = {
        guildId,
        channelId,
        listId: canReplayGuildRows ? current.listId : null,
        waitingForSync: !canReplayGuildRows,
        rows: canReplayGuildRows ? current.rows : [],
        ...callbacks,
      };
      if (canReplayGuildRows) {
        callbacks.onMembers(extractGatewayMembers(current.rows));
      }
    }

    await this.ensureConnected();
    this.sendSubscription(guildId, channelId);
  }

  disconnect(): void {
    debugLog("member_gateway.disconnect", { guildId: this.subscription?.guildId ?? null, channelId: this.subscription?.channelId ?? null });
    this.subscription = null;
    this.closeSocket(true);
  }

  private async ensureConnected(): Promise<void> {
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    if (!this.gatewayUrl) {
      this.gatewayUrl = await fetchGatewayUrl();
    }

    const gatewayUrl = `${this.gatewayUrl}/?v=${GATEWAY_VERSION}&encoding=json`;
    debugLog("member_gateway.connect", { gatewayUrl: this.gatewayUrl });

    await new Promise<void>((resolve, reject) => {
      this.ready = false;
      this.seq = null;
      this.manualDisconnect = false;
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.ws = new WebSocket(gatewayUrl);
      this.ws.addEventListener("message", this.handleMessage);
      this.ws.addEventListener("close", this.handleClose);
      this.ws.addEventListener("error", this.handleError);
    });
  }

  private handleMessage = (event: MessageEvent<unknown>): void => {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(messageDataToString(event.data)) as GatewayPayload;
    } catch (error) {
      this.failConnection(asError(error, "Failed to parse Discord gateway payload."));
      return;
    }

    if (typeof payload.s === "number") {
      this.seq = payload.s;
    }

    if (payload.op === 10) {
      debugLog("member_gateway.hello");
      const interval = parseHeartbeatInterval(payload.d);
      if (!interval) {
        this.failConnection(new Error("Discord gateway did not provide a heartbeat interval."));
        return;
      }
      this.startHeartbeat(interval);
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
      return;
    }

    if (payload.op === 11) {
      return;
    }

    if (payload.op === 7 || payload.op === 9) {
      debugLog("member_gateway.reconnect_requested", { op: payload.op });
      void this.reconnect();
      return;
    }

    if (payload.t === "READY") {
      debugLog("member_gateway.ready");
      this.ready = true;
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    if (payload.t === "GUILD_MEMBER_LIST_UPDATE") {
      this.handleMemberListUpdate(payload.d);
    }
  };

  private handleClose = (event: CloseEvent): void => {
    debugLog("member_gateway.close", { code: event.code, reason: event.reason || null, manualDisconnect: this.manualDisconnect, wasReady: this.ready });
    const error = new Error(
      event.reason
        ? `Discord member list gateway closed: ${event.reason}`
        : `Discord member list gateway closed (code ${event.code}).`,
    );
    const manualDisconnect = this.manualDisconnect;
    this.cleanupSocketState();

    if (!manualDisconnect) {
      this.readyReject?.(error);
      this.readyResolve = null;
      this.readyReject = null;
      this.subscription?.onError(error);
    }
  };

  private handleError = (): void => {
    debugLog("member_gateway.error", { ready: this.ready });
    if (!this.ready) {
      this.readyReject?.(new Error("Could not connect to the Discord member list gateway."));
      this.readyResolve = null;
      this.readyReject = null;
    }
  };

  private handleMemberListUpdate(data: unknown): void {
    const subscription = this.subscription;
    if (!subscription) {
      debugLog("member_gateway.update_ignored", { reason: "no_subscription", summary: summarizeMemberListUpdate(data) });
      return;
    }
    if (!isObject(data)) {
      debugLog("member_gateway.update_ignored", { reason: "malformed", guildId: subscription.guildId, channelId: subscription.channelId });
      return;
    }

    const guildId = typeof data.guild_id === "string" ? data.guild_id : null;
    if (!guildId || guildId !== subscription.guildId) {
      debugLog("member_gateway.update_ignored", { reason: "guild_mismatch", expectedGuildId: subscription.guildId, actualGuildId: guildId, channelId: subscription.channelId, summary: summarizeMemberListUpdate(data) });
      return;
    }

    const listId = typeof data.id === "string" ? data.id : null;
    const ops = Array.isArray(data.ops) ? data.ops : [];
    const hasInitialSync = ops.some(isInitialSyncOp);
    debugLog("member_gateway.update", { guildId, channelId: subscription.channelId, listId, waitingForSync: subscription.waitingForSync, hasInitialSync, rowsBefore: subscription.rows.length, ops: summarizeMemberListOps(ops) });

    if (subscription.waitingForSync) {
      if (!hasInitialSync || !listId) {
        debugLog("member_gateway.update_ignored", { reason: !listId ? "missing_list_id" : "waiting_for_initial_sync", guildId, channelId: subscription.channelId, listId, ops: summarizeMemberListOps(ops) });
        return;
      }
      subscription.listId = listId;
      subscription.waitingForSync = false;
      subscription.rows = applyGatewayMemberListOps([], ops);
      const members = extractGatewayMembers(subscription.rows);
      debugLog("member_gateway.members", { guildId, channelId: subscription.channelId, listId, rows: subscription.rows.length, members: members.length, initial: true });
      subscription.onMembers(members);
      return;
    }

    if (listId && subscription.listId !== listId && hasInitialSync) {
      debugLog("member_gateway.list_replaced", { guildId, channelId: subscription.channelId, previousListId: subscription.listId, nextListId: listId });
      subscription.listId = listId;
      subscription.rows = applyGatewayMemberListOps([], ops);
      const members = extractGatewayMembers(subscription.rows);
      debugLog("member_gateway.members", { guildId, channelId: subscription.channelId, listId, rows: subscription.rows.length, members: members.length, initial: true });
      subscription.onMembers(members);
      return;
    }

    if (!listId || subscription.listId !== listId) {
      debugLog("member_gateway.update_ignored", { reason: !listId ? "missing_list_id" : "list_id_mismatch", guildId, channelId: subscription.channelId, expectedListId: subscription.listId, actualListId: listId, ops: summarizeMemberListOps(ops) });
      return;
    }

    subscription.rows = applyGatewayMemberListOps(subscription.rows, ops);
    const members = extractGatewayMembers(subscription.rows);
    debugLog("member_gateway.members", { guildId, channelId: subscription.channelId, listId, rows: subscription.rows.length, members: members.length, initial: false });
    subscription.onMembers(members);
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatIntervalMs = intervalMs;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.seq });
    }, Math.max(1_000, this.heartbeatIntervalMs));
  }

  private sendSubscription(guildId: string, channelId: string): void {
    if (!this.ready) {
      debugLog("member_gateway.subscribe_skipped", { guildId, channelId, reason: "not_ready" });
      return;
    }
    debugLog("member_gateway.send_subscription", { guildId, channelId, range: [0, 99] });
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      debugLog("member_gateway.send_skipped", { socketState: this.ws?.readyState ?? null });
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private async reconnect(): Promise<void> {
    const subscription = this.subscription;
    if (!subscription) return;
    debugLog("member_gateway.reconnect", { guildId: subscription.guildId, channelId: subscription.channelId });
    if (this.reconnectPromise) return this.reconnectPromise;

    this.reconnectPromise = (async () => {
      subscription.listId = null;
      subscription.waitingForSync = true;
      subscription.rows = [];

      this.resetSocket();
      await this.ensureConnected();

      if (!this.subscription) return;
      if (this.subscription.guildId !== subscription.guildId || this.subscription.channelId !== subscription.channelId) {
        return;
      }

      this.sendSubscription(subscription.guildId, subscription.channelId);
    })().catch((error) => {
      if (this.subscription !== subscription) return;
      subscription.onError(asError(error, "Failed to reconnect Discord member list gateway."));
    }).finally(() => {
      this.reconnectPromise = null;
    });

    return this.reconnectPromise;
  }

  private failConnection(error: Error): void {
    debugLog("member_gateway.fail_connection", { error: error.message });
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.subscription?.onError(error);
    this.closeSocket(true);
  }

  private closeSocket(manualDisconnect: boolean): void {
    this.manualDisconnect = manualDisconnect;
    if (manualDisconnect && !this.ready) {
      this.readyReject?.(new Error("Discord member list gateway disconnected."));
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
      return;
    }
    this.cleanupSocketState();
  }

  private resetSocket(): void {
    const socket = this.ws;
    if (socket) {
      socket.removeEventListener("message", this.handleMessage);
      socket.removeEventListener("close", this.handleClose);
      socket.removeEventListener("error", this.handleError);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }

    this.connectPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.cleanupSocketState();
  }

  private cleanupSocketState(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.removeEventListener("message", this.handleMessage);
      this.ws.removeEventListener("close", this.handleClose);
      this.ws.removeEventListener("error", this.handleError);
    }
    this.ws = null;
    this.ready = false;
    this.seq = null;
    this.heartbeatIntervalMs = 0;
  }
}

export function applyGatewayMemberListOps(existingRows: GatewayMemberListRow[], ops: unknown[]): GatewayMemberListRow[] {
  let rows = [...existingRows];

  for (const rawOp of ops) {
    if (!isObject(rawOp) || typeof rawOp.op !== "string") continue;

    switch (rawOp.op) {
      case "SYNC": {
        const range = Array.isArray(rawOp.range) ? rawOp.range : [];
        if (range[0] !== 0) break;
        rows = Array.isArray(rawOp.items)
          ? rawOp.items.map(gatewayRowFromItem).filter((row): row is GatewayMemberListRow => row !== null)
          : [];
        break;
      }
      case "DELETE": {
        const index = typeof rawOp.index === "number" ? rawOp.index : -1;
        if (index >= 0 && index < rows.length) {
          rows.splice(index, 1);
        }
        break;
      }
      case "UPDATE": {
        const index = typeof rawOp.index === "number" ? rawOp.index : -1;
        const row = gatewayRowFromItem(rawOp.item);
        if (!row) break;
        updateGatewayRow(rows, index, row);
        break;
      }
      case "INSERT": {
        const index = typeof rawOp.index === "number" ? rawOp.index : -1;
        const row = gatewayRowFromItem(rawOp.item);
        if (!row || index < 0) break;
        rows.splice(Math.min(index, rows.length), 0, row);
        break;
      }
      default:
        break;
    }
  }

  return rows;
}

export function extractGatewayMembers(rows: GatewayMemberListRow[]): DiscordGuildMember[] {
  return rows.flatMap((row) => row.type === "member" ? [row.member] : []);
}

function updateGatewayRow(rows: GatewayMemberListRow[], index: number, nextRow: GatewayMemberListRow): void {
  const nextIdentity = gatewayRowIdentity(nextRow);
  if (nextIdentity === null) return;

  if (index >= 0 && index < rows.length && gatewayRowIdentity(rows[index]!) === nextIdentity) {
    rows[index] = nextRow;
    return;
  }

  const existingIndex = rows.findIndex((row) => gatewayRowIdentity(row) === nextIdentity);
  if (existingIndex >= 0) {
    rows[existingIndex] = nextRow;
  }
}

function gatewayRowIdentity(row: GatewayMemberListRow): string | null {
  return row.type === "group" ? `group:${row.id}` : `member:${row.member.id}`;
}

function gatewayRowFromItem(item: unknown): GatewayMemberListRow | null {
  if (!isObject(item)) return null;

  if (isObject(item.group) && typeof item.group.id === "string") {
    return { type: "group", id: item.group.id };
  }

  const member = gatewayMemberFromPayload(item.member);
  return member ? { type: "member", member } : null;
}

function gatewayMemberFromPayload(payload: unknown): DiscordGuildMember | null {
  if (!isObject(payload) || !isObject(payload.user) || typeof payload.user.id !== "string" || typeof payload.user.username !== "string") {
    return null;
  }

  const globalName = typeof payload.user.global_name === "string" && payload.user.global_name.trim()
    ? payload.user.global_name
    : null;
  const displayName = typeof payload.user.display_name === "string" && payload.user.display_name.trim()
    ? payload.user.display_name
    : null;

  return {
    id: payload.user.id,
    username: payload.user.username,
    displayName: globalName ?? displayName ?? payload.user.username,
    bot: Boolean(payload.user.bot),
    roleIds: Array.isArray(payload.roles) ? payload.roles.filter((roleId): roleId is string => typeof roleId === "string") : undefined,
  };
}

function isInitialSyncOp(op: unknown): boolean {
  return isObject(op)
    && op.op === "SYNC"
    && Array.isArray(op.range)
    && op.range[0] === 0;
}

function summarizeMemberListUpdate(data: unknown): Record<string, unknown> | null {
  if (!isObject(data)) return null;
  return {
    guildId: typeof data.guild_id === "string" ? data.guild_id : null,
    id: typeof data.id === "string" ? data.id : null,
    ops: Array.isArray(data.ops) ? summarizeMemberListOps(data.ops) : [],
  };
}

function summarizeMemberListOps(ops: unknown[]): Record<string, unknown>[] {
  return ops.map((op) => {
    if (!isObject(op)) return { op: "malformed" };
    const summary: Record<string, unknown> = { op: typeof op.op === "string" ? op.op : "unknown" };
    if (Array.isArray(op.range)) summary.range = op.range.slice(0, 2);
    if (typeof op.index === "number") summary.index = op.index;
    if (Array.isArray(op.items)) {
      summary.items = op.items.length;
      summary.memberItems = op.items.filter((item) => isObject(item) && isObject(item.member)).length;
      summary.groupItems = op.items.filter((item) => isObject(item) && isObject(item.group)).length;
    }
    if (isObject(op.item)) {
      summary.item = isObject(op.item.member) ? "member" : isObject(op.item.group) ? "group" : "unknown";
    }
    return summary;
  });
}

function parseHeartbeatInterval(data: unknown): number | null {
  if (!isObject(data) || typeof data.heartbeat_interval !== "number") return null;
  return data.heartbeat_interval;
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
