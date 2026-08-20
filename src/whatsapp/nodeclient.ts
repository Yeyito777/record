import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import type { WhatsAppBackendHandle } from "./controller";
import type {
  WhatsAppBackendEventListener,
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppLoginResult,
  WhatsAppMessage,
  WhatsAppMessageKey,
} from "./types";
import type {
  WhatsAppMarkReadParams,
  WhatsAppFetchHistoryParams,
  WhatsAppDownloadMediaParams,
  WhatsAppDownloadMediaResult,
  WhatsAppImageUpload,
  WhatsAppSendImagesParams,
  WhatsAppSendTextParams,
  WhatsAppSetChatMutedParams,
  WhatsAppSetChatMutedResult,
  WhatsAppWorkerMessage,
  WhatsAppWorkerMethod,
  WhatsAppWorkerRequest,
} from "./worker-protocol";

export interface NodeWhatsAppBackendClientOptions {
  authDirectory: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnWorker?: () => ChildProcessWithoutNullStreams;
}

type UntypedListener = (event: unknown) => void | Promise<void>;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

function workerDefaults(): { command: string; args: string[]; cwd: string } {
  const projectRoot = resolve(import.meta.dir, "../..");
  return {
    command: resolve(projectRoot, "node_modules/.bin/tsx"),
    args: [resolve(import.meta.dir, "worker.ts")],
    cwd: projectRoot,
  };
}

export class NodeWhatsAppBackendClient implements WhatsAppBackendHandle {
  private readonly options: NodeWhatsAppBackendClientOptions;
  private readonly listeners = new Map<WhatsAppBackendEventName, Set<UntypedListener>>();
  private readonly pending = new Map<number, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private inputBuffer = "";
  private requestSequence = 0;
  private stopping = false;
  private currentState: WhatsAppConnectionState = { status: "idle" };

  constructor(options: NodeWhatsAppBackendClientOptions) {
    this.options = options;
  }

  get state(): WhatsAppConnectionState {
    return this.currentState;
  }

  get isConnected(): boolean {
    return this.currentState.status === "connected";
  }

  on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as UntypedListener);
    return () => listeners?.delete(listener as UntypedListener);
  }

  async startLogin(): Promise<WhatsAppLoginResult> {
    return await this.request("start-login") as WhatsAppLoginResult;
  }

  cancelLogin(): boolean {
    if (!this.child) return false;
    void this.request("cancel-login").catch(() => {});
    return true;
  }

  async sendText(
    chatId: string,
    text: string,
    quoted?: WhatsAppMessage,
    ephemeralExpirationSeconds?: number,
  ): Promise<WhatsAppMessage> {
    const params: WhatsAppSendTextParams = { chatId, text, quoted, ephemeralExpirationSeconds };
    return await this.request("send-text", params as unknown as Record<string, unknown>) as WhatsAppMessage;
  }

  async sendImages(
    chatId: string,
    images: WhatsAppImageUpload[],
    caption: string,
    quoted?: WhatsAppMessage,
    ephemeralExpirationSeconds?: number,
  ): Promise<WhatsAppMessage[]> {
    const params: WhatsAppSendImagesParams = { chatId, images, caption, quoted, ephemeralExpirationSeconds };
    return await this.request("send-images", params as unknown as Record<string, unknown>) as WhatsAppMessage[];
  }

  async downloadMedia(message: WhatsAppMessage, destinationPath: string): Promise<WhatsAppDownloadMediaResult> {
    const params: WhatsAppDownloadMediaParams = { message, destinationPath };
    return await this.request("download-media", params as unknown as Record<string, unknown>) as WhatsAppDownloadMediaResult;
  }

  async markRead(keys: WhatsAppMessageKey[]): Promise<void> {
    const params: WhatsAppMarkReadParams = { keys };
    await this.request("mark-read", params as unknown as Record<string, unknown>);
  }

  async fetchHistory(count: number, oldestKey: WhatsAppMessageKey, oldestTimestampMs: number): Promise<string> {
    const params: WhatsAppFetchHistoryParams = { count, oldestKey, oldestTimestampMs };
    return await this.request("fetch-history", params as unknown as Record<string, unknown>) as string;
  }

  async setChatMuted(chatId: string, muted: boolean): Promise<WhatsAppSetChatMutedResult> {
    const params: WhatsAppSetChatMutedParams = { chatId, muted };
    return await this.request("set-chat-muted", params as unknown as Record<string, unknown>) as WhatsAppSetChatMutedResult;
  }

  async logout(): Promise<void> {
    try {
      await this.request("logout");
    } finally {
      await this.shutdown();
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.currentState = { status: "stopped" };
      return;
    }
    try {
      await Promise.race([
        this.request("shutdown"),
        new Promise((resolveDone) => setTimeout(resolveDone, 750)),
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      this.child = null;
      this.currentState = { status: "stopped" };
      this.rejectPending(new Error("WhatsApp worker stopped."));
    }
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.stopping) throw new Error("WhatsApp worker is stopping.");
    const defaults = workerDefaults();
    const child = this.options.spawnWorker?.() ?? spawn(
      this.options.command ?? defaults.command,
      this.options.args ?? defaults.args,
      {
        cwd: this.options.cwd ?? defaults.cwd,
        env: {
          ...process.env,
          ...this.options.env,
          RECORD_WHATSAPP_AUTH_DIR: this.options.authDirectory,
          RECORD_WHATSAPP_DIAGNOSTICS_SOCKET: join(dirname(this.options.authDirectory), "diagnostics.sock"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.inputBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleData(chunk));
    // Never let worker diagnostics write into Record's alternate-screen TUI.
    child.stderr.on("data", () => {});
    child.on("error", (error) => this.handleWorkerFailure(error));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      this.handleWorkerFailure(new Error(`WhatsApp worker exited unexpectedly (${signal ?? code ?? "unknown"}).`));
    });
    return child;
  }

  private request(method: WhatsAppWorkerMethod, params?: Record<string, unknown>): Promise<unknown> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.requestSequence;
    const request: WhatsAppWorkerRequest = { type: "request", id, method, params };
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        rejectRequest(error);
      });
    });
  }

  private handleData(chunk: string): void {
    this.inputBuffer += chunk;
    let newline: number;
    while ((newline = this.inputBuffer.indexOf("\n")) >= 0) {
      const line = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: WhatsAppWorkerMessage;
      try {
        message = JSON.parse(line) as WhatsAppWorkerMessage;
      } catch {
        this.handleWorkerFailure(new Error("WhatsApp worker returned invalid data."));
        continue;
      }
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        continue;
      }
      if (message.type === "event") this.handleEvent(message.event, message.data);
    }
  }

  private handleEvent<K extends WhatsAppBackendEventName>(event: K, data: WhatsAppBackendEventMap[K]): void {
    if (event === "state") this.currentState = data as WhatsAppConnectionState;
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        void Promise.resolve(listener(data)).catch(() => {});
      } catch {}
    }
  }

  private handleWorkerFailure(error: Error): void {
    if (this.stopping) return;
    this.currentState = { status: "failed", error };
    this.handleEvent("state", this.currentState);
    this.handleEvent("error", { phase: "socket", error, recoverable: false });
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createNodeWhatsAppBackendClient(
  options: NodeWhatsAppBackendClientOptions,
): NodeWhatsAppBackendClient {
  return new NodeWhatsAppBackendClient(options);
}
