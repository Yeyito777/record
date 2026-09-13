import { createCipheriv, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, spyOn, test } from "bun:test";
import { getMediaKeys, type WAMessage } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

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
      url: "https://mmg.whatsapp.net/v/t62.7118-24/example.enc",
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

  for (const status of [403, 404, 410]) {
    test(`refreshes expired media after a Baileys Boom HTTP ${status}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "record-whatsapp-media-retry-"));
      let attempts = 0;
      let refreshes = 0;
      const result = await downloadWhatsAppMediaToFile({
        updateMediaMessage: async (message) => {
          refreshes++;
          return { ...message, message: { imageMessage: { ...message.message!.imageMessage, url: "https://mmg.whatsapp.net/fresh" } } };
        },
      }, mediaMessage(), join(directory, "photo.jpg"), {
        downloader: async (message) => {
          if (++attempts === 1) throw new Boom("Failed to fetch stream", { statusCode: status });
          expect(message.message?.imageMessage?.url).toBe("https://mmg.whatsapp.net/fresh");
          return Readable.from([Buffer.from([1, 2, 3, 4])]);
        },
      });
      expect(readFileSync(result.path)).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(attempts).toBe(2);
      expect(refreshes).toBe(1);
    });
  }

  test("recovers and decrypts through the real Baileys HTTP downloader", async () => {
    const message = mediaMessage();
    const keys = await getMediaKeys(Buffer.from([1, 2, 3, 4]), "image");
    const plain = Buffer.from([1, 2, 3, 4]);
    const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const mac = createHmac("sha256", keys.macKey!).update(Buffer.concat([keys.iv, encrypted])).digest().subarray(0, 10);
    const directory = mkdtempSync(join(tmpdir(), "record-whatsapp-real-download-"));
    const urls: string[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (url: Parameters<typeof fetch>[0]) => {
      urls.push(String(url));
      return urls.length === 1
        ? new Response(null, { status: 403 })
        : new Response(Buffer.concat([encrypted, mac]));
    }) as typeof fetch);
    try {
      let refreshes = 0;
      const result = await downloadWhatsAppMediaToFile({
        updateMediaMessage: async (source) => {
          refreshes++;
          source.message!.imageMessage!.directPath = "/fresh.enc";
          source.message!.imageMessage!.url = "https://mmg.whatsapp.net/fresh.enc";
          return source;
        },
      }, message, join(directory, "photo.jpg"));
      expect(readFileSync(result.path)).toEqual(plain);
      expect(refreshes).toBe(1);
      expect(urls).toEqual([
        "https://mmg.whatsapp.net/v/t62.7118-24/example.enc",
        "https://mmg.whatsapp.net/fresh.enc",
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("does not request reupload for unrelated network/server failures", async () => {
    for (const error of [new Error("offline"), new Boom("server error", { statusCode: 500 })]) {
      let refreshes = 0;
      await expect(downloadWhatsAppMediaToFile({
        updateMediaMessage: async (message) => { refreshes++; return message; },
      }, mediaMessage(), join(tmpdir(), "unused-media.jpg"), {
        downloader: async () => { throw error; },
      })).rejects.toThrow(error.message);
      expect(refreshes).toBe(0);
    }
  });

  test("bounds expired-media recovery to one refresh and reports an actionable error", async () => {
    let attempts = 0;
    let refreshes = 0;
    await expect(downloadWhatsAppMediaToFile({
      updateMediaMessage: async (message) => { refreshes++; return message; },
    }, mediaMessage(), join(tmpdir(), "unused-media.jpg"), {
      downloader: async () => { attempts++; throw new Boom("Failed to fetch stream", { statusCode: 403 }); },
    })).rejects.toThrow("expired media");
    expect(attempts).toBe(2);
    expect(refreshes).toBe(1);
  });

  test("rejects cached messages that predate media download metadata", () => {
    const message = mediaMessage();
    if (message.content.kind === "media") delete message.content.download;
    expect(() => downloadableWhatsAppMessage(message)).toThrow("download information is unavailable");
  });
});
