import type {
  MiscMessageGenerationOptions,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";

function normalizedExpiration(value: unknown): number | undefined {
  if (value == null) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.floor(number);
}

/**
 * Resolves a known chat setting, falling back to group metadata when possible.
 * Baileys has no equivalent metadata request for one-to-one chats.
 */
export async function resolveWhatsAppEphemeralExpiration(
  socket: Pick<WASocket, "groupMetadata">,
  chatId: string,
  knownExpiration: unknown,
): Promise<number | undefined> {
  if (knownExpiration !== undefined) return normalizedExpiration(knownExpiration);
  if (!chatId.endsWith("@g.us")) return undefined;
  try {
    const metadata = await socket.groupMetadata(chatId);
    return normalizedExpiration(metadata.ephemeralDuration);
  } catch {
    // This lookup is best effort. A metadata failure must not block sending.
    return undefined;
  }
}

/** Builds Baileys options while preserving quote and disappearing contexts. */
export function buildWhatsAppSendOptions(
  quoted: WAMessage | undefined,
  ephemeralExpirationSeconds: number | undefined,
): MiscMessageGenerationOptions | undefined {
  const options: MiscMessageGenerationOptions = {};
  if (quoted) options.quoted = quoted;
  if (ephemeralExpirationSeconds !== undefined && ephemeralExpirationSeconds > 0) {
    options.ephemeralExpiration = ephemeralExpirationSeconds;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}
