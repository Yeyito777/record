/**
 * A made-up WhatsApp account for `--fixtures`: the same backend seam as the
 * real one (`backend.ts`), so the provider, its store and its conversions
 * run exactly as they do on a real account. Deterministic: the same chats,
 * contacts and messages every run (only their times follow the clock, from
 * the hour the bridge started; `RECORD_WA_FIXTURES_ANCHOR=ms` pins them).
 *
 * About 200 chats (people, groups, a few archived, pinned and muted ones),
 * histories with photos, videos, GIFs, voice notes, documents, stickers,
 * replies, reactions, edits, deletions, forwards, receipts and group
 * notices. "Ana Ruiz" has a long history, most of it fetched on demand from
 * the "phone" (as WhatsApp does) when the app scrolls back; "Family" is long
 * too, "Climbing crew" mostly photos. With writes on (fixtures default),
 * sends are echoed, delivered, read and answered.
 *
 * `RECORD_WA_FIXTURES_SIGNED_OUT=1` starts signed out: `login.start` shows
 * made-up QR codes, and `whatsapp.fixtures.scan` "scans" one.
 * `whatsapp.fixtures.poke` makes someone write now (notifications, badge).
 */

import { writeFileSync } from "node:fs";

import { Canvas, cachedDemoImage, hexColor, renderIcon, renderPicture, type Rgb } from "../../../demo/png";
import type {
  WhatsAppBackendEventListener,
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppChat,
  WhatsAppConnectionState,
  WhatsAppContact,
  WhatsAppLoginResult,
  WhatsAppMediaContent,
  WhatsAppMessage,
  WhatsAppMessageKey,
} from "../../../whatsapp/types";
import type { RawEvent, WaBackend } from "./backend";
import type { Extras, StoredMessage, SystemNotice } from "./store";

export const FIXTURE_SELF = "15550100000@s.whatsapp.net";
const SELF_NAME = "Alex Moreno";

const FIRST = [
  "Ana", "Leo", "Sam", "Priya", "Jonas", "Mika", "Sofía", "Mateo", "Valentina", "Lucas", "Camila", "Diego", "Isabel", "Noah",
  "Emma", "Liam", "Olivia", "Ethan", "Mia", "Lucía", "Martina", "Hugo", "Nora", "Omar", "Yuki", "Chen", "Aisha", "Ravi",
  "Fatima", "Tomás", "Elena", "Pablo", "Lena", "Felix", "Clara", "Iván", "Julia", "Marco", "Sara", "Nico", "Grace", "Kofi",
];
const LAST = [
  "Ruiz", "Park", "Okafor", "Shah", "Berg", "Tanaka", "García", "López", "Rossi", "Müller", "Silva", "Kim", "Nguyen", "Costa",
  "Moreau", "Novak", "Haddad", "Reyes", "Ito", "Kowalski", "Andersen", "Fischer", "Romero", "Santos", "Patel", "Vega", "Ortiz",
  "Lindqvist", "Duarte", "Hale", "Mensah",
];
const GROUPS = [
  "Family", "Climbing crew 🧗", "Weekend trip ✈️", "Study group", "Design review", "Old friends", "Book club 📚", "Neighbors",
  "Soccer Thursdays ⚽", "Apartment 4B", "Wedding planning 💍", "Office lunch", "Mom & Dad", "Board games night 🎲",
  "Running club", "Cousins", "Product launch", "Garden share 🌱", "Band practice 🎸", "Uni reunion", "Hiking 🏔️",
  "Secret Santa 🎁", "Spanish practice", "Photo walk 📸", "Dinner club", "Bike repairs", "Team standup", "Pickup basketball",
  "Movie night 🍿", "Parents of 3B", "Beach house", "Recipes 🍝", "Concert tickets", "Roommates", "Volunteers",
  "Ski trip ⛷️", "Language exchange", "Chess club ♟️", "Housewarming 🏠", "Thesis support",
];
const LINES = [
  "are you coming tonight?", "haha yes", "I'll bring the snacks", "did you see the photos?", "running 5 min late",
  "that's wild", "ok sounds good", "can you send me the notes from today?", "on my way 🚗", "❤️❤️", "let's do saturday instead",
  "lol", "wait what", "good morning!", "thanks!!", "see you there", "omg 😂😂", "I'm outside", "perfect 👌", "no worries",
  "what time works for you?", "just landed ✈️", "happy birthday!! 🎉🎂", "did you eat yet?", "call me when you can",
  "that's *exactly* what I said", "sounds _amazing_", "I can't believe it's already November", "👍", "yesss",
  "can't make it today, sorry 😕", "the meeting moved to 3pm", "I found a great place for dinner: https://maps.example.com/p/2841",
  "brb", "where are you guys?", "we're at the usual table", "who's bringing the speaker?", "🔥🔥🔥", "same here",
  "tell me more", "I'll check and get back to you", "that was the best concert ever", "ok ok", "Sure, no problem.",
  "let me know when you're free this week", "send pics!", "miss you guys", "is it raining there too? ☔",
  "this one is a longer message, the kind that wraps over two or three lines in a bubble on a phone screen, because sometimes people write paragraphs",
  "Quick update:\n- tickets booked\n- hotel confirmed\n- still need a car", "```npm run build``` fails on my machine",
  "~cancelled~ moved to next week", "Remember to bring your ID 🪪", "¿vienes mañana?", "Ja, klar! 😄", "Ciao!",
  "I left the keys under the mat", "can you pick up milk on the way back? 🥛", "ok I'm here", "1 sec", "good night 🌙",
];
const LONG_LINES = [
  "So here's the plan for tomorrow: we meet at the station at 8, take the 8:20 train, and should be at the trailhead around 10. Bring water, snacks and a jacket, it gets cold up there in the afternoon.",
  "I've been thinking about what you said yesterday and I think you're right. We should just go for it and stop overthinking every little detail. Worst case we learn something 🤷",
  "Reminder for everyone: rent is due on the 1st, the cleaning schedule is on the fridge, and please don't leave dishes in the sink overnight 🙏",
];
const CAPTIONS = ["sunset from the balcony 🌅", "look at this", "the view!!", "dinner", "found this in the old album", "before / after", "", "", "", ""];
const DOCS: [string, string, number][] = [
  ["Itinerary.pdf", "application/pdf", 182_400], ["Budget 2026.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 48_211],
  ["Notes week 4.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 23_904], ["tickets.pdf", "application/pdf", 391_552],
];
const PHOTO_SIZES: [number, number][] = [[1600, 1200], [1200, 1600], [1080, 1350], [1600, 900], [1200, 1200], [900, 1600]];
const COLORS: Rgb[] = [0xe57373, 0x64b5f6, 0x81c784, 0xffb74d, 0xba68c8, 0x4db6ac, 0xf06292, 0x9575cd, 0x4fc3f7, 0xaed581].map(hexColor);
const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🙏", "🔥"];
const HOUR = 3_600_000;
const MINUTE = 60_000;

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

interface Person { jid: string; name?: string; pushName?: string; picture: boolean }

interface FixtureChat {
  index: number;
  jid: string;
  group: boolean;
  name?: string;
  members: string[];
  /** Messages delivered at the first sync, oldest first. */
  messages: StoredMessage[];
  /** Older messages only the "phone" has (on-demand history), oldest first. */
  older: StoredMessage[];
  unread: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
}

interface Fixture {
  people: Person[];
  chats: FixtureChat[];
  /** Status updates of the last day, oldest first. */
  statuses: StoredMessage[];
}

function phone(index: number): string {
  return `1555${String(2_000_000 + ((index * 7919) % 7_000_000)).padStart(7, "0")}@s.whatsapp.net`;
}

function key(chat: FixtureChat, id: string, fromMe: boolean, sender: string): WhatsAppMessageKey {
  return { id, chatId: chat.jid, fromMe, ...(chat.group && !fromMe ? { participantId: sender } : {}) };
}

function media(kind: WhatsAppMediaContent["mediaKind"], fields: Partial<WhatsAppMediaContent>): WhatsAppMediaContent {
  return { kind: "media", mediaKind: kind, download: { mediaKeyBase64: "Zml4dHVyZQ==", directPath: "/fixture" }, ...fields };
}

let thumbs: string[] | null = null;
function thumb(seed: number): string {
  thumbs ??= PHOTO_SIZES.map(([w, h], index) => cachedDemoImage(`wa-thumb-${index}`, () =>
    renderPicture(Math.round(w / 25), Math.round(h / 25), COLORS[index]!, COLORS[(index + 3) % COLORS.length]!, index + 1)).toString("base64"));
  return thumbs[seed % thumbs.length]!;
}

/** Builds the whole account; `anchor` is the newest message's time. */
export function buildFixture(anchor: number): Fixture {
  const people: Person[] = [];
  for (let i = 0; i < 150; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length]}`;
    const saved = i % 23 !== 22;
    people.push({ jid: phone(i + 1), ...(saved ? { name } : {}), pushName: name.split(" ")[0], picture: i % 6 !== 5 });
  }
  const chats: FixtureChat[] = [];
  // Interleave people and groups the way a real list mixes them.
  const order: { group: boolean; index: number }[] = [];
  for (let i = 0, p = 0, g = 0; p < 150 || g < GROUPS.length; i++) {
    if (g < GROUPS.length && (i % 5 === 1 || p >= 150)) order.push({ group: true, index: g++ });
    else order.push({ group: false, index: p++ });
  }
  order.push({ group: false, index: 150 }, { group: false, index: 151 });
  order.forEach((entry, position) => {
    const random = rng(position + 11);
    const group = entry.group;
    const jid = group ? `1203630${String(4_000_000_000 + entry.index * 97).padStart(11, "0")}@g.us` : entry.index >= 150 ? phone(900 + entry.index) : people[entry.index]!.jid;
    const members = group
      ? Array.from({ length: 3 + Math.floor(random() * 9) }, (_, n) => people[(entry.index * 13 + n * 17) % people.length]!.jid)
      : [jid];
    const long = position === 0 ? 2400 : group && entry.index === 0 ? 1500 : group && entry.index === 1 ? 400 : 0;
    const count = long || 6 + Math.floor(random() ** 1.6 * 70);
    const chat: FixtureChat = {
      index: position, jid, group, members, messages: [], older: [],
      ...(group ? { name: GROUPS[entry.index] } : {}),
      unread: [1, 3, 4, 8, 12, 15, 21, 30].includes(position) ? 1 + Math.floor(random() * (position === 4 ? 40 : 6)) : 0,
      pinned: position === 3 || position === 1 || position === 9,
      archived: position % 47 === 46,
      muted: position % 13 === 7,
    };
    // The newest message: minutes ago for the first chats, months for the last.
    const newest = anchor - Math.round((position ** 1.55) * 9 * MINUTE + random() * 5 * MINUTE);
    const photos = group && entry.index === 1;
    const list = buildHistory(chat, count, newest, random, photos, chat.unread);
    const local = position === 0 ? 400 : list.length;
    chat.older = list.slice(0, list.length - local);
    chat.messages = list.slice(list.length - local);
    chats.push(chat);
  });
  return { people, chats, statuses: buildStatuses(people, anchor) };
}

const STATUS_TEXTS = [
  "Monday mood ☕", "Back home after 3 weeks ✈️", "New place, who's coming over?", "🏔️🏔️🏔️", "Can't believe it's November",
  "Finally finished the marathon 🏃", "Sunday reset", "Thank you all for the birthday wishes ❤️",
];
const STATUS_COLORS = [0xff1f7aec, 0xff7e57c2, 0xff26a69a, 0xffef5350, 0xff5c6bc0, 0xffffa726, 0xff8d6e63, 0xff66bb6a];

function buildStatuses(people: Person[], anchor: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  [0, 2, 5, 7, 11, 14, 19, 23, 30].forEach((index, n) => {
    const person = people[index]!;
    const random = rng(500 + index);
    const count = 1 + Math.floor(random() * 4);
    let ts = anchor - (2 + n * 2.1) * HOUR;
    for (let k = 0; k < count; k++) {
      ts += Math.round((5 + random() * 40) * MINUTE);
      const id = `ST${index.toString(36).toUpperCase()}${k}B7`;
      const message: StoredMessage = {
        key: { id, chatId: "status@broadcast", fromMe: false, participantId: person.jid }, id, chatId: "status@broadcast",
        fromMe: false, senderId: person.jid, timestampMs: ts, content: { kind: "text", text: "" },
      };
      if (random() < 0.55) {
        const size = Math.floor(random() * PHOTO_SIZES.length);
        const [w, h] = PHOTO_SIZES[size]!;
        message.content = media("image", { mimeType: "image/jpeg", width: w, height: h, sizeBytes: Math.round(w * h * 0.12), caption: random() < 0.5 ? STATUS_TEXTS[(n + k) % STATUS_TEXTS.length] : "" });
        message.x = { thumb: thumb(size) };
      } else {
        message.content = { kind: "text", text: STATUS_TEXTS[(n * 3 + k) % STATUS_TEXTS.length]! };
        message.x = { color: STATUS_COLORS[(n + k) % STATUS_COLORS.length]! };
      }
      out.push(message);
    }
  });
  return out;
}

function buildHistory(chat: FixtureChat, count: number, newest: number, random: () => number, photos: boolean, unread: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  // Walk back from the newest message, then reverse.
  let ts = newest;
  const times: number[] = [];
  for (let n = 0; n < count; n++) {
    times.push(ts);
    const gap = random() < 0.08 ? (4 + random() * 30) * HOUR : random() < 0.3 ? (5 + random() * 90) * MINUTE : (0.2 + random() * 4) * MINUTE;
    ts -= Math.round(gap);
  }
  times.reverse();
  const prefix = `F${chat.index.toString(36).toUpperCase().padStart(2, "0")}`;
  for (let n = 0; n < count; n++) {
    const id = `${prefix}${n.toString(36).toUpperCase().padStart(4, "0")}A7C3`;
    // The unread messages at the end are someone else's.
    const mine = random() < (chat.group ? 0.25 : 0.42) && n < count - unread;
    const sender = mine ? FIXTURE_SELF : chat.group ? chat.members[Math.floor(random() * chat.members.length)]! : chat.jid;
    const message: StoredMessage = {
      key: key(chat, id, mine, sender), id, chatId: chat.jid, fromMe: mine, senderId: sender,
      timestampMs: times[n]!, content: { kind: "text", text: "" },
    };
    const extras: Extras = {};
    const roll = random();
    if (chat.group && n === 0) {
      message.content = { kind: "unsupported", sourceType: "stub" };
      extras.system = { type: "created", actor: chat.members[0]!, text: chat.name ?? "" };
    } else if (chat.group && roll < 0.012) {
      message.content = { kind: "unsupported", sourceType: "stub" };
      const target = chat.members[Math.floor(random() * chat.members.length)]!;
      const notice: SystemNotice = random() < 0.5
        ? { type: "added", actor: chat.members[0]!, targets: [target] }
        : random() < 0.5 ? { type: "left", targets: [target] } : { type: "icon", actor: target };
      extras.system = notice;
    } else if (!chat.group && roll < 0.008) {
      message.content = { kind: "unsupported", sourceType: "stub" };
      extras.system = { type: random() < 0.6 ? "missed_voice" : "missed_video" };
    } else if (photos ? roll < 0.75 : roll < 0.07) {
      const size = Math.floor(random() * PHOTO_SIZES.length);
      const [w, h] = PHOTO_SIZES[size]!;
      message.content = media("image", { mimeType: "image/jpeg", width: w, height: h, sizeBytes: Math.round(w * h * 0.12), caption: CAPTIONS[Math.floor(random() * CAPTIONS.length)] });
      extras.thumb = thumb(size);
    } else if (roll < 0.09) {
      const size = Math.floor(random() * 4);
      const [w, h] = PHOTO_SIZES[size]!;
      const gif = random() < 0.35;
      message.content = media("video", { mimeType: "video/mp4", width: Math.round(w / 2), height: Math.round(h / 2), durationSeconds: gif ? 3 : 4 + Math.floor(random() * 80), sizeBytes: 2_400_000, ...(gif ? { animated: true } : {}), caption: gif ? "" : CAPTIONS[Math.floor(random() * CAPTIONS.length)] });
      extras.thumb = thumb(size);
    } else if (roll < 0.13) {
      message.content = media("audio", { mimeType: "audio/ogg; codecs=opus", voiceNote: true, durationSeconds: 2 + Math.floor(random() ** 2 * 120), sizeBytes: 30_000 });
    } else if (roll < 0.14) {
      const [name, mime, size] = DOCS[Math.floor(random() * DOCS.length)]!;
      message.content = media("document", { mimeType: mime, fileName: name, sizeBytes: size });
    } else if (roll < 0.16) {
      message.content = media("sticker", { mimeType: "image/webp", width: 512, height: 512, sizeBytes: 18_000 });
    } else if (roll < 0.163) {
      message.content = { kind: "text", text: "[Location]\nCafé Central\nhttps://maps.google.com/?q=40.4168,-3.7038" };
    } else if (roll < 0.17) {
      message.content = { kind: "text", text: LONG_LINES[Math.floor(random() * LONG_LINES.length)]! };
    } else {
      message.content = { kind: "text", text: LINES[Math.floor(random() * LINES.length)]! };
    }
    if (!extras.system) {
      if (n > 3 && random() < 0.08) {
        const target = out[n - 1 - Math.floor(random() * Math.min(6, n - 1))]!;
        if (!target.x?.system) {
          message.replyTo = { id: target.id, chatId: chat.jid, ...(target.senderId && chat.group ? { participantId: target.senderId } : {}) };
          extras.quote = { text: fixtureSummary(target), ...(target.senderId ? { participant: target.senderId } : {}) };
        }
      }
      if (random() < 0.07) {
        const reactors = chat.group ? chat.members.slice(0, 1 + Math.floor(random() * 3)) : [mine ? chat.jid : FIXTURE_SELF];
        message.reactions = reactors.map((jid, r) => ({ senderId: jid, fromMe: jid === FIXTURE_SELF, emoji: REACTIONS[(n + r) % REACTIONS.length]! }));
      }
      if (random() < 0.015) message.editedTimestampMs = (message.timestampMs ?? 0) + 2 * MINUTE;
      if (random() < 0.012) {
        extras.deleted = true;
        message.content = { kind: "text", text: "" };
      }
      if (random() < 0.02) extras.forwarded = true;
      if (mine) extras.status = n >= count - 2 && !chat.group ? (n === count - 1 ? "delivered" : "read") : "read";
      if (!mine && !chat.group && random() < 0.05) message.senderName = chat.jid;
    }
    if (Object.keys(extras).length > 0) message.x = extras;
    out.push(message);
  }
  return out;
}

function fixtureSummary(message: StoredMessage): string {
  if (message.content.kind === "text") return message.content.text.slice(0, 120);
  if (message.content.kind === "media") {
    if (message.content.caption) return message.content.caption;
    return { image: "📷 Photo", video: "🎥 Video", audio: "🎤 Voice message", document: `📄 ${message.content.fileName ?? "Document"}`, sticker: "Sticker" }[message.content.mediaKind];
  }
  return "";
}

/** A made-up profile photo: a person against a coloured wall, or for a group a landscape. */
function portrait(seed: number, group: boolean): Buffer {
  const size = 192;
  const random = rng(seed + 101);
  const wall = COLORS[seed % COLORS.length]!;
  const canvas = new Canvas(size, size);
  const shade = (c: Rgb, k: number): Rgb => c.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))) as unknown as Rgb;
  if (group) {
    canvas.gradient(shade(wall, 1.15), shade(wall, 0.55));
    canvas.fillCircle(size * (0.2 + random() * 0.6), size * 0.3, size * 0.12, [255, 236, 179], 230);
    canvas.fillCircle(size * 0.25, size * 1.1, size * 0.55, shade(wall, 0.4), 255);
    canvas.fillCircle(size * 0.85, size * 1.15, size * 0.6, shade(wall, 0.3), 255);
    return canvas.encode();
  }
  canvas.gradient(shade(wall, 1.2), shade(wall, 0.7));
  const skins: Rgb[] = [[241, 194, 166], [224, 172, 135], [198, 134, 98], [141, 85, 62], [255, 219, 190]];
  const hair: Rgb[] = [[40, 30, 25], [92, 58, 33], [180, 130, 70], [20, 20, 20], [140, 70, 40]];
  const skin = skins[Math.floor(random() * skins.length)]!;
  const top: Rgb = [Math.floor(random() * 200), Math.floor(random() * 200), Math.floor(random() * 200)];
  canvas.fillCircle(size * 0.5, size * 1.08, size * 0.42, top, 255);
  canvas.fillRect(size * 0.43, size * 0.55, size * 0.14, size * 0.16, shade(skin, 0.92), 255);
  canvas.fillCircle(size * 0.5, size * 0.4, size * 0.2, hair[Math.floor(random() * hair.length)]!, 255);
  canvas.fillCircle(size * 0.5, size * 0.45, size * 0.18, skin, 255);
  canvas.grain(seed, 4);
  return canvas.encode();
}

/** The made-up QR payload (never a real pairing). */
function fakeQr(serial: number): string {
  return `2@FIXTURE${serial.toString(36).toUpperCase()}${"x".repeat(90)},${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(2)},fixture-${serial}`;
}

type Listener = (event: unknown) => void;

export function createFixturesBackend(options: { anchor?: number; signedOut?: boolean; delayMs?: number } = {}): WaBackend & {
  scan(): void;
  poke(chatJid?: string, text?: string): void;
  readonly fixture: Fixture;
} {
  const anchor = options.anchor ?? (Number(process.env.RECORD_WA_FIXTURES_ANCHOR || 0) || Math.floor(Date.now() / HOUR) * HOUR);
  const fixture = buildFixture(anchor);
  const byJid = new Map(fixture.chats.map((chat) => [chat.jid, chat]));
  const listeners = new Map<WhatsAppBackendEventName, Set<Listener>>();
  const rawListeners = new Set<(event: RawEvent) => void>();
  let signedIn = !(options.signedOut ?? process.env.RECORD_WA_FIXTURES_SIGNED_OUT === "1");
  let state: WhatsAppConnectionState = { status: "idle" };
  let qrTimer: ReturnType<typeof setInterval> | null = null;
  let qrSerial = 0;
  let requests = 0;
  let sent = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); run(); }, ms);
    timers.add(timer);
  };

  const emit = <K extends WhatsAppBackendEventName>(event: K, data: WhatsAppBackendEventMap[K]) => {
    if (event === "state") state = data as WhatsAppConnectionState;
    for (const listener of [...(listeners.get(event) ?? [])]) listener(data);
  };
  const raw = (event: RawEvent) => {
    for (const listener of rawListeners) listener(event);
  };
  const account = { id: `${FIXTURE_SELF.split("@")[0]}:12@s.whatsapp.net`, name: SELF_NAME };

  const plain = (message: StoredMessage): WhatsAppMessage => {
    const { x: _extras, ...rest } = message;
    return rest;
  };
  /** Sends messages the way Baileys' events bring them: extras first. */
  const deliver = (messages: StoredMessage[], live: boolean): WhatsAppMessage[] => {
    const converted: WhatsAppMessage[] = [];
    for (const message of messages) {
      if (message.x?.system) {
        raw({ kind: "system", message, live });
        continue;
      }
      if (message.x) raw({ kind: "extras", id: message.id, extras: message.x });
      converted.push(plain(message));
    }
    return converted;
  };

  const chatOf = (chat: FixtureChat): WhatsAppChat => ({
    id: chat.jid, kind: chat.group ? "group" : "direct",
    ...(chat.name ? { name: chat.name } : {}),
    lastMessageAtMs: chat.messages.at(-1)?.timestampMs ?? 0,
    unreadCount: chat.unread, archived: chat.archived, pinned: chat.pinned,
    ...(chat.muted ? { mutedUntilMs: -1 } : {}),
  });
  const contacts = (): WhatsAppContact[] => fixture.people.map((person) => ({
    id: person.jid, ...(person.name ? { name: person.name } : {}), ...(person.pushName ? { pushName: person.pushName } : {}),
  }));

  const connect = () => {
    emit("state", { status: "connecting", source: "saved-session", attempt: 0 });
    later(options.delayMs ?? 30, () => {
      emit("state", { status: "connected", resumed: true, connectedAtMs: Date.now(), account });
      // The first sync, in chunks as the phone sends it.
      const all = fixture.chats;
      emit("history", { chats: all.map(chatOf), contacts: contacts(), messages: [], skippedMessages: 0, syncKind: "initial-bootstrap" });
      for (let i = 0; i < all.length; i += 40) {
        const chunk = all.slice(i, i + 40).flatMap((chat) => chat.messages);
        emit("history", { chats: [], contacts: [], messages: deliver(chunk, false), skippedMessages: 0, syncKind: "recent", isLatest: i + 40 >= all.length });
      }
      for (const chat of all) if (chat.group) raw({ kind: "group", chatId: chat.jid, size: chat.members.length + 1 });
      emit("history", { chats: [], contacts: [], messages: deliver(fixture.statuses, false), skippedMessages: 0, syncKind: "initial-status" });
    });
  };

  const stopQr = () => {
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = null;
  };

  const backend = {
    fixture,
    get state() { return state; },
    on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(listener as Listener);
      return () => set!.delete(listener as Listener);
    },
    onRaw(listener: (event: RawEvent) => void) {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
    async hasSession() {
      return signedIn;
    },
    async startLogin(): Promise<WhatsAppLoginResult> {
      if (signedIn) {
        connect();
        return { status: "connected", resumed: true, account };
      }
      emit("state", { status: "connecting", source: "login", attempt: 0 });
      const show = () => {
        emit("state", { status: "awaiting-qr", attempt: 0 });
        emit("qr", { qr: fakeQr(++qrSerial), issuedAtMs: Date.now() });
      };
      later(200, show);
      stopQr();
      qrTimer = setInterval(show, 20_000);
      return { status: "cancelled" };
    },
    cancelLogin() {
      stopQr();
      if (signedIn) return false;
      emit("state", { status: "cancelled" });
      return true;
    },
    scan() {
      if (signedIn || !qrTimer) return;
      stopQr();
      emit("state", { status: "connecting", source: "login", attempt: 0 });
      later(1_500, () => {
        signedIn = true;
        connect();
      });
    },
    poke(chatJid?: string, text?: string) {
      const chat = (chatJid && byJid.get(chatJid)) || fixture.chats[2]!;
      const sender = chat.group ? chat.members[0]! : chat.jid;
      const id = `P${Date.now().toString(36).toUpperCase()}`;
      const message: StoredMessage = {
        key: key(chat, id, false, sender), id, chatId: chat.jid, fromMe: false, senderId: sender,
        timestampMs: Date.now(), content: { kind: "text", text: text ?? "a new message" },
      };
      chat.messages.push(message);
      emit("chats", { kind: "update", chats: [{ id: chat.jid, kind: chat.group ? "group" : "direct", unreadCount: 1, lastMessageAtMs: message.timestampMs! }] });
      emit("messages", { kind: "upsert", upsertType: "notify", messages: deliver([message], true), skippedMessages: 0 });
    },
    async logout() {
      signedIn = false;
      emit("state", { status: "logged-out", disconnect: { code: 401, name: "loggedOut" } });
    },
    async shutdown() {
      stopQr();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      emit("state", { status: "stopped" });
    },
    async fetchHistory(count: number, anchorKey: WhatsAppMessageKey, timestampMs: number) {
      const requestId = `fixture-${++requests}`;
      const chat = byJid.get(anchorKey.chatId);
      later(250, () => {
        const older = (chat?.older ?? []).filter((message) => (message.timestampMs ?? 0) < timestampMs);
        const page = older.slice(Math.max(0, older.length - count));
        emit("history", { chats: [], contacts: [], messages: deliver(page, false), skippedMessages: 0, syncKind: "on-demand", requestId });
      });
      return requestId;
    },
    async downloadMedia(message: WhatsAppMessage, path: string) {
      if (message.content.kind !== "media") throw new Error("not media");
      const content = message.content;
      const seed = [...message.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      let bytes: Buffer;
      if (content.mediaKind === "image" || content.mediaKind === "video" || content.mediaKind === "sticker") {
        const scale = Math.min(1, 1280 / Math.max(content.width ?? 1200, content.height ?? 1200));
        const w = Math.round((content.width ?? 1200) * scale), h = Math.round((content.height ?? 1200) * scale);
        const variant = seed % 5;
        bytes = cachedDemoImage(`wa-${content.mediaKind}-${w}x${h}-${variant}`, () => content.mediaKind === "sticker"
          ? renderIcon(["🙂", "OK", "HI", "<3", "!!"][variant]!, COLORS[variant]!, 512, true)
          : renderPicture(w, h, COLORS[variant]!, COLORS[(variant + 4) % COLORS.length]!, variant + 1));
      } else {
        bytes = Buffer.from(`fixture ${content.mediaKind} ${message.id}\n`);
      }
      writeFileSync(path, bytes, { mode: 0o600 });
      return { path, sizeBytes: bytes.length };
    },
    async profilePicture(jid: string, path: string, _full?: boolean) {
      const person = fixture.people.find((candidate) => candidate.jid === jid);
      const chat = byJid.get(jid);
      if ((person && !person.picture) || (!person && !chat?.group)) return false;
      const index = person ? fixture.people.indexOf(person) : chat!.index;
      writeFileSync(path, cachedDemoImage(`wa-portrait-${jid.split("@")[0]}`, () => portrait(index, !person)), { mode: 0o600 });
      return true;
    },
    async groupInfo(jid: string) {
      const chat = byJid.get(jid);
      return chat?.group ? { subject: chat.name ?? null, size: chat.members.length + 1 } : null;
    },
    newMessageId() {
      return `S${Date.now().toString(36).toUpperCase()}${(++sent).toString(36).toUpperCase()}`;
    },
    async sendText(chatId: string, text: string, quoted: WhatsAppMessage | undefined, messageId: string) {
      const chat = byJid.get(chatId);
      if (!chat) throw new Error("no such chat");
      const message: StoredMessage = {
        key: { id: messageId, chatId, fromMe: true }, id: messageId, chatId, fromMe: true, senderId: FIXTURE_SELF,
        timestampMs: Date.now(), content: { kind: "text", text },
        ...(quoted ? { replyTo: { id: quoted.id, chatId, ...(quoted.senderId ? { participantId: quoted.senderId } : {}) } } : {}),
        x: { status: "sent" },
      };
      chat.messages.push(message);
      later(10, () => emit("messages", { kind: "upsert", upsertType: "append", messages: deliver([message], false), skippedMessages: 0 }));
      later(800, () => raw({ kind: "status", chatId, id: messageId, status: "delivered" }));
      later(2_500, () => raw({ kind: "status", chatId, id: messageId, status: "read" }));
      if (!chat.group) later(3_000, () => backend.poke(chatId, `↩ ${text.slice(0, 60)}`));
      return plain(message);
    },
    async sendReaction(target: WhatsAppMessageKey, emoji: string) {
      later(10, () => emit("reactions", [{ target, reaction: { senderId: FIXTURE_SELF, fromMe: true, emoji } }]));
    },
    async markRead(keys: WhatsAppMessageKey[]) {
      const chat = keys[0] ? byJid.get(keys[0].chatId) : undefined;
      if (chat) emit("chats", { kind: "update", chats: [{ id: chat.jid, kind: chat.group ? "group" : "direct", unreadCount: 0 }] });
    },
  };
  return backend;
}
