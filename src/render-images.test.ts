import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { customEmojiImages } from "./customemoji";
import { embedImageSources } from "./embeds";

import { invalidateFrame } from "./frame";
import { openImageModalState } from "./imagemodal";
import type { InlineChatImageReady } from "./inlineimage";
import { render } from "./render";
import { setMemberListMembers } from "./memberlist";
import { setSidebarGuilds } from "./sidebar";
import { SmoothScroller, markRelayout, markScrollIntent, setSmoothScroller, smoothScrollerFor } from "./smoothscroll";
import { createInitialState, cycleFocus, focusHistory, type AppState } from "./state";
import {
  appendTimelineMessage,
  prependTimelineMessages,
  removeTimelineInlineImageState,
  setTimelineImageDetails,
  setTimelineInlineImageState,
  setTimelineMessages,
} from "./timeline";
import { recordTypingStart } from "./typing";
import type { DiscordMessage } from "./discord";
import { VtScreen } from "./vtscreen.testutil";

// Chat images under everything that moves or covers them. Whatever happened
// before, at rest every image is placed where a fresh start would place it,
// cropped the same way, and shown over the cells it was placed on.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
/** Pixel sizes: small, tall (taller than the pane), wide, one row. */
const SIZES = [[64, 64], [128, 2048], [2000, 200], [300, 10], [400, 300]] as const;

let now = 0;
let screen: VtScreen;

let withEmoji = false;

function message(index: number, options: { image?: boolean; channelId?: string; timestamp?: number } = {}): DiscordMessage {
  const author = Math.floor(index / 3) % 2 === 0
    ? { id: "user-1", username: "ada", displayName: "Ada", bot: false }
    : { id: "user-2", username: "brook", displayName: "Brook", bot: false };
  const image = options.image ?? index % 3 === 1;
  return {
    id: String(10_000 + index),
    channelId: options.channelId ?? "channel-1",
    type: 0,
    timestamp: options.timestamp ?? Date.UTC(2026, 0, 1, 12, 0, 0) + index * 60_000,
    editedTimestamp: null,
    content: index % 5 === 0 ? "" : `m${index} ${withEmoji && index % 2 === 0 ? "<:KE:990001> " : ""}${"words that wrap ".repeat(index % 4 === 0 ? 6 : 1)}`.trim(),
    reactions: withEmoji && index % 3 === 0 ? [{ emoji: { id: "990002", name: "NC", animated: false }, count: 2, me: false }] : [],
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    author,
    reply: null,
    call: null,
    attachments: image
      ? [{ id: `a${index}`, filename: `img${index}.png`, contentType: "image/png", size: 68, url: `https://cdn.example/img${index}.png` }]
      : [],
    stickerNames: [],
    ...embedsFor(index),
  };
}

/** Some messages carry embeds: a thumbnail beside text, or a two-picture gallery below it. */
function embedsFor(index: number): Pick<DiscordMessage, "embeds" | "embedsCount"> {
  const picture = (name: string) => ({ url: `https://cdn.example/${name}`, proxyUrl: null, width: 400, height: 300 });
  const base = { type: "rich", title: `Embed ${index}`, url: `https://news.example/${index}`, description: "an embed description that wraps beside its thumbnail ".repeat(2), providerName: null, authorName: null };
  const embeds = index % 7 === 3
    ? [{ ...base, thumbnail: picture(`thumb${index}.png`) }]
    : index % 11 === 6
      ? [{ ...base, image: picture(`g${index}a.png`) }, { ...base, title: null, description: null, image: picture(`g${index}b.png`) }]
      : [];
  return { embeds, embedsCount: embeds.length };
}

function readyImage(attachmentId: string, url: string, index: number): InlineChatImageReady {
  const [pixelWidth, pixelHeight] = SIZES[index % SIZES.length]!;
  return {
    phase: "ready",
    attachmentId,
    filename: url.split("/").at(-1)!,
    sourceUrl: url,
    requestId: index,
    imageId: 0x40000000 + index,
    pngBase64: PNG,
    pixelWidth,
    pixelHeight,
  };
}

function showImages(state: AppState, messages: readonly DiscordMessage[]): void {
  for (const entry of messages) {
    for (const attachment of entry.attachments) {
      setTimelineInlineImageState(state.timeline, readyImage(attachment.id, attachment.url, Number(entry.id) - 10_000 + 1000));
    }
    embedImageSources(entry).forEach((source, index) => {
      setTimelineInlineImageState(state.timeline, readyImage(source.id, source.url, (Number(entry.id) - 10_000) * 10 + 5000 + index));
    });
  }
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

function frame(state: AppState): string {
  const out = capture(state);
  screen.write(out);
  return out;
}

function imageChatState(options: { smooth?: boolean; sidebar?: boolean; members?: boolean; messages?: number; scrollRegions?: boolean; emoji?: boolean; clips?: boolean } = {}): AppState {
  const state = createInitialState(null, "/tmp/record-config.json", {}, { scrollRegions: options.scrollRegions ?? true });
  state.cols = 110;
  state.rows = 34;
  setSidebarGuilds(state.sidebar, Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: `Guild ${i}`, icon: null })));
  state.sidebar.open = options.sidebar ?? true;
  setMemberListMembers(state.memberList, "g0", "channel-1", Array.from({ length: 30 }, (_, i) => ({
    id: `member-${i}`, username: `member${i}`, displayName: `Member ${i}`, bot: false,
  })));
  state.memberList.open = options.members ?? false;
  const messages = Array.from({ length: options.messages ?? 90 }, (_, i) => message(i));
  setTimelineMessages(state.timeline, "channel-1", messages);
  showImages(state, messages);
  if (options.smooth !== false) {
    const smooth = new SmoothScroller(100, () => now, 30);
    // st's image clip regions (mode 2033): the default path on the owner's st.
    if (options.clips) smooth.useImageClip(true);
    setSmoothScroller(state, smooth);
  }
  screen = new VtScreen(state.rows, state.cols);
  return state;
}

/** Let a glide finish, rendering each row when due, then one frame at rest. */
function rest(state: AppState): void {
  const smooth = smoothScrollerFor(state);
  for (let i = 0; smooth && i < 400 && smooth.busy(); i++) {
    now += Math.max(1, smooth.nextWakeMs());
    if (smooth.needsLayout()) frame(state);
  }
  now += 200;
  frame(state);
}

/** What a fresh Record would draw for the same state, on a fresh terminal. */
function reference(state: AppState): VtScreen {
  // The emoji renderer is shared: the reference frame must not disturb what
  // it remembers placing on the real screen.
  const emoji = customEmojiImages as unknown as Record<string, unknown>;
  const saved = { tracked: emoji.tracked, lastVisibleImageIds: emoji.lastVisibleImageIds, mayHavePlacements: emoji.mayHavePlacements };
  // ...and starts from nothing placed, like a fresh terminal.
  Object.assign(emoji, { tracked: null, lastVisibleImageIds: new Set(), mayHavePlacements: false });
  try {
    const copy = structuredClone(state);
    // Already laid out: rows and the cursor stay where they are (a re-map
    // through repeated line anchors could move the selection).
    copy.historyLineAnchors = [];
    // A fresh start in the same terminal mode: with image clip regions too.
    if (smoothScrollerFor(state)?.imageClipSupported) {
      const smooth = new SmoothScroller(100, () => now, 30);
      smooth.useImageClip(true);
      setSmoothScroller(copy, smooth);
    }
    const fresh = new VtScreen(copy.rows, copy.cols);
    fresh.write(capture(copy));
    return fresh;
  } finally {
    Object.assign(emoji, saved);
  }
}

const isChatImage = (imageId: number) => imageId >= 0x40000000 && imageId < 0x40000000 + 0x100000;
const isEmojiImage = (imageId: number) => imageId >= 0x72000000 && imageId < 0x73000000;

function expectImagesAtRest(state: AppState, context: string): void {
  const expected = reference(state);
  const placed = screen.placements().filter((placement) => isChatImage(placement.imageId));
  const wanted = expected.placements().filter((placement) => isChatImage(placement.imageId));
  expect({ context, placed }).toEqual({ context, placed: wanted });
  const hidden = screen.occlusions().filter((placement) => isChatImage(placement.imageId) || isEmojiImage(placement.imageId));
  expect({ context, hidden }).toEqual({ context, hidden: [] });
  // Emoji placement ids differ with smooth scrolling; their cells must not.
  const emojiCells = (screenToRead: VtScreen) => screenToRead.placements().filter((placement) => isEmojiImage(placement.imageId))
    .map(({ imageId, row, col }) => `${imageId}@${row},${col}`).sort();
  expect({ context, emoji: emojiCells(screen) }).toEqual({ context, emoji: emojiCells(expected) });
  expect({ context, text: screen.snapshot() }).toEqual({ context, text: expected.snapshot() });
}

describe("chat images under overlays", () => {
  const popup = (rows: number): AppState["autocomplete"] => ({
    type: "command",
    selection: 0,
    prefix: "/",
    matches: Array.from({ length: rows }, (_, i) => ({ name: `/cmd${i}`, desc: `command ${i}` })),
  });
  const openViewer = (state: AppState) => {
    const image = Object.values(state.timeline.inlineImages).find((entry): entry is InlineChatImageReady => entry.phase === "ready")!;
    state.imageModal = openImageModalState({ filename: image.filename }, image);
  };
  /** Ten messages, each with an image, arriving at a followed bottom. */
  const arrivals = (state: AppState, from: number) => {
    for (let i = 0; i < 10; i++) {
      const arrived = message(from + i, { image: true });
      appendTimelineMessage(state.timeline, arrived);
      showImages(state, [arrived]);
      frame(state);
    }
  };

  for (const smooth of [true, false]) {
    const where = smooth ? "smooth scrolling" : "no smooth scrolling";

    test(`images that move under the open viewer are whole once it closes (${where})`, () => {
      const state = imageChatState({ smooth, sidebar: false });
      rest(state);
      openViewer(state);
      rest(state);
      arrivals(state, 300);
      rest(state);
      state.imageModal = null;
      rest(state);
      expectImagesAtRest(state, "viewer closed");
    });

    test(`a resize under the open viewer leaves the images whole once it closes (${where})`, () => {
      const state = imageChatState({ smooth, sidebar: false });
      rest(state);
      openViewer(state);
      rest(state);
      markRelayout(state);
      state.rows -= 3;
      invalidateFrame(state);
      smoothScrollerFor(state)?.terminalReset();
      screen.resize(state.rows, state.cols);
      rest(state);
      state.imageModal = null;
      rest(state);
      expectImagesAtRest(state, "viewer closed after a resize");
    });

    test(`images moving while the autocomplete popup is open stay with their text and are whole once it closes (${where})`, () => {
      const state = imageChatState({ smooth, sidebar: true });
      state.editor.buffer = "/c";
      rest(state);
      state.autocomplete = popup(9);
      rest(state);
      arrivals(state, 400);
      rest(state);
      // While it is open: nothing is shown anywhere a fresh start would not show it.
      const open = reference(state);
      const wanted = new Set(open.placements().map((placement) => JSON.stringify(placement)));
      for (const placement of screen.placements().filter((entry) => isChatImage(entry.imageId))) {
        expect(wanted.has(JSON.stringify(placement)) || screen.occlusions().some((hidden) => hidden.placementId === placement.placementId)).toBe(true);
      }
      state.autocomplete = null;
      rest(state);
      expectImagesAtRest(state, "popup closed after arrivals");
    });

    test(`scrolling with the autocomplete popup open leaves no image missing once it closes (${where})`, () => {
      const state = imageChatState({ smooth, sidebar: true });
      rest(state);
      state.autocomplete = popup(6);
      rest(state);
      for (const step of [-3, -5, -2, -6, 4, -4, -7, 3]) {
        markScrollIntent(state);
        const top = state.timeline.scrollOffset === Number.MAX_SAFE_INTEGER ? state.timeline.maxScroll : state.timeline.scrollOffset;
        state.timeline.scrollOffset = Math.max(0, Math.min(state.timeline.maxScroll, top + step));
        frame(state);
        rest(state);
      }
      state.autocomplete = null;
      rest(state);
      expectImagesAtRest(state, "popup closed after scrolls");
    });
  }
});

describe("cells under images", () => {
  /** Text and attributes of every cell under each chat image placement. */
  const cellsUnderImages = () => screen.placements().filter((placement) => isChatImage(placement.imageId)).map((placement) => {
    const columns = Number(/(?:^|,)c=(\d+)/.exec(placement.controls)![1]);
    const rows = Number(/(?:^|,)r=(\d+)/.exec(placement.controls)![1]);
    const cells = screen.grid.slice(placement.row, placement.row + rows)
      .map((line) => line.slice(placement.col, placement.col + columns).map((cell) => `${cell.sgr}:${cell.ch}`).join(" "));
    return { imageId: placement.imageId, row: placement.row, cells };
  });

  test("a visual selection over image rows leaves the cells under the images as they were", () => {
    const state = imageChatState({ smooth: false, sidebar: false });
    rest(state);
    focusHistory(state);
    state.editor.mode = "normal";
    const image = state.historyLineAnchors.findIndex((anchor) => anchor.includes(":image:"));
    state.timeline.scrollOffset = Math.max(0, image - 2);
    state.historyCursor = { row: image + 1, col: 0 };
    rest(state);
    const before = cellsUnderImages();
    expect(before.length).toBeGreaterThan(0);
    for (const mode of ["visual", "visual-line"] as const) {
      state.editor.mode = mode;
      state.historyVisualAnchor = { row: Math.max(0, image - 2), col: 0 };
      rest(state);
      expect(cellsUnderImages()).toEqual(before);
      state.editor.mode = "normal";
      rest(state);
    }
  });
});

describe("the VT model's image clip regions (st mode 2033)", () => {
  test("an image clips to its region; only cells it can draw over hide it; a new clip starts afresh", () => {
    const vt = new VtScreen(12, 20);
    // Clip region rows 2-6, columns 1-10 (1-based); an 8-row image anchored on row 4 reaches row 11.
    vt.write("\x1b]2032;k;2,1,6,10\x1b\\\x1b[4;2H\x1b_Ga=p,i=1073741825,p=7,c=4,r=8,C=1,z=1,q=1\x1b\\");
    const hidden = () => vt.occlusions().map((placement) => placement.cell.row);
    // Rows below the region (a prompt) change: nothing it draws there, nothing hidden.
    vt.write("\x1b[9;1Hprompt text\x1b[11;3Hmore");
    expect(hidden()).toEqual([]);
    // A cell inside the region changes: hidden there.
    vt.write("\x1b[5;3Hx");
    expect(hidden()).toEqual([4]);
    // The clip grows: the placement remembers its cells afresh, the x included.
    vt.write("\x1b]2032;k;2,1,9,10\x1b\\");
    expect(hidden()).toEqual([]);
    // Outside every region (a different anchor column) an image is not clipped.
    vt.write("\x1b[4;15H\x1b_Ga=p,i=1073741826,p=8,c=2,r=4,C=1,z=1,q=1\x1b\\");
    vt.write("\x1b[7;16Hy");
    expect(vt.occlusions().map((placement) => placement.imageId)).toEqual([1073741826]);
    // Mode 2032 off clears the regions (st: CSI ? 2032 l): the image draws
    // whole again, remembering its cells afresh, so a change below the old
    // region now hides it.
    vt.write("\x1b[?2032l");
    expect(vt.occlusions().map((placement) => placement.imageId)).toEqual([1073741826]);
    vt.write("\x1b[10;3Hw");
    expect(vt.occlusions().map((placement) => placement.imageId)).toEqual([1073741825, 1073741826]);
  });
});

describe("narrow panes", () => {
  test("a window too narrow for both side panels hides the member list, then the sidebar, and brings them back when it widens", () => {
    const state = imageChatState({ smooth: false, sidebar: true, members: true });
    // Emoji and paperclip rows: what froze Record at a one-column pane.
    setTimelineMessages(state.timeline, "channel-1", [
      ...state.timeline.messages,
      { ...message(500, { image: false }), content: "😀 wide 📎 rows 🎉" },
    ]);
    for (const cols of [30, 31, 32, 33, 40, 48, 49, 56, 57, 58, 60, 75, 76, 77, 80, 120, 31]) {
      state.cols = cols;
      state.rows = 20;
      invalidateFrame(state);
      screen = new VtScreen(state.rows, state.cols);
      frame(state);
      const layout = state.chatMouseLayout!;
      const pane = layout.lastCol - layout.firstCol + 1;
      const sidebarShown = screen.text()[0]!.trimStart().startsWith("Servers");
      const membersShown = layout.lastCol < cols;
      expect({ cols, toggles: [state.sidebar.open, state.memberList.open] }).toEqual({ cols, toggles: [true, true] });
      // The panels never overlap the pane or each other; the pane stays usable.
      expect({ cols, firstCol: layout.firstCol }).toEqual({ cols, firstCol: sidebarShown ? 29 : 1 });
      expect({ cols, lastCol: layout.lastCol }).toEqual({ cols, lastCol: membersShown ? cols - 28 : cols });
      expect({ cols, usable: pane >= Math.min(20, cols) }).toEqual({ cols, usable: true });
      // Panels go as late as possible: the member list first, then the sidebar.
      expect({ cols, sidebarShown, membersShown }).toEqual({ cols, sidebarShown: cols >= 48, membersShown: cols >= 76 });
    }
  });

  test("a panel the window is too narrow for gives up focus, and focus cycling skips it", () => {
    const state = imageChatState({ smooth: false, sidebar: true, members: true });
    state.cols = 120;
    state.panelFocus = "memberlist";
    frame(state);
    expect(state.panelFocus).toBe("memberlist");
    state.cols = 60;
    invalidateFrame(state);
    frame(state);
    expect(state.panelFocus as string).toBe("chat");
    const visited = new Set<string>();
    for (let i = 0; i < 4; i++) {
      cycleFocus(state);
      visited.add(state.panelFocus);
    }
    expect([...visited].sort()).toEqual(["chat", "sidebar"]);
    expect(state.memberList.open).toBe(true);
  });

  test("an image is never placed outside the message pane's columns", () => {
    for (const cols of [30, 31, 32, 33, 40, 60]) {
      for (const [sidebar, members] of [[true, true], [true, false], [false, true]] as const) {
        const state = imageChatState({ smooth: false, sidebar, members });
        state.cols = cols;
        state.rows = 14;
        screen = new VtScreen(state.rows, state.cols);
        rest(state);
        const layout = state.chatMouseLayout!;
        for (const placement of screen.placements().filter((entry) => isChatImage(entry.imageId))) {
          const columns = Number(/(?:^|,)c=(\d+)/.exec(placement.controls)![1]);
          // Zero-based screen columns of the pane: firstCol..lastCol are one-based.
          expect({ cols, sidebar, members, left: placement.col + 1 >= layout.firstCol, right: placement.col + columns <= layout.lastCol })
            .toEqual({ cols, sidebar, members, left: true, right: true });
        }
      }
    }
  });
});

describe("images placed past the pane for a glide", () => {
  test("an image that fits exactly once the prompt shrinks mid-glide is whole at rest", () => {
    let found = false;
    for (let attempt = 0; attempt < 60 && !found; attempt++) {
      const state = imageChatState({ smooth: true, sidebar: false });
      state.editor.buffer = "1\n2\n3\n4\n5";
      state.editor.cursor = state.editor.buffer.length;
      rest(state);
      state.timeline.scrollOffset = state.timeline.maxScroll - attempt;
      rest(state);
      // Glide one row towards older history: an image at the bottom edge is placed whole, past the pane.
      markScrollIntent(state);
      state.timeline.scrollOffset -= 1;
      frame(state);
      const paneBottom = state.chatMouseLayout!.bodyTop + state.chatMouseLayout!.bodyRows - 1;
      const past = screen.placements().filter((placement) => isChatImage(placement.imageId)
        && placement.row + Number(/(?:^|,)r=(\d+)/.exec(placement.controls)![1]) > paneBottom
        && placement.row + Number(/(?:^|,)r=(\d+)/.exec(placement.controls)![1]) <= paneBottom + 2);
      if (past.length === 0 || !smoothScrollerFor(state)!.busy()) continue;
      found = true;
      // Mid-glide the prompt shrinks by two rows: the image now fits the pane as placed.
      markRelayout(state);
      state.editor.buffer = "1\n2\n3";
      state.editor.cursor = state.editor.buffer.length;
      frame(state);
      rest(state);
      expectImagesAtRest(state, `attempt ${attempt}`);
    }
    expect(found).toBe(true);
  });
});

describe("custom emoji under the autocomplete popup", () => {
  const isEmoji = (imageId: number) => imageId >= 0x72000000 && imageId < 0x73000000;
  beforeAll(() => {
    customEmojiImages.configure({
      fetch: (async () => new Response(Buffer.from(PNG, "base64"))) as unknown as typeof fetch,
      onUpdate: () => {},
    });
  });
  afterAll(() => customEmojiImages.setEnabled(false));

  for (const smooth of [true, false]) {
    test(`emoji that move under the popup are not drawn over it, and are shown once it closes (${smooth ? "smooth scrolling" : "no smooth scrolling"})`, async () => {
      // A fresh terminal: forget what earlier tests placed.
      customEmojiImages.setEnabled(false);
      customEmojiImages.setEnabled(true);
      const state = imageChatState({ smooth, sidebar: true, messages: 60 });
      const emojiMessages = (from: number) => Array.from({ length: 12 }, (_, i) => ({
        ...message(from + i, { image: false }),
        content: `<:KE:990001> hello <:NC:990002> ${i}`,
      }));
      setTimelineMessages(state.timeline, "channel-1", [...state.timeline.messages, ...emojiMessages(60)]);
      frame(state);
      await new Promise((resolve) => setTimeout(resolve, 30));
      rest(state);
      state.autocomplete = {
        type: "command",
        selection: 0,
        prefix: "/",
        matches: Array.from({ length: 12 }, (_, i) => ({ name: `/cmd${i}`, desc: `command ${i}` })),
      };
      rest(state);
      const popupRows = screen.text().flatMap((text, row) => text.includes("/cmd") ? [row] : []);
      expect(popupRows.length).toBe(12);
      for (const arrived of emojiMessages(200)) {
        appendTimelineMessage(state.timeline, arrived);
        frame(state);
        rest(state);
        // Not one emoji placement sits on the popup's rows (nothing over it on any terminal).
        const over = screen.placements().filter((placement) => isEmoji(placement.imageId) && popupRows.includes(placement.row));
        expect(over).toEqual([]);
      }
      state.autocomplete = null;
      rest(state);
      const expected = reference(state).placements().filter((placement) => isEmoji(placement.imageId));
      const placed = screen.placements().filter((placement) => isEmoji(placement.imageId));
      const cells = (list: typeof placed) => list.map(({ imageId, row, col }) => `${imageId}@${row},${col}`).sort();
      expect(cells(placed)).toEqual(cells(expected));
      expect(screen.occlusions().filter((placement) => isEmoji(placement.imageId))).toEqual([]);
    });
  }
});

describe("chat images under random scrolling, arrivals, overlays and layout changes", () => {
  for (const [label, options] of [
    ["smooth scrolling, sidebar", { smooth: true, sidebar: true }],
    ["smooth scrolling, full width", { smooth: true, sidebar: false }],
    ["no smooth scrolling, full width", { smooth: false, sidebar: false }],
    ["no smooth scrolling, sidebar", { smooth: false, sidebar: true }],
    ["scrollRegions off", { smooth: false, sidebar: false, scrollRegions: false }],
    ["custom emoji, smooth scrolling, sidebar", { smooth: true, sidebar: true, emoji: true }],
    ["image clip regions, sidebar", { smooth: true, sidebar: true, clips: true }],
    ["image clip regions, custom emoji, full width", { smooth: true, sidebar: false, clips: true, emoji: true }],
    ["custom emoji, no smooth scrolling, full width", { smooth: false, sidebar: false, emoji: true }],
  ] as const) {
    test(`at rest every image is placed and shown as a fresh start would (${label})`, async () => {
      withEmoji = "emoji" in options;
      customEmojiImages.configure({ fetch: (async () => new Response(Buffer.from(PNG, "base64"))) as unknown as typeof fetch, onUpdate: () => {} });
      // A fresh terminal: forget what earlier tests placed.
      customEmojiImages.setEnabled(false);
      customEmojiImages.setEnabled(withEmoji);
      const state = imageChatState(options);
      frame(state);
      await new Promise((resolve) => setTimeout(resolve, 30));
      rest(state);
      let seed = Number(process.env.IMG_FUZZ_SEED ?? 0) + 7 + label.length;
      const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
      let next = 90;
      let older = 0;
      let emojiSeen = 0;
      /** Images resting past the pane's bottom (st clips them there). */
      let clippedSeen = 0;
      const log: string[] = [];
      for (let step = 0; step < Number(process.env.IMG_FUZZ_STEPS ?? 220); step++) {
        const roll = random();
        let op: string;
        if (roll < 0.3) {
          op = "scroll";
          markScrollIntent(state);
          const delta = Math.floor(random() * 13) - 6 || 1;
          state.timeline.scrollOffset = Math.max(0, Math.min(state.timeline.maxScroll, state.timeline.scrollOffset + delta));
        } else if (roll < 0.38) {
          op = "arrival";
          const arrived = message(next++);
          appendTimelineMessage(state.timeline, arrived);
          showImages(state, [arrived]);
        } else if (roll < 0.42) {
          op = "older page";
          const page = Array.from({ length: 5 }, (_, i) => message(5000 + older * 10 + i, { timestamp: Date.UTC(2025, 0, 1) + (older * 10 + i) * 60_000 }));
          older++;
          prependTimelineMessages(state.timeline, page, 88, { hasOlder: true });
          showImages(state, page);
        } else if (roll < 0.46) {
          op = "typing";
          if (random() < 0.5) recordTypingStart(state.typing, "channel-1", { id: "user-9", displayName: "Cy" }, Date.now());
          else state.typing.byChannelId = {};
        } else if (roll < 0.54) {
          op = "cursor";
          focusHistory(state);
          state.editor.mode = "normal";
          const top = state.timeline.scrollOffset === Number.MAX_SAFE_INTEGER ? state.timeline.maxScroll : state.timeline.scrollOffset;
          state.historyCursor = { row: Math.max(0, Math.min(state.historyLines.length - 1, top + Math.floor(random() * 25))), col: 0 };
        } else if (roll < 0.57) {
          op = "visual";
          if (state.chatFocus === "history" && state.editor.mode === "normal") {
            state.editor.mode = pick(["visual", "visual-line"] as const);
            state.historyVisualAnchor = { row: Math.max(0, state.historyCursor.row - Math.floor(random() * 12)), col: 0 };
          } else if (state.chatFocus === "history") {
            state.editor.mode = "normal";
          }
        } else if (roll < 0.6) {
          op = "pending delete";
          const bound = pick(state.historyMessageBounds);
          state.messageDeletePending = state.messageDeletePending || !bound ? null : { channelId: "channel-1", messageId: bound.messageId } as AppState["messageDeletePending"];
        } else if (roll < 0.63) {
          op = "prompt";
          state.chatFocus = "prompt";
          state.panelFocus = "chat";
          state.editor.mode = "insert";
        } else if (roll < 0.68) {
          op = "prompt rows";
          markRelayout(state);
          state.editor.buffer = Array.from({ length: Math.floor(random() * 12) }, (_, i) => `line ${i}`).join("\n");
          state.editor.cursor = state.editor.buffer.length;
        } else if (roll < 0.72) {
          op = "sidebar";
          markRelayout(state);
          state.sidebar.open = !state.sidebar.open;
        } else if (roll < 0.74) {
          op = "member list";
          markRelayout(state);
          state.memberList.open = !state.memberList.open;
        } else if (roll < 0.77) {
          op = "resize";
          markRelayout(state);
          // Sometimes tiny: the pane shorter than a tall image, or gone.
          const tiny = random() < 0.25;
          state.rows = tiny ? 4 + Math.floor(random() * 10) : 18 + Math.floor(random() * 22);
          state.cols = tiny ? 30 + Math.floor(random() * 30) : 70 + Math.floor(random() * 60);
          invalidateFrame(state);
          smoothScrollerFor(state)?.terminalReset();
          screen.resize(state.rows, state.cols);
        } else if (roll < 0.83) {
          op = "collapse/expand";
          markRelayout(state);
          const withImage = state.timeline.messages.filter((entry) => entry.attachments.length > 0);
          const target = pick(withImage);
          const attachment = target.attachments[0]!;
          if (state.timeline.inlineImages[attachment.id]) removeTimelineInlineImageState(state.timeline, attachment.id);
          else showImages(state, [target]);
        } else if (roll < 0.86) {
          op = "details";
          markRelayout(state);
          setTimelineImageDetails(state.timeline, !state.timeline.showImageDetails);
        } else if (roll < 0.9) {
          op = "autocomplete";
          state.autocomplete = state.autocomplete ? null : {
            type: "command",
            selection: 0,
            prefix: "/",
            matches: Array.from({ length: 2 + Math.floor(random() * 8) }, (_, i) => ({ name: `/cmd${i}`, desc: `command ${i}` })),
          };
        } else if (roll < 0.93) {
          op = "viewer";
          if (state.imageModal) {
            state.imageModal = null;
          } else {
            const image = pick(Object.values(state.timeline.inlineImages).filter((entry): entry is InlineChatImageReady => entry.phase === "ready"));
            if (image) state.imageModal = openImageModalState({ filename: image.filename }, image);
          }
        } else if (roll < 0.96) {
          op = "follow";
          state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
        } else if (roll < 0.98) {
          op = "channel switch";
          markRelayout(state);
          const channelId = state.timeline.channelId === "channel-1" ? "channel-2" : "channel-1";
          const messages = Array.from({ length: 40 + Math.floor(random() * 40) }, (_, i) => message(i + (channelId === "channel-2" ? 7000 : 0), { channelId }));
          setTimelineMessages(state.timeline, channelId, messages);
          showImages(state, messages);
          state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
        } else {
          op = "loading then ready";
          markRelayout(state);
          const withImage = state.timeline.messages.filter((entry) => entry.attachments.length > 0);
          const target = pick(withImage);
          const attachment = target.attachments[0]!;
          setTimelineInlineImageState(state.timeline, { phase: "loading", attachmentId: attachment.id, filename: attachment.filename, sourceUrl: attachment.url, requestId: 1 });
          frame(state);
          markRelayout(state);
          showImages(state, [target]);
        }
        log.push(op);
        frame(state);
        // Part of the glide, sometimes interrupted by the next input.
        const smooth = smoothScrollerFor(state);
        const until = now + Math.floor(random() * 150);
        while (smooth?.busy() && now < until) {
          now += Math.max(1, smooth.nextWakeMs());
          if (smooth.needsLayout()) frame(state);
        }
        if (random() < 0.35 && !state.autocomplete && !state.imageModal) {
          rest(state);
          emojiSeen += screen.placements().filter((placement) => isEmojiImage(placement.imageId)).length;
          const paneBottom = state.chatMouseLayout ? state.chatMouseLayout.bodyTop + state.chatMouseLayout.bodyRows - 1 : 0;
          clippedSeen += screen.placements().filter((placement) => isChatImage(placement.imageId)
            && placement.row + Number(/(?:^|,)r=(\d+)/.exec(placement.controls)?.[1] ?? 1) > paneBottom).length;
          expectImagesAtRest(state, `${label}: step ${step} after ${log.slice(-6).join(", ")}`);
        }
      }
      state.autocomplete = null;
      state.imageModal = null;
      rest(state);
      expectImagesAtRest(state, `${label}: end after ${log.slice(-6).join(", ")}`);
      if (withEmoji) expect(emojiSeen).toBeGreaterThan(0);
      if ("clips" in options) expect(clippedSeen).toBeGreaterThan(0);
      withEmoji = false;
      customEmojiImages.setEnabled(false);
    });
  }
});

