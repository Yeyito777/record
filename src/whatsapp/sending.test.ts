import { describe, expect, test } from "bun:test";
import { generateWAMessage, type WAMessage, type WASocket } from "@whiskeysockets/baileys";

import {
  buildWhatsAppSendOptions,
  resolveWhatsAppEphemeralExpiration,
  sendWhatsAppImages,
} from "./sending";

describe("WhatsApp sending options", () => {
  test("adds the chat expiration without dropping quoted-message context", () => {
    const quoted = { key: { id: "quoted", remoteJid: "person@s.whatsapp.net" } } as WAMessage;
    expect(buildWhatsAppSendOptions(quoted, 86_400)).toEqual({
      quoted,
      ephemeralExpiration: 86_400,
    });
    expect(buildWhatsAppSendOptions(undefined, 0)).toBeUndefined();
  });

  test("makes Baileys encode the expiration into the outgoing message context", async () => {
    const options = buildWhatsAppSendOptions(undefined, 86_400);
    const generated = await generateWAMessage(
      "person@s.whatsapp.net",
      { text: "temporary" },
      {
        userJid: "self@s.whatsapp.net",
        upload: async () => ({ mediaUrl: "", directPath: "" }),
        ...options,
      },
    );
    expect(generated.message?.extendedTextMessage?.contextInfo?.expiration).toBe(86_400);
  });

  test("uses a known direct-chat duration and never invents a default", async () => {
    let metadataCalls = 0;
    const socket = {
      groupMetadata: async () => {
        metadataCalls += 1;
        return { ephemeralDuration: 7 * 86_400 };
      },
    } as unknown as Pick<WASocket, "groupMetadata">;

    expect(await resolveWhatsAppEphemeralExpiration(socket, "person@s.whatsapp.net", 86_400)).toBe(86_400);
    expect(await resolveWhatsAppEphemeralExpiration(socket, "person@s.whatsapp.net", 0)).toBe(0);
    expect(await resolveWhatsAppEphemeralExpiration(socket, "person@s.whatsapp.net", undefined)).toBeUndefined();
    expect(metadataCalls).toBe(0);
  });

  test("falls back to group metadata when no cached duration is known", async () => {
    const socket = {
      groupMetadata: async (jid: string) => ({
        id: jid,
        subject: "Group",
        owner: undefined,
        creation: 0,
        participants: [],
        ephemeralDuration: 7 * 86_400,
      }),
    } as unknown as Pick<WASocket, "groupMetadata">;

    expect(await resolveWhatsAppEphemeralExpiration(socket, "group@g.us", undefined)).toBe(604_800);
  });

  test("allows sending when a best-effort group metadata lookup fails", async () => {
    const socket = {
      groupMetadata: async () => { throw new Error("offline"); },
    } as unknown as Pick<WASocket, "groupMetadata">;
    expect(await resolveWhatsAppEphemeralExpiration(socket, "group@g.us", undefined)).toBeUndefined();
  });

  test("sends multiple images in order with caption/reply only on the first", async () => {
    const calls: Array<{ content: Record<string, unknown>; options?: Record<string, unknown> }> = [];
    const socket = {
      sendMessage: async (_jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ content, options });
        return {
          key: { id: `sent-${calls.length}`, remoteJid: "person@s.whatsapp.net", fromMe: true },
          message: { imageMessage: {} },
        };
      },
    } as unknown as Pick<WASocket, "sendMessage">;
    const quoted = { key: { id: "quoted", remoteJid: "person@s.whatsapp.net" } } as WAMessage;
    const sent = await sendWhatsAppImages(
      socket,
      "person@s.whatsapp.net",
      [
        { mediaType: "image/png", base64: Buffer.from("one").toString("base64"), sizeBytes: 3 },
        { mediaType: "image/jpeg", base64: Buffer.from("two").toString("base64"), sizeBytes: 3 },
      ],
      "caption",
      quoted,
      86_400,
    );

    expect(sent).toHaveLength(2);
    expect(calls[0]?.content).toMatchObject({ image: Buffer.from("one"), mimetype: "image/png", caption: "caption" });
    expect(calls[0]?.options).toEqual({ quoted, ephemeralExpiration: 86_400 });
    expect(calls[1]?.content).toMatchObject({ image: Buffer.from("two"), mimetype: "image/jpeg" });
    expect(calls[1]?.content.caption).toBeUndefined();
    expect(calls[1]?.options).toEqual({ ephemeralExpiration: 86_400 });
  });

  test("validates all image data before beginning a multi-image send", async () => {
    let sends = 0;
    const socket = {
      sendMessage: async () => { sends += 1; return undefined; },
    } as unknown as Pick<WASocket, "sendMessage">;
    await expect(sendWhatsAppImages(
      socket,
      "person@s.whatsapp.net",
      [
        { mediaType: "image/png", base64: Buffer.from("valid").toString("base64"), sizeBytes: 5 },
        { mediaType: "image/png", base64: "not base64", sizeBytes: 4 },
      ],
      "",
      undefined,
      undefined,
    )).rejects.toThrow("image 2 has invalid data");
    expect(sends).toBe(0);
  });
});
