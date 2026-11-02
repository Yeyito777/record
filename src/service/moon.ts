/**
 * The bridge's two Moon peers: Moon's control socket (one command per
 * connection: `state`, `badge APP N`; OSS-Phone-V1 docs/app-services.md)
 * and moon-notifyd (a long-lived JSON-lines connection: `notify.post`,
 * `notify.withdraw`; docs/notifications-protocol.md). Either may be absent
 * (Android mode, a restart, a sandbox): every call is best effort, bounded
 * in time, and never throws.
 */

import { createConnection, type Socket } from "node:net";

export const MOON_SOCKET = "/run/a26-shell/control.sock";
export const NOTIFY_SOCKET = "/run/moon-notify/notify.sock";

export interface MoonView {
  /** Moon's view: an app id, `home`, `lock`, … */
  view: string | null;
  screenAwake: boolean;
  locked: boolean;
}

export interface MoonLink {
  /** Moon's view right now, or null when Moon cannot be asked. */
  view(): Promise<MoonView | null>;
  /** Sets APP's icon badge; false when Moon refused or is absent. */
  badge(app: string, count: number): Promise<boolean>;
  /** Posts a notification; resolves with its id, or null. */
  post(notification: Record<string, unknown>): Promise<string | null>;
  withdraw(app: string, tag: string): Promise<boolean>;
  /** The tags of APP's notifications now up, or null. */
  list(app: string): Promise<string[] | null>;
  close(): void;
}

/** One request on Moon's control socket: the parsed JSON reply, or null. */
export function moonRequest(socketPath: string, command: string, timeoutMs = 600): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    let reply = "";
    const done = (value: any | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.setEncoding("utf8");
    // Moon answers the line and closes the connection. Not half-closed
    // (`end`): a Bun socket that ended its side reads no answer.
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk) => {
      reply += chunk;
      if (reply.length > 4 * 1024 * 1024) done(null);
    });
    socket.on("end", () => {
      try { done(JSON.parse(reply)); } catch { done(null); }
    });
    socket.on("error", () => done(null));
  });
}

export function parseMoonView(reply: any): MoonView | null {
  const result = reply?.result;
  if (!reply?.ok || typeof result !== "object" || result === null) return null;
  return {
    view: typeof result.view === "string" ? result.view : null,
    screenAwake: result.screen_awake === true,
    locked: result.locked !== false,
  };
}

/** A JSON-lines client of moon-notifyd that reconnects when it is needed. */
class NotifyClient {
  private socket: Socket | null = null;
  private connecting: Promise<Socket | null> | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (reply: any | null) => void>();

  constructor(private readonly path: string) {}

  private connect(): Promise<Socket | null> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve) => {
      const socket = createConnection(this.path);
      const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 1000);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve(socket);
      });
      socket.on("data", (chunk: string) => this.read(chunk));
      const drop = () => {
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        for (const answer of this.pending.values()) answer(null);
        this.pending.clear();
        this.buffer = "";
        resolve(null);
      };
      socket.on("error", drop);
      socket.on("close", drop);
    }).finally(() => { this.connecting = null; }) as Promise<Socket | null>;
    return this.connecting;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let reply: any;
      try { reply = JSON.parse(line); } catch { continue; }
      if (typeof reply?.id !== "number") continue;
      const answer = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      answer?.(reply);
    }
  }

  async request(cmd: string, args: Record<string, unknown>, timeoutMs = 1500): Promise<any | null> {
    const socket = await this.connect();
    if (!socket) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

export function createMoonLink(options: { moonSocket?: string; notifySocket?: string } = {}): MoonLink {
  const moonSocket = options.moonSocket ?? process.env.A26_SHELL_SOCKET ?? MOON_SOCKET;
  const notify = new NotifyClient(options.notifySocket ?? process.env.MOON_NOTIFY_SOCKET ?? NOTIFY_SOCKET);
  return {
    async view() {
      return parseMoonView(await moonRequest(moonSocket, "state", 600));
    },
    async badge(app, count) {
      const reply = await moonRequest(moonSocket, `badge ${app} ${Math.max(0, Math.min(99999, Math.floor(count)))}`);
      return reply?.ok === true;
    },
    async post(notification) {
      const reply = await notify.request("notify.post", notification);
      return reply?.ok ? String(reply.result?.id ?? "") || null : null;
    },
    async withdraw(app, tag) {
      const reply = await notify.request("notify.withdraw", { app, tag });
      return reply?.ok === true || reply?.error?.code === "not_found";
    },
    async list(app) {
      const reply = await notify.request("notify.list", { app });
      if (!reply?.ok || !Array.isArray(reply.result?.notifications)) return null;
      return reply.result.notifications.map((n: any) => n?.tag).filter((tag: unknown) => typeof tag === "string");
    },
    close() {
      notify.close();
    },
  };
}

/** No Moon at all (fixtures, sandboxes without their own Moon, tests). */
export function createNullMoonLink(): MoonLink {
  return {
    view: async () => null,
    badge: async () => false,
    post: async () => null,
    withdraw: async () => false,
    list: async () => null,
    close() {},
  };
}
