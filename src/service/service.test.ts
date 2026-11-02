import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatStore } from "./chatstore";
import { createLogger } from "./log";
import { sniffImage } from "./media";
import type { MoonLink, MoonView } from "./moon";
import { Notifier, summarize, tagFor } from "./notifier";
import type { WireChat, WireMessage } from "./protocol";
import { createProvider as createSample } from "./providers/sample";
import { Bridge } from "./server";
import { parseArgs } from "./main";

const quiet = createLogger("test", () => {});

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
  close() { this.socket.destroy(); }
}

const bridges: Bridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
});

async function startSample(options: { readOnly?: boolean; fixtures?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "service-"));
  const moon = new FakeMoon();
  const bridge = new Bridge({
    service: "whatsapp", socketPath: join(root, "run", "whatsapp.sock"), stateDir: join(root, "state"), cacheDir: join(root, "cache"),
    fixtures: options.fixtures ?? true, readOnly: options.readOnly ?? false, moon, log: quiet,
  });
  bridges.push(bridge);
  await bridge.start(createSample);
  const client = await Client.connect(join(root, "run", "whatsapp.sock"));
  return { root, moon, bridge, client };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bridge", () => {
  test("answers the core from the sample provider", async () => {
    const { client, root } = await startSample();
    const hello = await client.request("hello", { client: "test", protocol: 1 });
    expect(hello.ok).toBe(true);
    expect(hello.result.protocol).toBe(1);
    expect(hello.result.status.state).toBe("online");
    expect(statSync(join(root, "run", "whatsapp.sock")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);

    const list = await client.request("chats.list", { limit: 5 });
    expect(list.result.chats).toHaveLength(5);
    expect(list.result.chats[0].pinned).toBe(true);
    expect(list.result.cursor).toBe("o:5");
    const rest = await client.request("chats.list", { cursor: list.result.cursor });
    expect(rest.result.chats).toHaveLength(7);
    expect(rest.result.cursor).toBeNull();

    const chat = list.result.chats[1].id;
    const page = await client.request("history", { chat, limit: 30 });
    expect(page.result.messages).toHaveLength(30);
    expect(page.result.more).toBe(true);
    const older = await client.request("history", { chat, before: page.result.messages[0].id, limit: 100 });
    expect(older.result.messages).toHaveLength(90);
    expect(older.result.more).toBe(false);
    expect(older.result.messages.at(-1).ts).toBeLessThan(page.result.messages[0].ts);

    const bad = await client.request("history", { chat: "nope" });
    expect(bad.error.code).toBe("not_found");
    const unknown = await client.request("frobnicate");
    expect(unknown.error.code).toBe("unknown_command");
    client.close();
  });

  test("fetches media into the private cache and reports its size", async () => {
    const { client } = await startSample();
    const fetched = await client.request("media.fetch", { ref: "avatar:2", max: 120 });
    expect(fetched.ok).toBe(true);
    expect(fetched.result.mime).toBe("image/png");
    expect([fetched.result.w, fetched.result.h]).toEqual([256, 256]);
    expect(statSync(fetched.result.path).mode & 0o777).toBe(0o600);
    const again = await client.request("media.fetch", { ref: "avatar:2" });
    expect(again.result.path).toBe(fetched.result.path);
    client.close();
  });

  test("refuses writes while they are off and never lets --read-only turn them on", async () => {
    const { client } = await startSample({ readOnly: true });
    const chat = (await client.request("chats.list")).result.chats[0].id;
    for (const [cmd, args] of [
      ["send", { chat, text: "hi" }], ["react", { chat, message: "x", emoji: "👍" }], ["mark_read", { chat }], ["typing", { chat }],
    ] as const) {
      const answer = await client.request(cmd, args);
      expect(answer.error?.code).toBe("read_only");
    }
    const turnOn = await client.request("settings.set", { writes: true });
    expect(turnOn.error.code).toBe("read_only");
    expect((await client.request("status")).result.writes).toBe(false);
    client.close();
  });

  test("a real (non-fixture) bridge starts with writes off", async () => {
    const { client } = await startSample({ fixtures: false });
    expect((await client.request("settings.get")).result.writes).toBe(false);
    const chat = (await client.request("chats.list")).result.chats[0].id;
    expect((await client.request("send", { chat, text: "hi" })).error.code).toBe("read_only");
    client.close();
  });

  test("viewing a chat reads it locally, withdraws its notification and clears the badge", async () => {
    const { client, moon } = await startSample({ fixtures: false });
    await client.request("subscribe");
    await sleep(500);
    expect(moon.badges.at(-1)).toEqual(["whatsapp", 2]);
    const unread = (await client.request("chats.list")).result.chats.find((chat: WireChat) => chat.unread > 0 && !chat.muted);
    await client.request("view", { chat: unread.id, front: true });
    expect((await client.request("chat.get", { chat: unread.id })).result.unread).toBe(0);
    await sleep(500);
    expect(moon.badges.at(-1)).toEqual(["whatsapp", 1]);
    expect(client.events.some((event) => event.event === "chat" && event.chat.id === unread.id && event.chat.unread === 0)).toBe(true);
    client.close();
  });

  test("notifies a live message unless the app shows that chat in front", async () => {
    const { client, moon } = await startSample();
    await client.request("subscribe");
    await client.request("sample.poke", { chat: "sample:0", text: "hello there" });
    await sleep(20);
    expect(moon.posts).toHaveLength(1);
    expect(moon.posts[0]).toMatchObject({ app: "whatsapp", tag: tagFor("sample:0"), title: "Ana Ruiz", open: { app: "whatsapp", target: "sample:0" } });
    expect(String(moon.posts[0]!.body)).toStartWith("hello there");

    await client.request("view", { chat: "sample:0", front: true });
    moon.moonView = { view: "whatsapp", screenAwake: true, locked: false };
    await client.request("sample.poke", { chat: "sample:0" });
    await sleep(20);
    expect(moon.posts).toHaveLength(1);
    expect(moon.withdrawn).toContain(tagFor("sample:0"));

    // On the lock screen it notifies even though the app shows it.
    moon.moonView = { view: "whatsapp", screenAwake: true, locked: true };
    await client.request("sample.poke", { chat: "sample:5" });
    await client.request("view", { chat: "sample:5", front: true });
    await client.request("sample.poke", { chat: "sample:5" });
    await sleep(20);
    expect(moon.posts).toHaveLength(3);

    // Muted chats never notify.
    await client.request("sample.poke", { chat: "sample:9" });
    await sleep(20);
    expect(moon.posts).toHaveLength(3);
    client.close();
  });

  test("a second bridge on the same socket refuses to start", async () => {
    const { root } = await startSample();
    const second = new Bridge({
      service: "whatsapp", socketPath: join(root, "run", "whatsapp.sock"), stateDir: join(root, "state2"), cacheDir: join(root, "cache2"),
      fixtures: true, readOnly: false, moon: new FakeMoon(), log: quiet,
    });
    await expect(second.start(createSample)).rejects.toThrow("another bridge");
  });

  test("the chat list survives a restart", async () => {
    const { root, bridge } = await startSample();
    await bridge.stop();
    bridges.splice(bridges.indexOf(bridge), 1);
    expect(existsSync(join(root, "state", "chats.json"))).toBe(true);
    expect(statSync(join(root, "state", "chats.json")).mode & 0o777).toBe(0o600);
    const store = new ChatStore(join(root, "state"));
    expect(store.size).toBe(12);
    expect(readFileSync(join(root, "state", "chats.json"), "utf8")).toContain("Weekend trip");
  });
});

describe("pieces", () => {
  test("tags are ids or their hash", () => {
    expect(tagFor("sample:0")).toBe(tagFor("sample:0"));
    expect(tagFor("abc-1.2_3")).toBe("abc-1.2_3");
    expect(tagFor("wa:MTIz/x")).toMatch(/^c[0-9a-f]{16}$/);
  });

  test("summaries", () => {
    const base = { text: "", deleted: false, media: [] } as Pick<WireMessage, "text" | "media" | "deleted">;
    expect(summarize({ ...base, text: "  hi\nthere " })).toBe("hi there");
    expect(summarize({ ...base, media: [{ ref: "x", kind: "image" }] })).toBe("📷 Photo");
    expect(summarize({ ...base, media: [{ ref: "x", kind: "audio" }] })).toBe("🎤 Voice message");
    expect(summarize({ ...base, text: "x".repeat(400) })).toHaveLength(280);
  });

  test("sniffs image sizes", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 0, 0, 0, 0, 200]);
    expect(sniffImage(png)).toEqual({ mime: "image/png", w: 256, h: 200 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
    expect(sniffImage(gif)).toEqual({ mime: "image/gif", w: 320, h: 240 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x05, 0x46, 0x04, 0x38, 3]);
    expect(sniffImage(jpeg)).toEqual({ mime: "image/jpeg", w: 1080, h: 1350 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("notifications wait for moon-notifyd", async () => {
    const moon = new FakeMoon();
    let up = false;
    moon.post = async (notification) => (up ? (moon.posts.push(notification), "n1") : null);
    const notifier = new Notifier("discord", moon, () => ({ writes: false, notifications: true, previews: false }), quiet);
    const chat: WireChat = { id: "c1", kind: "dm", title: "Leo", ts: 1, unread: 1 };
    const message: WireMessage = { id: "m1", chat: "c1", ts: 1, author: { id: "u", name: "Leo" }, mine: false, text: "secret", format: "plain", media: [], reactions: [] };
    await notifier.incoming(message, chat);
    expect(moon.posts).toHaveLength(0);
    up = true;
    await sleep(1_100);
    expect(moon.posts).toHaveLength(1);
    expect(moon.posts[0]!.body).toBe("New message");
    notifier.stop();
  });

  test("arguments", () => {
    const options = parseArgs(["--provider", "whatsapp", "--fixtures", "--socket", "/tmp/a.sock"]);
    expect(options).toMatchObject({ service: "whatsapp", fixtures: true, moon: false, socketPath: "/tmp/a.sock", stateDir: "/var/lib/moon-social/whatsapp" });
    expect(parseArgs(["--provider", "discord"]).moon).toBe(true);
    expect(() => parseArgs(["--provider", "myspace"])).toThrow();
    expect(() => parseArgs(["--provider", "discord", "--state", "relative"])).toThrow();
  });
});
