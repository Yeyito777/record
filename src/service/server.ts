/**
 * The bridge: one service's socket for Moon's apps (docs/social-protocol.md).
 * It answers the protocol's core from what it keeps itself (the status, the
 * settings, the chat list) and hands the rest to the provider, checking the
 * writes guard first. It never waits on an app: a connection whose unread
 * output passes 16 MiB (a frozen app) is dropped, and the app reconnects.
 */

import { existsSync, chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { ChatStore } from "./chatstore";
import { ensurePrivateDir } from "./files";
import { errorText, type Logger } from "./log";
import { MediaCache } from "./media";
import type { MoonLink } from "./moon";
import { Notifier, unreadChats } from "./notifier";
import {
  BridgeError, PROTOCOL_VERSION, type BridgeEvent, type ServiceName, type StatusState, type WireMessage,
  type WireStatus, type WireUser,
} from "./protocol";
import type { Provider, ProviderFactory, ProviderHost } from "./provider";
import { SettingsStore } from "./settings";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BADGE_DELAY_MS = 400;

export interface BridgeOptions {
  service: ServiceName;
  socketPath: string;
  stateDir: string;
  cacheDir: string;
  fixtures: boolean;
  readOnly: boolean;
  moon: MoonLink;
  log: Logger;
}

interface Client {
  id: number;
  socket: Socket;
  buffer: string;
  subscribed: boolean;
  view: { chat: string | null; front: boolean } | null;
}

const WRITE_COMMANDS: Record<string, keyof Provider> = {
  send: "send", react: "react", edit: "edit", delete: "delete", mark_read: "markRead", typing: "typing",
};

function str(args: Record<string, any>, key: string, required = true): string | null {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new BridgeError("invalid_argument", `${key} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new BridgeError("invalid_argument", `${key} must be a string`);
  }
  return value;
}

function limitArg(args: Record<string, any>, fallback: number, max: number): number {
  const value = args.limit;
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new BridgeError("invalid_argument", "limit must be a positive integer");
  return Math.min(value, max);
}

export class Bridge {
  readonly settings: SettingsStore;
  readonly chats: ChatStore;
  readonly media: MediaCache;
  readonly notifier: Notifier;
  private provider: Provider | null = null;
  private server: Server | null = null;
  private readonly clients = new Map<number, Client>();
  private nextClient = 1;
  private status: WireStatus;
  private badgeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(private readonly options: BridgeOptions) {
    for (const dir of [options.stateDir, options.cacheDir, dirname(options.socketPath)]) ensurePrivateDir(dir);
    this.settings = new SettingsStore(options.stateDir, { readOnly: options.readOnly, fixtures: options.fixtures });
    this.chats = new ChatStore(options.stateDir);
    this.media = new MediaCache(options.cacheDir);
    this.notifier = new Notifier(options.service, options.moon, () => this.settings.get(), options.log);
    this.status = { service: options.service, state: "connecting", detail: null, writes: this.settings.writes, account: null };
    this.chats.onChange = (chat) => {
      this.broadcast({ event: "chat", chat });
      if (chat.unread === 0) void this.notifier.withdraw(chat.id);
      this.scheduleBadge();
    };
    this.chats.onRemove = (id) => {
      this.broadcast({ event: "chat_removed", id });
      void this.notifier.withdraw(id);
      this.scheduleBadge();
    };
  }

  get log(): Logger {
    return this.options.log;
  }

  host(): ProviderHost {
    const bridge = this;
    const { service, stateDir, cacheDir, fixtures, log, moon } = this.options;
    return {
      service, stateDir, cacheDir, fixtures, log, moon,
      chats: this.chats,
      media: this.media,
      notifier: this.notifier,
      settings: () => this.settings.get(),
      guardWrite: (what) => this.settings.guard(what),
      setStatus: (state, detail, account) => bridge.setStatus(state, detail ?? null, account),
      emit: (event) => bridge.broadcast(event),
      message: (message, live) => bridge.message(message, live),
      moonView: () => moon.view(),
      viewing: () => bridge.viewing(),
    };
  }

  async start(factory: ProviderFactory): Promise<void> {
    await this.listen();
    void this.notifier.init();
    this.scheduleBadge();
    this.provider = await factory(this.host());
    try {
      await this.provider.start();
    } catch (error) {
      this.log.error("provider.start_failed", { error: errorText(error) });
      this.setStatus("error", "The service could not start.");
    }
  }

  private async listen(): Promise<void> {
    const path = this.options.socketPath;
    if (existsSync(path)) {
      const alive = await new Promise<boolean>((resolve) => {
        const probe = createConnection(path);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", () => resolve(false));
      });
      if (alive) throw new Error(`another bridge answers on ${path}`);
      rmSync(path, { force: true });
    }
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, () => resolve());
    });
    chmodSync(path, 0o600);
    this.log.info("bridge.listening", { service: this.options.service, fixtures: this.options.fixtures, writes: this.settings.writes });
  }

  private accept(socket: Socket): void {
    const client: Client = { id: this.nextClient++, socket, buffer: "", subscribed: false, view: null };
    this.clients.set(client.id, client);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(client, chunk));
    const drop = () => this.drop(client);
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client.id)) return;
    client.socket.destroy();
    if (client.view) {
      this.notifier.setView(client.id, null);
      this.provider?.viewChanged?.(this.viewing());
    }
  }

  private read(client: Client, chunk: string): void {
    client.buffer += chunk;
    if (client.buffer.length > MAX_REQUEST_BYTES && !client.buffer.includes("\n")) {
      this.log.warn("client.request_too_long", { client: client.id });
      this.drop(client);
      return;
    }
    let newline: number;
    while ((newline = client.buffer.indexOf("\n")) >= 0) {
      const line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (line.trim()) void this.handleLine(client, line);
    }
  }

  private write(client: Client, value: unknown): void {
    if (!this.clients.has(client.id)) return;
    if (client.socket.writableLength > MAX_OUTPUT_BYTES) {
      this.log.warn("client.too_slow", { client: client.id });
      this.drop(client);
      return;
    }
    client.socket.write(`${JSON.stringify(value)}\n`);
  }

  broadcast(event: BridgeEvent): void {
    for (const client of this.clients.values()) if (client.subscribed) this.write(client, event);
  }

  private async handleLine(client: Client, line: string): Promise<void> {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      this.write(client, { id: null, ok: false, error: { code: "invalid_request", message: "not JSON" } });
      return;
    }
    const id = request?.id;
    if (typeof request !== "object" || request === null || !Number.isInteger(id) || id === 0 || typeof request.cmd !== "string") {
      this.write(client, { id: null, ok: false, error: { code: "invalid_request", message: "id and cmd are required" } });
      return;
    }
    try {
      const result = await this.dispatch(client, request.cmd, request);
      this.write(client, { id, ok: true, result: result ?? {} });
    } catch (error) {
      if (error instanceof BridgeError) {
        this.write(client, { id, ok: false, error: { code: error.code, message: error.message, ...error.extra } });
      } else {
        this.log.error("command.failed", { cmd: String(request.cmd).slice(0, 40), error: errorText(error) });
        this.write(client, { id, ok: false, error: { code: "internal", message: errorText(error) } });
      }
    }
  }

  private requireProvider(): Provider {
    if (!this.provider) throw new BridgeError("unavailable", "the service is starting");
    return this.provider;
  }

  async dispatch(client: Client, cmd: string, args: Record<string, any>): Promise<unknown> {
    switch (cmd) {
      case "hello":
        return {
          protocol: PROTOCOL_VERSION,
          service: this.options.service,
          status: this.status,
          capabilities: this.provider?.capabilities ?? [],
          fixtures: this.options.fixtures,
        };
      case "subscribe":
        client.subscribed = true;
        return {};
      case "status":
        return this.status;
      case "settings.get":
        return this.settings.get();
      case "settings.set": {
        const before = this.settings.writes;
        const settings = this.settings.set(args);
        if (before !== this.settings.writes) {
          this.log.info("settings.writes", { writes: this.settings.writes });
          this.setStatus(this.status.state, this.status.detail, this.status.account);
        }
        return settings;
      }
      case "chats.list":
        return this.chats.page({
          cursor: str(args, "cursor", false),
          limit: limitArg(args, 100, 500),
          folder: str(args, "folder", false),
        });
      case "chat.get": {
        const chat = this.chats.get(str(args, "chat")!);
        if (!chat) throw new BridgeError("not_found", "no such chat");
        return chat;
      }
      case "history":
        return this.requireProvider().history(str(args, "chat")!, {
          before: str(args, "before", false),
          limit: limitArg(args, 40, 100),
        });
      case "view":
        return this.view(client, str(args, "chat", false), args.front !== false);
      case "media.fetch": {
        const max = args.max;
        if (max !== undefined && max !== null && (!Number.isInteger(max) || max < 1)) {
          throw new BridgeError("invalid_argument", "max must be a positive integer");
        }
        return this.requireProvider().fetchMedia(str(args, "ref")!, max ?? null);
      }
      case "login.start":
        return this.optional("loginStart")(args);
      case "login.cancel":
        return this.optional("loginCancel")();
      case "logout":
        return this.optional("logout")();
    }
    const write = WRITE_COMMANDS[cmd];
    if (write) {
      const provider = this.requireProvider();
      const method = provider[write] as ((args: any) => Promise<unknown>) | undefined;
      if (!method) throw new BridgeError("unknown_command", `${this.options.service} has no ${cmd}`);
      this.settings.guard(cmd);
      const chat = str(args, "chat")!;
      switch (cmd) {
        case "send": {
          const text = typeof args.text === "string" ? args.text : "";
          const media = Array.isArray(args.media) ? args.media.filter((path: unknown) => typeof path === "string") : [];
          if (!text.trim() && media.length === 0) throw new BridgeError("invalid_argument", "nothing to send");
          return { message: await method.call(provider, { chat, text, reply_to: str(args, "reply_to", false), client_id: str(args, "client_id", false), media }) };
        }
        case "react":
          return method.call(provider, { chat, message: str(args, "message")!, emoji: str(args, "emoji")!, remove: args.remove === true });
        case "edit":
          return { message: await method.call(provider, { chat, message: str(args, "message")!, text: String(args.text ?? "") }) };
        case "delete":
          return method.call(provider, { chat, message: str(args, "message")! });
        case "mark_read":
          return method.call(provider, { chat, message: str(args, "message", false) });
        default:
          return method.call(provider, { chat });
      }
    }
    const extension = this.provider?.commands?.[cmd];
    if (extension) {
      if (extension.write) this.settings.guard(cmd);
      return extension.run(args, { client: client.id });
    }
    throw new BridgeError("unknown_command", `unknown command ${cmd.slice(0, 64)}`);
  }

  private optional(name: "loginStart" | "loginCancel" | "logout"): (args?: any) => Promise<unknown> {
    const provider = this.requireProvider();
    const method = provider[name] as ((args?: any) => Promise<unknown>) | undefined;
    if (!method) throw new BridgeError("unknown_command", `${this.options.service} has no ${name}`);
    return (args) => method.call(provider, args);
  }

  private async view(client: Client, chat: string | null, front: boolean): Promise<unknown> {
    client.view = { chat, front };
    this.notifier.setView(client.id, client.view);
    if (chat && front) {
      void this.notifier.withdraw(chat);
      this.chats.markReadLocally(chat);
      if (this.settings.writes && this.provider?.markRead && (this.chats.raw(chat)?.unread ?? 0) > 0) {
        this.provider.markRead({ chat }).catch((error) => this.log.warn("mark_read.failed", { error: errorText(error) }));
      }
    }
    this.provider?.viewChanged?.(this.viewing());
    return {};
  }

  viewing(): { chats: Set<string>; front: boolean } {
    const chats = new Set<string>();
    let front = false;
    for (const client of this.clients.values()) {
      if (!client.view) continue;
      if (client.view.chat) chats.add(client.view.chat);
      front ||= client.view.front;
    }
    return { chats, front };
  }

  message(message: WireMessage, live: boolean): void {
    this.broadcast({ event: "message", message, live });
    if (!live) return;
    void this.notifier.incoming(message, this.chats.get(message.chat)).then((outcome) => {
      if (outcome === "shown") this.chats.markReadLocally(message.chat);
    });
  }

  setStatus(state: StatusState, detail: string | null, account?: WireUser | null): void {
    const next: WireStatus = {
      service: this.options.service,
      state,
      detail,
      writes: this.settings.writes,
      account: account === undefined ? this.status.account : account,
    };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    if (next.state !== this.status.state) this.log.info("status", { state, signed_in: next.account !== null });
    this.status = next;
    this.broadcast({ event: "status", status: next });
  }

  private scheduleBadge(): void {
    if (this.badgeTimer) return;
    this.badgeTimer = setTimeout(() => {
      this.badgeTimer = null;
      const all = this.chats.all();
      const count = this.provider?.badge ? this.provider.badge(all) : (this.chats.size > 0 ? unreadChats(all) : null);
      this.notifier.setBadge(count);
    }, BADGE_DELAY_MS);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try { await this.provider?.stop(); } catch (error) { this.log.warn("provider.stop_failed", { error: errorText(error) }); }
    this.chats.save();
    this.notifier.stop();
    if (this.badgeTimer) clearTimeout(this.badgeTimer);
    for (const client of [...this.clients.values()]) this.drop(client);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.options.socketPath, { force: true });
    this.options.moon.close();
  }
}
