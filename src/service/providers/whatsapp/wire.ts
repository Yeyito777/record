/**
 * The WhatsApp provider's names and ids: chat ids are `wa:` and the jid in
 * base64url (opaque to the apps, and no phone number in Moon's logs);
 * media refs name the chat and message they come from; phone numbers are
 * shown the way WhatsApp shows unsaved contacts.
 */

import { BridgeError } from "../../protocol";
import type { WhatsAppMessage } from "../../../whatsapp/types";
import type { StoredMessage, SystemNotice } from "./store";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url").toString("utf8");

export function wireChatId(jid: string): string {
  return `wa:${b64(jid)}`;
}

export function jidOfChat(id: string): string {
  if (!id.startsWith("wa:") || id.length < 6) throw new BridgeError("not_found", "no such chat");
  const jid = unb64(id.slice(3));
  if (!/^[^@\s]+@[a-z.]+$/.test(jid)) throw new BridgeError("not_found", "no such chat");
  return jid;
}

export function wireUserId(jid: string): string {
  return `u:${b64(jid)}`;
}

export type MediaRef =
  | { kind: "avatar"; jid: string }
  | { kind: "media" | "thumb"; jid: string; id: string };

export function mediaRef(kind: "media" | "thumb", jid: string, id: string): string {
  return `${kind === "media" ? "m" : "t"}:${b64(jid)}:${id}`;
}

export function avatarRef(jid: string): string {
  return `a:${b64(jid)}`;
}

export function parseRef(ref: string): MediaRef {
  const parts = ref.split(":");
  if (parts[0] === "a" && parts.length === 2) return { kind: "avatar", jid: unb64(parts[1]!) };
  if ((parts[0] === "m" || parts[0] === "t") && parts.length === 3 && parts[2]) {
    return { kind: parts[0] === "m" ? "media" : "thumb", jid: unb64(parts[1]!), id: parts[2] };
  }
  throw new BridgeError("not_found", "no such media");
}

/** The number in a jid as WhatsApp shows it (`+1 555-010-1234`), or null. */
export function formattedPhone(jid: string): string | null {
  const [user, domain] = jid.split("@");
  if (domain !== "s.whatsapp.net") return null;
  const digits = user?.split(":")[0] ?? "";
  if (!/^\d{7,15}$/.test(digits)) return null;
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}

/** Strips control and bidi characters from a name (record's sanitizeTerminalLabel's rules). */
export function cleanName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

const UNSUPPORTED: Record<string, string> = {
  contactMessage: "👤 Contact",
  contactsArrayMessage: "👤 Contacts",
  locationMessage: "📍 Location",
  liveLocationMessage: "📍 Live location",
  interactiveMessage: "Interactive message",
  buttonsMessage: "Interactive message",
  ptvMessage: "🎥 Video message",
  lottieStickerMessage: "Sticker",
  eventMessage: "📅 Event",
  pollCreationMessage: "📊 Poll",
  viewOnceMessage: "View once message",
  viewOnceMessageV2: "View once message",
  groupInviteMessage: "Group invite",
  orderMessage: "Order",
  productMessage: "Product",
  callLogMesssage: "Call",
};

/** A message's text as the apps show it (`""` for a photo without caption). */
export function messageText(message: WhatsAppMessage): string {
  if (message.content.kind === "text") return message.content.text;
  if (message.content.kind === "media") return message.content.caption ?? "";
  const type = message.content.sourceType ?? "";
  return UNSUPPORTED[type] ?? "This message can't be shown here. Open WhatsApp on your phone to see it.";
}

/** A message in a few words: the chat list's preview, a reply's quote. */
export function messageSummary(message: StoredMessage, noticeText?: (notice: SystemNotice) => string): string {
  if (message.x?.deleted) return message.fromMe ? "You deleted this message" : "This message was deleted";
  if (message.x?.system) return noticeText ? noticeText(message.x.system) : "";
  const text = messageText(message).replace(/\s+/g, " ").trim();
  if (message.content.kind !== "media") return text.slice(0, 200);
  const media = message.content;
  const label = media.mediaKind === "image" ? "📷 Photo"
    : media.mediaKind === "video" ? (media.animated ? "GIF" : "🎥 Video")
    : media.mediaKind === "audio" ? (media.voiceNote ? `🎤 Voice message${media.durationSeconds ? ` (${duration(media.durationSeconds)})` : ""}` : "🎵 Audio")
    : media.mediaKind === "sticker" ? "Sticker"
    : `📄 ${media.fileName ?? "Document"}`;
  if (!text) return label;
  return `${label.split(" ")[0]} ${text}`.slice(0, 200);
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A notice row's sentence, with the names known now. */
export function noticeSentence(notice: SystemNotice, name: (jid: string) => string): string {
  const actor = notice.actor ? name(notice.actor) : "";
  const targets = (notice.targets ?? []).map(name);
  const list = targets.length <= 2 ? targets.join(" and ") : `${targets.slice(0, -1).join(", ")} and ${targets.at(-1)}`;
  switch (notice.type) {
    case "created": return `${actor || "Someone"} created group "${notice.text ?? ""}"`;
    case "subject": return `${actor || "Someone"} changed the group name to "${notice.text ?? ""}"`;
    case "icon": return `${actor || "Someone"} changed this group's icon`;
    case "description": return `${actor || "Someone"} changed the group description`;
    case "added": return actor && targets.length ? `${actor} added ${list}` : `${list || "Someone"} joined`;
    case "removed": return `${actor || "Someone"} removed ${list || "someone"}`;
    case "left": return `${list || "Someone"} left`;
    case "joined": return `${list || "Someone"} joined using this group's invite link`;
    case "number": return `${list || "Someone"} changed their phone number`;
    case "missed_voice": return "Missed voice call";
    case "missed_video": return "Missed video call";
  }
}
