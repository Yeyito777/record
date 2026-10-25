import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { invalidateFrame } from "./frame";
import { openImageModalState } from "./imagemodal";
import type { InlineChatImageReady } from "./inlineimage";
import { render } from "./render";
import {
  createSidebarIconFrame,
  createSidebarState,
  moveSidebarSelection,
  renderSidebar,
  setSidebarGuilds,
  SIDEBAR_WIDTH,
} from "./sidebar";
import {
  discordGuildIconSource,
  SidebarIconStore,
  sidebarIconInitials,
  sidebarIconTerminalOwner,
  sidebarIcons,
  type SidebarIconSource,
} from "./sidebaricons";
import { createInitialState } from "./state";
import { disposeInlineTerminalImages } from "./terminalimage";
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
      key: "guild-123-a_abc",
      owner: "guild-123-",
      url: "https://cdn.discordapp.com/icons/123/a_abc.png?size=64",
    });
    expect(discordGuildIconSource({ id: "123", icon: null })).toBeNull();
    // Ids and hashes become file names; anything unexpected is not fetched.
    expect(discordGuildIconSource({ id: "../x", icon: "abc" })).toBeNull();
    expect(discordGuildIconSource({ id: "1", icon: "a/b" })).toBeNull();
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
    const store = new SidebarIconStore({ fetch, cacheDir: null, concurrency: 1, onUpdate: () => updates++ });
    store.setEnabled(true);
    store.want([source("1"), source("2")], [source("3")]);
    store.want([source("1"), source("2")], [source("3")]);
    await store.idle();
    expect(urls).toEqual([source("1").url, source("2").url, source("3").url]);
    expect(store.get(source("1"))?.pixelWidth).toBe(1);
    expect(store.get(source("3"))).not.toBeNull();
    // Only icons drawn on screen ask for a repaint.
    expect(updates).toBe(2);
  });

  test("never fetches rows that scrolled away before their turn", async () => {
    const { urls, fetch } = recordingFetch();
    const store = new SidebarIconStore({ fetch, cacheDir: null, concurrency: 1 });
    store.setEnabled(true);
    store.want([source("1")], [source("2"), source("3")]);
    store.want([source("9")], []);
    await store.idle();
    expect(urls).toEqual([source("1").url, source("9").url]);
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

  test("rejects non-PNG and failed responses, then retries only after a pause", async () => {
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const { urls, fetch } = recordingFetch((url) => url.includes("/1/")
        ? new Response("<html>", { status: 200 })
        : new Response("", { status: 404 }));
      const store = new SidebarIconStore({ fetch, cacheDir: null });
      store.setEnabled(true);
      store.want([source("1"), source("2")]);
      await store.idle();
      expect(store.get(source("1"))).toBeNull();
      expect(store.get(source("2"))).toBeNull();
      store.want([source("1"), source("2")]);
      await store.idle();
      expect(urls).toHaveLength(2);
      now += 60_000;
      store.want([source("1")]);
      await store.idle();
      expect(urls).toHaveLength(3);
    } finally {
      Date.now = realNow;
    }
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

describe("sidebar rows with icons", () => {
  function sidebarWith(guilds: ReturnType<typeof guild>[]) {
    const sidebar = createSidebarState();
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
