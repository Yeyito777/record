import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";

import type {
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppMessage,
} from "./types";

const MAX_RECENT_UNSUPPORTED = 200;
const MAX_REQUEST_BYTES = 4096;

export interface WhatsAppUnsupportedDiagnostic {
  atMs: number;
  event: "history" | "messages";
  chatId: string;
  messageId: string;
  sourceType: string;
  sourceFields: string[];
}

export interface WhatsAppDiagnosticSnapshot {
  pid: number;
  startedAtMs: number;
  state: WhatsAppConnectionState;
  eventCounts: Partial<Record<WhatsAppBackendEventName, number>>;
  skippedMessages: number;
  recentUnsupported: WhatsAppUnsupportedDiagnostic[];
}

export class WhatsAppDiagnostics {
  private readonly startedAtMs = Date.now();
  private readonly eventCounts: Partial<Record<WhatsAppBackendEventName, number>> = {};
  private readonly recentUnsupported: WhatsAppUnsupportedDiagnostic[] = [];
  private skippedMessages = 0;

  record<K extends WhatsAppBackendEventName>(event: K, data: WhatsAppBackendEventMap[K]): void {
    this.eventCounts[event] = (this.eventCounts[event] ?? 0) + 1;
    if (event !== "history" && event !== "messages") return;
    const payload = data as WhatsAppBackendEventMap["history"] | WhatsAppBackendEventMap["messages"];
    this.skippedMessages += payload.skippedMessages;
    for (const message of payload.messages) this.recordUnsupported(event, message);
  }

  snapshot(state: WhatsAppConnectionState): WhatsAppDiagnosticSnapshot {
    return {
      pid: process.pid,
      startedAtMs: this.startedAtMs,
      state,
      eventCounts: { ...this.eventCounts },
      skippedMessages: this.skippedMessages,
      recentUnsupported: this.recentUnsupported.slice(),
    };
  }

  private recordUnsupported(event: "history" | "messages", message: WhatsAppMessage): void {
    if (message.content.kind !== "unsupported") return;
    this.recentUnsupported.push({
      atMs: Date.now(),
      event,
      chatId: message.chatId,
      messageId: message.id,
      sourceType: message.content.sourceType ?? "unknown",
      sourceFields: message.content.sourceFields?.slice(0, 30) ?? [],
    });
    if (this.recentUnsupported.length > MAX_RECENT_UNSUPPORTED) this.recentUnsupported.shift();
  }
}

export interface WhatsAppDiagnosticsServer {
  close(): Promise<void>;
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isSocket()) {
      throw new Error(`Refusing unsafe WhatsApp diagnostics socket: ${path}`);
    }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}

/** Starts a private metadata-only JSON-lines diagnostics socket. */
export async function startWhatsAppDiagnosticsServer(
  path: string,
  getSnapshot: () => WhatsAppDiagnosticSnapshot,
): Promise<WhatsAppDiagnosticsServer> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error(`Refusing unsafe WhatsApp diagnostics directory: ${directory}`);
  }
  await chmod(directory, 0o700);
  await removeStaleSocket(path);

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ error: "Diagnostics request is too large." })}\n`);
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      try {
        const request = JSON.parse(line) as { command?: unknown };
        if (request.command !== "summary") throw new Error("Unknown diagnostics command.");
        socket.end(`${JSON.stringify({ result: getSnapshot() })}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid diagnostics request.";
        socket.end(`${JSON.stringify({ error: message })}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
  await chmod(path, 0o600);
  server.unref();
  return {
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch(() => {});
    },
  };
}
