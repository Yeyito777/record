import { describe, expect, test } from "bun:test";

import { render } from "./render";
import { createInitialState, focusHistory } from "./state";
import { INSTAGRAM_GUILD_ID } from "./chatproviders";
import { patchTimelineMessage, setTimelineInlineImageState, setTimelineMessages } from "./timeline";
import { theme } from "./theme";
import type { DiscordMessage } from "./discord";
import { recordTypingStart } from "./typing";
import { createLoginModalState } from "./whatsapp/loginmodal";
import { openImageModalState } from "./imagemodal";
import { customEmojiMarker } from "./customemoji";
import { moveTo } from "./terminal";
import { invalidateFrame } from "./frame";
import { VtScreen } from "./vtscreen.testutil";

function message(id: string, content: string): DiscordMessage {
  const numericId = Number(id);
  const offsetMinutes = Number.isFinite(numericId) ? numericId * 7 : 0;
  return {
    id,
    channelId: "channel-1",
    type: 0,
    timestamp: Date.UTC(2026, 0, 1, 12, offsetMinutes, 0),
    editedTimestamp: null,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
  };
}

function captureRender(state: ReturnType<typeof createInitialState>): string {
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

function captureRenderWrites(state: ReturnType<typeof createInitialState>): string[] {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
  }
  return writes;
}

/** Split one write into what lands before and inside its synchronized update. */
function synchronizedParts(write: string): { before: string; frame: string } {
  const begin = write.indexOf("\x1b[?2026h");
  const end = write.indexOf("\x1b[?2026l");
  if (begin < 0 || end < begin || end + "\x1b[?2026l".length !== write.length) return { before: write, frame: "" };
  return { before: write.slice(0, begin), frame: write.slice(begin, end) };
}

function viewerPlacement(frame: string): string | undefined {
  return /\x1b_Ga=p,i=\d+,p=\d+,(c=\d+,r=\d+),C=1,z=2/.exec(frame)?.[1];
}

function stateWithReadyInlineImage(): ReturnType<typeof createInitialState> {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.cols = 100;
  state.rows = 24;
  const withImage = message("1", "look");
  withImage.attachments = [{
    id: "a1",
    filename: "cat.png",
    contentType: "image/png",
    size: 68,
    url: "https://cdn.example/cat.png",
  }];
  setTimelineMessages(state.timeline, "channel-1", [withImage]);
  setTimelineInlineImageState(state.timeline, {
    phase: "ready",
    attachmentId: "a1",
    filename: "cat.png",
    sourceUrl: "https://cdn.example/cat.png",
    requestId: 1,
    imageId: 0x40000001,
    pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
    pixelWidth: 1,
    pixelHeight: 1,
  });
  return state;
}

describe("render", () => {
  test("Instagram group timelines use the Instagram viewer and DM coloring", () => {
    const state = createInitialState(null, "/tmp/config.json");
    state.cols = 100;
    state.rows = 24;
    state.instagram.account = { id: "ig-self", fbid: "", username: "self", name: "Self" };
    state.channelList.activeChannel = {
      id: "ig:123", guildId: INSTAGRAM_GUILD_ID, parentId: null, name: "Group",
      topic: null, position: 0, type: 3, nsfw: false,
    };
    state.channelList.activeChannelId = "ig:123";
    const ownMessage = message("1", "hello");
    ownMessage.channelId = "ig:123";
    ownMessage.guildId = INSTAGRAM_GUILD_ID;
    ownMessage.author.id = "ig-self";
    setTimelineMessages(state.timeline, "ig:123", [ownMessage]);
    captureRender(state);
    expect(state.timeline.viewerId).toBe("ig-self");
    expect(state.timeline.accentViewerInDirectMessages).toBe(true);
  });
  test("composes the centered WhatsApp QR modal over the retained frame", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 120;
    state.rows = 48;
    state.whatsapp.loginModal = createLoginModalState({ phase: "qr", qr: "private-test-qr-payload" });

    const output = captureRender(state);

    expect(output).toContain("WhatsApp · Scan QR code");
    expect(output).not.toContain("private-test-qr-payload");
  });

  test("composes a centered source-resolution image modal and terminal placement", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 120;
    state.rows = 48;
    state.imageModal = {
      filename: "desktop.png",
      image: {
        phase: "ready",
        attachmentId: "modal:a1",
        filename: "desktop.png",
        sourceUrl: "https://cdn.example/desktop.png",
        requestId: 1,
        imageId: 0x40000002,
        pngBase64: "cG5n",
        pixelWidth: 1920,
        pixelHeight: 1080,
      },
    };

    const output = captureRender(state);

    expect(output).toContain("desktop.png · 1920×1080");
    expect(output).toContain("Enter or Esc to close");
    expect(output).toContain("\x1b_Ga=t,t=d,f=100,i=1073741826");
    expect(output).toContain("\x1b_Ga=p,i=1073741826");
  });

  test("opening, upgrading, and closing the viewer preserves chat image placements", () => {
    const state = stateWithReadyInlineImage();
    captureRender(state);
    const preview = state.timeline.inlineImages.a1!;
    if (preview.phase !== "ready") throw new Error("missing fixture");
    state.imageModal = { filename: preview.filename, image: preview, loading: true, preview: true };
    const opening = captureRender(state);
    expect(opening).not.toContain("a=t,");
    expect(opening).not.toContain("a=d,");
    expect(opening).toContain("z=2");
    expect(captureRender(state)).not.toContain("\x1b_G");

    state.imageModal = {
      filename: preview.filename,
      image: { ...preview, imageId: preview.imageId + 1, pixelWidth: 1920, pixelHeight: 1080 },
    };
    const upgrading = captureRender(state);
    expect(upgrading).toContain(`a=p,i=${preview.imageId + 1}`);
    // Only the temporary viewer placement goes away, never the inline one.
    expect(upgrading.match(/a=d,d=i,/g)).toHaveLength(1);
    state.imageModal = null;
    const closing = captureRender(state);
    expect(closing).not.toContain("a=t,");
    expect(closing).not.toContain("a=p,");
    expect(closing).toContain(`a=d,d=i,i=${preview.imageId + 1}`);
    expect(closing).not.toContain(`a=d,d=i,i=${preview.imageId},`);
  });

  test("the viewer opens, upgrades, and closes in single synchronized frames at one size", () => {
    const state = stateWithReadyInlineImage();
    state.cols = 239;
    state.rows = 51;
    state.timeline.terminalCellWidthPixels = 8;
    state.timeline.terminalCellHeightPixels = 20;
    captureRender(state);
    const inline = state.timeline.inlineImages.a1!;
    if (inline.phase !== "ready") throw new Error("missing fixture");
    // A bounded 384×256 preview of a 900×600 attachment.
    const preview = { ...inline, pixelWidth: 384, pixelHeight: 256 };
    state.imageModal = openImageModalState({ filename: "medium.png", width: 900, height: 600 }, preview);

    const opening = captureRenderWrites(state);
    expect(opening).toHaveLength(1);
    const opened = synchronizedParts(opening[0]!);
    expect(opened.before).toBe("");
    expect(opened.frame).toContain("Loading full image");
    expect(viewerPlacement(opened.frame)).toBe("c=113,r=30");

    const full = { ...inline, attachmentId: "modal:a1", imageId: inline.imageId + 1, pixelWidth: 900, pixelHeight: 600, pngBase64: "ZnVsbA==" };
    state.imageModal.image = full;
    state.imageModal.preview = state.imageModal.loading = false;
    const upgrading = captureRenderWrites(state);
    expect(upgrading).toHaveLength(1);
    const upgraded = synchronizedParts(upgrading[0]!);
    // New pixels arrive before the frame; the swap itself is atomic and in place.
    expect(upgraded.before).toContain(`a=t,t=d,f=100,i=${full.imageId}`);
    expect(upgraded.frame).not.toContain("a=t,");
    expect(upgraded.frame).toContain("Enter or Esc to close");
    expect(upgraded.frame).toMatch(new RegExp(`a=d,d=i,i=${inline.imageId},p=\\d+.*a=p,i=${full.imageId},`));
    expect(viewerPlacement(upgraded.frame)).toBe("c=113,r=30");

    // Re-rendering an unchanged viewer sends no graphics at all.
    expect(captureRenderWrites(state).join("")).not.toContain("\x1b_G");

    state.imageModal = null;
    const closing = captureRenderWrites(state);
    expect(closing).toHaveLength(1);
    const closed = synchronizedParts(closing[0]!);
    expect(closed.before).toBe("");
    expect(closed.frame).toContain(`a=d,d=i,i=${full.imageId}`);
    expect(closed.frame).not.toContain("a=t,");
  });

  test("opening a new channel stays pinned to the bottom even with old history anchors", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    state.historyLineAnchors = ["msg:old:header"];
    state.historyLines = ["old line"];

    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
    ]);

    captureRender(state);

    expect(state.timeline.maxScroll).toBeGreaterThan(0);
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
  });

  test("pending images push chat history up while keeping the bottom pinned", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
      message("4", "fourth"),
    ]);
    captureRender(state);
    const baselineMaxScroll = state.timeline.maxScroll;
    expect(state.timeline.scrollOffset).toBe(baselineMaxScroll);

    state.pendingImages = [{ mediaType: "image/png", base64: "", sizeBytes: 1536, filename: "image-1.png" }];
    captureRender(state);

    expect(state.timeline.maxScroll).toBe(baselineMaxScroll + 1);
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
  });

  for (const me of [false, true]) {
    for (const target of ["2", "6"]) {
      test(`reaction rows keep history at bottom (self=${me}, message=${target})`, () => {
        const state = createInitialState(null, "/tmp/record-config.json");
        state.cols = 80;
        state.rows = 12;
        setTimelineMessages(state.timeline, "channel-1",
          Array.from({ length: 6 }, (_, i) => message(String(i + 1), `message ${i + 1}`)));
        captureRender(state);
        focusHistory(state);
        captureRender(state);
        const oldMax = state.timeline.maxScroll;
        expect(oldMax).toBeGreaterThan(1);
        const patch = {
          id: target, channelId: "channel-1",
          reactionUpdate: { type: "add" as const, me, emoji: { id: null, name: "👍", animated: false } },
        };
        patchTimelineMessage(state.timeline, patch);
        captureRender(state);
        expect(state.timeline.maxScroll).toBe(oldMax + 1);
        expect(state.timeline.scrollOffset).toBe(oldMax + 1);

        patchTimelineMessage(state.timeline, { ...patch, reactionUpdate: { type: "clear" } });
        captureRender(state);
        expect(state.timeline.scrollOffset).toBe(oldMax);

        // Even one row above the bottom must not be treated as pinned.
        state.timeline.scrollOffset = oldMax - 1;
        captureRender(state);
        const anchor = state.historyLineAnchors[state.timeline.scrollOffset];
        patchTimelineMessage(state.timeline, patch);
        captureRender(state);
        expect(state.timeline.scrollOffset).toBeLessThan(state.timeline.maxScroll);
        expect(state.historyLineAnchors[state.timeline.scrollOffset]).toBe(anchor);
      });
    }
  }

  test("typing indicator bumps an unpinned history viewport instead of covering its bottom row", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    state.auth.user = {
      id: "viewer",
      username: "viewer",
      globalName: null,
      discriminator: "0",
      avatar: null,
      bot: false,
      email: null,
      verified: null,
    };
    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
      message("4", "fourth"),
      message("5", "fifth"),
      message("6", "sixth"),
      message("7", "seventh"),
      message("8", "eighth"),
    ]);
    captureRender(state);
    focusHistory(state);
    state.timeline.scrollOffset = 5;
    captureRender(state);
    const offsetBeforeTyping = state.timeline.scrollOffset;

    recordTypingStart(state.typing, "channel-1", { id: "other-user", displayName: "Alice" }, Date.now());
    captureRender(state);

    expect(state.timeline.scrollOffset).toBe(offsetBeforeTyping + 1);
  });

  test("prompt-focused one-line history scroll is not auto-pinned back to bottom", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    setTimelineMessages(state.timeline, "channel-1", [
      message("1", "first"),
      message("2", "second"),
      message("3", "third"),
      message("4", "fourth"),
      message("5", "fifth"),
      message("6", "sixth"),
    ]);
    captureRender(state);
    expect(state.chatFocus).toBe("prompt");
    expect(state.timeline.maxScroll).toBeGreaterThan(1);

    state.timeline.scrollOffset = state.timeline.maxScroll - 1;
    captureRender(state);

    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll - 1);
  });

  test("renders pending images between prompt separator and prompt line", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    state.pendingImages = [{ mediaType: "image/png", base64: "", sizeBytes: 1536, filename: "image-1.png" }];

    const output = captureRender(state);

    expect(output).toContain("📎 Image pasted (PNG, 1.5 KB)");
    expect(output.indexOf("📎 Image pasted")).toBeLessThan(output.indexOf("I\x1b["));
  });

  test("places expanded attachment PNGs inside their reserved chat rows", () => {
    const state = stateWithReadyInlineImage();

    const first = captureRender(state);
    expect(first).toContain("\x1b_Ga=t,t=d,f=100,i=1073741825,q=2;");
    expect(first).toContain("\x1b_Ga=p,i=1073741825");
    expect(first).toContain(",c=1,r=1,C=1,z=1,q=1;");

    const second = captureRender(state);
    expect(second).not.toContain("\x1b_Ga=t");
    expect(second).not.toContain("\x1b_Ga=p");
  });

  test("keeps the passive history-line highlight out of expanded image cells", () => {
    const state = stateWithReadyInlineImage();
    captureRender(state);
    focusHistory(state);
    const imageRow = state.historyLineAnchors.findIndex((anchor) => anchor.includes(":image:"));
    expect(imageRow).toBeGreaterThanOrEqual(0);
    state.historyCursor = { row: imageRow, col: 0 };
    state.historyVisualAnchor = { ...state.historyCursor };

    // Keep this assertion meaningful even when the test process reports only
    // 16-color support and both dark backgrounds adapt to ANSI black.
    const originalHistoryLineBg = theme.historyLineBg;
    theme.historyLineBg = "\x1b[48;2;1;2;3m";
    try {
      const output = captureRender(state);
      expect(output).toContain(theme.historyLineBg);
      expect(output).toContain(`${theme.reset}${theme.appBg ?? "\x1b[49m"} ${theme.reset}`);
    } finally {
      theme.historyLineBg = originalHistoryLineBg;
    }
  });

  test("marks an expanded image as one selected terminal placement", () => {
    const state = stateWithReadyInlineImage();
    captureRender(state);
    focusHistory(state);
    const imageRow = state.historyLineAnchors.findIndex((anchor) => anchor.includes(":image:"));
    expect(imageRow).toBeGreaterThanOrEqual(0);
    state.editor.mode = "visual";
    state.historyCursor = { row: imageRow, col: 0 };
    state.historyVisualAnchor = { ...state.historyCursor };

    const selected = captureRender(state);
    expect(selected).toContain("z=1,V=1,q=1");

    state.editor.mode = "normal";
    const unselected = captureRender(state);
    expect(unselected).toContain("\x1b_Ga=p,i=1073741825");
    expect(unselected).not.toContain("V=1");
  });

  test("keeps expanded image placements while autocomplete covers their cells", () => {
    const state = stateWithReadyInlineImage();

    const first = captureRender(state);
    expect(first).toContain("\x1b_Ga=p,i=1073741825");

    state.autocomplete = {
      type: "replace",
      selection: -1,
      prefix: ":",
      matches: [{ name: "😀", desc: ":grinning_face:" }],
      replaceStart: 0,
      replaceEnd: 1,
    };
    const withAutocomplete = captureRender(state);

    expect(withAutocomplete).toContain(":grinning_face:");
    expect(withAutocomplete).not.toContain("a=d,d=i,i=1073741825");
    expect(withAutocomplete).not.toContain("\x1b_Ga=p,i=1073741825");
  });

  test("defers a new image placement under the autocomplete popup until it closes", () => {
    const state = stateWithReadyInlineImage();
    // Tall enough to cover the image's row.
    state.autocomplete = {
      type: "replace",
      selection: -1,
      prefix: ":",
      matches: Array.from({ length: 18 }, () => ({ name: "😀", desc: ":grinning_face:" })),
      replaceStart: 0,
      replaceEnd: 1,
    };

    const coveredFirstFrame = captureRender(state);
    expect(coveredFirstFrame).toContain(":grinning_face:");
    expect(coveredFirstFrame).not.toContain("\x1b_Ga=p,i=1073741825");

    state.autocomplete = null;
    const unobscuredFrame = captureRender(state);
    expect(unobscuredFrame).toContain("\x1b_Ga=p,i=1073741825");
    expect(unobscuredFrame).not.toContain("\x1b_Ga=t,t=d,f=100");
  });

  test("places an image the autocomplete popup does not cover", () => {
    const state = stateWithReadyInlineImage();
    state.autocomplete = {
      type: "replace",
      selection: -1,
      prefix: ":",
      matches: [{ name: "😀", desc: ":grinning_face:" }],
      replaceStart: 0,
      replaceEnd: 1,
    };
    expect(captureRender(state)).toContain("\x1b_Ga=p,i=1073741825");
  });

  test("renders voice-message listening prompt in the theme accent color", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    state.voiceMessagePrompt = { phase: "recording", frameIndex: 0 };

    const output = captureRender(state);

    expect(output).toContain(`${theme.accent}⠋ Listening…${theme.reset}`);
  });

  test("renders custom emoji completion markers through the inline image renderer", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    state.autocomplete = {
      type: "replace",
      selection: -1,
      prefix: ":alien",
      replaceStart: 0,
      replaceEnd: 6,
      matches: [{
        name: "◇ ",
        desc: ":aliencat_stare_2: · Alien Cats",
        customEmoji: { id: "1478284001298087936", name: "aliencat_stare_2", animated: false },
      }],
    };

    const output = captureRender(state);

    expect(output).toContain("◇ ");
    expect(output).not.toMatch(/[\ue000-\uf8ff]/);
  });

  test("renders selected custom emoji as an inline image placeholder in the prompt", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 12;
    const marker = customEmojiMarker({ id: "1478284001298087936", name: "aliencat_stare_2", animated: false });
    state.editor.buffer = `look ${marker}`;
    state.editor.cursor = state.editor.buffer.length;

    const output = captureRender(state);

    expect(output).toContain("look ");
    expect(output).toContain("◇ ");
    expect(output).not.toContain("<:aliencat_stare_2:1478284001298087936>");
    expect(output).not.toContain(marker);
    // Prompt starts at column 5: "look " occupies five cells and the image two,
    // so the insert cursor belongs immediately after it at column 12.
    expect(output).toContain(moveTo(10, 12));
  });

  test("renders reply context in the prompt separator", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 100;
    state.rows = 12;
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-2",
      authorDisplayName: "Other",
      authorColor: theme.accent,
      summary: "original message",
      timestamp: null,
      mention: true,
    };

    const output = captureRender(state);

    expect(output).toContain("↩ Replying: ");
    expect(output).not.toContain("PING ");
  });

  test("keeps status notices out of populated chat history", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 100;
    state.rows = 12;
    setTimelineMessages(state.timeline, "channel-1", [message("1", "sacred chat")]);
    state.notice = { text: "Hidden channels shown.", tone: "muted", loading: false, statusLine: true, chat: true };

    const output = captureRender(state);

    expect(output).toContain("sacred chat");
    expect(output).toContain("Hidden channels shown.");
    expect(output.indexOf("Hidden channels shown.")).toBeGreaterThan(output.indexOf("N "));
    expect(state.historyLines.join("\n")).not.toContain("Hidden channels shown.");
  });

  test("renders pinged message rows with the ping background", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 10;
    state.auth.user = {
      id: "viewer",
      username: "viewer",
      globalName: null,
      discriminator: "0",
      avatar: null,
      bot: false,
      email: null,
      verified: null,
    };
    const ping = message("1", "hi <@viewer>");
    ping.author.id = "other-user";
    ping.mentionUserIds = ["viewer"];
    setTimelineMessages(state.timeline, "channel-1", [ping]);

    const output = captureRender(state);

    expect(state.historyLineBackgrounds.slice(0, 2)).toEqual([theme.pingBg, theme.pingBg]);
    expect(output).toContain(theme.pingBg);
  });
});

describe("message pane region scrolls", () => {
  const REGION_SCROLL = /\x1b\[(\d+);(\d+)r\x1b\[(\d+)([ST])\x1b\[r/;

  function chatState(options: { messages?: number } = {}): ReturnType<typeof createInitialState> {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 60;
    state.rows = 16;
    setTimelineMessages(
      state.timeline,
      "channel-1",
      Array.from({ length: options.messages ?? 30 }, (_, i) => message(String(i + 1), `line ${i + 1}`)),
    );
    return state;
  }

  /** Screen as a fresh full repaint of the current state would draw it. */
  function fullRepaintSnapshot(state: ReturnType<typeof createInitialState>): string {
    invalidateFrame(state);
    const screen = new VtScreen(state.rows, state.cols);
    screen.write(captureRender(state));
    return screen.snapshot();
  }

  test("history scrolls become DECSTBM + SU/SD with exposed rows, matching a full repaint", () => {
    const state = chatState();
    const screen = new VtScreen(state.rows, state.cols);
    screen.write(captureRender(state));
    const maxScroll = state.timeline.maxScroll;
    expect(maxScroll).toBeGreaterThan(10);

    for (const [offset, direction, amount] of [
      [maxScroll - 2, "T", 2],
      [maxScroll - 5, "T", 3],
      [maxScroll - 4, "S", 1],
      [maxScroll - 1, "S", 3],
    ] as const) {
      state.timeline.scrollOffset = offset;
      const out = captureRender(state);
      const scroll = REGION_SCROLL.exec(out);
      expect(scroll?.slice(3, 5)).toEqual([String(amount), direction]);
      expect(out.startsWith("\x1b[?2026h")).toBe(true);
      expect(out.endsWith("\x1b[?2026l")).toBe(true);
      // Only the exposed rows of the pane are rewritten.
      const [, top, bottom] = scroll!.map(Number);
      const written = [...out.matchAll(/\x1b\[(\d+);1H(?:\x1b\[[\d;]*m)*\x1b\[2K/g)].map((match) => Number(match[1]));
      const paneWrites = written.filter((row) => row >= top! && row <= bottom!);
      expect(paneWrites).toEqual(direction === "S"
        ? Array.from({ length: amount }, (_, i) => bottom! - amount + 1 + i)
        : Array.from({ length: amount }, (_, i) => top! + i));
      screen.write(out);
      expect(screen.snapshot()).toBe(fullRepaintSnapshot(state));
    }
  });

  test("a new message while following the bottom scrolls the pane up", () => {
    const state = chatState();
    const screen = new VtScreen(state.rows, state.cols);
    screen.write(captureRender(state));

    setTimelineMessages(state.timeline, "channel-1", [
      ...state.timeline.messages,
      message("31", "brand new"),
    ]);
    const out = captureRender(state);
    expect(out).toMatch(REGION_SCROLL);
    expect(REGION_SCROLL.exec(out)?.[4]).toBe("S");
    screen.write(out);
    expect(screen.text().join("\n")).toContain("brand new");
    expect(screen.snapshot()).toBe(fullRepaintSnapshot(state));
  });

  test("with the sidebar sharing the rows, scrolls repaint instead of using regions", () => {
    const state = chatState();
    state.sidebar.open = true;
    const screen = new VtScreen(state.rows, state.cols);
    screen.write(captureRender(state));

    state.timeline.scrollOffset = state.timeline.maxScroll - 2;
    const out = captureRender(state);
    expect(out).not.toMatch(REGION_SCROLL);
    expect(out).not.toMatch(/\x1b\[\d+[ST]/);
    screen.write(out);
    expect(screen.snapshot()).toBe(fullRepaintSnapshot(state));
  });

  test("jumps of a pane height or more repaint the pane", () => {
    const state = chatState({ messages: 60 });
    captureRender(state);
    state.timeline.scrollOffset = 0;
    const out = captureRender(state);
    expect(out).not.toMatch(REGION_SCROLL);
  });

  test("inline images are placed again at their scrolled rows", () => {
    const state = stateWithReadyInlineImage();
    setTimelineMessages(state.timeline, "channel-1", [
      ...state.timeline.messages,
      ...Array.from({ length: 30 }, (_, i) => message(String(i + 2), `after ${i}`)),
    ]);
    captureRender(state);
    state.timeline.scrollOffset = 0;
    const first = captureRender(state);
    const placedAt = /\x1b\[(\d+);(\d+)H\x1b_Ga=p,i=1073741825/.exec(first);
    expect(placedAt).not.toBeNull();

    state.timeline.scrollOffset = 1;
    const out = captureRender(state);
    expect(out).toMatch(REGION_SCROLL);
    const scrollAt = out.search(REGION_SCROLL);
    const replace = /\x1b\[(\d+);(\d+)H\x1b_Ga=p,i=1073741825/.exec(out);
    expect(replace).not.toBeNull();
    expect(Number(replace![1])).toBe(Number(placedAt![1]) - 1);
    // The placement follows the scroll, inside the same synchronized frame.
    expect(out.indexOf(replace![0])).toBeGreaterThan(scrollAt);
    expect(out.indexOf(replace![0])).toBeLessThan(out.indexOf("\x1b[?2026l"));
  });

  test("scrollRegions off keeps today's bytes (no SU/SD)", () => {
    const state = chatState();
    state.scrollRegions = false;
    const screen = new VtScreen(state.rows, state.cols);
    screen.write(captureRender(state));

    state.timeline.scrollOffset = state.timeline.maxScroll - 3;
    const out = captureRender(state);
    expect(out).not.toMatch(/\x1b\[\d+[ST]/);
    expect(out).not.toMatch(/\x1b\[\d+;\d+r/);
    screen.write(out);
    expect(screen.snapshot()).toBe(fullRepaintSnapshot(state));
  });
});


describe("the history cursor stays on its line while the view follows the bottom", () => {
  // Owner report (WhatsApp photo chat): after Ctrl+N, history arriving while the
  // view followed the bottom left the cursor on its old row number, i.e. on
  // another message far above the view, and the next Ctrl+U jumped there.
  function followingHistoryState(): ReturnType<typeof createInitialState> {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 20;
    setTimelineMessages(state.timeline, "channel-1", Array.from({ length: 40 }, (_, i) => message(String(100 + i), `line ${100 + i}`)));
    captureRender(state);
    focusHistory(state);
    state.historyCursorPendingVisibleBottom = true;
    captureRender(state);
    return state;
  }

  const cursorLine = (state: ReturnType<typeof createInitialState>) => state.historyLineAnchors[state.historyCursor.row];

  test("an older page arriving (history replaced, following the bottom) keeps the cursor on its line", () => {
    const state = followingHistoryState();
    const before = cursorLine(state);
    expect(before).toBeDefined();
    // Like a WhatsApp backfill: the whole history again with older messages before it.
    setTimelineMessages(state.timeline, "channel-1", [
      ...Array.from({ length: 30 }, (_, i) => message(String(10 + i), `older ${10 + i}`)),
      ...state.timeline.messages,
    ]);
    captureRender(state);
    expect(cursorLine(state)).toBe(before);
    // Still at the bottom, with the cursor in view.
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
    expect(state.historyCursor.row).toBeGreaterThanOrEqual(state.timeline.scrollOffset);
  });

  test("a new message arriving while following keeps the cursor on its line", () => {
    const state = followingHistoryState();
    const before = cursorLine(state);
    setTimelineMessages(state.timeline, "channel-1", [...state.timeline.messages, message("200", "brand new")]);
    captureRender(state);
    expect(cursorLine(state)).toBe(before);
  });
});

describe("scroll keys move the view from what is on screen", () => {
  // Owner report (WhatsApp photo chat): photos loading on screen pushed the
  // history cursor's line below the view; Ctrl+U then moved the view down to
  // reach it (the wrong way), and after new messages it jumped far up instead.
  function scrolledState(): ReturnType<typeof createInitialState> {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.cols = 80;
    state.rows = 20;
    setTimelineMessages(state.timeline, "channel-1", Array.from({ length: 80 }, (_, i) => message(String(100 + i), `line ${100 + i}`)));
    captureRender(state);
    focusHistory(state);
    state.timeline.scrollOffset = 60;
    captureRender(state);
    return state;
  }

  for (const [label, cursorRow] of [["below the view", 150], ["above the view", 5]] as const) {
    test(`with the cursor ${label}, Ctrl+U/D, Ctrl+E/Y and page keys scroll from the view`, async () => {
      const { scrollHistoryWithCursor, scrollHistoryPageWithCursor, scrollHistoryViewportSticky } = await import("./historycursor");
      const rows = 12;
      for (const [move, dir, expected] of [
        [(s: ReturnType<typeof createInitialState>) => scrollHistoryWithCursor(s, 1, 6, rows), 1, 54],
        [(s: ReturnType<typeof createInitialState>) => scrollHistoryWithCursor(s, -1, 6, rows), -1, 66],
        [(s: ReturnType<typeof createInitialState>) => scrollHistoryPageWithCursor(s, 1, rows, rows), 1, 48],
        [(s: ReturnType<typeof createInitialState>) => scrollHistoryViewportSticky(s, 1, rows), 1, 59],
      ] as const) {
        const state = scrolledState();
        state.historyCursor = { row: Math.min(cursorRow, state.historyLines.length - 1), col: 0 };
        move(state);
        expect(state.timeline.scrollOffset).toBe(expected);
        expect(Math.sign(state.timeline.scrollOffset - 60)).toBe(-dir);
        expect(state.historyCursor.row).toBeGreaterThanOrEqual(state.timeline.scrollOffset);
        expect(state.historyCursor.row).toBeLessThan(state.timeline.scrollOffset + rows);
      }
    });
  }
});
