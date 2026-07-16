import { describe, expect, test } from "bun:test";
import { generateWAMessage, type WAMessage, type WASocket } from "@whiskeysockets/baileys";

import {
  buildWhatsAppSendOptions,
  resolveWhatsAppEphemeralExpiration,
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
});
