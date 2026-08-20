import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { downloadMediaMessage, type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import pino from "pino";

import type { WhatsAppMessage } from "./types";
import type { WhatsAppDownloadMediaResult } from "./worker-protocol";

const silentBaileysLogger = pino({ level: "silent" });

export type WhatsAppMediaDownloader = (message: WAMessage) => Promise<Readable>;

export interface DownloadWhatsAppMediaOptions {
  downloader?: WhatsAppMediaDownloader;
}

function decodeMediaKey(encoded: string): Buffer {
  const normalized = encoded.replace(/=+$/g, "");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64").replace(/=+$/g, "") !== normalized) {
    throw new Error("WhatsApp media has an invalid encryption key.");
  }
  return decoded;
}

/** Rebuild the minimal Baileys message needed for media download/reupload. */
export function downloadableWhatsAppMessage(message: WhatsAppMessage): WAMessage {
  if (message.content.kind !== "media" || !message.content.download) {
    throw new Error("WhatsApp media download information is unavailable.");
  }

  const { download } = message.content;
  if (!download.directPath && !download.url) {
    throw new Error("WhatsApp media has no download location.");
  }

  const media = {
    mediaKey: decodeMediaKey(download.mediaKeyBase64),
    ...(download.directPath ? { directPath: download.directPath } : {}),
    ...(download.url ? { url: download.url } : {}),
    ...(message.content.mimeType ? { mimetype: message.content.mimeType } : {}),
    ...(message.content.sizeBytes !== undefined ? { fileLength: message.content.sizeBytes } : {}),
  };
  const field = `${message.content.mediaKind}Message` as
    | "imageMessage"
    | "videoMessage"
    | "audioMessage"
    | "documentMessage"
    | "stickerMessage";

  return {
    key: {
      id: message.key.id,
      remoteJid: message.key.chatId,
      fromMe: message.key.fromMe ?? message.fromMe,
      participant: message.key.participantId,
      remoteJidAlt: message.key.alternateChatId,
      participantAlt: message.key.alternateParticipantId,
    },
    message: { [field]: media },
    messageTimestamp: Math.floor((message.timestampMs ?? Date.now()) / 1_000),
  };
}

/** Stream and atomically cache decrypted WhatsApp media without base64 IPC copies. */
export async function downloadWhatsAppMediaToFile(
  socket: Pick<WASocket, "updateMediaMessage">,
  message: WhatsAppMessage,
  destinationPath: string,
  options: DownloadWhatsAppMediaOptions = {},
): Promise<WhatsAppDownloadMediaResult> {
  const baileysMessage = downloadableWhatsAppMessage(message);
  const stream = options.downloader
    ? await options.downloader(baileysMessage)
    : await downloadMediaMessage(baileysMessage, "stream", {}, {
      logger: silentBaileysLogger,
      reuploadRequest: (staleMessage) => socket.updateMediaMessage(staleMessage),
    });

  const directory = dirname(destinationPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(directory, `.${basename(destinationPath)}.part-${randomUUID()}`);

  try {
    await pipeline(stream, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
    const downloaded = await stat(temporaryPath);
    if (!downloaded.isFile() || downloaded.size <= 0) {
      throw new Error("WhatsApp returned an empty media file.");
    }
    await rename(temporaryPath, destinationPath);
    await chmod(destinationPath, 0o600);
    return { path: destinationPath, sizeBytes: downloaded.size };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
