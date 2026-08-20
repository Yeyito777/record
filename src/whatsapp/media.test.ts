import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, test } from "bun:test";
import type { WAMessage } from "@whiskeysockets/baileys";

import { downloadableWhatsAppMessage, downloadWhatsAppMediaToFile } from "./media";
import type { WhatsAppMessage } from "./types";

function mediaMessage(): WhatsAppMessage {
  return {
    key: {
      id: "media-1",
      chatId: "family@g.us",
      fromMe: false,
      participantId: "alice@s.whatsapp.net",
    },
    id: "media-1",
    chatId: "family@g.us",
    senderId: "alice@s.whatsapp.net",
    fromMe: false,
    timestampMs: 123_000,
    content: {
      kind: "media",
      mediaKind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 4,
      download: {
        mediaKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
        directPath: "/v/t62.7118-24/example.enc",
      },
    },
  };
}

describe("WhatsApp media downloads", () => {
  test("rebuilds the minimal Baileys media message", () => {
    const rebuilt = downloadableWhatsAppMessage(mediaMessage());

    expect(rebuilt.key).toMatchObject({
      id: "media-1",
      remoteJid: "family@g.us",
      fromMe: false,
      participant: "alice@s.whatsapp.net",
    });
    expect(rebuilt.message?.imageMessage).toMatchObject({
      directPath: "/v/t62.7118-24/example.enc",
      mimetype: "image/jpeg",
      fileLength: 4,
    });
    expect(Buffer.from(rebuilt.message?.imageMessage?.mediaKey ?? [])).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("streams decrypted bytes into a private atomic cache file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "record-whatsapp-media-test-"));
    const destinationPath = join(directory, "attachments", "photo.jpg");
    let downloadedMessage: WAMessage | null = null;

    const result = await downloadWhatsAppMediaToFile(
      { updateMediaMessage: async (message) => message },
      mediaMessage(),
      destinationPath,
      {
        downloader: async (message) => {
          downloadedMessage = message;
          return Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4])]);
        },
      },
    );

    expect((downloadedMessage as WAMessage | null)?.key.id).toBe("media-1");
    expect(result).toEqual({ path: destinationPath, sizeBytes: 4 });
    expect(readFileSync(destinationPath)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(readdirSync(join(directory, "attachments"))).toEqual(["photo.jpg"]);
  });

  test("rejects cached messages that predate media download metadata", () => {
    const message = mediaMessage();
    if (message.content.kind === "media") delete message.content.download;
    expect(() => downloadableWhatsAppMessage(message)).toThrow("download information is unavailable");
  });
});
