import { describe, expect, test } from "bun:test";
import { chatModificationToAppPatch } from "@whiskeysockets/baileys";

import { isWhatsAppChatMuted, WHATSAPP_MUTE_FOREVER_END_MS } from "./mute";

describe("WhatsApp mute state", () => {
  test("treats the provider's forever sentinel as muted", () => {
    expect(isWhatsAppChatMuted(WHATSAPP_MUTE_FOREVER_END_MS, 10_000)).toBe(true);
  });

  test("encodes the forever sentinel as a muted app-state action", () => {
    const patch = chatModificationToAppPatch(
      { mute: WHATSAPP_MUTE_FOREVER_END_MS },
      "group@g.us",
    );
    expect(patch.syncAction.muteAction).toMatchObject({
      muted: true,
      muteEndTimestamp: WHATSAPP_MUTE_FOREVER_END_MS,
    });
  });

  test("distinguishes active, expired, and cleared timed mutes", () => {
    expect(isWhatsAppChatMuted(10_001, 10_000)).toBe(true);
    expect(isWhatsAppChatMuted(10_000, 10_000)).toBe(false);
    expect(isWhatsAppChatMuted(9_999, 10_000)).toBe(false);
    expect(isWhatsAppChatMuted(null, 10_000)).toBe(false);
    expect(isWhatsAppChatMuted(undefined, 10_000)).toBe(false);
  });
});
