import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { DiscordMessage } from "../discord";
import type { LocalAttachmentImageSource } from "../state";
import type { WhatsAppMessage } from "./types";

export interface WhatsAppOutgoingSend {
  accountId: string;
  message: DiscordMessage;
  messageIds: string[];
  confirmedIds: Set<string>;
  confirmedMessages: WhatsAppMessage[];
  receivedAtMs: number;
  attachmentImages: Record<string, LocalAttachmentImageSource>;
}

function entryPath(directory: string, id: string): string {
  return join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
}

function assertPrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe WhatsApp outbox directory.");
  chmodSync(directory, 0o700);
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(code ?? "")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Small per-send write-ahead records, independent of the debounced history cache. */
export function saveWhatsAppOutgoingSend(directory: string, send: WhatsAppOutgoingSend): void {
  assertPrivateDirectory(directory);
  const path = entryPath(directory, send.message.id);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, ...send, confirmedIds: [...send.confirmedIds] }));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSend(value: unknown): WhatsAppOutgoingSend {
  if (!record(value) || value.version !== 1 || typeof value.accountId !== "string"
    || !record(value.message) || typeof value.message.id !== "string"
    || !value.message.id.startsWith("local:wa:") || typeof value.message.channelId !== "string"
    || typeof value.message.content !== "string" || !Number.isFinite(value.message.timestamp)
    || !record(value.message.author) || !Array.isArray(value.message.attachments)
    || !Array.isArray(value.messageIds) || !value.messageIds.length
    || !value.messageIds.every(id => typeof id === "string" && id.length > 0)
    || !Array.isArray(value.confirmedIds) || !value.confirmedIds.every(id => (value.messageIds as unknown[]).includes(id))
    || !Array.isArray(value.confirmedMessages) || !value.confirmedMessages.every(message =>
      record(message) && typeof message.id === "string" && typeof message.chatId === "string"
      && record(message.key) && record(message.content) && message.fromMe === true)
    || !Number.isFinite(value.receivedAtMs) || !record(value.attachmentImages)
    || !Object.values(value.attachmentImages).every(image =>
      record(image) && typeof image.mediaType === "string" && typeof image.base64 === "string")) {
    throw new Error("Invalid WhatsApp outbox record.");
  }
  const { version: _version, ...send } = value;
  return { ...send, confirmedIds: new Set(value.confirmedIds) } as unknown as WhatsAppOutgoingSend;
}

export function loadWhatsAppOutgoingSends(directory: string): WhatsAppOutgoingSend[] {
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe WhatsApp outbox directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe WhatsApp outbox record.");
    chmodSync(path, 0o600);
    return parseSend(JSON.parse(readFileSync(path, "utf8")));
  });
}

export function removeWhatsAppOutgoingSend(directory: string, id: string): void {
  rmSync(entryPath(directory, id), { force: true });
}

export function sameWhatsAppAccount(first: string, second: string): boolean {
  return first.replace(/:\d+@/, "@") === second.replace(/:\d+@/, "@");
}
