import { describe, expect, test } from "bun:test";
import type { Chat, Contact, WAMessage } from "@whiskeysockets/baileys";

import {
  getWhatsAppMessageEphemeralExpiration,
  toWhatsAppChat,
  toWhatsAppContact,
  toWhatsAppEphemeralChatPatch,
  toWhatsAppHistorySyncKind,
  toWhatsAppMessage,
  toWhatsAppMessageUpdate,
} from "./converters";
import type { WhatsAppMediaKind } from "./types";

function message(value: Partial<WAMessage>): WAMessage {
  return value as WAMessage;
}

describe("WhatsApp provider-neutral converters", () => {
  test("maps text, sender identity, timestamp, alternate IDs, and reply keys", () => {
    const converted = toWhatsAppMessage(message({
      key: {
        id: "message-1",
        remoteJid: "group@g.us",
        remoteJidAlt: "group-alt@g.us",
        participant: "15550001@s.whatsapp.net",
        participantAlt: "opaque@lid",
        fromMe: false,
      },
      pushName: "Ada",
      messageTimestamp: 1_725_000_000,
      message: {
        extendedTextMessage: {
          text: "hello",
          contextInfo: {
            stanzaId: "quoted-1",
            remoteJid: "group@g.us",
            participant: "15550002@s.whatsapp.net",
            quotedMessage: { conversation: "earlier" },
          },
        },
      },
    }));

    expect(converted).toEqual({
      key: {
        id: "message-1",
        chatId: "group@g.us",
        alternateChatId: "group-alt@g.us",
        participantId: "15550001@s.whatsapp.net",
        alternateParticipantId: "opaque@lid",
        fromMe: false,
      },
      id: "message-1",
      chatId: "group@g.us",
      senderId: "15550001@s.whatsapp.net",
      senderName: "Ada",
      fromMe: false,
      timestampMs: 1_725_000_000_000,
      content: { kind: "text", text: "hello" },
      replyTo: {
        id: "quoted-1",
        chatId: "group@g.us",
        participantId: "15550002@s.whatsapp.net",
      },
    });
  });

  test("retains reactions attached directly to history messages", () => {
    const converted = toWhatsAppMessage(message({
      key: {
        id: "message-1",
        remoteJid: "group@g.us",
        participant: "author@s.whatsapp.net",
        fromMe: false,
      },
      message: { conversation: "hello" },
      reactions: [{
        key: {
          id: "reaction-1",
          remoteJid: "group@g.us",
          participant: "alice@s.whatsapp.net",
          fromMe: false,
        },
        text: "❤️",
      }],
    }));

    expect(converted?.reactions).toEqual([{
      senderId: "alice@s.whatsapp.net",
      fromMe: false,
      emoji: "❤️",
    }]);
  });

  test("maps image, video, audio, document, and sticker metadata", () => {
    const cases: Array<[string, Record<string, unknown>, WhatsAppMediaKind]> = [
      ["imageMessage", {
        caption: "photo",
        mimetype: "image/jpeg",
        fileLength: 123,
        width: 640,
        height: 480,
        viewOnce: true,
      }, "image"],
      ["videoMessage", { caption: "clip", mimetype: "video/mp4", seconds: 4, gifPlayback: true }, "video"],
      ["audioMessage", { mimetype: "audio/ogg", seconds: 9, ptt: true }, "audio"],
      ["documentMessage", { mimetype: "application/pdf", fileName: "notes.pdf", fileLength: 456 }, "document"],
      ["stickerMessage", { mimetype: "image/webp", isAnimated: true, width: 512, height: 512 }, "sticker"],
    ];

    for (const [field, media, expectedKind] of cases) {
      const converted = toWhatsAppMessage(message({
        key: { id: `id-${field}`, remoteJid: "15550001@s.whatsapp.net", fromMe: true },
        message: { [field]: media },
      }));
      expect(converted?.content.kind).toBe("media");
      if (converted?.content.kind === "media") {
        expect(converted.content.mediaKind).toBe(expectedKind);
      }
    }

    const document = toWhatsAppMessage(message({
      key: { id: "doc", remoteJid: "15550001@s.whatsapp.net" },
      message: { documentMessage: { fileName: "notes.pdf", mimetype: "application/pdf", fileLength: 456 } },
    }));
    expect(document?.content).toMatchObject({
      kind: "media",
      mediaKind: "document",
      fileName: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 456,
    });
  });

  test("retains encrypted media download information across worker IPC", () => {
    const converted = toWhatsAppMessage(message({
      key: { id: "downloadable-image", remoteJid: "15550001@s.whatsapp.net" },
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: 3,
          mediaKey: new Uint8Array([1, 2, 3, 4]),
          directPath: "/v/t62.7118-24/example.enc",
          url: "https://mmg.whatsapp.net/v/example.enc",
        },
      },
    }));

    expect(converted?.content).toMatchObject({
      kind: "media",
      mediaKind: "image",
      download: {
        mediaKeyBase64: "AQIDBA==",
        directPath: "/v/t62.7118-24/example.enc",
        url: "https://mmg.whatsapp.net/v/example.enc",
      },
    });
    expect(JSON.parse(JSON.stringify(converted)).content.download.mediaKeyBase64).toBe("AQIDBA==");
  });

  test("renders common WhatsApp contact, location, interactive, PTV, and wrapped messages", () => {
    const chatId = "15550001@s.whatsapp.net";
    expect(toWhatsAppMessage(message({
      key: { id: "contact", remoteJid: chatId },
      message: { contactMessage: { displayName: "Ada" } },
    }))?.content).toEqual({ kind: "text", text: "[Contact] Ada" });

    expect(toWhatsAppMessage(message({
      key: { id: "location", remoteJid: chatId },
      message: { locationMessage: { name: "Cafe", degreesLatitude: 1.5, degreesLongitude: -2.5 } },
    }))?.content).toEqual({
      kind: "text",
      text: "[Location]\nCafe\nhttps://maps.google.com/?q=1.5,-2.5",
    });

    expect(toWhatsAppMessage(message({
      key: { id: "buttons", remoteJid: chatId },
      message: { buttonsMessage: { contentText: "Choose one", footerText: "Footer" } },
    }))?.content).toEqual({ kind: "text", text: "Choose one\nFooter" });

    expect(toWhatsAppMessage(message({
      key: { id: "ptv", remoteJid: chatId },
      message: { ptvMessage: { mimetype: "video/mp4", seconds: 3 } },
    }))?.content).toMatchObject({ kind: "media", mediaKind: "video", mimeType: "video/mp4", durationSeconds: 3 });

    expect(toWhatsAppMessage(message({
      key: { id: "wrapped", remoteJid: chatId },
      message: { associatedChildMessage: { message: { conversation: "album child" } } },
    }))?.content).toEqual({ kind: "text", text: "album child" });
  });

  test("renders polls, retains genuinely unsupported messages, and rejects unusable envelopes", () => {
    expect(toWhatsAppMessage(message({
      key: { id: "poll", remoteJid: "15550001@s.whatsapp.net" },
      message: { pollCreationMessage: { name: "Lunch?", options: [] } },
    }))?.content).toEqual({ kind: "text", text: "[Poll] Lunch?" });

    expect(toWhatsAppMessage(message({
      key: { id: "unknown", remoteJid: "15550001@s.whatsapp.net" },
      message: { requestPaymentMessage: {} },
    }))?.content).toEqual({
      kind: "unsupported",
      sourceType: "requestPaymentMessage",
      sourceFields: ["requestPaymentMessage"],
    });

    expect(toWhatsAppMessage(message({ key: { id: "missing-chat" }, message: { conversation: "x" } })))
      .toBeNull();
    expect(toWhatsAppMessage(message({ key: { id: "empty", remoteJid: "chat@g.us" } }))).toBeNull();
  });

  test("uses an injected account ID for the sender of outgoing direct messages", () => {
    const converted = toWhatsAppMessage(message({
      key: { id: "mine", remoteJid: "15550002@s.whatsapp.net", fromMe: true },
      message: { conversation: "sent" },
    }), { selfId: "15550001:1@s.whatsapp.net" });

    expect(converted?.senderId).toBe("15550001:1@s.whatsapp.net");
  });

  test("extracts disappearing settings from message contexts and protocol toggles", () => {
    const disappearingText = message({
      key: { id: "expiring", remoteJid: "person@s.whatsapp.net" },
      message: {
        extendedTextMessage: {
          text: "temporary",
          contextInfo: { expiration: 86_400 },
        },
      },
    });
    expect(getWhatsAppMessageEphemeralExpiration(disappearingText)).toBe(86_400);
    expect(toWhatsAppEphemeralChatPatch(disappearingText)).toEqual({
      id: "person@s.whatsapp.net",
      kind: "direct",
      ephemeralExpirationSeconds: 86_400,
    });

    const disabled = message({
      key: { id: "setting", remoteJid: "group@g.us" },
      message: {
        protocolMessage: {
          type: 3,
          ephemeralExpiration: 0,
        },
      },
    });
    expect(getWhatsAppMessageEphemeralExpiration(disabled)).toBe(0);
    expect(toWhatsAppEphemeralChatPatch(disabled)).toEqual({
      id: "group@g.us",
      kind: "group",
      ephemeralExpirationSeconds: 0,
    });
    expect(toWhatsAppMessage(disabled)).toBeNull();
  });

  test("turns Baileys edit patches into replacements for the original message", () => {
    const edit = toWhatsAppMessageUpdate({
      key: {
        id: "original-message",
        remoteJid: "person@s.whatsapp.net",
        fromMe: false,
      },
      update: {
        message: {
          editedMessage: {
            message: { conversation: "edited text" },
          },
        },
        messageTimestamp: 1_725_000_100,
      },
    });

    expect(edit).toMatchObject({
      id: "original-message",
      chatId: "person@s.whatsapp.net",
      fromMe: false,
      timestampMs: null,
      editedTimestampMs: 1_725_000_100_000,
      content: { kind: "text", text: "edited text" },
    });

    expect(toWhatsAppMessage(message({
      key: { id: "edit-envelope", remoteJid: "person@s.whatsapp.net" },
      message: {
        protocolMessage: {
          type: 14,
          key: { id: "original-message", remoteJid: "person@s.whatsapp.net" },
          editedMessage: { conversation: "edited text" },
        },
      },
    }))).toBeNull();
  });

  test("maps chat patches without inventing absent values", () => {
    const chat = toWhatsAppChat({
      id: "group@g.us",
      name: "Friends",
      lastMessageRecvTimestamp: 1_725_000_000,
      unreadCount: 3,
      archived: false,
      pinned: 1_725_000_001,
      muteEndTime: 1_725_003_600,
      ephemeralExpiration: 86_400,
    } as Chat);

    expect(chat).toEqual({
      id: "group@g.us",
      kind: "group",
      name: "Friends",
      lastMessageAtMs: 1_725_000_000_000,
      unreadCount: 3,
      archived: false,
      pinned: true,
      mutedUntilMs: 1_725_003_600_000,
      ephemeralExpirationSeconds: 86_400,
    });
    expect(toWhatsAppChat({ id: "person@lid", archived: true })).toEqual({
      id: "person@lid",
      kind: "direct",
      archived: true,
    });
  });

  test("normalizes Baileys mute durations and synchronized mute timestamps", () => {
    const before = Date.now();
    const duration = 7 * 24 * 60 * 60 * 1_000;
    const durationChat = toWhatsAppChat({ id: "person@s.whatsapp.net", muteEndTime: duration });
    expect(durationChat?.mutedUntilMs).toBeGreaterThanOrEqual(before + duration);
    expect(durationChat?.mutedUntilMs).toBeLessThanOrEqual(Date.now() + duration);

    const epochSeconds = 1_800_000_000;
    expect(toWhatsAppChat({ id: "group@g.us", muteEndTime: epochSeconds })?.mutedUntilMs)
      .toBe(epochSeconds * 1_000);
    expect(toWhatsAppChat({ id: "group@g.us", muteEndTime: -1 })?.mutedUntilMs).toBe(-1);
    expect(toWhatsAppChat({ id: "group@g.us", muteEndTime: 0 })?.mutedUntilMs).toBeNull();
  });

  test("maps contacts and history sync kinds", () => {
    expect(toWhatsAppContact({
      id: "opaque@lid",
      lid: "opaque@lid",
      phoneNumber: "15550001@s.whatsapp.net",
      name: "Saved Name",
      notify: "Push Name",
      imgUrl: null,
    } as Contact)).toEqual({
      id: "opaque@lid",
      lid: "opaque@lid",
      phoneId: "15550001@s.whatsapp.net",
      name: "Saved Name",
      pushName: "Push Name",
      avatarUrl: null,
    });
    expect(toWhatsAppHistorySyncKind(0)).toBe("initial-bootstrap");
    expect(toWhatsAppHistorySyncKind(6)).toBe("on-demand");
    expect(toWhatsAppHistorySyncKind(999)).toBe("unknown");
  });
});
