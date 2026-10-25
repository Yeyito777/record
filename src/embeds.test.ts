import { describe, expect, test } from "bun:test";

import { applyDiscordMessagePatch, mapDiscordEmbed, mapDiscordMessage, mapDiscordMessagePatch, type DiscordEmbedResponse, type DiscordMessage, type DiscordMessageResponse } from "./discord";
import { embedGroups, embedImageSources, embedMediaUrl, embedVideoTarget, parseEmbedSourceId } from "./embeds";
import { embedLinkAtHistoryCursor, embedMaskedLinkAt, embedVideoAtHistoryCursor, inlineImageBodyAttachmentAtHistoryCursor, openableTargetAtHistoryCursor } from "./historyopenable";
import { inlineImageSourcesForMessage } from "./inlineimage";
import { displayMessageParts, summarizeInlineMessageParts } from "./messageparts";
import { createInitialState, focusHistory } from "./state";
import { linkHintBlock } from "./statusblocks/linkhint";
import { ansiTrueColor, theme } from "./theme";
import { createTimelineState, renderTimelineLines, setTimelineImageDetails, setTimelineInlineImageState, setTimelineMessages, type TimelineState } from "./timeline";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const PROXY = "https://images-ext-1.discordapp.net/external/abc/https/pbs.twimg.com/media";

function media(name: string, width: number, height: number) {
  return { url: `https://pbs.twimg.com/media/${name}`, proxy_url: `${PROXY}/${name}`, width, height };
}

function message(id: string, content: string, embeds: DiscordEmbedResponse[], minute = 0): DiscordMessage {
  return {
    id,
    channelId: "c1",
    type: 0,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    timestamp: Date.UTC(2026, 9, 25, 12, minute),
    editedTimestamp: null,
    author: { id: `u${id}`, username: "ada", displayName: `Ada ${id}`, bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: embeds.length,
    embeds: embeds.map(mapDiscordEmbed),
  };
}

function render(timeline: TimelineState, width = 80) {
  const rendered = renderTimelineLines(timeline, width, 300, { text: "", tone: "muted" }, 0);
  return { ...rendered, plain: rendered.allLines.map((line) => stripAnsi(line).replace(/ +$/, "")) };
}

/** Mark every picture of the timeline's messages as drawn. */
function showAllImages(timeline: TimelineState): void {
  for (const entry of timeline.messages) {
    for (const source of inlineImageSourcesForMessage(entry)) {
      setTimelineInlineImageState(timeline, {
        phase: "ready", attachmentId: source.id, filename: source.filename, sourceUrl: source.url, requestId: 1,
        imageId: 0x40000001, pngBase64: PNG, pixelWidth: source.width ?? 400, pixelHeight: source.height ?? 300,
      });
    }
  }
}

const TWEET: DiscordEmbedResponse = {
  type: "rich",
  url: "https://fxtwitter.com/ada/status/1",
  color: 0x1da1f2,
  author: { name: "Ada (@ada)", url: "https://x.com/ada", icon_url: "https://pbs.twimg.com/a.jpg", proxy_icon_url: `${PROXY}/a.jpg` },
  provider: { name: "FxTwitter", url: "https://github.com/FixTweet/FxTwitter" },
  description: "shipped **smooth scrolling** today",
  footer: { text: "FxTwitter", icon_url: "https://fx/icon.png" },
  timestamp: "2026-10-24T18:42:00.000Z",
  image: media("shot.jpg", 1600, 900),
};

const QUICKVIDS: DiscordEmbedResponse = {
  type: "video",
  url: "https://d.xeezz.com/ada/status/2",
  video: { url: "https://d.xeezz.com/ada/status/2/video.mp4", proxy_url: "https://images-ext-1.discordapp.net/external/v/https/d.xeezz.com/ada/status/2/video.mp4", width: 720, height: 1280 },
};

describe("embed mapping", () => {
  test("keeps every field Discord sends", () => {
    const embed = mapDiscordEmbed({
      ...TWEET,
      fields: [{ name: "Likes", value: "12", inline: true }, { name: "", value: "", inline: false }],
      thumbnail: media("t.png", 80, 80),
      video: { url: "https://v/x.mp4", width: 640, height: 360, duration: 42 },
    });
    expect(embed).toEqual({
      type: "rich",
      title: null,
      url: "https://fxtwitter.com/ada/status/1",
      description: "shipped **smooth scrolling** today",
      providerName: "FxTwitter",
      authorName: "Ada (@ada)",
      providerUrl: "https://github.com/FixTweet/FxTwitter",
      authorUrl: "https://x.com/ada",
      // Discord's proxy is preferred for icons too.
      authorIconUrl: `${PROXY}/a.jpg`,
      color: 0x1da1f2,
      timestamp: Date.parse("2026-10-24T18:42:00.000Z"),
      footer: { text: "FxTwitter", iconUrl: "https://fx/icon.png" },
      // Empty fields are dropped.
      fields: [{ name: "Likes", value: "12", inline: true }],
      image: { url: "https://pbs.twimg.com/media/shot.jpg", proxyUrl: `${PROXY}/shot.jpg`, width: 1600, height: 900 },
      thumbnail: { url: "https://pbs.twimg.com/media/t.png", proxyUrl: `${PROXY}/t.png`, width: 80, height: 80 },
      video: { url: "https://v/x.mp4", proxyUrl: null, width: 640, height: 360, durationSecs: 42 },
    });
  });

  test("forwarded and referenced messages carry full embeds", () => {
    const mapped = mapDiscordMessage({
      id: "m2", channel_id: "c1", content: "", timestamp: "2026-10-25T12:00:00.000Z", edited_timestamp: null,
      author: { id: "u", username: "u" },
      message_reference: { type: 1, message_id: "m0", channel_id: "c0" },
      message_snapshots: [{ message: { content: "look", embeds: [TWEET] } }],
    } as DiscordMessageResponse);
    expect(mapped.forwarded?.embeds[0]?.image?.proxyUrl).toBe(`${PROXY}/shot.jpg`);
    expect(mapped.forwarded?.embeds[0]?.color).toBe(0x1da1f2);
  });

  test("a late unfurl (partial MESSAGE_UPDATE) adds embeds and keeps the text", () => {
    const original = message("m1", "https://fxtwitter.com/ada/status/1", []);
    const patch = mapDiscordMessagePatch({ id: "m1", channel_id: "c1", embeds: [TWEET] });
    expect(patch.content).toBeUndefined();
    const updated = applyDiscordMessagePatch(original, patch);
    expect(updated.content).toBe(original.content);
    expect(updated.embeds?.[0]?.authorName).toBe("Ada (@ada)");
    expect(updated.embedsCount).toBe(1);
  });

  test("SUPPRESS_EMBEDS removes the embeds, even if the update still lists them", () => {
    const original = message("m1", "https://fxtwitter.com/ada/status/1", [TWEET]);
    const patch = mapDiscordMessagePatch({ id: "m1", channel_id: "c1", flags: 4, embeds: [TWEET] });
    const updated = applyDiscordMessagePatch(original, patch);
    expect(updated.embeds).toEqual([]);
    expect(updated.embedsCount).toBe(0);
    // Other flags leave them alone.
    expect(applyDiscordMessagePatch(original, mapDiscordMessagePatch({ id: "m1", channel_id: "c1", flags: 2, embeds: [TWEET] })).embeds).toHaveLength(1);
  });
});

describe("embed media", () => {
  test("asks Discord's proxy for no more pixels than a chat row uses; other hosts get the URL as is", () => {
    const sized = new URL(embedMediaUrl({ url: "https://o/x.jpg", proxyUrl: `${PROXY}/x.jpg?format=webp`, width: 2560, height: 1440 }, { width: 1280, height: 720 }));
    expect(sized.searchParams.get("width")).toBe("1280");
    expect(sized.searchParams.get("height")).toBe("720");
    expect(sized.searchParams.get("format")).toBe("webp");
    // Small pictures are not enlarged.
    expect(embedMediaUrl({ url: "https://o/x.jpg", proxyUrl: `${PROXY}/x.jpg`, width: 80, height: 80 }, { width: 400, height: 400 })).toBe(`${PROXY}/x.jpg`);
    expect(embedMediaUrl({ url: "https://o/x.jpg", proxyUrl: "https://elsewhere.example/x.jpg", width: 4000, height: 4000 }, { width: 400, height: 400 })).toBe("https://elsewhere.example/x.jpg");
    expect(embedMediaUrl({ url: "https://o/x.jpg", proxyUrl: null, width: 4000, height: 4000 }, { width: 400, height: 400 })).toBe("https://o/x.jpg");
  });

  test("pictures become inline-image sources with stable ids and roles", () => {
    const article = message("m1", "", [{ type: "article", url: "https://n.example/a", title: "A", thumbnail: media("t.png", 400, 250), image: media("i.png", 1200, 600) }]);
    const sources = inlineImageSourcesForMessage(article);
    expect(sources.map((source) => parseEmbedSourceId(source.id)?.role)).toEqual(["image", "thumbnail"]);
    expect(sources.every((source) => source.contentType?.startsWith("image/") && source.size === 0)).toBe(true);
    expect(sources[0]!.cacheKey).toContain("discord-embed:");
  });

  test("a video's poster is its thumbnail, else a still from Discord's proxy, else nothing", () => {
    const withThumb = embedImageSources(message("m1", "", [{ ...QUICKVIDS, thumbnail: media("p.jpg", 720, 1280) }]));
    expect(withThumb).toHaveLength(1);
    expect(withThumb[0]!.url).toContain("p.jpg");
    const proxied = embedImageSources(message("m2", "", [QUICKVIDS]));
    expect(proxied).toHaveLength(1);
    expect(new URL(proxied[0]!.url).searchParams.get("format")).toBe("jpeg");
    expect(parseEmbedSourceId(proxied[0]!.id)?.role).toBe("poster");
    const unproxied = embedImageSources(message("m3", "", [{ ...QUICKVIDS, video: { url: "https://d.xeezz.com/v.mp4" } }]));
    expect(unproxied).toEqual([]);
  });

  test("same-URL image-only embeds fold into a gallery; exact duplicates drop", () => {
    const url = "https://twitter.com/ada/status/3";
    const groups = embedGroups([
      mapDiscordEmbed({ type: "rich", url, description: "three", image: media("1.jpg", 640, 480) }),
      mapDiscordEmbed({ url, image: media("2.jpg", 640, 480) }),
      mapDiscordEmbed({ url, image: media("3.jpg", 640, 480) }),
      mapDiscordEmbed({ type: "link", url: "https://other.example", title: "Other" }),
      mapDiscordEmbed({ type: "link", url: "https://other.example", title: "Other" }),
    ], "m1");
    expect(groups.map((group) => group.index)).toEqual([0, 3]);
    expect(groups[0]!.media.map((source) => source.attachment.id)).toEqual(["embed:m1:0:image", "embed:m1:1:image", "embed:m1:2:image"]);
  });

  test("videos open as files (attachments) or pages; Tenor keeps its gif path", () => {
    const file = embedVideoTarget(mapDiscordEmbed(QUICKVIDS), "m1", 0);
    expect(file?.kind).toBe("file");
    if (file?.kind === "file") {
      expect(file.attachment.filename).toBe("video.mp4");
      expect(file.attachment.url).toBe(QUICKVIDS.video!.proxy_url!);
    }
    const youtube = embedVideoTarget(mapDiscordEmbed({ type: "video", url: "https://www.youtube.com/watch?v=x", video: { url: "https://www.youtube.com/embed/x" } }), "m1", 0);
    expect(youtube).toEqual({ kind: "link", url: "https://www.youtube.com/watch?v=x" });
    const tenor = embedVideoTarget(mapDiscordEmbed({ type: "gifv", url: "https://tenor.com/view/x-1", provider: { name: "Tenor" }, video: { url: "https://media.tenor.com/x.mp4" } }), "m1", 0);
    expect(tenor).toEqual({ kind: "link", url: "https://tenor.com/view/x-1" });
    expect(embedVideoTarget(mapDiscordEmbed({ type: "link", url: "https://e.example" }), "m1", 0)).toBeNull();
  });
});

describe("embed placement in text", () => {
  test("an embed goes right under its URL's line, never inside a code block", () => {
    const parts = displayMessageParts("see\n```\nhttps://a.example\n```\nafter", [], [{ url: "https://a.example" }]);
    expect(parts.map((part) => part.kind === "text" ? part.text : "EMBED")).toEqual(["see\n```\nhttps://a.example\n```", "EMBED", "after"]);
    expect(parts[1]).toMatchObject({ placed: true });
  });

  test("inline summaries (reply previews) never say 'preview'", () => {
    expect(summarizeInlineMessageParts("", [], [{ type: "video", url: "https://d.xeezz.com/a/status/1", video: {} }])).toBe("↳ ▶ d.xeezz.com");
    expect(summarizeInlineMessageParts("hi", [], 2)).toBe("hi");
    expect(summarizeInlineMessageParts("", [], [{ title: "Story", providerName: "News" }])).toBe("↳ News: Story");
  });
});

describe("embed layout", () => {
  test("a rich embed: coloured bar, author, description, footer under its picture", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [message("m1", "https://fxtwitter.com/ada/status/1", [TWEET])]);
    showAllImages(timeline);
    const rendered = render(timeline);
    const link = rendered.plain.indexOf("https://fxtwitter.com/ada/status/1");
    expect(rendered.plain.slice(link + 1, link + 3)).toEqual(["▎ Ada (@ada)", "▎ shipped smooth scrolling today"]);
    // The bar takes the embed's colour.
    expect(rendered.allLines[link + 1]!.startsWith(`${theme.text}${ansiTrueColor(0x1da1f2)}▎`)).toBe(true);
    const image = rendered.inlineImages[0]!;
    expect(image.lineIndex).toBe(link + 3);
    expect(image.columnOffset).toBe(2);
    expect(rendered.plain[image.lineIndex + image.rows]).toBe("▎ FxTwitter");
    // The provider row and timestamp are details (Ctrl+O).
    expect(rendered.plain.some((line) => line.includes("FxTwitter / ") || line.includes("2026"))).toBe(false);
    setTimelineImageDetails(timeline, true);
    const detailed = render(timeline);
    expect(detailed.plain[link + 1]).toBe("▎ FxTwitter");
    expect(detailed.plain.some((line) => /FxTwitter • Oct 24, \d\d:42/.test(line))).toBe(true);
  });

  test("a video-only embed (QuickVids) is its poster with a play row, not 'preview'", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [message("m1", "https://d.xeezz.com/ada/status/2", [QUICKVIDS])]);
    let rendered = render(timeline);
    // Before the poster loads (or with /images hide): one text row naming it.
    expect(rendered.plain).toContain("▶ video · d.xeezz.com");
    expect(rendered.plain.some((line) => line.includes("preview"))).toBe(false);
    showAllImages(timeline);
    rendered = render(timeline);
    const poster = rendered.inlineImages[0]!;
    expect(poster.columnOffset).toBe(0);
    expect(rendered.plain[poster.lineIndex + poster.rows]).toBe("▶ Play");
  });

  test("a thumbnail sits at the right of the text when there is room, below it when not", () => {
    const article: DiscordEmbedResponse = {
      type: "article", url: "https://n.example/a", title: "Why terminals are having a moment",
      description: "A long description that wraps onto several lines beside the thumbnail in the message pane.",
      provider: { name: "Example News" }, thumbnail: media("t.png", 400, 400),
    };
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [message("m1", "read https://n.example/a", [article])]);
    showAllImages(timeline);
    const wide = render(timeline, 80);
    const thumb = wide.inlineImages[0]!;
    expect(thumb.columnOffset).toBeGreaterThan(40);
    // Rows beside it end exactly where it starts (render.ts restores the cells under it).
    for (let row = thumb.lineIndex; row < thumb.lineIndex + thumb.rows; row++) {
      expect(stripAnsi(wide.allLines[row]!).length).toBe(thumb.columnOffset!);
    }
    expect(wide.lineAnchors[thumb.lineIndex]).toContain(":embed:m1:0:title:0");
    const narrow = render(timeline, 34);
    const below = narrow.inlineImages[0]!;
    expect(below.columnOffset).toBe(2);
    expect(narrow.lineAnchors[below.lineIndex]).toBe("msg:m1:image:embed%3Am1%3A0%3Athumbnail:0");
  });

  test("inline fields sit side by side when they fit, stacked when not; long descriptions are capped", () => {
    const stats: DiscordEmbedResponse = {
      type: "rich", title: "Stats", color: 0x57f287,
      description: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
      fields: [{ name: "Members", value: "1,204", inline: true }, { name: "Online", value: "312", inline: true }, { name: "Note", value: "not inline", inline: false }],
      footer: { text: "Stats bot" },
    };
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [message("m1", "", [stats])]);
    const wide = render(timeline, 80);
    // A third of the width each (78 cells: 24-cell columns, 2-cell gaps).
    expect(wide.plain).toContain(`▎ Members${" ".repeat(19)}Online`);
    expect(wide.plain).toContain(`▎ 1,204${" ".repeat(21)}312`);
    expect(wide.plain).toContain("▎ Note");
    expect(wide.plain).toContain("▎ line 6…");
    expect(wide.plain).not.toContain("▎ line 7");
    expect(wide.plain.at(-1)).toBe("▎ Stats bot");
    const narrow = render(timeline, 30);
    expect(narrow.plain).toContain("▎ Members");
    expect(narrow.plain).toContain("▎ Online");
    setTimelineImageDetails(timeline, true);
    expect(render(timeline, 80).plain).toContain("▎ line 12");
  });

  test("a link embed with nothing but its URL is not drawn twice", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [
      message("m1", "https://example.com", [{ type: "link", url: "https://example.com" }]),
      message("m2", "", [{ type: "link", url: "https://example.org/page" }], 10),
    ]);
    const rendered = render(timeline);
    expect(rendered.plain.filter((line) => line.includes("example.com"))).toEqual(["https://example.com"]);
    // Elsewhere the host names it.
    expect(rendered.plain).toContain("▎ example.org");
  });

  test("a gallery draws its pictures side by side", () => {
    const url = "https://twitter.com/ada/status/3";
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [message("m1", url, [
      { type: "rich", url, description: "three", image: media("1.jpg", 640, 480) },
      { url, image: media("2.jpg", 640, 480) },
      { url, image: media("3.jpg", 640, 480) },
    ])]);
    showAllImages(timeline);
    const rendered = render(timeline);
    const [first, second, third] = rendered.inlineImages;
    expect(first!.lineIndex).toBe(second!.lineIndex);
    expect(second!.columnOffset).toBe(first!.columnOffset! + first!.columns + 1);
    expect(third!.lineIndex).toBe(first!.lineIndex + first!.rows);
  });

  test("text rows keep their anchors when an embed arrives between them", () => {
    const before = message("m1", "first https://a.example\nsecond line", []);
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [before]);
    const plain = render(timeline);
    const after = { ...before, embeds: [mapDiscordEmbed({ type: "link", url: "https://a.example", title: "A" })], embedsCount: 1 };
    setTimelineMessages(timeline, "c1", [after]);
    const unfurled = render(timeline);
    expect(unfurled.plain).toEqual(["Ada m1 " + plain.plain[0]!.slice("Ada m1 ".length), "first https://a.example", "▎ A", "second line"]);
    expect(unfurled.lineAnchors.filter((anchor) => anchor.includes(":content:"))).toEqual(plain.lineAnchors.filter((anchor) => anchor.includes(":content:")));
  });
});

describe("embed targets in history", () => {
  function historyState(messages: DiscordMessage[], width = 80) {
    const state = createInitialState(null, "/tmp/record-config.json");
    setTimelineMessages(state.timeline, "c1", messages);
    showAllImages(state.timeline);
    const rendered = renderTimelineLines(state.timeline, width, 300, { text: "", tone: "muted" }, 0);
    state.historyLines = rendered.allLines;
    state.historyLineAnchors = rendered.lineAnchors;
    state.historyMessageBounds = rendered.messageBounds;
    state.historyInlineImages = rendered.inlineImages;
    state.historyWrapContinuation = rendered.wrapContinuation;
    return { state, rendered };
  }

  test("a title opens its link; the poster and play row open the video", () => {
    const youtube: DiscordEmbedResponse = {
      type: "video", url: "https://www.youtube.com/watch?v=x", title: "Smooth scrolling explained",
      author: { name: "Demo Channel", url: "https://www.youtube.com/@demo" },
      thumbnail: media("yt.jpg", 1280, 720), video: { url: "https://www.youtube.com/embed/x", width: 1280, height: 720 },
    };
    const { state, rendered } = historyState([message("m1", "watch https://www.youtube.com/watch?v=x", [youtube])]);
    const row = (part: string) => rendered.lineAnchors.findIndex((anchor) => anchor.includes(part));
    state.historyCursor = { row: row(":title:0"), col: 4 };
    expect(embedLinkAtHistoryCursor(state)).toBe("https://www.youtube.com/watch?v=x");
    state.historyCursor = { row: row(":author:0"), col: 4 };
    expect(embedLinkAtHistoryCursor(state)).toBe("https://www.youtube.com/@demo");
    state.historyCursor = { row: row(":image:") + 1, col: 0 };
    expect(embedVideoAtHistoryCursor(state)).toEqual({ kind: "link", url: "https://www.youtube.com/watch?v=x" });
    state.historyCursor = { row: row(":video:0"), col: 2 };
    expect(embedVideoAtHistoryCursor(state)).toEqual({ kind: "link", url: "https://www.youtube.com/watch?v=x" });
    // A title is not a video.
    state.historyCursor = { row: row(":title:0"), col: 4 };
    expect(embedVideoAtHistoryCursor(state)).toBeNull();
  });

  test("a click on a thumbnail or the second gallery picture opens that picture", () => {
    const url = "https://twitter.com/ada/status/3";
    const { state, rendered } = historyState([message("m1", url, [
      { type: "rich", url, description: "three", image: media("1.jpg", 640, 480) },
      { url, image: media("2.jpg", 640, 480) },
    ])]);
    const second = rendered.inlineImages[1]!;
    state.historyCursor = { row: second.lineIndex + 1, col: second.columnOffset! + 1 };
    expect(inlineImageBodyAttachmentAtHistoryCursor(state)?.id).toBe("embed:m1:1:image");
    expect(embedVideoAtHistoryCursor(state)).toBeNull();
  });

  test("masked links in descriptions and field values open their URL; the label stays text-only", () => {
    const bot: DiscordEmbedResponse = {
      type: "rich", title: "Release", color: 0x24292f,
      // "View on GitHub" wraps onto the next row at width 40.
      description: "Built and shipped, all green. [View on GitHub](https://github.com/example/record) and read the [full release notes](https://record.example/notes \"Notes\") today.",
      fields: [{ name: "Links", value: "[Jump to message](https://discord.com/channels/1/2/3) · [Changelog](https://record.example/log)", inline: false }],
    };
    const { state, rendered } = historyState([message("m1", "", [bot])], 40);
    const plain = rendered.allLines.map(stripAnsi);
    // No URL is drawn, the labels are in the link colour.
    expect(plain.some((line) => line.includes("https://"))).toBe(false);
    expect(rendered.allLines.some((line) => line.includes(`${theme.accent}full release notes`))).toBe(true);
    const at = (needle: string, offset = 0) => {
      const row = plain.findIndex((line) => line.includes(needle));
      return { row, col: plain[row]!.indexOf(needle) + offset };
    };
    const open = (position: { row: number; col: number }) => {
      state.historyCursor = position;
      return openableTargetAtHistoryCursor(state);
    };
    expect(open(at("full release notes", 5))).toBe("https://record.example/notes");
    expect(embedMaskedLinkAt(state, at("Jump to", 2))).toBe("https://discord.com/channels/1/2/3");
    expect(open(at("Changelog"))).toBe("https://record.example/log");
    // A label wrapped onto two rows opens from either.
    const wrappedStart = plain.findIndex((line) => line.endsWith("View on"));
    expect(wrappedStart).toBeGreaterThan(0);
    expect(plain[wrappedStart + 1]!.startsWith("▎ GitHub")).toBe(true);
    expect(rendered.wrapContinuation[wrappedStart + 1]).toBe(true);
    expect(open({ row: wrappedStart, col: plain[wrappedStart]!.lastIndexOf("View") })).toBe("https://github.com/example/record");
    expect(open({ row: wrappedStart + 1, col: 3 })).toBe("https://github.com/example/record");
    // Plain words next to a label open nothing.
    expect(open(at("Built", 1))).toBeNull();
    expect(open(at("today", 1))).toBeNull();
    // The status line shows where the cursor's link goes.
    focusHistory(state);
    state.historyCursor = at("Changelog", 2);
    expect(linkHintBlock(state)?.rows[0]).toContain("↗ https://record.example/log");
    state.historyCursor = at("Built", 1);
    expect(linkHintBlock(state)).toBeNull();
  });
});
