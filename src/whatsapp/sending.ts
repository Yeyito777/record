import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";

import type { WhatsAppImageUpload } from "./worker-protocol";

export const MAX_WHATSAPP_IMAGES_PER_SEND = 30;
export const MAX_WHATSAPP_IMAGE_BYTES = 64 * 1024 * 1024;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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

function decodeWhatsAppImage(image: WhatsAppImageUpload, index: number): Buffer {
  if (!image.mediaType.startsWith("image/")) throw new Error(`WhatsApp image ${index + 1} has an invalid media type.`);
  if (!Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 || image.sizeBytes > MAX_WHATSAPP_IMAGE_BYTES) {
    throw new Error(`WhatsApp image ${index + 1} has an invalid size.`);
  }
  if (!image.base64 || !BASE64.test(image.base64)) throw new Error(`WhatsApp image ${index + 1} has invalid data.`);
  const buffer = Buffer.from(image.base64, "base64");
  if (buffer.length !== image.sizeBytes) throw new Error(`WhatsApp image ${index + 1} size does not match its data.`);
  return buffer;
}

/** Sends pasted images in order. The first image carries the caption and reply. */
export async function sendWhatsAppImages(
  socket: Pick<WASocket, "sendMessage">,
  chatId: string,
  images: readonly WhatsAppImageUpload[],
  caption: string,
  quoted: WAMessage | undefined,
  ephemeralExpirationSeconds: number | undefined,
): Promise<WAMessage[]> {
  if (images.length === 0 || images.length > MAX_WHATSAPP_IMAGES_PER_SEND) {
    throw new Error(`WhatsApp image sends require 1-${MAX_WHATSAPP_IMAGES_PER_SEND} images.`);
  }
  // Validate everything before the first network send so malformed later images
  // cannot leave the operation partially sent.
  const buffers = images.map(decodeWhatsAppImage);
  const sentMessages: WAMessage[] = [];
  for (let index = 0; index < images.length; index++) {
    const content: AnyMessageContent = {
      image: buffers[index],
      mimetype: images[index].mediaType,
      ...(index === 0 && caption ? { caption } : {}),
    };
    const sent = await socket.sendMessage(
      chatId,
      content,
      buildWhatsAppSendOptions(index === 0 ? quoted : undefined, ephemeralExpirationSeconds),
    );
    if (!sent) throw new Error(`WhatsApp did not return sent image ${index + 1}.`);
    sentMessages.push(sent);
  }
  return sentMessages;
}
