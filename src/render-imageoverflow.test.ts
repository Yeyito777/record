import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { render } from "./render";
import { setSidebarGuilds } from "./sidebar";
import { SmoothScroller, markScrollIntent, setSmoothScroller } from "./smoothscroll";
import { createInitialState, type AppState } from "./state";
import { appendTimelineMessage, setTimelineInlineImageState, setTimelineMessages } from "./timeline";
import { recordTypingStart } from "./typing";
import type { DiscordMessage } from "./discord";
import { VtScreen } from "./vtscreen.testutil";

// Owner report: "sometimes images clip into the prompt line while scrolling".
// While a glide runs, Record places an image cut off by the pane's bottom
// whole, past the pane (st clips it to the moving rectangle while it moves);
// at rest st clips nothing, so no image cell may then be outside the pane.
// These tests drive Record like main.ts does (frames when due), deliver its
// bytes to a model of st after a latency, and look at what st would draw
// every half millisecond.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
const IMAGE_ID = 0x40000001;

/** Record's clock. */
let now = 0;
/** st's clock (bytes arrive `latency` ms after Record writes them). */
let stNow = 0;
let latency = 0;
let screen: VtScreen;
let queue: { at: number; bytes: string }[] = [];
/** main.ts's smooth-scroll timer. */
let dueAt: number | null = null;
let state: AppState;
let smooth: SmoothScroller;
let violations: string[] = [];

function message(index: number, attachments: DiscordMessage["attachments"] = []): DiscordMessage {
  return {
    id: String(1000 + index),
    channelId: "channel-1",
    type: 0,
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0) + index * 60_000,
    editedTimestamp: null,
    content: `m${String(index).padStart(3, "0")} ${"words ".repeat(index % 3 === 0 ? 4 : 1)}`.trim(),
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    author: { id: `user-${index % 4}`, username: "u", displayName: `User ${index % 4}`, bot: false },
    reply: null,
    call: null,
    attachments,
    stickerNames: [],
    embedsCount: 0,
  };
}

function capture(): string {
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

/** One frame, like main.ts renderFrame(): render, write, plan the next glide frame. */
function renderFrame(): void {
  queue.push({ at: now + latency, bytes: capture() });
  const due = smooth.frameDueIn();
  dueAt = null;
  if (due === null) return;
  if (due <= 0) renderFrame();
  else dueAt = now + due;
}

let paneCache: { region: { top: number; left: number; bottom: number; right: number }; writes: number } | null = null;
let writes = 0;

/**
 * The message pane st shows now (1-based, inclusive): below the top
 * separator, above the typing row and the prompt. Read off st's screen, which
 * runs `latency` behind Record's state.
 */
function pane(): { top: number; left: number; bottom: number; right: number } {
  if (paneCache?.writes === writes) return paneCache.region;
  const left = state.sidebar.open ? 29 : 1;
  const text = screen.text().map((row) => row.slice(left - 1));
  let bottom = text.length;
  for (let row = 3; row < text.length; row++) {
    if (text[row]!.startsWith("──")) {
      bottom = row;
      break;
    }
  }
  if (/ (is|are) typing…/.test(text[bottom - 1] ?? "")) bottom--;
  const region = { top: 3, left, bottom, right: state.cols };
  paneCache = { region, writes };
  return region;
}

/** Advance both clocks to `until`, firing main's timer and delivering bytes as they come due. */
function run(until: number): void {
  for (let time = Math.max(now, stNow); time <= until; time += 0.5) {
    now = time;
    if (dueAt !== null && now >= dueAt) {
      dueAt = null;
      if (smooth.needsLayout()) renderFrame();
      else {
        const due = smooth.frameDueIn();
        if (due !== null && due <= 0) renderFrame();
        else if (due !== null) dueAt = now + due;
      }
    }
    while (queue.length > 0 && queue[0]!.at <= time) {
      stNow = queue[0]!.at;
      screen.write(queue.shift()!.bytes);
      writes++;
    }
    stNow = time;
    const outside = screen.imageCellsOutside(pane());
    if (outside.length > 0) violations.push(`t=${time} st offset=${screen.glideOffset().toFixed(3)}: ${outside.slice(0, 3).join(" ")} (+${Math.max(0, outside.length - 3)})`);
  }
}

/** An input: the state changes now, then main renders (scheduleRender is 16 ms; render at once here). */
function input(change: () => void): void {
  change();
  renderFrame();
}

function setUp(options: { latency?: number; sidebar?: boolean } = {}): void {
  now = 1000;
  stNow = 1000;
  latency = options.latency ?? 0;
  queue = [];
  dueAt = null;
  violations = [];
  state = createInitialState(null, "/tmp/record-config.json");
  state.cols = 100;
  state.rows = 30;
  setSidebarGuilds(state.sidebar, Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: `Guild ${i}`, icon: null })));
  state.sidebar.open = options.sidebar ?? true;
  const messages = Array.from({ length: 80 }, (_, i) => message(i));
  messages[60] = message(60, [{ id: "a1", filename: "tall.png", contentType: "image/png", size: 68, url: "https://cdn.example/tall.png" }]);
  setTimelineMessages(state.timeline, "channel-1", messages);
  setTimelineInlineImageState(state.timeline, {
    phase: "ready", attachmentId: "a1", filename: "tall.png", sourceUrl: "https://cdn.example/tall.png",
    requestId: 1, imageId: IMAGE_ID, pngBase64: PNG, pixelWidth: 40, pixelHeight: 120,
  });
  smooth = new SmoothScroller(100, () => now, 30);
  setSmoothScroller(state, smooth);
  screen = new VtScreen(state.rows, state.cols, () => stNow);
  renderFrame();
  run(now + 300);
}

/** Scroll (no glide) until the image straddles the pane's bottom edge, its top half in view. */
function imageAtBottomEdge(): void {
  for (let offset = state.timeline.maxScroll; offset >= 0; offset--) {
    input(() => { state.timeline.scrollOffset = offset; });
    run(now + 200);
    const placed = screen.placements().find((placement) => placement.imageId === IMAGE_ID);
    const rows = Number(/(?:^|,)r=(\d+)/.exec(placed?.controls ?? "")?.[1] ?? 0);
    if (placed && placed.row + rows >= pane().bottom - 1 && placed.row < pane().bottom - 3) return;
  }
  throw new Error("the image never reached the pane's bottom edge");
}

/** Scroll by `delta` lines as the user does (negative: back in history, the image glides down). */
function scroll(delta: number): void {
  input(() => {
    markScrollIntent(state);
    state.timeline.scrollOffset = Math.max(0, Math.min(state.timeline.maxScroll, state.timeline.scrollOffset + delta));
  });
}

beforeEach(() => { violations = []; });
afterEach(() => { setSmoothScroller(state, null); });

describe("no image cell is drawn outside the message pane (the prompt line stays clear)", () => {
  for (const ms of [0, 2, 12, 40]) {
    test(`a glide back pushing a tall image out through the pane's bottom, ${ms} ms to st`, () => {
      setUp({ latency: ms });
      imageAtBottomEdge();
      for (const step of [-1, -3, -2]) {
        scroll(step);
        run(now + 300);
      }
      expect(violations).toEqual([]);
    });
  }

  test("a second scroll back mid-glide, then one forward", () => {
    setUp({ latency: 3 });
    imageAtBottomEdge();
    scroll(-2);
    run(now + 40);
    scroll(-3);
    run(now + 30);
    scroll(4);
    run(now + 300);
    expect(violations).toEqual([]);
  });

  test("the autocomplete popup opening mid-glide (scroll, then type a command)", () => {
    setUp({ latency: 1 });
    imageAtBottomEdge();
    scroll(-3);
    run(now + 50);
    input(() => {
      state.autocomplete = {
        type: "command",
        selection: 0,
        prefix: "/",
        matches: Array.from({ length: 4 }, (_, i) => ({ name: `/cmd${i}`, desc: `command ${i}` })),
      };
    });
    run(now + 300);
    expect(violations).toEqual([]);
  });

  test("the typing line appearing mid-glide", () => {
    setUp({ latency: 1 });
    imageAtBottomEdge();
    scroll(-3);
    run(now + 20);
    input(() => recordTypingStart(state.typing, "channel-1", { id: "user-9", displayName: "Cy" }, Date.now()));
    run(now + 300);
    expect(violations).toEqual([]);
  });

  test("a frame that moves the pane's bottom edge (the typing line) crops at once, even mid-glide", () => {
    setUp({ latency: 0 });
    imageAtBottomEdge();
    scroll(-3);
    run(now + 20);
    const extended = screen.placements().find((placement) => placement.imageId === IMAGE_ID)!;
    const rowsOf = (controls: string) => Number(/(?:^|,)r=(\d+)/.exec(controls)?.[1] ?? 0);
    expect(extended.row + rowsOf(extended.controls) - 1).toBeGreaterThan(pane().bottom);
    input(() => recordTypingStart(state.typing, "channel-1", { id: "user-9", displayName: "Cy" }, Date.now()));
    run(now + 1);
    const cropped = screen.placements().find((placement) => placement.imageId === IMAGE_ID)!;
    expect(cropped.row + rowsOf(cropped.controls) - 1).toBeLessThanOrEqual(pane().bottom);
    run(now + 300);
    expect(violations).toEqual([]);
  });

  test("the prompt growing mid-glide", () => {
    setUp({ latency: 1 });
    imageAtBottomEdge();
    scroll(-3);
    run(now + 30);
    input(() => {
      state.editor.buffer = "line one\nline two\nline three";
      state.editor.cursor = state.editor.buffer.length;
    });
    run(now + 300);
    expect(violations).toEqual([]);
  });

  test("any sequence of wheel steps both ways, messages arriving and the typing line, with jittery latency", () => {
    setUp({ latency: 4 });
    imageAtBottomEdge();
    let seed = 41;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let next = 80;
    for (let step = 0; step < 120; step++) {
      latency = Math.floor(random() * 25);
      const roll = random();
      if (roll < 0.7) scroll(Math.floor(random() * 7) - 3 || -1);
      else if (roll < 0.8) input(() => appendTimelineMessage(state.timeline, message(next++)));
      else if (roll < 0.9) input(() => recordTypingStart(state.typing, "channel-1", { id: "user-9", displayName: "Cy" }, Date.now()));
      else input(() => { state.typing.byChannelId = {}; });
      run(now + Math.floor(random() * 140));
    }
    run(now + 400);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});
