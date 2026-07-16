import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  upsertWhatsAppChats,
  upsertWhatsAppContacts,
  upsertWhatsAppMessages,
  type WhatsAppUiState,
} from "./integration";
import type { WhatsAppAccount, WhatsAppChat, WhatsAppContact, WhatsAppMessage } from "./types";

const CACHE_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;

export interface WhatsAppCacheSnapshot {
  version: typeof CACHE_VERSION;
  savedAtMs: number;
  account: WhatsAppAccount | null;
  chats: WhatsAppChat[];
  contacts: WhatsAppContact[];
  messagesByChatId: Record<string, WhatsAppMessage[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validChat(value: unknown): value is WhatsAppChat {
  return isRecord(value) && typeof value.id === "string" && typeof value.kind === "string";
}

function validContact(value: unknown): value is WhatsAppContact {
  return isRecord(value) && typeof value.id === "string";
}

function validMessage(value: unknown): value is WhatsAppMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.chatId === "string"
    && typeof value.fromMe === "boolean"
    && isRecord(value.key)
    && typeof value.key.id === "string"
    && typeof value.key.chatId === "string"
    && isRecord(value.content)
    && typeof value.content.kind === "string";
}

function parseSnapshot(serialized: string): WhatsAppCacheSnapshot {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || value.version !== CACHE_VERSION || !Array.isArray(value.chats)
    || !Array.isArray(value.contacts) || !isRecord(value.messagesByChatId)) {
    throw new Error("Unsupported or invalid WhatsApp cache.");
  }

  const messagesByChatId: Record<string, WhatsAppMessage[]> = {};
  for (const [chatId, messages] of Object.entries(value.messagesByChatId)) {
    if (!Array.isArray(messages)) continue;
    messagesByChatId[chatId] = messages.filter(validMessage);
  }

  return {
    version: CACHE_VERSION,
    savedAtMs: typeof value.savedAtMs === "number" ? value.savedAtMs : 0,
    account: isRecord(value.account) && typeof value.account.id === "string"
      ? value.account as unknown as WhatsAppAccount
      : null,
    chats: value.chats.filter(validChat),
    contacts: value.contacts.filter(validContact),
    messagesByChatId,
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing unsafe WhatsApp cache directory: ${path}`);
  }
  await chmod(path, DIRECTORY_MODE);
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function snapshotWhatsAppUiState(state: WhatsAppUiState): WhatsAppCacheSnapshot {
  const contacts = new Map<string, WhatsAppContact>();
  for (const contact of Object.values(state.contactsById)) contacts.set(contact.id, contact);
  return {
    version: CACHE_VERSION,
    savedAtMs: Date.now(),
    account: state.account,
    chats: Object.values(state.chatsById),
    contacts: [...contacts.values()],
    messagesByChatId: Object.fromEntries(
      Object.entries(state.messagesByChatId).map(([chatId, messages]) => [chatId, messages.slice()]),
    ),
  };
}

export function hydrateWhatsAppUiState(state: WhatsAppUiState, snapshot: WhatsAppCacheSnapshot): void {
  state.account = snapshot.account;
  upsertWhatsAppContacts(state, snapshot.contacts);
  upsertWhatsAppChats(state, snapshot.chats);
  for (const messages of Object.values(snapshot.messagesByChatId)) {
    upsertWhatsAppMessages(state, messages);
  }
}

export async function loadWhatsAppCache(cacheFile: string): Promise<WhatsAppCacheSnapshot | null> {
  try {
    const info = await lstat(cacheFile);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing unsafe WhatsApp cache file: ${cacheFile}`);
    }
    if (info.size > MAX_CACHE_BYTES) throw new Error("WhatsApp cache is unexpectedly large.");
    await chmod(cacheFile, FILE_MODE);
    return parseSnapshot(await readFile(cacheFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveWhatsAppCache(cacheFile: string, snapshot: WhatsAppCacheSnapshot): Promise<void> {
  const directory = dirname(cacheFile);
  await ensurePrivateDirectory(directory);
  try {
    const existing = await lstat(cacheFile);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing unsafe WhatsApp cache file: ${cacheFile}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }

  const temporary = join(directory, `.record-whatsapp-cache-${randomUUID()}.tmp`);
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      FILE_MODE,
    );
    await handle.writeFile(JSON.stringify(snapshot), { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, cacheFile);
    await chmod(cacheFile, FILE_MODE);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function removeWhatsAppCache(cacheFile: string): Promise<void> {
  try {
    const info = await lstat(cacheFile);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing unsafe WhatsApp cache file: ${cacheFile}`);
    }
    await unlink(cacheFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}
