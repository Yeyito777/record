import type { VoiceCallSession } from "../voice";

export interface ParsedStreamKey {
  type: "call" | "guild";
  guildId: string | null;
  channelId: string;
  ownerUserId: string;
}

export function parseStreamKey(streamKey: string): ParsedStreamKey | null {
  const parts = streamKey.split(":");
  if (parts[0] === "call" && parts.length === 3 && parts[1] && parts[2]) {
    return { type: "call", guildId: null, channelId: parts[1], ownerUserId: parts[2] };
  }
  if (parts[0] === "guild" && parts.length === 4 && parts[1] && parts[2] && parts[3]) {
    return { type: "guild", guildId: parts[1], channelId: parts[2], ownerUserId: parts[3] };
  }
  return null;
}

export function buildStreamKeyForVoiceSession(session: VoiceCallSession, ownerUserId: string): string {
  return session.target.guildId
    ? `guild:${session.target.guildId}:${session.target.channelId}:${ownerUserId}`
    : `call:${session.target.channelId}:${ownerUserId}`;
}

export function streamKeyMatchesVoiceSession(streamKey: string, session: VoiceCallSession): boolean {
  const parsed = parseStreamKey(streamKey);
  if (!parsed) return false;
  if (parsed.channelId !== session.target.channelId) return false;
  if (session.target.guildId) return parsed.type === "guild" && parsed.guildId === session.target.guildId;
  return parsed.type === "call" && parsed.guildId === null;
}

export function daveChannelIdForStreamServer(rtcServerId: string): string {
  try {
    return (BigInt(rtcServerId) - 1n).toString();
  } catch {
    return rtcServerId;
  }
}
