/** WhatsApp profile / group pictures for the sidebar (preview size only). */

/** Chats that can have a picture: people (phone number or LID) and groups. */
const PICTURE_JID_RE = /^[0-9]{1,40}(?::[0-9]{1,4})?@(?:s\.whatsapp\.net|lid|g\.us)$|^[0-9]{1,40}-[0-9]{1,20}@g\.us$/;
const PROFILE_PICTURE_TIMEOUT_MS = 10_000;

export function isWhatsAppPictureJid(jid: string): boolean {
  return PICTURE_JID_RE.test(jid);
}

interface ProfilePictureSocket {
  profilePictureUrl(jid: string, type?: "preview" | "image", timeoutMs?: number): Promise<string | undefined>;
}

/**
 * The preview picture URL for one chat, or null when it has none or hides it
 * from us (WhatsApp answers 404 item-not-found / 401 not-authorized). Any
 * other failure, such as 429 rate-overlimit, is thrown so the caller backs off.
 */
export async function fetchWhatsAppProfilePictureUrl(socket: ProfilePictureSocket, jid: string): Promise<string | null> {
  if (!isWhatsAppPictureJid(jid)) throw new Error("Invalid profile-picture request.");
  try {
    const url = await socket.profilePictureUrl(jid, "preview", PROFILE_PICTURE_TIMEOUT_MS);
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  } catch (error) {
    const code = (error as { data?: unknown }).data;
    if (code === 404 || code === 401) return null;
    throw error;
  }
}
