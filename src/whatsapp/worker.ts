import type { WAMessage } from "@whiskeysockets/baileys";

import { createRecordWhatsAppBackend } from "./backend";
import type { WhatsAppMessage } from "./types";
import type {
  WhatsAppMarkReadParams,
  WhatsAppSendImagesParams,
  WhatsAppSendTextParams,
  WhatsAppWorkerEvent,
  WhatsAppWorkerRequest,
  WhatsAppWorkerResponse,
} from "./worker-protocol";
import { toWhatsAppMessage } from "./converters";
import { buildWhatsAppSendOptions, resolveWhatsAppEphemeralExpiration, sendWhatsAppImages } from "./sending";

// Baileys creates credential/key files itself. A private process umask ensures
// they are private from the instant they are opened, before our auth wrapper's
// verification and chmod pass runs.
process.umask(0o077);

// Some transitive Signal implementations write ratchet/session objects through
// the global console instead of the supplied Baileys logger. Besides exposing
// key material, any stdout noise would corrupt this worker's JSON-lines IPC.
// All actionable backend failures already travel through typed error events.
for (const method of ["log", "info", "debug", "warn", "error", "dir", "trace"] as const) {
  console[method] = (() => {}) as typeof console[typeof method];
}

const authDirectory = process.env.RECORD_WHATSAPP_AUTH_DIR;
if (!authDirectory) process.exit(64);

const backend = createRecordWhatsAppBackend({ authDirectory });
let inputBuffer = "";
let shuttingDown = false;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "Unknown worker error");
  return message.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error ? safeError(item) : item)) as T;
}

function write(message: WhatsAppWorkerResponse | WhatsAppWorkerEvent): void {
  process.stdout.write(`${JSON.stringify(jsonSafe(message))}\n`);
}

for (const event of ["state", "qr", "history", "messages", "chats", "contacts", "lid-mapping", "error"] as const) {
  backend.on(event, (data) => write({ type: "event", event, data } as WhatsAppWorkerEvent));
}

function quotedMessage(message: WhatsAppMessage): WAMessage {
  const body = message.content.kind === "text"
    ? { conversation: message.content.text }
    : message.content.kind === "media" && message.content.caption
      ? { extendedTextMessage: { text: message.content.caption } }
      : { conversation: "" };
  return {
    key: {
      id: message.key.id,
      remoteJid: message.key.chatId,
      fromMe: message.key.fromMe ?? message.fromMe,
      participant: message.key.participantId,
    },
    message: body,
    messageTimestamp: Math.floor((message.timestampMs ?? Date.now()) / 1000),
  };
}

async function handle(request: WhatsAppWorkerRequest): Promise<unknown> {
  switch (request.method) {
    case "start-login":
      return await backend.startLogin();
    case "cancel-login":
      return { cancelled: backend.cancelLogin() };
    case "send-text": {
      const params = request.params as unknown as WhatsAppSendTextParams;
      if (!params?.chatId || typeof params.text !== "string") throw new Error("Invalid send-text request.");
      const socket = backend.getSocket();
      const expiration = await resolveWhatsAppEphemeralExpiration(
        socket,
        params.chatId,
        params.ephemeralExpirationSeconds,
      );
      // Persist a group setting discovered on demand in the UI/cache too.
      if (params.ephemeralExpirationSeconds === undefined && expiration !== undefined) {
        write({
          type: "event",
          event: "chats",
          data: {
            kind: "update",
            chats: [{
              id: params.chatId,
              kind: "group",
              ephemeralExpirationSeconds: expiration,
            }],
          },
        });
      }
      const sent = await socket.sendMessage(
        params.chatId,
        { text: params.text },
        buildWhatsAppSendOptions(
          params.quoted ? quotedMessage(params.quoted) : undefined,
          expiration,
        ),
      );
      const converted = sent ? toWhatsAppMessage(sent, { selfId: socket.user?.id }) : null;
      if (!converted) throw new Error("WhatsApp did not return the sent message.");
      return converted;
    }
    case "send-images": {
      const params = request.params as unknown as WhatsAppSendImagesParams;
      if (!params?.chatId || !Array.isArray(params.images) || typeof params.caption !== "string") {
        throw new Error("Invalid send-images request.");
      }
      const socket = backend.getSocket();
      const expiration = await resolveWhatsAppEphemeralExpiration(
        socket,
        params.chatId,
        params.ephemeralExpirationSeconds,
      );
      const sent = await sendWhatsAppImages(
        socket,
        params.chatId,
        params.images,
        params.caption,
        params.quoted ? quotedMessage(params.quoted) : undefined,
        expiration,
      );
      const converted = sent.map((message) => toWhatsAppMessage(message, { selfId: socket.user?.id }));
      if (converted.some((message) => message === null)) throw new Error("WhatsApp returned an invalid sent image.");
      return converted;
    }
    case "mark-read": {
      const params = request.params as unknown as WhatsAppMarkReadParams;
      if (!Array.isArray(params?.keys)) throw new Error("Invalid mark-read request.");
      await backend.getSocket().readMessages(params.keys.map((key) => ({
        remoteJid: key.chatId,
        id: key.id,
        fromMe: key.fromMe,
        participant: key.participantId,
      })));
      return { read: true };
    }
    case "logout":
      await backend.getSocket().logout();
      return { loggedOut: true };
    case "shutdown":
      shuttingDown = true;
      await backend.shutdown();
      return { stopped: true };
  }
}

function dispatch(request: WhatsAppWorkerRequest): void {
  void handle(request).then((result) => {
    write({ type: "response", id: request.id, result });
    if (request.method === "shutdown") process.exit(0);
  }).catch((error) => {
    write({ type: "response", id: request.id, error: safeError(error) });
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  let newline: number;
  while ((newline = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as WhatsAppWorkerRequest;
      if (request.type !== "request" || !Number.isInteger(request.id)) throw new Error("Invalid request.");
      dispatch(request);
    } catch (error) {
      write({ type: "response", id: 0, error: safeError(error) });
    }
  }
});

async function stop(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await backend.shutdown().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("disconnect", () => void stop());
