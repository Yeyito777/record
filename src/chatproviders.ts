import { DIRECT_MESSAGES_GUILD_ID, type DiscordChannel, type DiscordGuild } from "./discord";

/** Synthetic top-level sidebar root owned by the WhatsApp provider. */
export const WHATSAPP_GUILD_ID = "@me::whatsapp";
export const WHATSAPP_GUILD_NAME = "WhatsApp";
export const WHATSAPP_CHANNEL_ID_PREFIX = "wa:";

export function whatsappGuild(): DiscordGuild {
  return { id: WHATSAPP_GUILD_ID, name: WHATSAPP_GUILD_NAME, icon: null };
}

export function isFixedTopLevelGuildId(guildId: string | null | undefined): boolean {
  return guildId === DIRECT_MESSAGES_GUILD_ID || guildId === WHATSAPP_GUILD_ID;
}

export function isWhatsAppChannelId(channelId: string | null | undefined): boolean {
  return Boolean(channelId?.startsWith(WHATSAPP_CHANNEL_ID_PREFIX));
}

export function isWhatsAppChannel(channel: Pick<DiscordChannel, "id" | "guildId"> | null | undefined): boolean {
  return channel?.guildId === WHATSAPP_GUILD_ID || isWhatsAppChannelId(channel?.id);
}

export function whatsappChannelId(jid: string): string {
  return `${WHATSAPP_CHANNEL_ID_PREFIX}${Buffer.from(jid, "utf8").toString("base64url")}`;
}

export function whatsappJidFromChannelId(channelId: string): string | null {
  if (!isWhatsAppChannelId(channelId)) return null;
  try {
    const jid = Buffer.from(channelId.slice(WHATSAPP_CHANNEL_ID_PREFIX.length), "base64url").toString("utf8");
    return jid.includes("@") ? jid : null;
  } catch {
    return null;
  }
}
