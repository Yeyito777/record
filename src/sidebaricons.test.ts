import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { INSTAGRAM_GUILD_ID, WHATSAPP_GUILD_ID, WHATSAPP_GUILD_NAME, whatsappChannelId } from "./chatproviders";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, mapDirectMessageChannel, type DiscordChannel } from "./discord";
import { invalidateFrame } from "./frame";
import { openImageModalState } from "./imagemodal";
import type { InlineChatImageReady } from "./inlineimage";
import { render } from "./render";
import {
  createSidebarIconFrame,
  createSidebarState,
  moveSidebarSelection,
  renderSidebar,
  setSidebarCachedChannels,
  setSidebarGuilds,
  SIDEBAR_WIDTH,
} from "./sidebar";
import {
  discordGroupIconSource,
  discordGuildIconSource,
  discordUserAvatarSource,
  bundledSidebarIconSource,
  instagramUserPictureSource,
  SidebarIconStore,
  whatsappChatPictureSource,
  sidebarIconInitials,
  sidebarIconTerminalOwner,
  sidebarIcons,
  type SidebarIconSource,
} from "./sidebaricons";
import { SmoothScroller, markScrollIntent, setSmoothScroller } from "./smoothscroll";
import { createInitialState } from "./state";
import { disposeInlineTerminalImages } from "./terminalimage";
import { setTimelineMessages } from "./timeline";
import { termWidth } from "./textwidth";
import { theme } from "./theme";
import { VtScreen } from "./vtscreen.testutil";

// A valid transparent 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function pngResponse(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}

function recordingFetch(respond: (url: string) => Response | Promise<Response> = () => pngResponse()) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return respond(url);
  }) as typeof globalThis.fetch;
  return { urls, fetch };
}

function guild(id: string, name: string, icon: string | null = `hash${id}`) {
  return { id, name, icon };
}

function source(id: string, hash = `hash${id}`): SidebarIconSource {
  return discordGuildIconSource({ id, icon: hash })!;
}

function readyImage(imageId: number): InlineChatImageReady {
  return {
    phase: "ready",
    attachmentId: `icon-${imageId}`,
    filename: "icon.png",
    sourceUrl: "https://cdn.discordapp.com/icons/x/y.png",
    requestId: 0,
    imageId,
    pngBase64: PNG.toString("base64"),
    pixelWidth: 1,
    pixelHeight: 1,
  };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-sidebar-icons-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sidebar icon sources", () => {
  test("uses small static PNGs from the Discord CDN", () => {
    expect(discordGuildIconSource({ id: "123", icon: "a_abc" })).toEqual({
      platform: "discord",
      key: "guild-123-a_abc",
      owner: "guild-123-",
      url: "https://cdn.discordapp.com/icons/123/a_abc.png?size=64",
    });
    expect(discordGuildIconSource({ id: "123", icon: null })).toBeNull();
    // Ids and hashes become file names; anything unexpected is not fetched.
    expect(discordGuildIconSource({ id: "../x", icon: "abc" })).toBeNull();
    expect(discordGuildIconSource({ id: "1", icon: "a/b" })).toBeNull();
  });

  test("DM avatars and group DM icons come from the same CDN", () => {
    expect(discordUserAvatarSource({ id: "7", avatar: "abc" })?.url).toBe("https://cdn.discordapp.com/avatars/7/abc.png?size=64");
    expect(discordGroupIconSource({ id: "8", icon: "def" })?.url).toBe("https://cdn.discordapp.com/channel-icons/8/def.png?size=64");
    expect(discordUserAvatarSource({ id: "7", avatar: null })).toBeNull();
    const group = mapDirectMessageChannel({ id: "8", parent_id: null, type: 3, icon: "def", recipients: [] });
    expect(group.icon).toBe("def");
    expect(mapDirectMessageChannel({ id: "9", parent_id: null, type: 1 }).icon).toBeUndefined();
  });

  test("initials fill two cells", () => {
    expect(sidebarIconInitials("Toolbar Cult")).toBe("TC");
    expect(sidebarIconInitials("Direct Messages")).toBe("DM");
    expect(sidebarIconInitials("WhatsApp")).toBe("WA");
    expect(sidebarIconInitials("Instagram")).toBe("In");
    expect(sidebarIconInitials("x")).toBe("X ");
    expect(sidebarIconInitials("🎮")).toBe("🎮");
    expect(sidebarIconInitials("")).toBe("  ");
    for (const name of ["日本語 サーバー", "a b c", "🎮 games", "!!!"]) {
      expect(termWidth(sidebarIconInitials(name))).toBe(2);
    }
  });
});

describe("SidebarIconStore", () => {
  test("fetches visible icons first, then nearby ones, each once", async () => {
    const { urls, fetch } = recordingFetch();
    let updates = 0;
    const store = new SidebarIconStore({ fetch, cacheDir: null, concurrency: { discord: 1 }, onUpdate: () => updates++ });
    store.setEnabled(true);
    store.want([source("1"), source("2")], [source("3")]);
    store.want([source("1"), source("2")], [source("3")]);
    await store.idle();
    expect(urls).toEqual([source("1").url!, source("2").url!, source("3").url!]);
    expect(store.get(source("1"))?.pixelWidth).toBe(1);
    expect(store.get(source("3"))).not.toBeNull();
    // Only icons drawn on screen ask for a repaint.
    expect(updates).toBe(2);
  });

  test("never fetches rows that scrolled away before their turn", async () => {
    const { urls, fetch } = recordingFetch();
    const store = new SidebarIconStore({ fetch, cacheDir: null, concurrency: { discord: 1 } });
    store.setEnabled(true);
    store.want([source("1")], [source("2"), source("3")]);
    store.want([source("9")], []);
    await store.idle();
    expect(urls).toEqual([source("1").url!, source("9").url!]);
  });

  test("does nothing until the terminal supports graphics", async () => {
    const { urls, fetch } = recordingFetch();
    const store = new SidebarIconStore({ fetch, cacheDir: null });
    store.want([source("1")]);
    await store.idle();
    expect(urls).toEqual([]);
  });

  test("survives restarts through the disk cache and drops superseded pictures", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "guild-1-old.png"), PNG);
    writeFileSync(join(dir, "guild-10-other.png"), PNG);
    const first = recordingFetch();
    const store = new SidebarIconStore({ fetch: first.fetch, cacheDir: dir });
    store.setEnabled(true);
    store.want([source("1", "new")]);
    await store.idle();
    for (let i = 0; i < 50 && readdirSync(dir).includes("guild-1-old.png"); i++) await Bun.sleep(2);
    expect(first.urls).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual(["guild-1-new.png", "guild-10-other.png"]);

    const second = recordingFetch();
    const restarted = new SidebarIconStore({ fetch: second.fetch, cacheDir: dir });
    restarted.setEnabled(true);
    restarted.want([source("1", "new")]);
    await restarted.idle();
    expect(second.urls).toEqual([]);
    expect(restarted.get(source("1", "new"))?.pngBase64).toBe(PNG.toString("base64"));
  });

  test("never asks again about a picture that does not exist, even after a restart", async () => {
    const dir = tempDir();
    const { urls, fetch } = recordingFetch((url) => url.includes("/1/")
      ? new Response("<html>", { status: 200 })
      : new Response("", { status: 404 }));
    const store = new SidebarIconStore({ fetch, cacheDir: dir, convert: async () => { throw new Error("not an image"); } });
    store.setEnabled(true);
    store.want([source("1"), source("2")]);
    await store.idle();
    expect(store.get(source("1"))).toBeNull();
    expect(store.get(source("2"))).toBeNull();
    store.want([source("1"), source("2")]);
    await store.idle();
    expect(urls).toHaveLength(2);
    for (let i = 0; i < 50 && readdirSync(dir).length < 2; i++) await Bun.sleep(2);
    expect(readdirSync(dir).sort()).toEqual(["guild-1-hash1.none", "guild-2-hash2.none"]);

    const restarted = new SidebarIconStore({ fetch, cacheDir: dir });
    restarted.setEnabled(true);
    restarted.want([source("1"), source("2")]);
    await restarted.idle();
    expect(urls).toHaveLength(2);
  });

  test("provider root logos come from the repo: 64 px PNGs, no network, no cache files", async () => {
    const dir = tempDir();
    const { urls, fetch } = recordingFetch();
    const store = new SidebarIconStore({ fetch, cacheDir: dir });
    store.setEnabled(true);
    const logos = (["direct-messages", "whatsapp", "instagram"] as const).map(bundledSidebarIconSource);
    store.want(logos);
    await store.idle();
    expect(urls).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    for (const logo of logos) {
      const image = store.get(logo)!;
      expect([image.pixelWidth, image.pixelHeight]).toEqual([64, 64]);
    }
  });

  test("WhatsApp asks through the session one chat at a time and remembers chats without a picture", async () => {
    const dir = tempDir();
    const asked: string[] = [];
    const resolvers = {
      whatsapp: async (iconSource: SidebarIconSource) => {
        asked.push(iconSource.ref!);
        return iconSource.ref!.startsWith("1") ? `https://pps.whatsapp.net/${iconSource.ref}.jpg` : null;
      },
    };
    const { urls, fetch } = recordingFetch(() => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200 }));
    let converted = 0;
    const convert = async () => { converted++; return PNG; };
    let inFlight = 0;
    let maxInFlight = 0;
    const slowFetch = (async (input: string | URL | Request) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(2);
      inFlight--;
      return fetch(input);
    }) as typeof globalThis.fetch;
    const store = new SidebarIconStore({ fetch: slowFetch, cacheDir: dir, resolvers, convert });
    store.setEnabled(true);
    const people = ["15550001@s.whatsapp.net", "15550002@s.whatsapp.net", "25550003@s.whatsapp.net"].map(whatsappChatPictureSource);
    store.want(people);
    await store.idle();
    expect(asked).toEqual(people.map((person) => person.ref!));
    expect(urls).toHaveLength(2);
    expect(maxInFlight).toBe(1);
    expect(converted).toBe(2);
    expect(store.get(people[0]!)).not.toBeNull();
    expect(store.get(people[2]!)).toBeNull();
    for (let i = 0; i < 50 && readdirSync(dir).length < 3; i++) await Bun.sleep(2);

    // A restart within the cache's lifetime asks nothing at all.
    const restarted = new SidebarIconStore({ fetch, cacheDir: dir, resolvers, convert });
    restarted.setEnabled(true);
    restarted.want(people);
    await restarted.idle();
    expect(asked).toHaveLength(3);
    expect(urls).toHaveLength(2);
    expect(restarted.get(people[1]!)).not.toBeNull();
  });

  test("old pictures are asked for again after days; a failed refresh keeps the old one", async () => {
    const dir = tempDir();
    const ig = instagramUserPictureSource("55", "https://scontent.cdninstagram.com/a.jpg")!;
    writeFileSync(join(dir, `${ig.key}.png`), PNG);
    let now = Date.now();
    const { urls, fetch } = recordingFetch(() => new Response("", { status: 503 }));
    const fresh = new SidebarIconStore({ fetch, cacheDir: dir, now: () => now });
    fresh.setEnabled(true);
    fresh.want([ig]);
    await fresh.idle();
    expect(urls).toHaveLength(0);
    expect(fresh.get(ig)).not.toBeNull();

    now += 8 * 24 * 60 * 60_000;
    const later = new SidebarIconStore({ fetch, cacheDir: dir, now: () => now });
    later.setEnabled(true);
    later.want([ig]);
    await later.idle();
    expect(urls).toHaveLength(1);
    expect(later.get(ig)).not.toBeNull();
  });

  test("a WhatsApp resolver error backs off instead of retrying", async () => {
    let now = 1_000_000;
    let calls = 0;
    const store = new SidebarIconStore({
      fetch: recordingFetch().fetch, cacheDir: null, now: () => now,
      resolvers: { whatsapp: async () => { calls++; throw new Error("rate-overlimit"); } },
    });
    store.setEnabled(true);
    const people = ["15550001@s.whatsapp.net", "15550002@s.whatsapp.net"].map(whatsappChatPictureSource);
    for (let i = 0; i < 5; i++) {
      store.want(people);
      await store.idle();
    }
    expect(calls).toBe(1);
    now += 60_000;
    store.want(people);
    await store.idle();
    expect(calls).toBe(2);
  });

  test("errors back the platform off, doubling, and keep other platforms going", async () => {
    let now = 1_000_000;
    let failing = true;
    const { urls, fetch } = recordingFetch((url) => failing && url.includes("cdn.discordapp.com")
      ? new Response("", { status: 429 })
      : pngResponse());
    const store = new SidebarIconStore({ fetch, cacheDir: null, now: () => now, concurrency: { discord: 1 } });
    store.setEnabled(true);
    const ig = instagramUserPictureSource("55", "https://scontent.cdninstagram.com/a.jpg")!;
    store.want([source("1"), source("2"), ig]);
    await store.idle();
    // The first 429 pauses Discord: source 2 waits; Instagram is unaffected.
    expect(urls).toEqual([source("1").url!, ig.url!]);
    store.want([source("1"), source("2")]);
    await store.idle();
    expect(urls).toHaveLength(2);

    now += 60_000;
    store.want([source("1"), source("2")]);
    await store.idle();
    expect(urls.slice(2)).toEqual([source("1").url!]);
    // Second error: two minutes this time.
    now += 60_000;
    store.want([source("1"), source("2")]);
    await store.idle();
    expect(urls).toHaveLength(3);
    now += 60_000;
    failing = false;
    store.want([source("1"), source("2")]);
    await store.idle();
    expect(urls).toHaveLength(5);
    expect(store.get(source("2"))).not.toBeNull();
  });

  test("falls back to the tile after the terminal rejects an icon three times", async () => {
    const { fetch } = recordingFetch();
    const store = new SidebarIconStore({ fetch, cacheDir: null });
    store.setEnabled(true);
    store.want([source("1")]);
    await store.idle();
    const imageId = store.get(source("1"))!.imageId;
    expect(store.noteTerminalRejection(imageId + 1000)).toBe(false);
    for (let i = 0; i < 2; i++) expect(store.noteTerminalRejection(imageId)).toBe(true);
    expect(store.get(source("1"))).not.toBeNull();
    store.noteTerminalRejection(imageId);
    expect(store.get(source("1"))).toBeNull();
  });
});

function padTo(text: string): string {
  return `${text}${" ".repeat(SIDEBAR_WIDTH - 1 - termWidth(text))}│`;
}

describe("sidebar rows with icons", () => {
  function sidebarWith(guilds: ReturnType<typeof guild>[]) {
    // These pin today's look with arrows; sidebar-tree.test.ts covers both modes.
    const sidebar = createSidebarState({ arrows: "show" });
    sidebar.open = true;
    setSidebarGuilds(sidebar, guilds);
    return sidebar;
  }

  test("without graphics the rows are unchanged", () => {
    const sidebar = sidebarWith([guild("1", "Alpha"), guild("2", "Beta", null)]);
    const before = renderSidebar(sidebar, [], 10);
    expect(renderSidebar(sidebar, [], 10, false, null, 0, new Set(), "⋯", new Map(), new Map(), {}, null)).toEqual(before);
    expect(stripAnsi(before[2]!)).toContain("▸ ▸ Alpha");
  });

  test("ready icons leave a blank box for the placement; others show initials", () => {
    const sidebar = sidebarWith([guild("1", "Alpha Server"), guild("2", "Beta", null), guild("3", "Gamma")]);
    const ready = readyImage(0x73000001);
    const frame = createSidebarIconFrame((iconSource) => iconSource.key === source("1").key ? ready : null);
    const rows = renderSidebar(sidebar, [], 10, false, null, 0, new Set(), "⋯", new Map(), new Map(), {}, frame);

    expect(stripAnsi(rows[2]!)).toStartWith("▸ ▸    Alpha Server");
    expect(stripAnsi(rows[3]!)).toStartWith("  ▸ Be Beta");
    expect(stripAnsi(rows[4]!)).toStartWith("  ▸ Ga Gamma");
    expect(rows[3]).toContain(`${theme.userBg}`);
    for (const row of rows.slice(2, 5)) expect(termWidth(stripAnsi(row))).toBe(SIDEBAR_WIDTH);

    expect(frame.placements).toEqual([{ image: ready, row: 3, col: 5, highlighted: true }]);
    // Beta has no picture; Alpha and Gamma do.
    expect(frame.visible.map((iconSource) => iconSource.key)).toEqual([source("1").key, source("3").key]);
  });

  test("direct messages show avatars in place of their marker; roots get fixed initials", () => {
    const sidebar = sidebarWith([guild("1", "Alpha")]);
    setSidebarGuilds(sidebar, [{ id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null }, guild("1", "Alpha")]);
    const dm = (id: string, type: number, name: string, extra: Partial<DiscordChannel> = {}): DiscordChannel => ({
      id, guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name, topic: null, position: 0, type, nsfw: false, ...extra,
    });
    setSidebarCachedChannels(sidebar, DIRECT_MESSAGES_GUILD_ID, [
      dm("11", 1, "alice", { recipients: [{ id: "u1", username: "alice", displayName: "alice", bot: false, avatar: "ava" }], lastMessageId: "30" }),
      dm("12", 3, "the group", { icon: "grp", lastMessageId: "20" }),
      dm("13", 1, "bob", { recipients: [{ id: "u2", username: "bob", displayName: "bob", bot: false }], lastMessageId: "10" }),
    ]);
    sidebar.expandedGuildId = DIRECT_MESSAGES_GUILD_ID;
    const plain = renderSidebar(sidebar, [], 12).map(stripAnsi);
    expect(plain.some((row) => row.startsWith("  # alice"))).toBe(true);

    const frame = createSidebarIconFrame(() => null);
    const rows = renderSidebar(sidebar, [], 12, false, null, 0, new Set(), "⋯", new Map(), new Map(), {}, frame).map(stripAnsi);
    expect(rows).toContain(padTo("▸ ▾ DM Direct Messages"));
    // Avatars line up under the root's tile, names under its name.
    expect(rows.some((row) => row.startsWith("    Al alice"))).toBe(true);
    expect(rows.some((row) => row.startsWith("    TG the group"))).toBe(true);
    expect(rows.some((row) => row.startsWith("    Bo bob"))).toBe(true);
    expect(frame.visible.map((iconSource) => iconSource.key).sort()).toEqual(["bundled-direct-messages", "group-12-grp", "guild-1-hash1", "user-u1-ava"]);
  });

  test("WhatsApp and Instagram rows ask for their pictures, a few rows ahead only", () => {
    const sidebar = sidebarWith([]);
    setSidebarGuilds(sidebar, [
      { id: WHATSAPP_GUILD_ID, name: WHATSAPP_GUILD_NAME, icon: null },
      { id: INSTAGRAM_GUILD_ID, name: "Instagram", icon: null },
    ]);
    const chat = (index: number): DiscordChannel => ({
      id: whatsappChannelId(`1555000${String(index).padStart(4, "0")}@s.whatsapp.net`), guildId: WHATSAPP_GUILD_ID, parentId: null,
      name: `Chat ${index}`, topic: null, position: index, type: 1, nsfw: false, lastMessageId: String(1000 - index),
    });
    setSidebarCachedChannels(sidebar, WHATSAPP_GUILD_ID, [
      ...Array.from({ length: 30 }, (_, index) => chat(index)),
      { ...chat(99), id: whatsappChannelId("status@broadcast"), name: "Status", lastMessageId: "1" },
    ]);
    sidebar.expandedGuildId = WHATSAPP_GUILD_ID;
    const frame = createSidebarIconFrame(() => null);
    const rows = renderSidebar(sidebar, [], 10, false, null, 0, new Set(), "⋯", new Map(), new Map(), {}, frame).map(stripAnsi);
    expect(rows[2]).toStartWith("▸ ▾ WA WhatsApp");
    expect(rows[3]).toStartWith("    C0 Chat 0");
    // Eight list rows: the root's bundled logo plus seven chats on screen, three more ahead.
    expect(frame.visible).toHaveLength(8);
    expect(frame.visible[0]).toEqual(bundledSidebarIconSource("whatsapp"));
    expect(frame.visible[1]).toEqual(whatsappChatPictureSource("15550000000@s.whatsapp.net"));
    expect(frame.nearby).toHaveLength(3);
    expect(frame.nearby.every((iconSource) => iconSource.platform === "whatsapp")).toBe(true);

    setSidebarCachedChannels(sidebar, INSTAGRAM_GUILD_ID, [
      { id: "ig-1", guildId: INSTAGRAM_GUILD_ID, parentId: null, name: "ana", topic: null, position: 0, type: 1, nsfw: false,
        recipients: [{ id: "77", username: "ana", displayName: "Ana", bot: false }], pictureUrl: "https://scontent.cdninstagram.com/a.jpg" },
      { id: "ig-2", guildId: INSTAGRAM_GUILD_ID, parentId: null, name: "group", topic: null, position: 1, type: 3, nsfw: false,
        recipients: [{ id: "78", username: "bo", displayName: "Bo", bot: false }], pictureUrl: "https://scontent.cdninstagram.com/b.jpg" },
    ]);
    sidebar.expandedGuildId = INSTAGRAM_GUILD_ID;
    const igFrame = createSidebarIconFrame(() => null);
    renderSidebar(sidebar, [], 10, false, null, 0, new Set(), "⋯", new Map(), new Map(), {}, igFrame);
    // Groups keep their initials tile.
    expect(igFrame.visible.filter((iconSource) => iconSource.platform !== "bundled"))
      .toEqual([instagramUserPictureSource("77", "https://scontent.cdninstagram.com/a.jpg")!]);
  });

  test("prefetches about a screen around the viewport, nearest first", () => {
    const guilds = Array.from({ length: 40 }, (_, index) => guild(String(index + 1), `Server ${index + 1}`));
    const sidebar = sidebarWith(guilds);
    sidebar.selectedIndex = 20;
    sidebar.scrollOffset = 15;
    const frame = createSidebarIconFrame(() => null);
    renderSidebar(sidebar, [], 7, false, null, 0, new Set(), "⋯", new Map(), new Map(), {}, frame);
    const visible = frame.visible.map((iconSource) => iconSource.key);
    expect(visible).toHaveLength(5);
    const first = Number(visible[0]!.split("-")[1]);
    const last = Number(visible.at(-1)!.split("-")[1]);
    const nearby = frame.nearby.map((iconSource) => Number(iconSource.key.split("-")[1]));
    expect(nearby.slice(0, 2)).toEqual([last + 1, first - 1]);
    expect(nearby).toHaveLength(10);
  });
});

describe("rendering sidebar icons", () => {
  afterEach(() => {
    sidebarIcons.setEnabled(false);
    disposeInlineTerminalImages(sidebarIconTerminalOwner, () => {});
  });

  function capture(state: ReturnType<typeof createInitialState>): string {
    let output = "";
    const originalWrite = process.stdout.write;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      render(state);
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
    }
    return output;
  }

  async function iconState(count = 3) {
    const { urls, fetch } = recordingFetch();
    sidebarIcons.configure({ fetch, cacheDir: null, onUpdate: () => {} });
    sidebarIcons.setEnabled(true);
    const state = createInitialState(null, "/tmp/record-config.json");
    state.rows = 12;
    state.cols = 80;
    state.sidebar.open = true;
    state.sidebar.arrows = "show";
    setSidebarGuilds(state.sidebar, Array.from({ length: count }, (_, index) => guild(`9${index}`, `Server ${index}`)));
    capture(state);
    await sidebarIcons.idle();
    return { state, urls };
  }

  function sidebarPlacements(output: string): string[] {
    return [...output.matchAll(/\x1b\[(\d+);(\d+)H\x1b_Ga=p,i=(\d+),p=(\d+),c=2,r=1,C=1/g)]
      .filter((match) => Number(match[3]) >= 0x73000000)
      .map((match) => `${match[1]},${match[2]}:${match[4]}`);
  }

  function transmissions(output: string): number {
    return [...output.matchAll(/\x1b_Ga=t,t=d,f=100,i=(\d+)/g)].filter((match) => Number(match[1]) >= 0x73000000).length;
  }

  test("places icons once and does not resend them when nothing changed", async () => {
    const { state, urls } = await iconState();
    expect(urls).toHaveLength(3);
    const first = capture(state);
    expect(transmissions(first)).toBe(3);
    expect(sidebarPlacements(first)).toEqual(["3,5:2", "4,5:1", "5,5:1"]);

    const screen = new VtScreen(state.rows, state.cols);
    screen.write(first);
    expect(screen.text()[2]!.slice(0, 14)).toBe("▸ ▸    Server ");

    const idle = capture(state);
    expect(transmissions(idle)).toBe(0);
    expect(sidebarPlacements(idle)).toEqual([]);
  });

  test("a row turning active or inactive keeps its icon shown (st hides an image whose cells change)", async () => {
    const { state } = await iconState();
    const screen = new VtScreen(state.rows, state.cols);
    invalidateFrame(state);
    screen.write(capture(state));
    const icons = () => screen.placements().filter((placement) => placement.imageId >= 0x73000000).length;
    const hidden = () => screen.occlusions().filter((placement) => placement.imageId >= 0x73000000);
    expect(icons()).toBe(3);
    // The cursor stays on the first server while the open server changes.
    for (const active of ["91", "92", "91", null]) {
      state.sidebar.activeGuildId = active;
      screen.write(capture(state));
      expect(icons()).toBe(3);
      expect(hidden()).toEqual([]);
    }
  });

  test("moving the selection re-places only the two rows involved", async () => {
    const { state } = await iconState();
    capture(state);
    moveSidebarSelection(state.sidebar, [], 1);
    const moved = capture(state);
    expect(transmissions(moved)).toBe(0);
    expect(sidebarPlacements(moved).sort()).toEqual(["3,5:1", "4,5:2"]);
  });

  test("closing and reopening the sidebar re-places without retransmitting", async () => {
    const { state } = await iconState();
    capture(state);
    state.sidebar.open = false;
    const closed = capture(state);
    expect(closed).toMatch(/\x1b_Ga=d,d=i,i=\d+,p=2/);
    state.sidebar.open = true;
    const reopened = capture(state);
    expect(transmissions(reopened)).toBe(0);
    expect(sidebarPlacements(reopened)).toHaveLength(3);
  });

  test("a full repaint (resize, invalidation) places every icon again", async () => {
    const { state } = await iconState();
    capture(state);
    invalidateFrame(state);
    const repainted = capture(state);
    expect(transmissions(repainted)).toBe(0);
    expect(sidebarPlacements(repainted)).toHaveLength(3);
  });

  test("smooth scrolling beside the sidebar puts icons the region scroll moved back in place", async () => {
    const { state } = await iconState(30);
    let now = 1000;
    const smooth = new SmoothScroller(100, () => now, 30);
    setSmoothScroller(state, smooth);
    state.rows = 24;
    setTimelineMessages(state.timeline, "channel-1", Array.from({ length: 60 }, (_, i) => ({
      id: String(100 + i), channelId: "channel-1", type: 0, timestamp: Date.UTC(2026, 0, 1) + i * 60_000, editedTimestamp: null,
      content: `line ${i}`, mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [],
      author: { id: "u", username: "u", displayName: "U", bot: false }, reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
    })));
    invalidateFrame(state);
    const screen = new VtScreen(state.rows, state.cols);
    screen.write(capture(state));
    const iconsAtRest = screen.placements().filter((placement) => placement.imageId >= 0x73000000);
    expect(iconsAtRest.length).toBeGreaterThan(5);

    markScrollIntent(state);
    state.timeline.scrollOffset -= 3;
    let scrolls = 0;
    for (let i = 0; i < 60; i++) {
      const out = capture(state);
      if (/\x1b\[\d+;\d+r\x1b\[\d+T/.test(out)) scrolls++;
      screen.write(out);
      // After every row of the glide the icons sit where they were.
      expect(screen.placements().filter((placement) => placement.imageId >= 0x73000000)).toEqual(iconsAtRest);
      if (!smooth.busy()) break;
      now += Math.max(1, smooth.nextWakeMs());
    }
    expect(scrolls).toBeGreaterThan(0);
    setSmoothScroller(state, null);
  });

  test("with synchronized updates confirmed, icons the region scroll moved are placed back", async () => {
    const { state } = await iconState(30);
    state.synchronizedUpdates = true;
    state.rows = 24;
    setTimelineMessages(state.timeline, "channel-1", Array.from({ length: 60 }, (_, i) => ({
      id: String(100 + i), channelId: "channel-1", type: 0, timestamp: Date.UTC(2026, 0, 1) + i * 60_000, editedTimestamp: null,
      content: `line ${i}`, mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [],
      author: { id: "u", username: "u", displayName: "U", bot: false }, reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
    })));
    invalidateFrame(state);
    const screen = new VtScreen(state.rows, state.cols);
    screen.write(capture(state));
    const iconsAtRest = screen.placements().filter((placement) => placement.imageId >= 0x73000000);
    expect(iconsAtRest.length).toBeGreaterThan(5);
    let scrolls = 0;
    for (const step of [-2, -3, 1, -1]) {
      state.timeline.scrollOffset += step;
      const out = capture(state);
      if (/\x1b\[\d+;\d+r\x1b\[\d+[ST]/.test(out)) scrolls++;
      screen.write(out);
      expect(screen.placements().filter((placement) => placement.imageId >= 0x73000000)).toEqual(iconsAtRest);
    }
    expect(scrolls).toBe(4);
  });

  test("scrolling the sidebar moves placements with their rows", async () => {
    const { state } = await iconState(30);
    capture(state);
    moveSidebarSelection(state.sidebar, [], 20);
    const scrolled = capture(state);
    const placements = sidebarPlacements(scrolled);
    expect(placements.length).toBeGreaterThan(0);
    for (const placement of placements) {
      const row = Number(placement.split(",")[0]);
      expect(row).toBeGreaterThanOrEqual(3);
      expect(row).toBeLessThanOrEqual(state.rows);
    }
  });

  test("the image viewer hides icons it covers and they return when it closes", async () => {
    const { state } = await iconState();
    state.cols = 30;
    state.rows = 12;
    capture(state);
    state.imageModal = openImageModalState(
      { filename: "x.png", width: 4000, height: 100 },
      { ...readyImage(0x10), pixelWidth: 4000, pixelHeight: 100 },
    );
    // The viewer spans rows 4-8 from column 3: the two icons under it go,
    // the selected one on row 3 stays.
    const open = capture(state);
    expect([...open.matchAll(/\x1b_Ga=d,d=i,i=(\d+),p=(\d+)/g)].map((match) => match[2])).toEqual(["1", "1"]);
    state.imageModal = null;
    const closed = capture(state);
    expect(sidebarPlacements(closed)).toEqual(["4,5:1", "5,5:1"]);
    expect(transmissions(closed)).toBe(0);
  });
});
