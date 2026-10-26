/**
 * A fake Instagram for the offline demo, behind the Instagram controller's
 * client seam (InstagramControllerOptions.clientFactory). No cookies, no
 * network: a few chats full of what real Instagram DMs carry (shared posts,
 * reels and stories with and without preview sizes, photos, videos, albums,
 * stickers, GIFs, voice notes, links, long text, very tall and very wide
 * pictures, reaction notices), older pages after a delay, inbox previews
 * reduced the way Instagram's inbox query reduces them, and a fake CDN whose
 * pictures take 200-1500 ms to "download". Pictures are JPEGs of the size
 * their URL names, made on first request and shared by every URL of that size.
 */

import { InstagramClient, type InstagramReelMedia, type InstagramSendReceipt } from "../instagram/client";
import type { InstagramSession } from "../instagram/auth";
import {
  contentSummary, type IgContent, type IgInboxPage, type IgMediaItem, type IgMessage, type IgShare, type IgThread, type IgUser,
} from "../instagram/model";
import { demoJpeg } from "./whatsapp";
import { hexColor, renderIcon, renderPicture, type Rgb } from "./png";

export const DEMO_INSTAGRAM_CDN_HOST = "scontent-demo-1.cdninstagram.com";
/** Thread ids: the long 1:1 full of shares (RECORD_DEMO_OPEN=ig-shares) and the photo group (ig-photos). */
export const DEMO_INSTAGRAM_SHARES_THREAD = "340120000000000001";
export const DEMO_INSTAGRAM_PHOTOS_THREAD = "340120000000000002";
/** One of each tricky picture, newest at the bottom (RECORD_DEMO_OPEN=ig-gallery). */
export const DEMO_INSTAGRAM_GALLERY_THREAD = "340120000000000006";

const VIEWER: IgUser = { id: "17841400000000001", fbid: "17841400000000901", username: "demo.user", name: "Demo User" };
const PEOPLE = {
  maya: { id: "5550001", fbid: "100000000000001", username: "maya.lopes", name: "Maya Lopes" },
  leo: { id: "5550002", fbid: "100000000000002", username: "leo.kaya", name: "Leo Kaya" },
  nina: { id: "5550003", fbid: "100000000000003", username: "nina.okafor", name: "Nina Okafor" },
  theo: { id: "5550004", fbid: "100000000000004", username: "theo.m", name: "Theo Martin" },
  sam: { id: "5550005", fbid: "100000000000005", username: "sam.rivera.art", name: "Sam Rivera" },
} satisfies Record<string, IgUser>;
const AUTHORS = ["natgeo", "nasa", "foodbeast", "archdigest", "streetphoto", "catsofinstagram", "spacex", "bonappetitmag"];

const TEXTS = [
  "omg", "LOL", "wait this is so good", "hahaha", "no way", "ok this one's for you", "send me more like this",
  "😂😂😂", "I need to go here", "who even made this", "sameee", "ahahah stop", "this is literally us",
  "did you see this?", "brb", "obsessed", "ok but why is this so accurate", "❤️", "wow", "we have to try this place",
];
const LONG_TEXT = [
  "ok so long story but I finally went to that bakery you sent me last week and honestly it was even better than the video,",
  "the line was like 40 minutes but the croissants were still warm and they had this pistachio thing that I can't stop thinking about.",
  "Also I ran into Theo there?? He says hi and that you owe him a call. Anyway we should all go together next weekend if you're free,",
  "I'll bring the speaker and we can do the park after. Let me know by Thursday so I can tell the others 🙏",
].join(" ");
const CAPTIONS = [
  "Golden hour over the valley 🌄", "The perfect weeknight pasta, ready in 20 minutes", "Inside a cliffside house in Portugal",
  "New images from the telescope show a nursery of stars", "When the cat realises it's Monday", "Street corners of Tokyo, 5am",
];

interface PictureSpec { width: number; height: number }
/** What Instagram's CDN serves per kind (pixels of the file itself). */
const POST_SIZES: PictureSpec[] = [
  { width: 1080, height: 1350 }, { width: 1080, height: 1080 }, { width: 1080, height: 566 }, { width: 1440, height: 1800 },
];
const PORTRAIT: PictureSpec = { width: 720, height: 1280 };
const STORY: PictureSpec = { width: 1080, height: 1920 };
const PHOTO_SIZES: PictureSpec[] = [
  { width: 1440, height: 1920 }, { width: 1920, height: 1440 }, { width: 1179, height: 2556 }, { width: 1080, height: 1080 },
];
const TALL: PictureSpec = { width: 1170, height: 6000 };
const WIDE: PictureSpec = { width: 4000, height: 700 };
const GIF: PictureSpec = { width: 480, height: 270 };
const LINK: PictureSpec = { width: 1200, height: 630 };

const COLORS: Array<[Rgb, Rgb]> = [
  [hexColor(0x833ab4), hexColor(0xfd1d1d)], [hexColor(0x405de6), hexColor(0x5851db)], [hexColor(0xf77737), hexColor(0xfcaf45)],
  [hexColor(0x0f766e), hexColor(0x99f6e4)], [hexColor(0x1e3a8a), hexColor(0x93c5fd)], [hexColor(0x7c2d12), hexColor(0xfdba74)],
];

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

/** A signed-looking CDN URL that names the size of the file it serves. */
export function demoInstagramCdnUrl(id: string, size: PictureSpec, extension = "jpg", folder = "t51.2885-15"): string {
  return `https://${DEMO_INSTAGRAM_CDN_HOST}/v/${folder}/${id}_${size.width}x${size.height}_n.${extension}?stp=dst-jpg_e35&_nc_ht=${DEMO_INSTAGRAM_CDN_HOST}&oh=00_DEMO${hash(id).toString(16)}&oe=6720DEMO`;
}

function avatarUrl(user: IgUser): string {
  return `https://${DEMO_INSTAGRAM_CDN_HOST}/v/t51.2885-19/${user.username}_150x150_n.jpg?_nc_ht=${DEMO_INSTAGRAM_CDN_HOST}&oh=00_DEMO`;
}

/** Instagram serves previews no wider than 1080 (shares) and full files as sent. */
function previewSize(size: PictureSpec, maxWidth = 1080): PictureSpec {
  if (size.width <= maxWidth) return size;
  return { width: maxWidth, height: Math.round((size.height * maxWidth) / size.width) };
}

interface ThreadSpec {
  id: string;
  users: IgUser[];
  title?: string;
  count: number;
  stepMinutes: number;
  /** Item-kind weights for this chat. */
  mix: Partial<Record<ItemKind, number>>;
  unread?: number;
  folder?: IgThread["folder"];
}

type ItemKind =
  | "text" | "long" | "post" | "postNoSize" | "reel" | "reelNoSize" | "story" | "photo" | "album" | "video" | "sticker"
  | "gif" | "voice" | "link" | "tall" | "wide" | "call" | "heart" | "reactionNotice" | "reply" | "disappearing" | "unavailable";

export interface DemoInstagramData {
  viewer: IgUser;
  /** Every message per thread, oldest first, with full content. */
  threads: IgThread[];
  people: IgUser[];
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function weighted(random: () => number, mix: Partial<Record<ItemKind, number>>): ItemKind {
  const entries = Object.entries(mix) as Array<[ItemKind, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [kind, weight] of entries) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return entries[0]![0];
}

function share(fields: Partial<IgShare> & Pick<IgShare, "kind">): IgShare {
  return { title: "", caption: "", author: "", preview: null, previewWidth: 0, previewHeight: 0, text: "", expired: false, ...fields };
}

function code(id: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = hash(id);
  let out = "C";
  for (let index = 0; index < 10; index++) {
    out += alphabet[value % alphabet.length];
    value = Math.imul(value ^ index, 0x01000193) >>> 0;
  }
  return out;
}

function mediaItem(id: string, size: PictureSpec, video = false): IgMediaItem {
  const preview = demoInstagramCdnUrl(`${id}p`, previewSize(size, video ? 720 : 1080));
  return {
    id, video, preview,
    url: video ? demoInstagramCdnUrl(id, size, "mp4", "o1/v/t16") : demoInstagramCdnUrl(id, size),
    width: size.width, height: size.height,
  };
}

function content(kind: ItemKind, id: string, random: () => number, other: IgUser, mine: boolean): IgContent {
  switch (kind) {
    case "text": return { kind: "text", text: pick(random, TEXTS) };
    case "long": return { kind: "text", text: LONG_TEXT };
    case "post":
    case "postNoSize": {
      const size = pick(random, POST_SIZES);
      const preview = previewSize(size);
      const shortcode = code(id);
      return { kind: "share", share: share({
        kind: "post", code: shortcode, url: `https://www.instagram.com/p/${shortcode}/`, author: pick(random, AUTHORS),
        caption: pick(random, CAPTIONS), preview: demoInstagramCdnUrl(id, preview),
        ...(kind === "post" ? { previewWidth: preview.width, previewHeight: preview.height } : {}),
        text: random() < 0.25 ? pick(random, TEXTS) : "",
      }) };
    }
    case "reel":
    case "reelNoSize":
      return { kind: "share", share: share({
        kind: "reel", code: code(id), url: `https://www.instagram.com/reel/${code(id)}/`, author: pick(random, AUTHORS),
        caption: random() < 0.7 ? pick(random, CAPTIONS) : "", preview: demoInstagramCdnUrl(id, PORTRAIT),
        ...(kind === "reel" ? { previewWidth: PORTRAIT.width, previewHeight: PORTRAIT.height } : {}),
      }) };
    case "story": {
      const roll = random();
      const owner = mine ? other.username : VIEWER.username;
      const expired = roll > 0.85;
      return { kind: "share", share: share({
        kind: "story", username: owner, storyId: String(3_400_000_000_000_000_000n + BigInt(hash(id))), author: owner,
        preview: expired ? null : demoInstagramCdnUrl(id, STORY),
        // Story previews come with a size about half the time.
        ...(!expired && roll < 0.5 ? { previewWidth: STORY.width, previewHeight: STORY.height } : {}),
        storyContext: roll < 0.45 ? "reply" : roll < 0.65 ? "reaction" : roll < 0.75 ? "mention" : "share",
        text: roll < 0.45 ? pick(random, TEXTS) : roll < 0.65 ? "😍" : "", expired,
      }) };
    }
    case "photo": return { kind: "media", items: [mediaItem(id, pick(random, PHOTO_SIZES))] };
    case "album": return { kind: "media", items: [0, 1, 2].map((index) => mediaItem(`${id}a${index}`, pick(random, PHOTO_SIZES))) };
    case "video": return { kind: "media", items: [mediaItem(id, { width: 720, height: 1280 }, true)] };
    case "tall": return { kind: "media", items: [mediaItem(id, TALL)] };
    case "wide": return { kind: "media", items: [mediaItem(id, WIDE)] };
    case "sticker": return { kind: "sticker", url: demoInstagramCdnUrl(id, { width: 320, height: 320 }, "webp", "t39.1997-6"), alt: "Waving hand" };
    case "gif":
      return { kind: "animated", still: demoInstagramCdnUrl(id, GIF, "webp", "t39.1997-6"), mp4: demoInstagramCdnUrl(id, GIF, "mp4", "t39.1997-6"),
        width: GIF.width, height: GIF.height, sticker: false };
    case "voice": return { kind: "voice", url: demoInstagramCdnUrl(id, { width: 1, height: 1 }, "mp4", "o1/v/t2"), durationSecs: 3 + Math.floor(random() * 40) };
    case "link":
      return { kind: "share", share: share({
        kind: "link", url: "https://www.example.com/articles/the-best-bakeries-in-the-city", title: "The 12 best bakeries in the city, ranked",
        caption: "We ate our way through every croissant in town so you don't have to.",
        preview: demoInstagramCdnUrl(id, LINK), previewWidth: LINK.width, previewHeight: LINK.height,
        text: random() < 0.5 ? "this is the one I was talking about" : "",
      }) };
    case "call": return { kind: "call", call: { video: random() < 0.5, outcome: random() < 0.5 ? "missed" : "ended", line: "Video chat ended", duration: "4:12" } };
    case "heart": return { kind: "heart" };
    case "disappearing": return { kind: "disappearing", video: random() < 0.3 };
    case "unavailable": return { kind: "unavailable" };
    default: return { kind: "text", text: pick(random, TEXTS) };
  }
}

function legacyId(id: string): string {
  return `340282366841710300${id.slice(-21).padStart(21, "0")}`;
}

/** The demo's Instagram world, the same for every run with the same anchor. */
export function buildDemoInstagramData(anchorMs: number): DemoInstagramData {
  const { maya, leo, nina, theo, sam } = PEOPLE;
  const specs: ThreadSpec[] = [
    {
      id: DEMO_INSTAGRAM_SHARES_THREAD, users: [maya], count: 160, stepMinutes: 9, unread: 3,
      mix: {
        text: 30, long: 3, post: 6, postNoSize: 6, reel: 5, reelNoSize: 6, story: 8, photo: 6, video: 2, sticker: 2, gif: 2,
        voice: 2, link: 2, tall: 2, wide: 2, call: 1, heart: 1, reactionNotice: 5, reply: 4, disappearing: 1, unavailable: 1,
      },
    },
    {
      id: DEMO_INSTAGRAM_PHOTOS_THREAD, users: [leo, nina, theo], title: "Weekend crew 🏕️", count: 110, stepMinutes: 6, unread: 8,
      mix: { text: 20, photo: 30, album: 8, video: 6, tall: 3, wide: 3, postNoSize: 6, reelNoSize: 6, reactionNotice: 4, reply: 3, sticker: 2 },
    },
    { id: "340120000000000003", users: [leo], count: 45, stepMinutes: 41, mix: { text: 30, postNoSize: 8, post: 4, reelNoSize: 4, long: 2, reactionNotice: 3 } },
    { id: "340120000000000004", users: [nina], count: 30, stepMinutes: 63, mix: { story: 12, reel: 4, reelNoSize: 6, text: 10, voice: 2 } },
    { id: "340120000000000005", users: [sam], count: 3, stepMinutes: 5, folder: "pending", mix: { text: 2, postNoSize: 1 } },
  ];
  const threads = specs.map((spec, threadIndex): IgThread => {
    const random = seeded(4000 + threadIndex);
    const messages: IgMessage[] = [];
    for (let index = 0; index < spec.count; index++) {
      const id = `mid.$demo${threadIndex}${String(index).padStart(5, "0")}`;
      const mine = spec.folder !== "pending" && random() < 0.35;
      const sender = mine ? VIEWER : pick(random, spec.users);
      let kind = weighted(random, spec.mix);
      if ((kind === "reactionNotice" || kind === "reply") && messages.length < 3) kind = "text";
      const timestampMs = anchorMs - (spec.count - index) * spec.stepMinutes * 60_000 - Math.floor(random() * 40_000);
      const message: IgMessage = {
        id, senderFbid: sender.fbid, senderName: sender.name, timestampMs, reactions: [],
        offlineThreadingId: String(BigInt(timestampMs) << 22n),
        content: kind === "reactionNotice" ? { kind: "text", text: "" } : content(kind, id, random, pick(random, spec.users), mine),
      };
      if (kind === "reactionNotice") {
        // Instagram's own line for a reaction, next to the reaction on the target itself.
        const target = messages[messages.length - 1 - Math.floor(random() * Math.min(8, messages.length))]!;
        const emoji = random() < 0.5 ? "❤️" : pick(random, ["😂", "💗", "😮", "🔥"]);
        const own = target.senderFbid === VIEWER.fbid ? "your" : "a";
        const name = mine ? "You" : sender.name.split(" ")[0];
        // Instagram lists the reaction on the target too, mostly; some notices
        // name their target, some carry the reaction-log flag, some neither.
        if (random() < 0.7) target.reactions.push({ emoji, senderFbid: sender.fbid });
        message.content = { kind: "system", text: emoji === "❤️" ? `${name} liked a message` : `${name} reacted ${emoji} to ${own} message`,
          ...(random() < 0.5 ? { reactionLog: true as const } : {}) };
        if (random() < 0.6) message.replyTo = { id: target.id, senderFbid: target.senderFbid, senderName: target.senderName, summary: contentSummary(target.content) };
      } else if (kind === "reply") {
        const target = messages[messages.length - 1 - Math.floor(random() * Math.min(12, messages.length))]!;
        message.replyTo = { id: target.id, senderFbid: target.senderFbid, senderName: target.senderName, summary: contentSummary(target.content) };
      }
      if (kind !== "reactionNotice" && random() < 0.06) message.reactions.push({ emoji: pick(random, ["❤️", "😂", "🔥"]), senderFbid: (mine ? spec.users[0]! : VIEWER).fbid });
      messages.push(message);
    }
    const newest = messages.at(-1)!;
    const unread = spec.unread ?? 0;
    const others = messages.filter((message) => message.senderFbid !== VIEWER.fbid);
    const readUpTo = unread ? (others.at(-unread - 1)?.timestampMs ?? 0) : newest.timestampMs;
    if (unread && newest.senderFbid === VIEWER.fbid) newest.senderFbid = spec.users[0]!.fbid;
    return {
      id: spec.id, legacyId: legacyId(spec.id), rawTitle: spec.title ?? "",
      users: spec.users.map((user) => ({ ...user, picUrl: avatarUrl(user) })),
      viewerFbid: VIEWER.fbid, isGroup: spec.users.length > 1, lastActivityMs: newest.timestampMs, messages,
      receipts: { [VIEWER.fbid]: readUpTo, ...Object.fromEntries(spec.users.map((user) => [user.fbid, newest.timestampMs])) },
      markedUnread: false, muted: false, folder: spec.folder ?? "inbox", canSend: true, nicknames: {},
      hasOlder: false, cursor: null, detailLoaded: false,
    };
  });
  threads.push(galleryThread(anchorMs));
  return { viewer: VIEWER, threads, people: Object.values(PEOPLE) };
}

/** Theo's chat: every picture shape Instagram sends, in a fixed order. */
function galleryThread(anchorMs: number): IgThread {
  const { theo } = PEOPLE;
  const post = (id: string, size: PictureSpec, sized: boolean, caption: string): IgContent => ({ kind: "share", share: share({
    kind: "post", code: code(id), url: `https://www.instagram.com/p/${code(id)}/`, author: "natgeo", caption,
    preview: demoInstagramCdnUrl(id, size), ...(sized ? { previewWidth: size.width, previewHeight: size.height } : {}),
  }) });
  const items: Array<(id: string) => IgContent> = [
    () => ({ kind: "text", text: "size check: one of each 👇" }),
    (id) => ({ kind: "media", items: [mediaItem(id, TALL)] }),
    (id) => ({ kind: "media", items: [mediaItem(id, WIDE)] }),
    (id) => post(id, { width: 1080, height: 566 }, true, "Wide post, with its size"),
    (id) => post(id, { width: 1080, height: 566 }, false, "Wide post, no size"),
    (id) => post(id, { width: 1080, height: 1350 }, false, "Portrait post, no size"),
    (id) => post(id, { width: 1080, height: 1080 }, false, "Square post, no size"),
    (id) => ({ kind: "share", share: share({ kind: "reel", code: code(id), url: `https://www.instagram.com/reel/${code(id)}/`, author: "spacex", caption: "Reel, no size", preview: demoInstagramCdnUrl(id, PORTRAIT) }) }),
    (id) => ({ kind: "share", share: share({ kind: "story", username: theo.username, author: theo.username, preview: demoInstagramCdnUrl(id, STORY), storyContext: "reply", text: "story reply, no size" }) }),
    (id) => ({ kind: "share", share: share({ kind: "story", username: VIEWER.username, author: VIEWER.username, preview: demoInstagramCdnUrl(id, STORY), previewWidth: STORY.width, previewHeight: STORY.height, storyContext: "mention" }) }),
    (id) => ({ kind: "sticker", url: demoInstagramCdnUrl(id, { width: 320, height: 320 }, "webp", "t39.1997-6"), alt: "Waving hand" }),
    (id) => ({ kind: "animated", still: demoInstagramCdnUrl(id, GIF, "webp", "t39.1997-6"), mp4: demoInstagramCdnUrl(id, GIF, "mp4", "t39.1997-6"), width: GIF.width, height: GIF.height, sticker: false }),
    (id) => content("link", id, seeded(7), theo, false),
    (id) => ({ kind: "media", items: [mediaItem(id, { width: 1179, height: 2556 })] }),
    (id) => ({ kind: "media", items: [mediaItem(`${id}a`, { width: 1440, height: 1920 }), mediaItem(`${id}b`, { width: 1920, height: 1440 }), mediaItem(`${id}c`, { width: 1080, height: 1080 })] }),
    () => ({ kind: "text", text: "that's all of them" }),
  ];
  const messages = items.map((make, index): IgMessage => {
    const id = `mid.$demog${String(index).padStart(5, "0")}`;
    const timestampMs = anchorMs - (items.length - index) * 60_000;
    return { id, senderFbid: theo.fbid, senderName: theo.name, timestampMs, reactions: [], content: make(id) };
  });
  return {
    id: DEMO_INSTAGRAM_GALLERY_THREAD, legacyId: legacyId(DEMO_INSTAGRAM_GALLERY_THREAD), rawTitle: "",
    users: [{ ...theo, picUrl: avatarUrl(theo) }], viewerFbid: VIEWER.fbid, isGroup: false,
    lastActivityMs: messages.at(-1)!.timestampMs - 3_600_000, messages,
    receipts: { [VIEWER.fbid]: messages.at(-1)!.timestampMs, [theo.fbid]: messages.at(-1)!.timestampMs },
    markedUnread: false, muted: false, folder: "inbox", canSend: true, nicknames: {}, hasOlder: false, cursor: null, detailLoaded: false,
  };
}

/** How the inbox query carries a message: `__typename` + `text_body` and Instagram's snippet line only. */
function reduced(message: IgMessage, viewerFbid: string): IgMessage {
  const kind = message.content.kind;
  if (message.content.kind === "system" && /reacted|liked/.test(message.content.text)) {
    // The inbox's copy of a reaction notice: only Instagram's snippet line.
    const text = message.content.text.replace(/^\S+ /, "");
    return { ...message, reactions: [], content: { kind: "unsupported", text: "Message" }, snippet: `${text[0]!.toUpperCase()}${text.slice(1)}` };
  }
  if (kind === "text" || kind === "heart" || kind === "call" || kind === "system") return { ...message, reactions: [] };
  const summary = contentSummary(message.content);
  const snippet = message.senderFbid === viewerFbid ? `You: ${summary}` : summary;
  return { ...message, reactions: [], content: { kind: "unsupported", text: summary }, snippet };
}

const PAGE = 20;
const INBOX_MESSAGES = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DemoInstagramClientOptions {
  data: DemoInstagramData;
  /** Delay of an older-history page. */
  olderPageDelayMs: number;
  /** Delay of every other request. */
  latencyMs?: number;
  log?: (line: string) => void;
}

/** The demo session: never written to disk, never a real login. */
export function demoInstagramSession(data: DemoInstagramData): InstagramSession {
  return { cookies: { sessionid: "demo-session-not-real", csrftoken: "demo", ds_user_id: data.viewer.id } };
}

const offline = (async () => {
  throw new Error("The demo Instagram never uses the network.");
}) as unknown as typeof fetch;

export class DemoInstagramClient extends InstagramClient {
  private nextSent = 0;

  constructor(private readonly demo: DemoInstagramClientOptions) {
    super(demoInstagramSession(demo.data), { fetcher: offline });
  }

  override get readOnly(): boolean { return false; }

  private find(id: string): IgThread | undefined {
    return this.demo.data.threads.find((thread) => thread.id === id);
  }

  private wait(older = false): Promise<void> {
    return delay(older ? this.demo.olderPageDelayMs : this.demo.latencyMs ?? 120);
  }

  private preview(thread: IgThread): IgThread {
    return {
      ...thread, users: thread.users.map((user) => ({ ...user })),
      messages: thread.messages.slice(-INBOX_MESSAGES).map((message) => reduced(message, thread.viewerFbid)),
      hasOlder: false, cursor: null, detailLoaded: false,
    };
  }

  override async inbox(): Promise<IgInboxPage> {
    await this.wait();
    const threads = this.demo.data.threads.filter((thread) => thread.folder === "inbox").map((thread) => this.preview(thread));
    this.demo.log?.(`instagram inbox: ${threads.length} threads`);
    const viewer = this.demo.data.viewer;
    return { threads, cursor: null, hasNextPage: false, mailboxId: "17850000000000001", sequenceId: "705483",
      viewer: { id: viewer.id, fbid: viewer.fbid, username: "", name: "" } };
  }

  override async inboxPage(): Promise<IgInboxPage> {
    return { ...(await this.inbox()), threads: [] };
  }

  override async thread(id: string, _sequenceId = ""): Promise<IgThread> {
    await this.wait();
    const thread = this.find(id);
    if (!thread) throw new Error("Instagram couldn't open this chat.");
    const start = Math.max(0, thread.messages.length - PAGE);
    this.demo.log?.(`instagram thread ${id}: ${thread.messages.length - start} newest`);
    return {
      ...structuredClone(thread), messages: structuredClone(thread.messages.slice(start)),
      hasOlder: start > 0, cursor: start > 0 ? `older:${start}` : null, detailLoaded: false,
      viewerUsername: this.demo.data.viewer.username, viewerName: this.demo.data.viewer.name,
    };
  }

  override async olderMessages(id: string, cursor: string): Promise<{ messages: IgMessage[]; cursor: string | null; hasOlder: boolean }> {
    await this.wait(true);
    const thread = this.find(id);
    const end = Number(/^older:(\d+)$/.exec(cursor)?.[1] ?? 0);
    const start = Math.max(0, end - PAGE);
    this.demo.log?.(`instagram older ${id} before ${end}: ${end - start}`);
    // Instagram returns newest first; the controller sorts.
    const messages = structuredClone(thread?.messages.slice(start, end) ?? []).reverse();
    return { messages, cursor: start > 0 ? `older:${start}` : null, hasOlder: start > 0 };
  }

  override async requests(): Promise<{ pending: IgThread[]; spamCount: number }> {
    await this.wait();
    return { pending: this.demo.data.threads.filter((thread) => thread.folder === "pending").map((thread) => this.preview(thread)), spamCount: 1 };
  }

  override async searchUsers(query: string): Promise<IgUser[]> {
    await this.wait();
    const wanted = query.toLowerCase();
    return this.demo.data.people.filter((user) => user.username.includes(wanted) || user.name.toLowerCase().includes(wanted));
  }

  override async sendText(text: string, target: { threadId: string } | { recipientIds: string[] }, options: { replyTo?: string; otid?: string } = {}): Promise<InstagramSendReceipt> {
    await this.wait();
    const thread = "threadId" in target ? this.find(target.threadId) : undefined;
    const messageId = `mid.$demosent${++this.nextSent}`;
    const timestampMs = Date.now();
    if (thread) {
      const quoted = options.replyTo ? thread.messages.find((message) => message.id === options.replyTo) : undefined;
      thread.messages.push({
        id: messageId, senderFbid: this.demo.data.viewer.fbid, senderName: this.demo.data.viewer.name, timestampMs,
        content: { kind: "text", text }, reactions: [], ...(options.otid ? { offlineThreadingId: options.otid } : {}),
        ...(quoted ? { replyTo: { id: quoted.id, senderFbid: quoted.senderFbid, senderName: quoted.senderName, summary: contentSummary(quoted.content) } } : {}),
      });
      thread.lastActivityMs = timestampMs;
    }
    return { messageId, timestampMs };
  }

  override async react(threadId: string, messageId: string, emoji: string, remove: boolean): Promise<void> {
    await this.wait();
    const message = this.find(threadId)?.messages.find((candidate) => candidate.id === messageId);
    if (!message) return;
    const viewer = this.demo.data.viewer.fbid;
    message.reactions = message.reactions.filter((reaction) => reaction.senderFbid !== viewer);
    if (!remove) message.reactions.push({ emoji, senderFbid: viewer });
  }

  override async markRead(threadId: string): Promise<number | null> {
    await this.wait();
    const thread = this.find(threadId);
    const newest = thread?.messages.at(-1);
    if (!thread || !newest) return null;
    thread.receipts[this.demo.data.viewer.fbid] = newest.timestampMs;
    return newest.timestampMs;
  }

  override async acceptRequest(threadId: string): Promise<void> {
    await this.wait();
    const thread = this.find(threadId);
    if (thread) thread.folder = "inbox";
  }

  override async reel(shortcode: string): Promise<InstagramReelMedia> {
    await this.wait();
    return {
      videoUrl: demoInstagramCdnUrl(shortcode, PORTRAIT, "mp4", "o1/v/t16"), previewUrl: demoInstagramCdnUrl(shortcode, PORTRAIT),
      author: pick(seeded(hash(shortcode)), AUTHORS), caption: "",
    };
  }
}

export interface DemoInstagramCdnOptions {
  /** Download time, spread per URL between these (the same URL always takes as long). */
  minDelayMs?: number;
  maxDelayMs?: number;
  log?: (line: string) => void;
}

/** The fake Instagram CDN: pictures of the size their URL names, after a delay. */
export class DemoInstagramCdn {
  private readonly pictures = new Map<string, Promise<Buffer>>();

  constructor(private readonly options: DemoInstagramCdnOptions = {}) {}

  async fetch(url: URL, signal: AbortSignal | null): Promise<Response> {
    const started = Date.now();
    const min = this.options.minDelayMs ?? 200;
    const max = this.options.maxDelayMs ?? 1500;
    const match = /\/([^/]+)_(\d+)x(\d+)_n\.(jpg|webp|mp4)$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const [, id, w, h, extension] = match as unknown as [string, string, string, string, string];
    const width = Math.min(8000, Number(w));
    const height = Math.min(8000, Number(h));
    const avatar = url.pathname.includes("/t51.2885-19/");
    const sticker = extension === "webp";
    let bytes: Buffer;
    let type = "image/jpeg";
    if (extension === "mp4") {
      bytes = Buffer.from(`Record demo media ${id}\n`);
      type = "video/mp4";
    } else if (avatar) {
      bytes = await this.picture(`avatar:${id}`, () => Promise.resolve(renderIcon(id.slice(0, 2).toUpperCase(), COLORS[hash(id) % COLORS.length]![0], 150, false)));
      type = "image/png";
    } else if (sticker) {
      bytes = await this.picture(`sticker:${width}x${height}`, () => Promise.resolve(renderIcon("HI", hexColor(0xfcaf45), Math.min(width, height), true)));
      type = "image/png";
    } else {
      const colors = COLORS[(width * 7 + height) % COLORS.length]!;
      bytes = await this.picture(`${width}x${height}`, () => demoJpeg(renderPicture(width, height, colors[0], colors[1], width + height)));
    }
    const wait = min + (hash(url.pathname) % Math.max(1, max - min)) - (Date.now() - started);
    await abortableDelay(Math.max(0, wait), signal);
    this.options.log?.(`instagram cdn ${url.pathname}: ${bytes.length} bytes in ${Date.now() - started} ms`);
    return new Response(bytes as unknown as BodyInit, { headers: { "content-type": type, "content-length": String(bytes.length) } });
  }

  private picture(key: string, make: () => Promise<Buffer>): Promise<Buffer> {
    let bytes = this.pictures.get(key);
    if (!bytes) {
      bytes = make();
      this.pictures.set(key, bytes);
    }
    return bytes;
  }
}

function abortableDelay(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
