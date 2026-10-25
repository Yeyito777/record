import { afterEach, describe, expect, test } from "bun:test";

import { mapDiscordMessagePatch, type DiscordEmbedResponse, type DiscordMessage } from "./discord";
import { invalidateFrame } from "./frame";
import { inlineImageSourcesForMessage } from "./inlineimage";
import { render } from "./render";
import { SmoothScroller, setSmoothScroller, smoothScrollerFor } from "./smoothscroll";
import { createInitialState, focusHistory, type AppState } from "./state";
import { disposeInlineTerminalImages } from "./terminalimage";
import { patchTimelineMessage, setTimelineInlineImageState, setTimelineMessages } from "./timeline";
import { VtScreen } from "./vtscreen.testutil";

// Embeds that arrive (a link unfurling) or leave (SUPPRESS_EMBEDS) through
// MESSAGE_UPDATE re-lay the message out in place: following the bottom it
// glides (smoothscroll.ts), otherwise the reading position stays put.

let now = 0;
let screen: VtScreen;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";

const PREVIEW: DiscordEmbedResponse = {
  type: "article",
  url: "https://news.example.org/story",
  title: "Preview title",
  description: "A description long enough to take a line of its own.",
  color: 0x57f287,
  image: { url: "https://news.example.org/a.jpg", proxy_url: "https://images-ext-1.discordapp.net/external/x/a.jpg", width: 400, height: 200 },
};

function message(index: number): DiscordMessage {
  return {
    id: String(1000 + index),
    channelId: "channel-1",
    type: 0,
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0) + index * 60_000,
    editedTimestamp: null,
    content: `m${String(index).padStart(3, "0")} https://news.example.org/story`,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    author: { id: `user-${index % 2}`, username: "ada", displayName: index % 2 ? "Brook" : "Ada", bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
    embeds: [],
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

function frame(state: AppState): string {
  const out = capture(state);
  screen.write(out);
  return out;
}

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

function fullRepaint(state: AppState): VtScreen {
  invalidateFrame(state);
  disposeInlineTerminalImages(state, () => {});
  const reference = new VtScreen(state.rows, state.cols);
  reference.write(capture(state));
  return reference;
}

const glides = (out: string) => [...out.matchAll(/\x1b\]2032;m;(-?\d+);(-?\d+);\d+\x1b\\/g)]
  .filter((match) => match[2] !== "0").map((match) => Number(match[2]));

function chatState(): AppState {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.cols = 120;
  state.rows = 30;
  setTimelineMessages(state.timeline, "channel-1", Array.from({ length: 60 }, (_, i) => message(i)));
  setSmoothScroller(state, new SmoothScroller(100, () => now, 30));
  screen = new VtScreen(state.rows, state.cols);
  return state;
}

/** Discord unfurling the link: a partial MESSAGE_UPDATE with the embeds. */
function unfurl(state: AppState, index: number): void {
  patchTimelineMessage(state.timeline, mapDiscordMessagePatch({ id: String(1000 + index), channel_id: "channel-1", embeds: [PREVIEW] }));
}

/** The author removing the preview: flag 4. */
function suppress(state: AppState, index: number): void {
  patchTimelineMessage(state.timeline, mapDiscordMessagePatch({ id: String(1000 + index), channel_id: "channel-1", flags: 4, embeds: [] }));
}

function showEmbedImages(state: AppState): void {
  for (const entry of state.timeline.messages) {
    for (const source of inlineImageSourcesForMessage(entry)) {
      setTimelineInlineImageState(state.timeline, {
        phase: "ready", attachmentId: source.id, filename: source.filename, sourceUrl: source.url, requestId: 1,
        imageId: 0x40000002, pngBase64: PNG, pixelWidth: 400, pixelHeight: 200,
      });
    }
  }
}

const topAnchor = (state: AppState) => state.historyLineAnchors[state.timeline.scrollOffset];

afterEach(() => {
  now += 1000;
});

describe("embeds arriving and leaving by MESSAGE_UPDATE", () => {
  test("a preview unfurling under the followed bottom glides in and stays at the bottom", () => {
    const state = chatState();
    settle(state);
    unfurl(state, 59);
    const out = frame(state);
    expect(glides(out).length).toBe(1);
    animate(state);
    // Its picture loads next: still followed.
    showEmbedImages(state);
    frame(state);
    animate(state);
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
    const text = screen.text().join("\n");
    expect(text).toContain("▎ Preview title");
    expect(screen.placements()).toHaveLength(1);
    expect(screen.placements()).toEqual(fullRepaint(state).placements());
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  test("a preview leaving the followed bottom (suppressed) glides it back", () => {
    const state = chatState();
    unfurl(state, 59);
    showEmbedImages(state);
    settle(state);
    expect(screen.placements()).toHaveLength(1);
    suppress(state, 59);
    const out = frame(state);
    expect(glides(out).length).toBe(1);
    animate(state);
    expect(screen.text().join("\n")).not.toContain("Preview title");
    expect(screen.placements()).toEqual([]);
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });

  for (const where of ["above", "below"] as const) {
    test(`scrolled up, a preview unfurling ${where} the view keeps the reading position (no glide)`, () => {
      const state = chatState();
      focusHistory(state);
      settle(state);
      state.timeline.scrollOffset = state.timeline.maxScroll - 40;
      settle(state);
      const top = topAnchor(state);
      const before = screen.snapshot();
      const firstVisible = Number(/^msg:(\d+):/.exec(top!)![1]) - 1000;
      unfurl(state, where === "above" ? firstVisible - 2 : 59);
      const all = [frame(state), ...animate(state)].join("");
      expect(glides(all)).toEqual([]);
      expect(topAnchor(state)).toBe(top);
      expect(screen.snapshot()).toBe(before);

      suppress(state, where === "above" ? firstVisible - 2 : 59);
      const removed = [frame(state), ...animate(state)].join("");
      expect(glides(removed)).toEqual([]);
      expect(topAnchor(state)).toBe(top);
      expect(screen.snapshot()).toBe(before);
    });
  }

  test("scrolled up, a preview unfurling in view grows that message downwards, the top line stays", () => {
    const state = chatState();
    focusHistory(state);
    settle(state);
    state.timeline.scrollOffset = state.timeline.maxScroll - 40;
    settle(state);
    const top = topAnchor(state);
    const firstVisible = Number(/^msg:(\d+):/.exec(top!)![1]) - 1000;
    unfurl(state, firstVisible + 2);
    showEmbedImages(state);
    const all = [frame(state), ...animate(state)].join("");
    expect(glides(all)).toEqual([]);
    expect(topAnchor(state)).toBe(top);
    expect(screen.text().join("\n")).toContain("▎ Preview title");
    expect(screen.placements()).toEqual(fullRepaint(state).placements());
    expect(screen.snapshot()).toBe(fullRepaint(state).snapshot());
  });
});
