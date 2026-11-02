/**
 * A made-up service for building the apps before (or beside) a real
 * provider's fixtures: a dozen chats, paged histories with photos, avatars,
 * and writes that act on the made-up data (a sent message is echoed, then
 * answered). No account, no network. `--provider-module` of this file, or
 * any provider started with `--fixtures` until it has its own.
 */

import { renderIcon, renderPicture, hexColor, type Rgb } from "../../demo/png";
import { writeFileSync } from "node:fs";

import { BridgeError, type WireChat, type WireMedia, type WireMessage } from "../protocol";
import type { Provider, ProviderHost } from "../provider";

const NAMES = [
  "Ana Ruiz", "Leo Park", "Weekend trip", "Mom", "Study group", "Sam Okafor", "Priya", "Climbing crew",
  "Jonas", "Design review", "Mika", "Old friends",
];
const LINES = [
  "are you coming tonight?", "haha yes", "I'll bring the snacks", "did you see the photos?", "running 5 min late",
  "that's wild", "ok sounds good", "can you send me the notes from today", "on my way 🚗", "❤️❤️",
  "let's do saturday instead", "this one is a longer message, the kind that wraps over two or three lines in a bubble on a phone screen",
  "lol", "wait what", "good morning!", "here", "thanks!!", "see you there",
];
const COLORS: Rgb[] = [hexColor(0xe57373), hexColor(0x64b5f6), hexColor(0x81c784), hexColor(0xffb74d), hexColor(0xba68c8), hexColor(0x4db6ac)];
const PER_CHAT = 120;

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

export function createProvider(host: ProviderHost): Provider {
  const anchor = Math.floor(Date.now() / 60_000) * 60_000;
  const histories = new Map<string, WireMessage[]>();
  const me = { id: "me", name: "You" };
  let sent = 0;

  const avatar = (index: number): WireMedia => ({ ref: `avatar:${index}`, kind: "image", w: 256, h: 256, mime: "image/png" });

  NAMES.forEach((title, index) => {
    const id = `sample:${index}`;
    const group = /trip|group|crew|review|friends/i.test(title);
    const random = rng(index + 7);
    const messages: WireMessage[] = [];
    let ts = anchor - index * 37 * 60_000 - PER_CHAT * 9 * 60_000;
    for (let n = 0; n < PER_CHAT; n++) {
      ts += Math.floor(random() * 15 * 60_000) + 30_000;
      const mine = random() < 0.4;
      const photo = random() < 0.08;
      const author = mine ? me : { id: `u${index}-${group ? Math.floor(random() * 3) : 0}`, name: group ? ["Ana", "Leo", "Sam"][Math.floor(random() * 3)]! : title };
      messages.push({
        id: `${id}:${n}`, chat: id, ts, author, mine,
        text: photo ? "" : LINES[Math.floor(random() * LINES.length)]!,
        format: "plain",
        media: photo ? [{ ref: `photo:${index}:${n}`, kind: "image", w: n % 2 ? 1200 : 1600, h: n % 2 ? 1600 : 1200, mime: "image/png" }] : [],
        reactions: random() < 0.1 ? [{ emoji: "❤️", count: 1, mine: !mine }] : [],
        status: mine ? "read" : null,
      });
    }
    histories.set(id, messages);
    const last = messages.at(-1)!;
    host.chats.upsert({
      id, kind: group ? "group" : "dm", title, avatar: avatar(index), ts: last.ts,
      last: { id: last.id, ts: last.ts, author: last.author.name, text: last.text || "📷 Photo", mine: last.mine },
      unread: index % 4 === 1 ? index : 0, muted: index === 9, pinned: index === 3, folder: "inbox",
      members: group ? 3 + index : null,
    });
  });

  const chatOf = (id: string): WireChat => {
    const chat = host.chats.raw(id);
    if (!chat) throw new BridgeError("not_found", "no such chat");
    return chat;
  };

  const append = (message: WireMessage, live: boolean) => {
    const list = histories.get(message.chat)!;
    list.push(message);
    const chat = chatOf(message.chat);
    host.chats.upsert({
      ...chat, ts: message.ts,
      last: { id: message.id, ts: message.ts, author: message.author.name, text: message.text || "📷 Photo", mine: message.mine },
      unread: message.mine ? 0 : chat.unread + 1,
    });
    host.message(message, live);
  };

  return {
    capabilities: ["sample", "send", "react", "typing"],
    async start() {
      host.setStatus("online", null, { id: me.id, name: "Sample Account", username: "sample" });
    },
    async stop() {},
    async history(chat, { before, limit }) {
      chatOf(chat);
      const list = histories.get(chat)!;
      const end = before ? list.findIndex((message) => message.id === before) : list.length;
      if (end < 0) throw new BridgeError("not_found", "no such message");
      const start = Math.max(0, end - limit);
      return { messages: list.slice(start, end), more: start > 0 };
    },
    async fetchMedia(ref) {
      const avatarMatch = /^avatar:(\d+)$/.exec(ref);
      const photoMatch = /^photo:(\d+):(\d+)$/.exec(ref);
      if (!avatarMatch && !photoMatch) throw new BridgeError("not_found", "no such media");
      return host.media.fetch(`sample:${ref}`, "image/png", async (path) => {
        let png: Buffer;
        if (avatarMatch) {
          const index = Number(avatarMatch[1]);
          png = renderIcon(NAMES[index]!.slice(0, 1), COLORS[index % COLORS.length]!, 256, true);
        } else {
          const index = Number(photoMatch![1]), n = Number(photoMatch![2]);
          const [w, h] = n % 2 ? [1200, 1600] : [1600, 1200];
          png = renderPicture(w, h, COLORS[index % COLORS.length]!, COLORS[(index + 2) % COLORS.length]!, n);
        }
        writeFileSync(path, png, { mode: 0o600 });
        return { mime: "image/png" };
      });
    },
    async send({ chat, text, client_id }) {
      chatOf(chat);
      const message: WireMessage = {
        id: `${chat}:s${++sent}`, chat, ts: Date.now(), author: me, mine: true, text, format: "plain",
        media: [], reactions: [], status: "sent", client_id: client_id ?? null,
      };
      append(message, true);
      const title = chatOf(chat).title;
      setTimeout(() => append({
        id: `${chat}:r${sent}`, chat, ts: Date.now(), author: { id: `reply-${chat}`, name: title }, mine: false,
        text: `↩ ${text.slice(0, 60)}`, format: "plain", media: [], reactions: [],
      }, true), 2_000);
      return message;
    },
    async react({ chat, message, emoji, remove }) {
      const list = histories.get(chatOf(chat).id)!;
      const index = list.findIndex((item) => item.id === message);
      if (index < 0) throw new BridgeError("not_found", "no such message");
      const item = list[index]!;
      const others = item.reactions.filter((reaction) => !reaction.mine);
      list[index] = { ...item, reactions: remove ? others : [...others, { emoji, count: 1, mine: true }] };
      host.message(list[index]!, false);
    },
    async markRead({ chat }) {
      host.chats.patch(chat, { unread: 0, mentions: 0 });
    },
    async typing() {},
    commands: {
      /** A message from someone, now (notification and badge tests). */
      "sample.poke": {
        run: async (args) => {
          const chat = typeof args.chat === "string" ? args.chat : "sample:0";
          const title = chatOf(chat).title;
          append({
            id: `${chat}:p${Date.now()}`, chat, ts: Date.now(), author: { id: `poke-${chat}`, name: title }, mine: false,
            text: typeof args.text === "string" ? args.text : "a new message", format: "plain", media: [], reactions: [],
          }, true);
          return {};
        },
      },
    },
  };
}
