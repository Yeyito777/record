import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proto, WAMessageStubType, type WAMessage } from "@whiskeysockets/baileys";

import { createLogger } from "../log";
import type { MoonLink, MoonView } from "../moon";
import { Bridge } from "../server";
import type { WhatsAppConnectionState, WhatsAppMessage } from "../../whatsapp/types";
import { createProvider, WhatsAppProvider } from "./whatsapp";
import type { RawEvent, WaBackend } from "./whatsapp/backend";
import { messageExtras, messageStatus, noticeMessage, quotedText } from "./whatsapp/live";
import { cleanName } from "./whatsapp/wire";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const quiet = createLogger("test", () => {});
const ANCHOR = Date.UTC(2026, 10, 1, 12);

class FakeMoon implements MoonLink {
  posts: Record<string, unknown>[] = [];
  withdrawn: string[] = [];
  badges: [string, number][] = [];
  moonView: MoonView | null = { view: "home", screenAwake: true, locked: false };
  async view() { return this.moonView; }
  async badge(app: string, count: number) { this.badges.push([app, count]); return true; }
  async post(notification: Record<string, unknown>): Promise<string | null> { this.posts.push(notification); return `n${this.posts.length}`; }
  async withdraw(_app: string, tag: string) { this.withdrawn.push(tag); return true; }
  async list() { return []; }
  close() {}
}

class Client {
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (value: any) => void>();
  events: any[] = [];
  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const value = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        if (value.event) this.events.push(value);
        else this.waiting.get(value.id)?.(value);
      }
    });
  }
  static connect(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new Client(socket)));
      socket.once("error", reject);
    });
  }
  request(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }
  async until(predicate: (event: any) => boolean, ms = 3000): Promise<any> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.events.find(predicate);
      if (found) return found;
      await Bun.sleep(20);
    }
    throw new Error("event did not come");
  }
  close() { this.socket.destroy(); }
}

const bridges: Bridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  delete process.env.RECORD_WA_FIXTURES_SIGNED_OUT;
});

async function startFixtures(options: { readOnly?: boolean; signedOut?: boolean; root?: string } = {}) {
  process.env.RECORD_WA_FIXTURES_ANCHOR = String(ANCHOR);
  if (options.signedOut) process.env.RECORD_WA_FIXTURES_SIGNED_OUT = "1";
  const root = options.root ?? mkdtempSync(join(tmpdir(), "wa-"));
  const moon = new FakeMoon();
  const bridge = new Bridge({
    service: "whatsapp", socketPath: join(root, "run", "whatsapp.sock"), stateDir: join(root, "state"), cacheDir: join(root, "cache"),
    fixtures: true, readOnly: options.readOnly ?? false, moon, log: quiet,
  });
  bridges.push(bridge);
  await bridge.start(createProvider);
  const client = await Client.connect(join(root, "run", "whatsapp.sock"));
  await client.request("subscribe");
  // The fixtures' first sync.
  for (let i = 0; i < 100 && bridge.chats.size < 150 && !options.signedOut; i++) await Bun.sleep(20);
  return { bridge, client, moon, root };
}

async function chatNamed(client: Client, title: string, folder = "inbox") {
  const list = await client.request("chats.list", { limit: 500, folder });
  const chat = list.result.chats.find((candidate: any) => candidate.title === title);
  if (!chat) throw new Error(`no chat ${title}`);
  return chat;
}

describe("whatsapp fixtures", () => {
  test("the list: pinned first, newest first, the archive apart, last messages and unread counts", async () => {
    const { client } = await startFixtures();
    const list = await client.request("chats.list", { limit: 500 });
    const chats = list.result.chats;
    expect(chats.length).toBeGreaterThan(150);
    expect(chats.slice(0, 3).every((chat: any) => chat.pinned)).toBe(true);
    const unpinned = chats.filter((chat: any) => !chat.pinned);
    for (let i = 1; i < unpinned.length; i++) expect(unpinned[i - 1].ts).toBeGreaterThanOrEqual(unpinned[i].ts);
    const family = chats.find((chat: any) => chat.title === "Family");
    expect(family.kind).toBe("group");
    expect(family.members).toBeGreaterThan(3);
    expect(family.last.author).toBeTruthy();
    expect(chats.some((chat: any) => chat.unread > 0)).toBe(true);
    expect(chats.every((chat: any) => chat.id.startsWith("wa:"))).toBe(true);
    const archived = await client.request("chats.list", { limit: 500, folder: "archived" });
    expect(archived.result.chats.length).toBeGreaterThan(0);
    expect(archived.result.chats.every((chat: any) => chat.archived)).toBe(true);
  });

  test("history pages back through the bridge's store, then the phone's on-demand pages, to the start", async () => {
    const { client } = await startFixtures();
    const ana = await chatNamed(client, "Ana Ruiz");
    let before: string | null = null;
    let total = 0;
    const seen = new Set<string>();
    for (let page = 0; page < 80; page++) {
      const answer = await client.request("history", { chat: ana.id, limit: 100, ...(before ? { before } : {}) });
      expect(answer.ok).toBe(true);
      const messages = answer.result.messages;
      for (const message of messages) {
        expect(seen.has(message.id)).toBe(false);
        seen.add(message.id);
      }
      for (let i = 1; i < messages.length; i++) expect(messages[i - 1].ts).toBeLessThanOrEqual(messages[i].ts);
      total += messages.length;
      if (!answer.result.more) break;
      before = messages[0].id;
    }
    expect(total).toBe(2400);
  }, 30_000);

  test("messages carry what record's converters leave out: quotes, thumbnails, receipts, notices", async () => {
    const { client } = await startFixtures();
    const family = await chatNamed(client, "Family");
    const answer = await client.request("history", { chat: family.id, limit: 100 });
    const messages = answer.result.messages;
    expect(messages.some((m: any) => m.reply_to && m.reply_to.text)).toBe(true);
    expect(messages.some((m: any) => m.media[0]?.thumb)).toBe(true);
    expect(messages.filter((m: any) => m.mine).every((m: any) => m.status)).toBe(true);
    expect(messages.some((m: any) => m.reactions.length > 0)).toBe(true);
    const first = await client.request("history", { chat: family.id, limit: 100, before: messages[0].id });
    expect(first.ok).toBe(true);
  });

  test("media: a photo, its thumbnail and a picture come as files; a person without one says so once", async () => {
    const { client, bridge } = await startFixtures();
    const family = await chatNamed(client, "Family");
    const answer = await client.request("history", { chat: family.id, limit: 100 });
    const photo = answer.result.messages.find((m: any) => m.media[0]?.kind === "image");
    const fetched = await client.request("media.fetch", { ref: photo.media[0].ref, max: 640 });
    expect(fetched.ok).toBe(true);
    expect(fetched.result.w).toBeGreaterThan(0);
    const thumb = await client.request("media.fetch", { ref: photo.media[0].thumb });
    expect(thumb.ok).toBe(true);
    const avatar = await client.request("media.fetch", { ref: family.avatar.ref });
    expect(avatar.ok).toBe(true);
    // Every sixth person has no picture.
    const list = (await client.request("chats.list", { limit: 500 })).result.chats.filter((c: any) => c.kind === "dm");
    let missing: any = null;
    for (const chat of list.slice(0, 20)) {
      const answer = await client.request("media.fetch", { ref: chat.avatar.ref });
      if (!answer.ok) { missing = chat; expect(answer.error.code).toBe("not_found"); break; }
    }
    expect(missing).not.toBeNull();
    await Bun.sleep(50);
    expect(bridge.chats.get(missing.id)?.avatar).toBeNull();
  });

  test("a live message notifies and counts on the badge; opening the chat reads it here only", async () => {
    const { client, moon, bridge } = await startFixtures({ readOnly: true });
    const ana = await chatNamed(client, "Ana Ruiz");
    await client.request("whatsapp.fixtures.poke", { chat: ana.id, text: "are you up?" });
    await client.until((event) => event.event === "message" && event.live && event.message.text === "are you up?");
    for (let i = 0; i < 50 && moon.posts.length === 0; i++) await Bun.sleep(20);
    expect(moon.posts.at(-1)?.body).toContain("are you up?");
    expect(moon.posts.at(-1)?.open).toEqual({ app: "whatsapp", target: ana.id });
    expect(bridge.chats.get(ana.id)!.unread).toBeGreaterThan(0);
    await client.request("view", { chat: ana.id, front: true });
    await Bun.sleep(50);
    expect(bridge.chats.get(ana.id)!.unread).toBe(0);
    expect(moon.withdrawn.length).toBeGreaterThan(0);
    await Bun.sleep(500);
    expect(moon.badges.length).toBeGreaterThan(0);
  });

  test("writes: refused while off; with them on a send is echoed with its client id and then delivered", async () => {
    const off = await startFixtures({ readOnly: true });
    const ana = await chatNamed(off.client, "Ana Ruiz");
    const refused = await off.client.request("send", { chat: ana.id, text: "hi", client_id: "c1" });
    expect(refused.error.code).toBe("read_only");
    const react = await off.client.request("react", { chat: ana.id, message: "x", emoji: "👍" });
    expect(react.error.code).toBe("read_only");

    const on = await startFixtures();
    const chat = await chatNamed(on.client, "Ana Ruiz");
    const sent = await on.client.request("send", { chat: chat.id, text: "on my way", client_id: "c7" });
    expect(sent.ok).toBe(true);
    expect(sent.result.message.client_id).toBe("c7");
    expect(sent.result.message.mine).toBe(true);
    await on.client.request("view", { chat: chat.id, front: true });
    await on.client.until((event) => event.event === "message" && event.message.id === sent.result.message.id && event.message.status === "delivered", 3000);
  });

  test("status updates: by who posted, unseen first; seen here only; their photos come as files", async () => {
    const { client } = await startFixtures();
    const list = await client.request("whatsapp.status.list");
    const updates = list.result.updates;
    expect(updates.length).toBe(9);
    expect(updates.every((u: any) => !u.seen && u.items.length > 0)).toBe(true);
    const first = updates[0];
    const ids = first.items.map((item: any) => item.id);
    await client.request("whatsapp.status.seen", { ids });
    const again = (await client.request("whatsapp.status.list")).result.updates;
    expect(again.at(-1).user.id).toBe(first.user.id);
    expect(again.at(-1).seen).toBe(true);
    const photo = updates.flatMap((u: any) => u.items).find((item: any) => item.media[0]?.kind === "image");
    expect((await client.request("media.fetch", { ref: photo.media[0].ref })).ok).toBe(true);
    const text = updates.flatMap((u: any) => u.items).find((item: any) => item.media.length === 0);
    expect(text.ext.background).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("signed out: a QR as rows of modules, then linking, then the chats", async () => {
    const { client } = await startFixtures({ signedOut: true });
    expect((await client.request("status")).result.state).toBe("signed_out");
    expect((await client.request("login.start", { method: "qr" })).ok).toBe(true);
    const qr = await client.until((event) => event.event === "login" && event.state === "qr");
    expect(qr.qr.size).toBe(qr.qr.rows.length);
    expect(qr.qr.rows.every((row: string) => /^[01]+$/.test(row) && row.length === qr.qr.size)).toBe(true);
    await client.request("whatsapp.fixtures.scan");
    await client.until((event) => event.event === "login" && event.state === "waiting");
    await client.until((event) => event.event === "login" && event.state === "done", 4000);
    expect((await client.request("status")).result.state).toBe("online");
    const list = await client.request("chats.list", { limit: 10 });
    expect(list.result.chats.length).toBe(10);
  });

  test("one bridge per session: a second one on the same state refuses to start", async () => {
    const root = mkdtempSync(join(tmpdir(), "wa-lock-"));
    // Another live bridge process holds the state.
    const other = spawn("sleep", ["30"], { argv0: "service" } as any);
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(root, "state", "wa"), { recursive: true });
      writeFileSync(join(root, "state", "wa", "bridge.pid"), `${other.pid}\n`);
      const bridge = new Bridge({
        service: "whatsapp", socketPath: join(root, "run", "whatsapp.sock"), stateDir: join(root, "state"), cacheDir: join(root, "cache"),
        fixtures: true, readOnly: true, moon: new FakeMoon(), log: quiet,
      });
      bridges.push(bridge);
      const provider = new WhatsAppProvider(bridge.host(), scriptedBackend(), null);
      const command = (await Bun.file(`/proc/${other.pid}/cmdline`).text()).replace(/\0/g, " ");
      if (/service/.test(command)) await expect(provider.start()).rejects.toThrow(/another WhatsApp bridge/);
      else await expect(provider.start()).resolves.toBeUndefined();
    } finally {
      other.kill();
    }
  });
});

/** A backend that only emits what a test tells it to. */
function scriptedBackend(): WaBackend & { emit: (event: string, data: unknown) => void; raw: (event: RawEvent) => void } {
  const listeners = new Map<string, Set<(data: any) => void>>();
  const rawListeners = new Set<(event: RawEvent) => void>();
  let state: WhatsAppConnectionState = { status: "idle" };
  return {
    get state() { return state; },
    on(event: any, listener: any) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(listener);
      return () => set!.delete(listener);
    },
    onRaw(listener) { rawListeners.add(listener); return () => rawListeners.delete(listener); },
    emit(event: string, data: unknown) {
      if (event === "state") state = data as WhatsAppConnectionState;
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
    raw(event: RawEvent) { for (const listener of rawListeners) listener(event); },
    async hasSession() { return true; },
    async startLogin() { return { status: "connected", resumed: true }; },
    cancelLogin() { return false; },
    async logout() {},
    async shutdown() {},
    async fetchHistory() { return "r1"; },
    async downloadMedia() { return {}; },
    async profilePicture() { return false; },
    async groupInfo() { return null; },
    newMessageId() { return "N1"; },
    async sendText(): Promise<WhatsAppMessage> { throw new Error("no"); },
    async sendReaction() {},
    async markRead() {},
  };
}

describe("whatsapp provider", () => {
  async function startScripted() {
    const root = mkdtempSync(join(tmpdir(), "wa-s-"));
    const backend = scriptedBackend();
    const moon = new FakeMoon();
    const bridge = new Bridge({
      service: "whatsapp", socketPath: join(root, "run", "whatsapp.sock"), stateDir: join(root, "state"), cacheDir: join(root, "cache"),
      fixtures: false, readOnly: true, moon, log: quiet,
    });
    bridges.push(bridge);
    let provider!: WhatsAppProvider;
    await bridge.start((host) => (provider = new WhatsAppProvider(host, backend, null)));
    backend.emit("state", { status: "connected", resumed: true, connectedAtMs: 1, account: { id: "15550001111:3@s.whatsapp.net", name: "Me" } });
    return { bridge, backend, provider, moon };
  }

  const text = (id: string, chatId: string, body: string, extra: Partial<WhatsAppMessage> = {}): WhatsAppMessage => ({
    key: { id, chatId, fromMe: false }, id, chatId, fromMe: false, senderId: chatId, timestampMs: 1_793_000_000_000,
    content: { kind: "text", text: body }, ...extra,
  });

  test("a chat known by its LID becomes the phone number's once WhatsApp maps them", async () => {
    const { bridge, backend } = await startScripted();
    backend.emit("chats", { kind: "upsert", chats: [{ id: "98765@lid", kind: "direct", unreadCount: 2, lastMessageAtMs: 1_793_000_000_000 }] });
    backend.emit("messages", { kind: "upsert", upsertType: "append", messages: [text("A1", "98765@lid", "hi")], skippedMessages: 0 });
    await Bun.sleep(10);
    expect(bridge.chats.all().map((chat) => chat.id)).toHaveLength(1);
    backend.emit("lid-mapping", { lid: "98765@lid", phoneId: "15557770000@s.whatsapp.net" });
    await Bun.sleep(10);
    const chats = bridge.chats.all();
    expect(chats).toHaveLength(1);
    expect(Buffer.from(chats[0]!.id.slice(3), "base64url").toString()).toBe("15557770000@s.whatsapp.net");
    expect(chats[0]!.unread).toBe(2);
    expect(chats[0]!.title).toBe("+1 555-777-0000");
  });

  test("chats.update counts unread as deltas; a read on the phone clears it and the notification", async () => {
    const { bridge, backend, moon } = await startScripted();
    const jid = "15552223333@s.whatsapp.net";
    backend.emit("chats", { kind: "upsert", chats: [{ id: jid, kind: "direct", unreadCount: 0, lastMessageAtMs: 1_793_000_000_000 }] });
    backend.emit("contacts", { kind: "upsert", contacts: [{ id: jid, name: "Leo Park" }] });
    backend.emit("chats", { kind: "update", chats: [{ id: jid, kind: "direct", unreadCount: 1 }] });
    backend.emit("messages", { kind: "upsert", upsertType: "notify", messages: [text("B1", jid, "dinner?")], skippedMessages: 0 });
    backend.emit("chats", { kind: "update", chats: [{ id: jid, kind: "direct", unreadCount: 1 }] });
    await Bun.sleep(30);
    const id = bridge.chats.all()[0]!.id;
    expect(bridge.chats.get(id)!.unread).toBe(2);
    expect(bridge.chats.get(id)!.title).toBe("Leo Park");
    expect(moon.posts.at(-1)?.title).toBe("Leo Park");
    backend.emit("chats", { kind: "update", chats: [{ id: jid, kind: "direct", unreadCount: 0 }] });
    await Bun.sleep(30);
    expect(bridge.chats.get(id)!.unread).toBe(0);
    expect(moon.withdrawn.length).toBeGreaterThan(0);
  });

  test("extras, revokes and receipts from the socket land on record's messages", async () => {
    const { bridge, backend, provider } = await startScripted();
    const jid = "15552224444@s.whatsapp.net";
    backend.raw({ kind: "extras", id: "C1", extras: { quote: { text: "where?", participant: jid }, forwarded: true } });
    backend.emit("messages", { kind: "upsert", upsertType: "append", messages: [text("C1", jid, "here", { replyTo: { id: "Z9", chatId: jid } })], skippedMessages: 0 });
    backend.emit("messages", { kind: "upsert", upsertType: "append", messages: [{ ...text("C2", jid, "mine"), fromMe: true, key: { id: "C2", chatId: jid, fromMe: true } }], skippedMessages: 0 });
    backend.raw({ kind: "status", chatId: jid, id: "C2", status: "read" });
    backend.raw({ kind: "revoke", chatId: jid, id: "C1" });
    await Bun.sleep(10);
    const chat = bridge.chats.all()[0]!;
    const page = await provider.history(chat.id, { limit: 10 });
    const [first, second] = page.messages;
    expect(first!.deleted).toBe(true);
    expect(first!.forwarded).toBe(true);
    expect(second!.status).toBe("read");
    expect(chat.ext?.status).toBe("read");
  });

  test("stub messages become notices with today's names", async () => {
    const { bridge, backend, provider } = await startScripted();
    const group = "120363000000000099@g.us";
    backend.emit("contacts", { kind: "upsert", contacts: [{ id: "15551112222@s.whatsapp.net", name: "Ana" }, { id: "15553334444@s.whatsapp.net", notify: "Leo", pushName: "Leo" } as any] });
    const stub = noticeMessage({
      key: { id: "S1", remoteJid: group, fromMe: false, participant: "15551112222@s.whatsapp.net" },
      messageTimestamp: 1_793_000_000,
      messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
      messageStubParameters: [JSON.stringify({ phoneNumber: "15553334444@s.whatsapp.net" })],
    } as WAMessage, "15550001111@s.whatsapp.net");
    expect(stub).not.toBeNull();
    backend.raw({ kind: "system", message: stub!, live: false });
    backend.raw({ kind: "group", chatId: group, subject: "Trip", size: 4 });
    await Bun.sleep(10);
    const chat = bridge.chats.all().find((c) => c.kind === "group")!;
    expect(chat.title).toBe("Trip");
    const page = await provider.history(chat.id, { limit: 10 });
    expect(page.messages[0]!.system).toBe(true);
    // Unsaved: by number, as WhatsApp shows them.
    expect(page.messages[0]!.text).toBe("Ana added +1 555-333-4444");
  });
});

describe("whatsapp live helpers", () => {
  test("a message's extras: its thumbnail, what it quotes, forwarded, its receipt", () => {
    const message = {
      key: { id: "M1", remoteJid: "1@s.whatsapp.net", fromMe: true },
      status: proto.WebMessageInfo.Status.DELIVERY_ACK,
      message: {
        imageMessage: {
          jpegThumbnail: new Uint8Array([1, 2, 3]),
          contextInfo: {
            isForwarded: true,
            participant: "2@s.whatsapp.net",
            quotedMessage: { conversation: "see   you\nthere" },
          },
        },
      },
    } as unknown as WAMessage;
    const extras = messageExtras(message)!;
    expect(extras.thumb).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(extras.quote).toEqual({ text: "see you there", participant: "2@s.whatsapp.net" });
    expect(extras.forwarded).toBe(true);
    expect(extras.status).toBe("delivered");
    expect(messageStatus(proto.WebMessageInfo.Status.READ)).toBe("read");
    expect(quotedText({ audioMessage: { ptt: true } })).toBe("🎤 Voice message");
  });

  test("names lose control and direction characters", () => {
    expect(cleanName("a\u0000b\u202ec  d")).toBe("a bc d");
  });
});
