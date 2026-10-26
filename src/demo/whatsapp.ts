/**
 * A fake WhatsApp for the offline demo, behind the same backend seam the real
 * Node worker uses (WhatsAppBackendHandle). No sockets, no auth: a few chats,
 * one of them nearly all photos, older pages on request after a delay, and
 * media "downloads" that take 100-800 ms like WhatsApp's fetch + decrypt.
 * Photos are JPEGs of real camera/screenshot sizes (ffmpeg, else PNG), made
 * on first download and shared by every message of the same size.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { WhatsAppBackendHandle } from "../whatsapp/controller";
import type {
  WhatsAppAccount,
  WhatsAppBackendEventListener,
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppChat,
  WhatsAppConnectionState,
  WhatsAppContact,
  WhatsAppLoginResult,
  WhatsAppMessage,
  WhatsAppMessageKey,
  WhatsAppReactionEvent,
} from "../whatsapp/types";
import type { WhatsAppDownloadMediaResult, WhatsAppImageUpload, WhatsAppSetChatMutedResult } from "../whatsapp/worker-protocol";
import { hexColor, renderPicture, type Rgb } from "./png";

export const DEMO_WHATSAPP_SELF = "5511900000000@s.whatsapp.net";
/** The chat that is nearly all photos (RECORD_DEMO_OPEN=wa-photos). */
export const DEMO_WHATSAPP_PHOTOS_CHAT = "120363000000000001@g.us";

/** Messages per chat a fresh connection (and the seeded cache) starts with. */
const RECENT_MESSAGES = 40;

interface PhotoSize {
  width: number;
  height: number;
  from: Rgb;
  to: Rgb;
}

/** Phone photos, screenshots, a few small and one huge. */
const PHOTO_SIZES: readonly PhotoSize[] = [
  { width: 1600, height: 1200, from: hexColor(0x1d4e89), to: hexColor(0x7fb3d5) },
  { width: 1200, height: 1600, from: hexColor(0x6a1b4d), to: hexColor(0xe59cc4) },
  { width: 1600, height: 900, from: hexColor(0x14532d), to: hexColor(0x86efac) },
  { width: 900, height: 1600, from: hexColor(0x7c2d12), to: hexColor(0xfdba74) },
  { width: 1280, height: 1280, from: hexColor(0x312e81), to: hexColor(0xa5b4fc) },
  { width: 4000, height: 3000, from: hexColor(0x134e4a), to: hexColor(0x5eead4) },
  { width: 640, height: 480, from: hexColor(0x3f3f46), to: hexColor(0xd4d4d8) },
  { width: 320, height: 240, from: hexColor(0x713f12), to: hexColor(0xfde047) },
  { width: 1920, height: 1080, from: hexColor(0x1e3a8a), to: hexColor(0x93c5fd) },
  { width: 1080, height: 1920, from: hexColor(0x4c1d95), to: hexColor(0xc4b5fd) },
  { width: 2048, height: 1536, from: hexColor(0x064e3b), to: hexColor(0x6ee7b7) },
  { width: 512, height: 512, from: hexColor(0x831843), to: hexColor(0xf9a8d4) },
];

const CAPTIONS = [
  "sunset from the balcony", "look at this", "the view!!", "found this in the old album",
  "dinner", "this is the place I told you about", "lol", "before / after", "first try", "rainy day",
];
const TEXTS = [
  "omg", "so pretty", "where is this?", "send more", "haha", "❤️", "wow", "I want to go back",
  "that's the one", "ok one more", "nice", "who took this?",
];

interface DemoPerson {
  jid: string;
  name: string;
}

const PEOPLE: readonly DemoPerson[] = [
  { jid: "5511900000101@s.whatsapp.net", name: "Ana Souza" },
  { jid: "5511900000102@s.whatsapp.net", name: "Mãe" },
  { jid: "5511900000103@s.whatsapp.net", name: "Lucas Pereira" },
  { jid: "5511900000104@s.whatsapp.net", name: "Bia Martins" },
  { jid: "5511900000105@s.whatsapp.net", name: "Rafa" },
];

interface ChatSpec {
  chat: WhatsAppChat;
  members: readonly DemoPerson[];
  count: number;
  /** Share of messages that are photos. */
  photos: number;
  stepMinutes: number;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

export interface DemoWhatsAppData {
  account: WhatsAppAccount;
  chats: WhatsAppChat[];
  contacts: WhatsAppContact[];
  /** Every message per chat, oldest first. */
  messagesByChatId: Map<string, WhatsAppMessage[]>;
  /** Which photo size a media message shows. */
  photoSizeByMessageId: Map<string, number>;
}

/** The demo's WhatsApp world, the same for every run with the same anchor. */
export function buildDemoWhatsAppData(anchorMs: number): DemoWhatsAppData {
  const [ana, mae, lucas, bia, rafa] = PEOPLE as [DemoPerson, DemoPerson, DemoPerson, DemoPerson, DemoPerson];
  const specs: ChatSpec[] = [
    { chat: { id: DEMO_WHATSAPP_PHOTOS_CHAT, kind: "group", name: "Photo dump 📷", unreadCount: 12 }, members: [ana, lucas, bia, rafa], count: 260, photos: 0.92, stepMinutes: 4 },
    { chat: { id: mae.jid, kind: "direct" }, members: [mae], count: 70, photos: 0.15, stepMinutes: 37 },
    { chat: { id: "120363000000000002@g.us", kind: "group", name: "Weekend trip" }, members: [lucas, bia, rafa], count: 140, photos: 0.35, stepMinutes: 11 },
    { chat: { id: ana.jid, kind: "direct", unreadCount: 2 }, members: [ana], count: 40, photos: 0, stepMinutes: 23 },
  ];
  const messagesByChatId = new Map<string, WhatsAppMessage[]>();
  const photoSizeByMessageId = new Map<string, number>();
  const chats: WhatsAppChat[] = [];
  specs.forEach((spec, chatIndex) => {
    const random = seeded(1000 + chatIndex);
    const group = spec.chat.kind === "group";
    const messages: WhatsAppMessage[] = [];
    for (let index = 0; index < spec.count; index++) {
      const id = `3EB0DEMO${chatIndex}${String(index).padStart(4, "0")}`;
      const fromMe = random() < 0.2;
      const sender = spec.members[Math.floor(random() * spec.members.length)]!;
      const senderId = fromMe ? DEMO_WHATSAPP_SELF : sender.jid;
      const timestampMs = anchorMs - (spec.count - index) * spec.stepMinutes * 60_000 - Math.floor(random() * 50_000);
      const key: WhatsAppMessageKey = {
        id,
        chatId: spec.chat.id,
        fromMe,
        ...(group && !fromMe ? { participantId: sender.jid } : {}),
      };
      const photo = random() < spec.photos;
      let content: WhatsAppMessage["content"];
      if (photo) {
        const size = Math.floor(random() * PHOTO_SIZES.length);
        const { width, height } = PHOTO_SIZES[size]!;
        photoSizeByMessageId.set(id, size);
        const caption = random() < 0.15 ? CAPTIONS[Math.floor(random() * CAPTIONS.length)] : undefined;
        // A few arrive without dimensions, as forwarded or old media can.
        const withSize = random() >= 0.04;
        content = {
          kind: "media",
          mediaKind: "image",
          mimeType: "image/jpeg",
          ...(caption ? { caption } : {}),
          ...(withSize ? { width, height } : {}),
          download: { mediaKeyBase64: Buffer.from(`demo-${id}`).toString("base64"), directPath: `/demo/${id}` },
        };
      } else {
        content = { kind: "text", text: TEXTS[Math.floor(random() * TEXTS.length)]! };
      }
      messages.push({
        key,
        id,
        chatId: spec.chat.id,
        senderId,
        ...(fromMe ? {} : { senderName: sender.name }),
        fromMe,
        timestampMs,
        content,
      });
    }
    messagesByChatId.set(spec.chat.id, messages);
    chats.push({ ...spec.chat, lastMessageAtMs: messages.at(-1)!.timestampMs ?? anchorMs });
  });
  return {
    account: { id: DEMO_WHATSAPP_SELF, name: "Demo User" },
    chats,
    contacts: PEOPLE.map((person) => ({ id: person.jid, name: person.name, pushName: person.name.split(" ")[0] })),
    messagesByChatId,
    photoSizeByMessageId,
  };
}

/** What Record's WhatsApp cache would hold after a previous run: the recent messages. */
export function demoWhatsAppCacheSnapshot(data: DemoWhatsAppData, savedAtMs: number): unknown {
  return {
    version: 1,
    savedAtMs,
    account: data.account,
    chats: data.chats,
    contacts: data.contacts,
    messagesByChatId: Object.fromEntries([...data.messagesByChatId].map(([chatId, messages]) => [chatId, messages.slice(-RECENT_MESSAGES)])),
  };
}

export interface DemoWhatsAppBackendOptions {
  data: DemoWhatsAppData;
  /** Delay of an older-history page. */
  olderPageDelayMs: number;
  /** Media fetch + decrypt time, spread per message between these. */
  mediaDelayMinMs?: number;
  mediaDelayMaxMs?: number;
  /** A chat picture URL the demo's fake CDN serves, or null for none. */
  pictureUrl?: (jid: string) => string | null;
  log?: (line: string) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One photo size as JPEG (ffmpeg), or PNG when ffmpeg is unavailable. */
function photoBytes(size: PhotoSize, seed: number): Promise<Buffer> {
  const png = renderPicture(size.width, size.height, size.from, size.to, seed);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-i", "pipe:0", "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(png);
      return;
    }
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin!.on("error", () => {});
    child.once("error", () => resolve(png));
    child.once("close", (code) => resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : png));
    child.stdin!.end(png);
  });
}

export class DemoWhatsAppBackend implements WhatsAppBackendHandle {
  state: WhatsAppConnectionState = { status: "idle" };
  private readonly listeners = new Map<WhatsAppBackendEventName, Set<(event: unknown) => void>>();
  private readonly photos = new Map<number, Promise<Buffer>>();
  private readonly uploads = new Map<string, Buffer>();
  private nextRequest = 0;
  private nextSent = 0;
  private stopped = false;

  constructor(private readonly options: DemoWhatsAppBackendOptions) {}

  get isConnected(): boolean {
    return this.state.status === "connected";
  }

  async startLogin(): Promise<WhatsAppLoginResult> {
    const { data } = this.options;
    this.setState({ status: "connecting", source: "saved-session", attempt: 1 });
    await delay(300);
    if (this.stopped) return { status: "stopped" };
    this.setState({ status: "connected", resumed: true, connectedAtMs: Date.now(), account: data.account });
    this.emit("history", {
      chats: data.chats,
      contacts: data.contacts,
      messages: [...data.messagesByChatId.values()].flatMap((messages) => messages.slice(-RECENT_MESSAGES)),
      skippedMessages: 0,
      isLatest: true,
      progress: 100,
      syncKind: "recent",
    });
    return { status: "connected", resumed: true, account: data.account };
  }

  cancelLogin(): boolean {
    return false;
  }

  async logout(): Promise<void> {
    this.stopped = true;
    this.setState({ status: "logged-out", disconnect: { code: 401, name: "loggedOut" } });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.setState({ status: "stopped" });
  }

  async sendText(chatId: string, text: string, quoted?: WhatsAppMessage, _ephemeral?: number, messageId?: string): Promise<WhatsAppMessage> {
    const message = this.ownMessage(chatId, { kind: "text", text }, messageId, quoted);
    this.store(message);
    return message;
  }

  async sendImages(chatId: string, images: WhatsAppImageUpload[], caption: string, quoted?: WhatsAppMessage, _ephemeral?: number, messageIds?: string[]): Promise<WhatsAppMessage[]> {
    return images.map((image, index) => {
      const message = this.ownMessage(chatId, {
        kind: "media",
        mediaKind: "image",
        mimeType: image.mediaType,
        ...(index === 0 && caption ? { caption } : {}),
      }, messageIds?.[index], index === 0 ? quoted : undefined);
      this.uploads.set(message.id, Buffer.from(image.base64, "base64"));
      this.store(message);
      return message;
    });
  }

  async markRead(): Promise<void> {}

  async sendReaction(key: WhatsAppMessageKey, emoji: string): Promise<WhatsAppReactionEvent> {
    return { target: key, reaction: { senderId: DEMO_WHATSAPP_SELF, fromMe: true, emoji } };
  }

  async fetchHistory(count: number, oldestKey: WhatsAppMessageKey, oldestTimestampMs: number): Promise<string> {
    const requestId = `demo-history-${++this.nextRequest}`;
    const chatId = oldestKey.chatId;
    const all = this.options.data.messagesByChatId.get(chatId) ?? [];
    const older = all.filter((message) => (message.timestampMs ?? 0) < oldestTimestampMs).slice(-count);
    this.options.log?.(`whatsapp history ${chatId} before ${oldestTimestampMs}: ${older.length}`);
    setTimeout(() => {
      if (this.stopped) return;
      const chat = this.options.data.chats.find((candidate) => candidate.id === chatId);
      this.emit("history", {
        chats: chat ? [chat] : [],
        contacts: [],
        messages: older,
        skippedMessages: 0,
        syncKind: "on-demand",
        requestId,
      });
    }, this.options.olderPageDelayMs);
    return requestId;
  }

  async downloadMedia(message: WhatsAppMessage, destinationPath: string): Promise<WhatsAppDownloadMediaResult> {
    const min = this.options.mediaDelayMinMs ?? 100;
    const max = this.options.mediaDelayMaxMs ?? 800;
    const started = Date.now();
    const bytes = this.uploads.get(message.id) ?? await this.photo(this.options.data.photoSizeByMessageId.get(message.id) ?? 0);
    // Fetch + decrypt: the same message always takes about as long.
    await delay(Math.max(0, min + (hash(message.id) % Math.max(1, max - min)) - (Date.now() - started)));
    if (this.stopped) throw new Error("WhatsApp is not connected.");
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, bytes);
    this.options.log?.(`whatsapp media ${message.id}: ${bytes.length} bytes in ${Date.now() - started} ms`);
    return { path: destinationPath, sizeBytes: bytes.length };
  }

  async setChatMuted(_chatId: string, muted: boolean): Promise<WhatsAppSetChatMutedResult> {
    return { mutedUntilMs: muted ? -1 : null };
  }

  async profilePictureUrl(jid: string): Promise<string | null> {
    return this.options.pictureUrl?.(jid) ?? null;
  }

  on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener as (event: unknown) => void);
    return () => set!.delete(listener as (event: unknown) => void);
  }

  private emit<K extends WhatsAppBackendEventName>(event: K, payload: WhatsAppBackendEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) void listener(payload);
  }

  private setState(state: WhatsAppConnectionState): void {
    this.state = state;
    this.emit("state", state);
  }

  private photo(size: number): Promise<Buffer> {
    let bytes = this.photos.get(size);
    if (!bytes) {
      bytes = photoBytes(PHOTO_SIZES[size] ?? PHOTO_SIZES[0]!, 7 + size);
      this.photos.set(size, bytes);
    }
    return bytes;
  }

  private ownMessage(chatId: string, content: WhatsAppMessage["content"], messageId: string | undefined, quoted: WhatsAppMessage | undefined): WhatsAppMessage {
    const id = messageId ?? `3EB0DEMOSENT${++this.nextSent}`;
    return {
      key: { id, chatId, fromMe: true },
      id,
      chatId,
      senderId: DEMO_WHATSAPP_SELF,
      fromMe: true,
      timestampMs: Date.now(),
      content,
      ...(quoted ? { replyTo: quoted.key } : {}),
    };
  }

  /** Later history pages and media downloads see what was sent. */
  private store(message: WhatsAppMessage): void {
    const messages = this.options.data.messagesByChatId.get(message.chatId);
    messages?.push(message);
  }
}
