import { describe, expect, test } from "bun:test";

import {
  WHATSAPP_GUILD_ID,
  isFixedTopLevelGuildId,
  isWhatsAppChannelId,
  whatsappChannelId,
  whatsappJidFromChannelId,
} from "./chatproviders";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";

describe("chat provider identifiers", () => {
  test("round-trips WhatsApp JIDs through namespaced UI channel ids", () => {
    const jid = "120363012345678901@g.us";
    const channelId = whatsappChannelId(jid);

    expect(isWhatsAppChannelId(channelId)).toBe(true);
    expect(whatsappJidFromChannelId(channelId)).toBe(jid);
    expect(whatsappJidFromChannelId("123456789")).toBeNull();
  });

  test("keeps Direct Messages and WhatsApp as fixed top-level roots", () => {
    expect(isFixedTopLevelGuildId(DIRECT_MESSAGES_GUILD_ID)).toBe(true);
    expect(isFixedTopLevelGuildId(WHATSAPP_GUILD_ID)).toBe(true);
    expect(isFixedTopLevelGuildId("guild-1")).toBe(false);
  });
});
