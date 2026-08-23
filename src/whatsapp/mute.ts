/** WhatsApp's app-state sentinel for a chat muted without an expiry. */
export const WHATSAPP_MUTE_FOREVER_END_MS = -1;

export function isWhatsAppChatMuted(
  mutedUntilMs: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  return mutedUntilMs === WHATSAPP_MUTE_FOREVER_END_MS
    || Boolean(mutedUntilMs && mutedUntilMs > nowMs);
}
