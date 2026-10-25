import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { customEmojiImages, customEmojiMarker } from "./customemoji";
import { invalidateFrame, retainedFrameRows } from "./frame";
import { render } from "./render";
import { MEMBER_LIST_WIDTH, setMemberListMembers } from "./memberlist";
import { setSidebarGuilds } from "./sidebar";
import { SmoothScroller, markRelayout, markScrollIntent, setSmoothScroller, smoothScrollerFor } from "./smoothscroll";
import { createInitialState, focusHistory, type AppState } from "./state";
import { scrollHistoryWithCursor } from "./historycursor";
import { appendTimelineMessage, prependTimelineMessages, setTimelineInlineImageState, setTimelineMessages } from "./timeline";
import { disposeInlineTerminalImages } from "./terminalimage";
import { recordTypingStart } from "./typing";
import type { DiscordMessage } from "./discord";
import { VtScreen } from "./vtscreen.testutil";

// App-driven smooth scrolling (st mode 2032) of the message pane: only scroll
// intent and messages arriving at a followed bottom glide; every frame is a
// region scroll plus exposed rows (and side-panel segments) with the motion in
// the same synchronized update; at rest the screen is a full repaint's.

let now = 0;
let screen: VtScreen;

function message(index: number, channelId = "channel-1"): DiscordMessage {
  const author = Math.floor(index / 3) % 2 === 0
    ? { id: "user-1", username: "ada", displayName: "Ada", bot: false }
    : { id: "user-2", username: "brook", displayName: "Brook", bot: false };
  return {
    id: String(1000 + index),
    channelId,
    type: 0,
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0) + index * 60_000,
    editedTimestamp: null,
    content: `m${String(index).padStart(3, "0")} ${"words that wrap ".repeat(index % 4 === 0 ? 7 : 1)}`.trim(),
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    author,
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
  };
}

function capture(state: AppState): string {
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

function chatState(options: { sidebar?: boolean; members?: boolean; messages?: number; smooth?: boolean } = {}): AppState {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.cols = 120;
  state.rows = 30;
  setSidebarGuilds(state.sidebar, Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, name: `Guild ${i}`, icon: null })));
  state.sidebar.open = options.sidebar ?? false;
  if (options.members) {
    state.memberList.open = true;
    setMemberListMembers(state.memberList, "g0", "channel-1", Array.from({ length: 40 }, (_, i) => ({
      id: `member-${i}`, username: `member${i}`, displayName: `Member ${i}`, bot: false,
    })));
  }
  setTimelineMessages(state.timeline, "channel-1", Array.from({ length: options.messages ?? 60 }, (_, i) => message(i)));
  if (options.smooth !== false) setSmoothScroller(state, new SmoothScroller(100, () => now, 30));
  screen = new VtScreen(state.rows, state.cols);
  return state;
}

/** Render and feed the screen. */
function frame(state: AppState): string {
  const out = capture(state);
  screen.write(out);
  return out;
}

/** Renders like main.ts until the glide rests: each row when due, then one frame at rest. */
function animate(state: AppState): string[] {
  const smooth = smoothScrollerFor(state)!;
  const outs: string[] = [];
  let wasBusy = false;
  for (let i = 0; i < 400; i++) {
    if (!smooth.busy()) {
      if (wasBusy) outs.push(frame(state));
      break;
    }
    wasBusy = true;
    now += Math.max(1, smooth.nextWakeMs());
    if (smooth.needsLayout()) outs.push(frame(state));
  }
  return outs;
}

function settle(state: AppState): void {
  frame(state);
  now += 500;
  animate(state);
  frame(state);
}

/** The screen a fresh full repaint of the current state draws (text and placements). */
function fullRepaint(state: AppState): VtScreen {
  invalidateFrame(state);
  // Forget what was placed so the reference places every image again.
  disposeInlineTerminalImages(state, () => {});
  const reference = new VtScreen(state.rows, state.cols);
  reference.write(capture(state));
  return reference;
}

/** The last frame's rows painted from scratch. */
function retainedScreen(state: AppState): string {
  const reference = new VtScreen(state.rows, state.cols);
  reference.write(retainedFrameRows(state)!.join(""));
  return reference.snapshot();
}

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const regionScrolls = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)r\x1b\[(\d+)([ST])\x1b\[r/g)]
  .map((match) => ({ top: Number(match[1]), bottom: Number(match[2]), rows: Number(match[3]), dir: match[4] }));
/** Eased moves (OSC 2032 ; m ; dA ; B ; D with B != 0): glides. */
const glides = (out: string) => [...out.matchAll(/\x1b\]2032;m;(-?\d+);(-?\d+);\d+\x1b\\/g)]
  .filter((match) => match[2] !== "0").map((match) => Number(match[2]));
const resets = (out: string) => [...out.matchAll(/\x1b\]2032;o;(-?\d+)\x1b\\/g)].map((match) => Number(match[1]));
const rects = (out: string) => {
  const match = /\x1b\]2032;r((?:;\d+,\d+,\d+,\d+)*)\x1b\\/.exec(out);
  return match ? match[1]!.slice(1).split(";").filter(Boolean).map((rect) => rect.split(",").map(Number)) : null;
};

beforeEach(() => { now = 1000; });
afterEach(() => { now = 0; });

describe("smooth scrolling the message pane", () => {
  for (const [sidebar, members] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const label = `sidebar ${sidebar ? "open" : "closed"}, member list ${members ? "open" : "closed"}`;

    test(`a scroll is one eased move and one synchronized region scroll; st glides the rest (${label})`, () => {
      const state = chatState({ sidebar, members });
      settle(state);
      state.timeline.scrollOffset = state.timeline.maxScroll - 20;
      settle(state);

      markScrollIntent(state);
      state.timeline.scrollOffset -= 3;
      const outs = [frame(state), ...animate(state)];
      const all = outs.join("");
      const crossings = outs.filter((out) => regionScrolls(out).length > 0);
      // The input's own frame lays the history out at the target; the only
      // other frame is the one at rest (nothing to redraw here).
      expect(crossings).toHaveLength(1);
      expect(outs.length).toBeLessThanOrEqual(2);
      for (const out of crossings) {
        expect(out.startsWith(SYNC_BEGIN)).toBe(true);
        expect(out.endsWith(SYNC_END)).toBe(true);
        // The move rides in the same synchronized update as the scroll.
        expect(out.indexOf("\x1b]2032;m;")).toBeGreaterThan(out.indexOf("\x1b[r"));
        expect(out.indexOf("\x1b]2032;m;")).toBeLessThan(out.indexOf(SYNC_END));
        // Only the exposed rows are drawn whole; beside the others only the side panels repaint.
        expect(out.match(/\x1b\[2K/g)?.length ?? 0).toBeLessThanOrEqual(regionScrolls(out)[0]!.rows);
      }
      expect(regionScrolls(all).every((scroll) => scroll.dir === "T")).toBe(true);
      expect(regionScrolls(all).reduce((sum, scroll) => sum + scroll.rows, 0)).toBe(3);
      expect(glides(all)).toEqual([-3000]);
      expect(resets(all)).toEqual([]);
      expect(smoothScrollerFor(state)!.busy()).toBe(false);
      expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
    });

    test(`the moving rectangle is the pane's columns of the band (${label})`, () => {
      const state = chatState({ sidebar, members });
      const out = frame(state);
      const mainCol = sidebar ? 29 : 1;
      const mainRight = members ? state.cols - MEMBER_LIST_WIDTH : state.cols;
      const [rect] = rects(out)!;
      expect(rect![0]).toBe(3);
      expect(rect![1]).toBe(mainCol);
      expect(rect![3]).toBe(mainRight);
      expect(rects(out)).toHaveLength(1);
    });
  }

  test("scrolling towards newer history glides with SU", () => {
    const state = chatState({ sidebar: true, members: true });
    settle(state);
    state.timeline.scrollOffset = state.timeline.maxScroll - 20;
    settle(state);
    markScrollIntent(state);
    state.timeline.scrollOffset += 4;
    const all = [frame(state), ...animate(state)].join("");
    expect(regionScrolls(all).every((scroll) => scroll.dir === "S")).toBe(true);
    expect(regionScrolls(all).reduce((sum, scroll) => sum + scroll.rows, 0)).toBe(4);
    expect(glides(all)).toEqual([4000]);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  test("the band and rectangle stop above the autocomplete popup", () => {
    const state = chatState({ sidebar: true });
    settle(state);
    state.timeline.scrollOffset = state.timeline.maxScroll - 20;
    settle(state);
    state.autocomplete = {
      type: "command",
      selection: 0,
      prefix: "/",
      matches: Array.from({ length: 5 }, (_, i) => ({ name: `/cmd${i}`, desc: `command ${i}` })),
    };
    const opened = frame(state);
    const [rect] = rects(opened)!;
    const popupTop = screen.text().findIndex((row) => row.includes("/cmd0")) + 1;
    expect(popupTop).toBeGreaterThan(3);
    expect(rect![2]).toBe(popupTop - 1);
    markScrollIntent(state);
    state.timeline.scrollOffset -= 2;
    const all = [frame(state), ...animate(state)].join("");
    for (const scroll of regionScrolls(all)) expect(scroll.bottom).toBe(rect![2]);
    expect(regionScrolls(all).reduce((sum, scroll) => sum + scroll.rows, 0)).toBe(2);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  test("a message arriving while following the bottom glides in from where the history was", () => {
    const state = chatState({ sidebar: true, members: true });
    settle(state);
    appendTimelineMessage(state.timeline, message(60));
    state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
    const out = frame(state);
    const [scroll] = regionScrolls(out);
    expect(scroll?.dir).toBe("S");
    expect(glides(out)).toEqual([scroll!.rows * 1000]);
    animate(state);
    expect(screen.text().join("\n")).toContain("m060");
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  test("the typing line coming and going while following glides the pane by its row", () => {
    const state = chatState({ sidebar: true });
    settle(state);
    recordTypingStart(state.typing, "channel-1", { id: "user-9", displayName: "Cy" }, Date.now());
    const appeared = frame(state);
    expect(regionScrolls(appeared)).toHaveLength(1);
    expect(glides(appeared)).toEqual([1000]);
    animate(state);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());

    state.typing.byChannelId = {};
    const gone = frame(state);
    expect(glides(gone)).toEqual([-1000]);
    animate(state);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  test("older history arriving mid-glide keeps the glide going (no repaint, no restart)", () => {
    const state = chatState({ sidebar: true, members: true });
    settle(state);
    state.timeline.scrollOffset = 12;
    settle(state);
    markScrollIntent(state);
    state.timeline.scrollOffset -= 3;
    const outs = [frame(state)];
    now += 20;
    const older = Array.from({ length: 15 }, (_, i) => message(i, "channel-1")).map((entry, i) => ({ ...entry, id: String(500 + i), timestamp: entry.timestamp - 86_400_000 }));
    prependTimelineMessages(state.timeline, older, 118, { hasOlder: true });
    outs.push(...animate(state));
    const all = outs.join("");
    expect(resets(all)).toEqual([]);
    expect(glides(all)).toEqual([-3000]);
    expect(regionScrolls(all).reduce((sum, scroll) => sum + scroll.rows, 0)).toBe(3);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  test("a jump further than a screen (gg) glides in from one screen away", () => {
    const state = chatState({ sidebar: true, messages: 120 });
    settle(state);
    markScrollIntent(state);
    state.timeline.scrollOffset = 0;
    const first = frame(state);
    expect(resets(first)).toHaveLength(1);
    expect(glides(first)).toHaveLength(1);
    animate(state);
    expect(state.timeline.scrollOffset).toBe(0);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  test("history-cursor motions that scroll glide", () => {
    const state = chatState({ sidebar: true });
    settle(state);
    focusHistory(state);
    settle(state);
    state.historyCursor = { row: state.timeline.scrollOffset, col: 0 };
    settle(state);
    // k at the top edge of the view: the cursor motion scrolls one row.
    const { scrollHistoryWithCursor } = require("./historycursor") as typeof import("./historycursor");
    scrollHistoryWithCursor(state, 1, 1, 25);
    const all = [frame(state), ...animate(state)].join("");
    expect(glides(all)).toHaveLength(1);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });
});

describe("only scrolling glides", () => {
  for (const where of ["at the bottom", "scrolled up"] as const) {
    const scrolledUp = where === "scrolled up";

    function setUp(): AppState {
      const state = chatState({ sidebar: true, members: true });
      settle(state);
      if (scrolledUp) {
        state.timeline.scrollOffset = state.timeline.maxScroll - 15;
        settle(state);
      }
      return state;
    }

    test(`a send snaps, ${where}`, () => {
      const state = setUp();
      markRelayout(state);
      const own = { ...message(61), author: { id: "me", username: "me", displayName: "Me", bot: false }, localStatus: "pending" as const };
      appendTimelineMessage(state.timeline, own);
      state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      const all = [frame(state), ...animate(state)].join("");
      expect(glides(all)).toEqual([]);
      expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
    });

    test(`switching channels snaps, ${where}`, () => {
      const state = setUp();
      setTimelineMessages(state.timeline, "channel-2", Array.from({ length: 50 }, (_, i) => message(i + 5, "channel-2")));
      const all = [frame(state), ...animate(state)].join("");
      expect(glides(all)).toEqual([]);
    });

    test(`the sidebar and member list toggling snap, ${where}`, () => {
      const state = setUp();
      state.sidebar.open = false;
      expect(glides([frame(state), ...animate(state)].join(""))).toEqual([]);
      state.memberList.open = false;
      expect(glides([frame(state), ...animate(state)].join(""))).toEqual([]);
      state.sidebar.open = true;
      expect(glides([frame(state), ...animate(state)].join(""))).toEqual([]);
      expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
    });

    test(`a resize snaps, ${where}`, () => {
      const state = setUp();
      state.cols = 100;
      state.rows = 26;
      invalidateFrame(state);
      smoothScrollerFor(state)!.terminalReset();
      markRelayout(state);
      screen = new VtScreen(state.rows, state.cols);
      const all = [frame(state), ...animate(state)].join("");
      expect(glides(all)).toEqual([]);
      // st dropped its rectangles with the resize: they are sent again.
      expect(rects(all)).not.toBeNull();
    });

    test(`a key that re-lays out the bottom (an own reaction, a toggle) snaps, ${where}`, () => {
      const state = setUp();
      markRelayout(state);
      const last = state.timeline.messages.at(-1)!;
      const reacted = { ...last, reactions: [{ emoji: { id: null, name: "👍" }, count: 1, me: true }] } as DiscordMessage;
      setTimelineMessages(state.timeline, "channel-1", [...state.timeline.messages.slice(0, -1), reacted], { preserveScroll: true });
      if (!scrolledUp) state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      expect(glides([frame(state), ...animate(state)].join(""))).toEqual([]);
    });
  }

  test("a message arriving below a scrolled-up view moves nothing", () => {
    const state = chatState({ sidebar: true });
    settle(state);
    state.timeline.scrollOffset = state.timeline.maxScroll - 15;
    settle(state);
    const before = screen.snapshot();
    appendTimelineMessage(state.timeline, message(60));
    const all = [frame(state), ...animate(state)].join("");
    expect(glides(all)).toEqual([]);
    expect(regionScrolls(all)).toEqual([]);
    expect(screen.snapshot()).toBe(before);
  });

  test("scrolling while a message arrives below glides only the scroll", () => {
    const state = chatState({ sidebar: true });
    settle(state);
    state.timeline.scrollOffset = state.timeline.maxScroll - 15;
    settle(state);
    appendTimelineMessage(state.timeline, message(60));
    appendTimelineMessage(state.timeline, message(61));
    markScrollIntent(state);
    state.timeline.scrollOffset -= 2;
    const all = [frame(state), ...animate(state)].join("");
    expect(glides(all)).toEqual([-2000]);
    expect(regionScrolls(all).reduce((sum, scroll) => sum + scroll.rows, 0)).toBe(2);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });
});

describe("inline images while gliding", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";

  function imageState(): AppState {
    const state = chatState({ sidebar: true });
    const messages = state.timeline.messages.map((entry) => ({ ...entry }));
    messages[40] = {
      ...messages[40]!,
      attachments: [{ id: "a1", filename: "cat.png", contentType: "image/png", size: 68, url: "https://cdn.example/cat.png" }],
    };
    setTimelineMessages(state.timeline, "channel-1", messages);
    setTimelineInlineImageState(state.timeline, {
      phase: "ready",
      attachmentId: "a1",
      filename: "cat.png",
      sourceUrl: "https://cdn.example/cat.png",
      requestId: 1,
      imageId: 0x40000001,
      pngBase64: PNG,
      pixelWidth: 40,
      pixelHeight: 80,
    });
    return state;
  }

  const placement = (out: string) => /\x1b_Ga=p,i=1073741825,p=\d+,c=\d+,r=(\d+)(?:,y=(\d+),h=(\d+))?/.exec(out);

  test("an image cut off by the pane's bottom is placed whole while gliding and cropped again at rest", () => {
    const state = imageState();
    settle(state);
    // Find a view where the image straddles the pane's bottom edge.
    let cut: RegExpExecArray | null = null;
    for (let offset = state.timeline.maxScroll; offset >= 0 && !cut; offset--) {
      state.timeline.scrollOffset = offset;
      const out = frame(state);
      const placed = placement(out);
      if (placed?.[3] && Number(placed[2] ?? 0) === 0) cut = placed;
      now += 500;
    }
    expect(cut).not.toBeNull();
    settle(state);

    markScrollIntent(state);
    state.timeline.scrollOffset -= 1;
    const outs = [frame(state), ...animate(state)];
    const during = outs.slice(0, -1).map(placement).filter(Boolean);
    expect(during.length).toBeGreaterThan(0);
    // While gliding: no bottom crop (the whole image past the edge).
    for (const placed of during) expect(placed![3]).toBeUndefined();
    // The frame at rest crops it to the pane again.
    const rest = placement(outs.at(-1)!);
    expect(rest?.[3]).toBeDefined();
    expect(screen.placements()).toEqual(fullRepaint(state).placements());
  });

  test("after scrolls past images their placements equal a full repaint's", () => {
    const state = imageState();
    settle(state);
    state.timeline.scrollOffset = state.timeline.maxScroll - 4;
    settle(state);
    for (const step of [-2, -3, -1, -4, 2, 3, -5, 1]) {
      markScrollIntent(state);
      state.timeline.scrollOffset += step;
      frame(state);
      now += 30;
      animate(state);
      expect(screen.placements()).toEqual(fullRepaint(state).placements());
      expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
    }
  });
});

describe("terminals without mode 2032", () => {
  test("nothing changes: no mode 2032 sequences, and beside the sidebar the pane repaints as before", () => {
    const state = chatState({ sidebar: true, smooth: false });
    const out = frame(state);
    expect(out).not.toContain("\x1b]2032");
    state.timeline.scrollOffset = state.timeline.maxScroll - 3;
    const step = frame(state);
    expect(step).not.toContain("\x1b]2032");
    expect(regionScrolls(step)).toEqual([]);
  });

  test("scrollRegions off ignores an attached scroller", () => {
    const state = chatState({ sidebar: false });
    state.scrollRegions = false;
    const out = frame(state);
    expect(out).not.toContain("\x1b]2032");
    markScrollIntent(state);
    state.timeline.scrollOffset = state.timeline.maxScroll - 3;
    expect(frame(state)).not.toContain("\x1b]2032");
  });
});

describe("any sequence of glides, arrivals and history pages", () => {
  test("every frame leaves the screen as its rows painted from scratch, and rests on a full repaint", () => {
    const state = chatState({ sidebar: true, members: true, messages: 80 });
    settle(state);
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let next = 80;
    let older = 0;
    let crossings = 0;
    for (let step = 0; step < 160; step++) {
      const roll = random();
      if (roll < 0.55) {
        markScrollIntent(state);
        const delta = Math.floor(random() * 9) - 4;
        state.timeline.scrollOffset = Math.max(0, Math.min(state.timeline.maxScroll, state.timeline.scrollOffset + (delta || 1)));
      } else if (roll < 0.7) {
        appendTimelineMessage(state.timeline, message(next++));
        if (random() < 0.5) state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
      } else if (roll < 0.8) {
        const page = Array.from({ length: 6 }, (_, i) => ({ ...message(i), id: String(100 + older * 10 + i), timestamp: Date.UTC(2025, 0, 1) + (older * 10 + i) * 60_000 }));
        older++;
        prependTimelineMessages(state.timeline, page, 88, { hasOlder: true });
      } else if (roll < 0.85) {
        recordTypingStart(state.typing, "channel-1", { id: "user-9", displayName: "Cy" }, Date.now());
      } else if (roll < 0.9) {
        state.typing.byChannelId = {};
      }
      const out = frame(state);
      if (regionScrolls(out).length > 0) crossings++;
      expect(screen.snapshot()).toBe(retainedScreen(state));
      // Part of the glide, sometimes interrupted by the next input.
      const smooth = smoothScrollerFor(state)!;
      const until = now + Math.floor(random() * 120);
      while (smooth.busy() && now < until) {
        now += Math.max(1, smooth.nextWakeMs());
        if (!smooth.needsLayout()) continue;
        const row = frame(state);
        if (regionScrolls(row).length > 0) crossings++;
        expect(screen.snapshot()).toBe(retainedScreen(state));
      }
    }
    animate(state);
    expect(crossings).toBeGreaterThan(50);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });
});

describe("images on rows rewritten in place (st hides an image whose cells change under it)", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
  const KE = { id: "990001", name: "KE", animated: false };
  const NC = { id: "990002", name: "NC", animated: false };
  const isEmoji = (imageId: number) => imageId >= 0x72000000 && imageId < 0x73000000;
  const visibleEmoji = () => screen.visiblePlacements().filter((placement) => isEmoji(placement.imageId)).length;
  const placedEmoji = () => screen.placements().filter((placement) => isEmoji(placement.imageId)).length;

  beforeAll(async () => {
    customEmojiImages.configure({
      fetch: (async (_url: string | URL | Request) => new Response(Buffer.from(PNG, "base64"))) as typeof fetch,
      onUpdate: () => {},
    });
    customEmojiImages.setEnabled(true);
  });
  afterAll(() => customEmojiImages.setEnabled(false));

  async function emojiState(): Promise<AppState> {
    // A fresh terminal: forget what earlier tests placed.
    customEmojiImages.setEnabled(false);
    customEmojiImages.setEnabled(true);
    const state = chatState({ sidebar: true, messages: 40 });
    const messages = state.timeline.messages.map((entry) => ({ ...entry }));
    const ke = customEmojiMarker(KE);
    messages[30] = { ...messages[30]!, content: `<:KE:${KE.id}> <:KE:${KE.id}> <:KE:${KE.id}>` };
    messages[34] = { ...messages[34]!, content: `that's so <:NC:${NC.id}>` };
    messages[36] = { ...messages[36]!, reactions: [{ emoji: { id: KE.id, name: "KE", animated: false }, count: 1, me: false }] } as DiscordMessage;
    void ke;
    setTimelineMessages(state.timeline, "channel-1", messages);
    frame(state);
    await new Promise((resolve) => setTimeout(resolve, 30));
    settle(state);
    focusHistory(state);
    settle(state);
    return state;
  }

  /** Puts the history cursor on `row` (a history line) and renders. */
  function cursorTo(state: AppState, row: number): void {
    state.historyCursor = { row, col: 0 };
    frame(state);
  }

  const lineWith = (state: AppState, text: string) => state.historyLines.findIndex((line) => line.includes(text));

  test("the cursor line moving onto and off emoji rows keeps every emoji shown", async () => {
    const state = await emojiState();
    const total = placedEmoji();
    expect(total).toBeGreaterThanOrEqual(5);
    expect(visibleEmoji()).toBe(total);
    const ke = customEmojiMarker(KE);
    const kRow = state.historyLines.findIndex((line) => line.split(ke).length === 4);
    const ncRow = lineWith(state, "that's so");
    const reactionRow = state.historyLines.findIndex((line) => line.includes("╰─"));
    expect(Math.min(kRow, ncRow, reactionRow)).toBeGreaterThanOrEqual(0);
    for (const row of [kRow + 1, kRow, kRow - 1, ncRow, ncRow + 1, reactionRow, reactionRow - 1]) {
      cursorTo(state, row);
      expect(visibleEmoji()).toBe(placedEmoji());
      expect(placedEmoji()).toBe(total);
    }
  });

  test("visual-mode selection and a pending delete over emoji rows keep them shown", async () => {
    const state = await emojiState();
    const total = placedEmoji();
    const ncRow = lineWith(state, "that's so");
    cursorTo(state, ncRow);
    state.editor.mode = "visual-line";
    state.historyVisualAnchor = { row: ncRow - 6, col: 0 };
    frame(state);
    expect(visibleEmoji()).toBe(total);
    state.editor.mode = "normal";
    frame(state);
    expect(visibleEmoji()).toBe(total);
    const bound = state.historyMessageBounds.find((entry) => ncRow >= entry.start && ncRow < entry.end)!;
    state.messageDeletePending = { messageId: bound.messageId, channelId: "channel-1" } as AppState["messageDeletePending"];
    frame(state);
    expect(visibleEmoji()).toBe(total);
    state.messageDeletePending = null;
    frame(state);
    expect(visibleEmoji()).toBe(total);
  });

  test("a reaction count changing on a reactions row keeps its emoji shown", async () => {
    const state = await emojiState();
    const total = placedEmoji();
    const reactionRow = state.historyLines.findIndex((line) => line.includes("╰─"));
    cursorTo(state, reactionRow);
    const messages = state.timeline.messages.map((entry) => ({ ...entry }));
    messages[36] = { ...messages[36]!, reactions: [{ emoji: { id: KE.id, name: "KE", animated: false }, count: 2, me: true }] } as DiscordMessage;
    setTimelineMessages(state.timeline, "channel-1", messages, { preserveScroll: true });
    frame(state);
    now += 300;
    animate(state);
    expect(placedEmoji()).toBe(total);
    expect(visibleEmoji()).toBe(total);
  });

  test("an emoji row that scrolls and is rewritten in the same frame keeps its emoji shown", async () => {
    const state = await emojiState();
    const ncRow = lineWith(state, "that's so");
    cursorTo(state, ncRow);
    // One frame: the view scrolls a row (cursor motion at the edge) and the cursor line moves.
    const before = state.timeline.scrollOffset;
    state.historyCursor = { row: before, col: 0 };
    frame(state);
    scrollHistoryWithCursor(state, 1, 2, 25);
    const out = frame(state);
    expect(regionScrolls(out).length).toBe(1);
    now += 300;
    animate(state);
    expect(visibleEmoji()).toBe(placedEmoji());
    cursorTo(state, lineWith(state, "that's so"));
    expect(visibleEmoji()).toBe(placedEmoji());
  });

  test("an inline image row the cursor moves onto keeps its image shown", () => {
    const state = chatState({ sidebar: true });
    const messages = state.timeline.messages.map((entry) => ({ ...entry }));
    messages[55] = {
      ...messages[55]!,
      attachments: [{ id: "a1", filename: "cat.png", contentType: "image/png", size: 68, url: "https://cdn.example/cat.png" }],
    };
    setTimelineMessages(state.timeline, "channel-1", messages);
    setTimelineInlineImageState(state.timeline, {
      phase: "ready", attachmentId: "a1", filename: "cat.png", sourceUrl: "https://cdn.example/cat.png",
      requestId: 1, imageId: 0x40000001, pngBase64: PNG, pixelWidth: 40, pixelHeight: 80,
    });
    settle(state);
    focusHistory(state);
    settle(state);
    const isImage = (placement: { imageId: number }) => placement.imageId === 0x40000001;
    expect(screen.visiblePlacements().filter(isImage)).toHaveLength(1);
    const bound = state.historyMessageBounds.find((entry) => entry.messageId === messages[55]!.id)!;
    for (let row = bound.end - 1; row >= bound.start; row--) {
      cursorTo(state, row);
      expect(screen.visiblePlacements().filter(isImage)).toHaveLength(1);
    }
  });
});

describe("reloading the open channel while scrolled up", () => {
  for (const smoothOn of [true, false]) {
    test(`keeps the view on the same messages with the prompt focused, no glide (smooth ${smoothOn ? "on" : "off"})`, () => {
      const state = chatState({ smooth: smoothOn });
      expect(state.chatFocus).toBe("prompt");
      frame(state);
      if (smoothOn) settle(state);
      state.timeline.scrollOffset = state.timeline.maxScroll - 25;
      if (smoothOn) settle(state); else frame(state);
      const topAnchor = state.historyLineAnchors[state.timeline.scrollOffset];
      const before = screen.snapshot();

      // A REST revalidation brings the same history plus newer messages.
      const reloaded = [...Array.from({ length: 60 }, (_, i) => message(i)), ...Array.from({ length: 5 }, (_, i) => message(60 + i))];
      setTimelineMessages(state.timeline, "channel-1", reloaded, { preserveScroll: true });
      const out = frame(state);

      expect(state.timeline.scrollOffset).toBeLessThan(state.timeline.maxScroll);
      expect(state.historyLineAnchors[state.timeline.scrollOffset]).toBe(topAnchor);
      expect(glides(out)).toEqual([]);
      if (smoothOn) {
        settle(state);
        expect(state.historyLineAnchors[state.timeline.scrollOffset]).toBe(topAnchor);
      }
      expect(screen.snapshot()).toBe(before);
    });
  }
});
