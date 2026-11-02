import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiscordMessage } from "../../discord";
import { createLogger } from "../log";
import type { MoonLink, MoonView } from "../moon";
import { Bridge } from "../server";
import { createProvider } from "./discord";
import { Account } from "./discord/account";
import { installFixtures } from "./discord/fixtures";
import { mediaRequest } from "./discord/refs";
import { decodeUserProto } from "./discord/userproto";
import { plainText, wireMessage } from "./discord/wire";

process.env.DISCORD_FIXTURES_HEARTBEAT_MS = "1000";
const quiet = createLogger("test", () => {});

class FakeMoon implements MoonLink {
  posts: Record<string, any>[] = [];
  badges: number[] = [];
  moonView: MoonView | null = { view: "home", screenAwake: true, locked: false };
  async view() { return this.moonView; }
  async badge(_app: string, count: number) { this.badges.push(count); return true; }
  async post(notification: Record<string, unknown>) { this.posts.push(notification); return `n${this.posts.length}`; }
  async withdraw() { return true; }
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

const bridges: Bridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
});

/** A fixtures bridge, its gateway's client payloads recorded. */
async function start(options: { readOnly?: boolean } = {}) {
  const fixtures = installFixtures();
  const payloads: any[] = [];
  const handle = fixtures.server.handleClientPayload.bind(fixtures.server);
  fixtures.server.handleClientPayload = (socket, payload) => {
    payloads.push(payload);
    handle(socket, payload);
  };
  const root = mkdtempSync(join(tmpdir(), "discord-"));
  const moon = new FakeMoon();
  const bridge = new Bridge({
    service: "discord", socketPath: join(root, "discord.sock"), stateDir: join(root, "state"), cacheDir: join(root, "cache"),
    fixtures: true, readOnly: options.readOnly ?? false, moon, log: quiet,
  });
  bridges.push(bridge);
  await bridge.start(createProvider);
  const client = await Client.connect(join(root, "discord.sock"));
  await client.request("subscribe");
  await until(async () => (await client.request("status")).result.state === "online");
  return { moon, bridge, client, payloads, fixtures };
}

describe("discord provider on the fixtures", () => {
  test("servers, channels, threads and DMs; history; media", async () => {
    const { client } = await start();
    const list = await client.request("chats.list", { limit: 500 });
    const chats = list.result.chats as any[];
    expect(chats.filter((chat) => chat.kind === "dm").length).toBeGreaterThan(5);
    expect(chats.some((chat) => chat.kind === "group")).toBe(true);
    expect(chats.some((chat) => chat.kind === "thread" && chat.parent)).toBe(true);
    expect(chats.some((chat) => chat.kind === "forum")).toBe(true);
    expect(chats.some((chat) => chat.kind === "voice")).toBe(true);
    // A channel @everyone may not see, where the user has no role that lets them: not a chat.
    const guilds = (await client.request("discord.guilds")).result.guilds as any[];
    expect(guilds).toHaveLength(15);
    expect(guilds[0].categories.map((c: any) => c.name)).toEqual(["Information", "Text Channels", "Voice Channels"]);
    expect(guilds.some((guild) => guild.muted)).toBe(true);
    expect(guilds.some((guild) => guild.unread)).toBe(true);

    const general = chats.find((chat) => chat.title === "general" && chat.ext.guild === guilds[0].id);
    expect(general.ext.category).toBe(guilds[0].categories[1].id);
    const page = await client.request("history", { chat: general.id, limit: 40 });
    expect(page.result.messages).toHaveLength(40);
    expect(page.result.more).toBe(true);
    expect(page.result.messages[0].format).toBe("discord");
    const older = await client.request("history", { chat: general.id, before: page.result.messages[0].id, limit: 40 });
    expect(older.result.messages.at(-1).ts).toBeLessThan(page.result.messages[0].ts);

    const avatar = page.result.messages[0].author.avatar.ref;
    const fetched = await client.request("media.fetch", { ref: avatar, max: 110 });
    expect(fetched.ok).toBe(true);
    expect(existsSync(fetched.result.path)).toBe(true);
    const outside = await client.request("media.fetch", { ref: "u:https://example.com/x.png" });
    expect(outside.error.code).toBe("invalid_argument");
    client.close();
  });

  test("notifies DMs, mentions and channels set to all messages; nothing muted, nothing else", async () => {
    const { client, moon } = await start();
    const chats = (await client.request("chats.list", { limit: 500 })).result.chats as any[];
    const guilds = (await client.request("discord.guilds")).result.guilds as any[];
    const dm = chats.find((chat) => chat.kind === "dm");
    const everything = chats.find((chat) => chat.kind === "channel" && chat.ext.guild === guilds[0].id);
    const mentionsOnly = chats.find((chat) => chat.kind === "channel" && chat.ext.guild === guilds[1].id);
    const muted = chats.find((chat) => chat.kind === "channel" && chat.ext.guild === guilds.find((g) => g.muted).id);
    const emit = (chat: string, text: string, mention = false) => client.request("discord.fixtures.emit", { chat, text, mention });
    await emit(dm.id, "hello there");
    await emit(mentionsOnly.id, "nobody is mentioned");
    await emit(mentionsOnly.id, "look at this", true);
    await emit(everything.id, "a message for everyone");
    await emit(muted.id, "muted mention", true);
    await until(() => moon.posts.length >= 3);
    await sleep(200);
    expect(moon.posts.map((post) => post.tag)).toEqual([dm.id, mentionsOnly.id, everything.id]);
    expect(moon.posts[0].title).toBe(dm.title);
    // Mentions read as names, not tokens.
    expect(moon.posts[1].body).toContain("@Demo User look at this");
    expect(moon.posts[2].title).toBe(`#${everything.title} (${guilds[0].name})`);
    const after = (await client.request("chat.get", { chat: mentionsOnly.id })).result;
    expect(after.mentions).toBeGreaterThan(0);
    await until(() => moon.badges.length > 0 && moon.badges.at(-1)! > 0);
    client.close();
  });

  test("while writes are off the session is invisible and away and never sends a presence update", async () => {
    const { client, payloads } = await start({ readOnly: true });
    const identify = payloads.find((payload) => payload.op === 2);
    expect(identify.d.presence).toEqual({ activities: [], status: "invisible", since: null, afk: true });
    expect(identify.d.capabilities).toBe(30717);
    expect(identify.d.properties.browser).toBe("Discord Client");
    // Heartbeats (at most one a second, as record's) each check the presence: still nothing.
    await sleep(2300);
    expect(payloads.filter((payload) => payload.op === 40).length).toBeGreaterThanOrEqual(2);
    expect(payloads.some((payload) => payload.op === 3 || payload.op === 4)).toBe(false);
    const send = await client.request("send", { chat: "1", text: "hi" });
    expect(send.error.code).toBe("read_only");
    client.close();
  });

  test("with writes on it carries the user's status and follows their changes", async () => {
    const { client, payloads, fixtures } = await start();
    const identify = payloads.find((payload) => payload.op === 2);
    expect(identify.d.presence.status).toBe("online");
    expect(identify.d.presence.afk).toBe(false);
    // StatusSettings { status: StringValue("idle") } in PreloadedUserSettings field 11.
    const status = Buffer.from([0x0a, 0x06, 0x0a, 0x04, ...Buffer.from("idle")]);
    const proto = Buffer.concat([Buffer.from([0x5a, status.length]), status]).toString("base64");
    fixtures.server.dispatch("USER_SETTINGS_PROTO_UPDATE", { settings: { type: 1, proto }, partial: true });
    const update = await until(() => payloads.find((payload) => payload.op === 3));
    expect(update.d).toEqual({ status: "idle", afk: false, since: 0, activities: [] });
    client.close();
  });
});

describe("discord account", () => {
  const ready = {
    user: { id: "100", username: "me" },
    guilds: [{
      id: "1", joined_at: "2026-01-01T00:00:00.000Z",
      properties: { id: "1", name: "G", icon: null, owner_id: "999", default_message_notifications: 1 },
      roles: [
        { id: "1", name: "@everyone", color: 0, position: 0, permissions: String(1n << 10n) },
        { id: "5", name: "Mods", color: 0xff0000, position: 2, permissions: "0" },
      ],
      channels: [
        { id: "10", type: 4, name: "Cat", position: 0, parent_id: null },
        { id: "11", type: 0, name: "open", position: 1, parent_id: "10", last_message_id: "2000000000000000000" },
        { id: "12", type: 0, name: "secret", position: 2, parent_id: "10", permission_overwrites: [{ id: "1", type: 0, allow: "0", deny: String(1n << 10n) }] },
        { id: "13", type: 0, name: "mods", position: 3, parent_id: "10", permission_overwrites: [{ id: "1", type: 0, allow: "0", deny: String(1n << 10n) }, { id: "5", type: 0, allow: String(1n << 10n), deny: "0" }] },
      ],
      threads: [],
    }],
    merged_members: [[{ user_id: "100", roles: ["5"] }]],
    private_channels: [{ id: "50", type: 1, recipient_ids: ["7"], last_message_id: "2000000000000000001" }],
    users: [{ id: "7", username: "ana", global_name: "Ana" }],
    read_state: { entries: [{ id: "50", last_message_id: "1000000000000000000", mention_count: 2 }] },
    user_guild_settings: { entries: [{ guild_id: "1", muted: false, message_notifications: 3, suppress_everyone: true, channel_overrides: [{ channel_id: "10", muted: true, message_notifications: 0 }] }] },
  };

  test("visibility, unread state, mutes, notification levels and mentions", () => {
    const account = new Account();
    account.loadReady(ready, []);
    const chats = account.chats();
    expect(chats.map((chat) => chat.id).sort()).toEqual(["11", "13", "50"]);
    const dm = chats.find((chat) => chat.id === "50")!;
    expect([dm.kind, dm.title, dm.unread, dm.mentions]).toEqual(["dm", "Ana", 2, 2]);
    const open = account.channels.get("11")!;
    // Messages after the user joined, never opened: unread.
    expect(account.isUnread(open)).toBe(true);
    expect(account.channelMuted(open)).toBe(true);
    expect(account.notificationLevel(open)).toBe(0);
    expect(account.mentionsMe({ mentions: [], mention_everyone: true }, open)).toBe(false);
    expect(account.mentionsMe({ mentions: [{ id: "100" }] }, open)).toBe(true);
    expect(account.mentionsMe({ mentions: [], mention_roles: ["5"] }, open)).toBe(true);
    expect(account.roleColor("1", ["5"])).toBe(0xff0000);
    account.ack("11", "2000000000000000000", 0);
    expect(account.isUnread(open)).toBe(false);
    const arrival = account.arrive({ id: "2000000000000000005", channel_id: "50", author: { id: "7" }, type: 0, mentions: [] }, false);
    expect(arrival?.notify).toBe(true);
    expect(account.badge()).toBe(3);
  });

  test("the settings protobuf: status and folders", () => {
    // status "dnd"; one folder (id 9, "Work", color 255) holding guilds 1 and 2.
    const status = Buffer.from([0x0a, 0x05, 0x0a, 0x03, ...Buffer.from("dnd")]);
    const fixed = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
    const ids = Buffer.concat([fixed(1n), fixed(2n)]);
    const name = Buffer.from([0x0a, 0x04, ...Buffer.from("Work")]);
    const folder = Buffer.concat([
      Buffer.from([0x0a, ids.length]), ids,
      Buffer.from([0x12, 0x02, 0x08, 0x09]),
      Buffer.from([0x1a, name.length]), name,
      Buffer.from([0x22, 0x03, 0x08, 0xff, 0x01]),
    ]);
    const folders = Buffer.concat([Buffer.from([0x0a, folder.length]), folder]);
    const settings = Buffer.concat([Buffer.from([0x5a, status.length]), status, Buffer.from([0x72, folders.length]), folders]);
    const decoded = decodeUserProto(settings.toString("base64"));
    expect(decoded.status).toBe("dnd");
    expect(decoded.folders).toEqual([{ id: "9", name: "Work", color: 255, guildIds: ["1", "2"] }]);
    expect(decodeUserProto("not base64 at all!!").folders).toEqual([]);
  });
});

describe("discord media refs and messages", () => {
  test("refs become Discord CDN URLs at the size drawn, and nothing else is fetched", () => {
    expect(mediaRequest("av:123:abcdef0123456789abcdef0123456789", 100).url).toBe("https://cdn.discordapp.com/avatars/123/abcdef0123456789abcdef0123456789.png?size=128");
    expect(mediaRequest("em:42", 60).url).toBe("https://cdn.discordapp.com/emojis/42.png?size=64&quality=lossless");
    const photo = mediaRequest("p:2000:1000:image/png:https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3&", 500);
    expect(photo.url).toBe("https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3&=&format=webp&quality=lossless&width=500&height=250");
    expect(photo.key).toBe("media.discordapp.net/attachments/1/2/a.png@500x250");
    expect(() => mediaRequest("u:https://evil.example/x.png", 10)).toThrow();
    expect(() => mediaRequest("av:../x:abc", 10)).toThrow();
  });

  test("a message's tokens, attachments, reactions and embeds", () => {
    const account = new Account();
    account.loadReady({ user: { id: "100", username: "me" }, guilds: [], private_channels: [], read_state: { entries: [] } }, []);
    const message: DiscordMessage = {
      id: "5", channelId: "50", guildId: null, type: 0, content: "hi <@7> <:blob:9>", mentionEveryone: false, mentionRoleIds: [],
      mentionUserIds: ["7"], mentionUsers: [{ id: "7", username: "ana", displayName: "Ana", bot: false }], timestamp: 1, editedTimestamp: 2,
      author: { id: "7", username: "ana", displayName: "Ana", bot: false, avatar: "abcdef0123456789abcdef0123456789" },
      reply: null, call: null, stickerNames: [], stickers: [], embedsCount: 1,
      attachments: [
        { id: "a", filename: "p.jpg", contentType: "image/jpeg", size: 10, url: "https://cdn.discordapp.com/attachments/50/a/p.jpg", proxyUrl: "https://media.discordapp.net/attachments/50/a/p.jpg", width: 800, height: 600 },
        { id: "b", filename: "v.mp4", contentType: "video/mp4", size: 10, url: "https://cdn.discordapp.com/attachments/50/b/v.mp4", width: 640, height: 360 },
        { id: "c", filename: "notes.txt", contentType: "text/plain", size: 2048, url: "https://cdn.discordapp.com/attachments/50/c/notes.txt" },
      ],
      embeds: [{ type: "rich", title: "T", url: "https://x.test", description: "d", providerName: null, authorName: null, color: 0x5865f2, fields: [{ name: "n", value: "v", inline: true }] }],
      reactions: [{ emoji: { id: "9", name: "blob", animated: false }, count: 2, me: true }, { emoji: { id: null, name: "👍", animated: false }, count: 1, me: false }],
    };
    const wire = wireMessage(message, { account });
    expect(wire.media.map((media) => media.kind)).toEqual(["image", "video", "file"]);
    expect(wire.media[1]!.thumb).toStartWith("v:640:360:");
    expect(wire.reactions).toEqual([{ emoji: "<:blob:9>", count: 2, mine: true }, { emoji: "👍", count: 1, mine: false }]);
    expect((wire.ext as any).users).toEqual({ "7": "Ana" });
    expect((wire.ext as any).emoji["9"].ref).toBe("em:9");
    expect((wire.ext as any).embeds[0].color).toBe(0x5865f2);
    expect(wire.edited_ts).toBe(2);
    expect(plainText(wire)).toBe("hi @Ana :blob:");
  });
});
