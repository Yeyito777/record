import { describe, expect, test } from "bun:test";

import {
  appendTimelineMessage,
  createTimelineState,
  prependTimelineMessages,
  renderTimelineLines,
  setTimelineMessages,
  setTimelineRenderContext,
  startLoadingOlderMessages,
} from "./timeline";
import { ansiTrueColor, dmAuthorColor, theme } from "./theme";
import { termWidth } from "./textwidth";
import type { DiscordMessage } from "./discord";

function message(
  id: string,
  content: string,
  options: {
    authorId?: string;
    authorName?: string;
    bot?: boolean;
    reply?: DiscordMessage["reply"];
    call?: DiscordMessage["call"];
    timestamp?: number;
    type?: number;
    guildId?: string | null;
    roleIds?: string[];
    mentionUsers?: DiscordMessage["mentionUsers"];
  } = {},
): DiscordMessage {
  return {
    id,
    channelId: "channel-1",
    guildId: options.guildId,
    type: options.type ?? 0,
    timestamp: options.timestamp ?? Date.UTC(2026, 0, 1, 12, 0, 0),
    editedTimestamp: null,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: options.mentionUsers?.map((user) => user.id) ?? [],
    mentionUsers: options.mentionUsers,
    author: {
      id: options.authorId ?? "user-1",
      username: "tester",
      displayName: options.authorName ?? "Tester",
      bot: options.bot ?? false,
      roleIds: options.roleIds,
    },
    reply: options.reply ?? null,
    call: options.call ?? null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
  };
}

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("timeline rendering", () => {
  test("loading notices use the shared spinner label", () => {
    const timeline = createTimelineState();
    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "Validating token…", tone: "muted", loading: true },
      1,
    );

    expect(rendered.lines[0]).toContain("⠙ Validating token…");
  });

  test("status-only notices do not render into timeline content", () => {
    const timeline = createTimelineState();
    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "Downloading image.png…", tone: "muted", loading: true, chat: false },
      1,
    );

    expect(rendered.lines.join("\n")).not.toContain("Downloading image.png");
  });

  test("message loading uses the shared spinner label", () => {
    const timeline = createTimelineState();
    timeline.loading = true;

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain("⠋ Loading messages…");
  });

  test("shows message loading above live messages while the initial page loads", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("2", "from gateway")], { hasOlder: true });
    timeline.loading = true;

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines[0]).toBe("");
    expect(plainLines.some((line) => line.includes("⠋ Loading messages…"))).toBe(true);
    expect(plainLines.at(-1) ?? "").toContain("from gateway");
  });

  test("shows a top loader while fetching older messages", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("2", "newer")], { hasOlder: true });
    timeline.scrollOffset = 0;
    startLoadingOlderMessages(timeline);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain("⠋ Loading older messages…");
  });

  test("prepending older messages shifts scroll to preserve the current viewport", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("2", "newer")], { hasOlder: true });
    timeline.scrollOffset = 0;
    startLoadingOlderMessages(timeline);

    prependTimelineMessages(timeline, [message("1", "older")], 80, { hasOlder: false });

    expect(timeline.loadingOlder).toBe(false);
    expect(timeline.hasOlder).toBe(false);
    expect(timeline.messages.map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(timeline.scrollOffset).toBe(0);
  });

  test("reuses cached timeline content across identical redraws", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "before **bold** *italic* `code` after")]);

    const first = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );
    const second = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(second.allLines).toBe(first.allLines);
    expect(second.lineAnchors).toBe(first.lineAnchors);
    expect(second.wrapContinuation).toBe(first.wrapContinuation);
    expect(second.messageBounds).toBe(first.messageBounds);
  });

  test("invalidates cached timeline content after prepending older messages", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("2", "newer")], { hasOlder: true });

    const first = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    prependTimelineMessages(timeline, [message("1", "older **message**")], 80, { hasOlder: false });

    const second = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(second.allLines).not.toBe(first.allLines);
    expect(second.lines.map(stripAnsi).some((line) => line.includes("older message"))).toBe(true);
  });

  test("wraps wide unicode message content by terminal columns", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "memes＆media 【the🦋chat】 café")]);

    const rendered = renderTimelineLines(
      timeline,
      12,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    for (const line of plainLines.slice(1)) {
      expect(termWidth(line)).toBeLessThanOrEqual(12);
    }
  });

  test("renders inline markdown formatting in chat history", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "before **bold** *italic* `code` after")]);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("before bold italic code after");
    expect(rendered.lines[1]).not.toContain("**bold**");
    expect(rendered.lines[1]).not.toContain("*italic*");
    expect(rendered.lines[1]).not.toContain("`code`");
  });

  test("renders fenced code blocks with gutter and language label", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "```ts\nconst x = 1\n```")]);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines).toContain("▎ ts");
    expect(plainLines).toContain("▎ const x = 1");
  });

  test("renders markdown tables with box drawing", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "| Name | Value |\n| --- | --- |\n| foo | bar |")]);

    const rendered = renderTimelineLines(
      timeline,
      40,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines.some((line) => line.startsWith("┌"))).toBe(true);
    expect(plainLines.some((line) => line.includes("│ Name") && line.includes("│ Value "))).toBe(true);
    expect(plainLines.some((line) => line.startsWith("└"))).toBe(true);
  });

  test("renders reply previews above the message header", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "reply body", {
      reply: {
        messageId: "message-0",
        authorId: "author-0",
        authorDisplayName: "Alice",
        timestamp: Date.UTC(2026, 0, 1, 11, 59, 0),
        summary: "hello there [attachments] cat.png",
      },
    })]);

    const rendered = renderTimelineLines(
      timeline,
      28,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines[0]).toContain("↪ Alice · hello there");
    expect(plainLines[1]).toContain("[attachments] cat.png");
    expect(plainLines.some((line) => line.includes("Tester 12:00"))).toBe(true);
    expect(plainLines.some((line) => line.includes("reply body"))).toBe(true);
  });

  test("renders deleted reply previews", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "reply body", {
      reply: {
        messageId: "message-0",
        authorId: null,
        authorDisplayName: null,
        timestamp: null,
        summary: "Deleted message",
      },
    })]);

    const rendered = renderTimelineLines(
      timeline,
      28,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[0] ?? "")).toBe("↪ Deleted message");
  });

  test("renders the viewer display name in accent inside direct messages", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "hello", { authorId: "viewer", authorName: "Paramount" })]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      40,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain(theme.accent);
    expect(stripAnsi(rendered.lines[0] ?? "")).toContain("Paramount 12:00");
  });

  test("renders pending local messages muted", () => {
    const timeline = createTimelineState();
    const pending = message("local-1", "sending now", { authorId: "viewer", authorName: "Paramount" });
    pending.localStatus = "pending";
    setTimelineMessages(timeline, "channel-1", [pending]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      40,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[0] ?? "")).toContain("Paramount 12:00");
    expect(stripAnsi(rendered.lines[0] ?? "")).not.toContain("sending");
    expect(rendered.lines[1]).toContain(theme.muted);
    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("sending now");
  });

  test("replaces matching pending local messages when gateway echoes the sent message", () => {
    const timeline = createTimelineState();
    const pending = message("local-1", "hello", { authorId: "viewer", authorName: "Paramount" });
    pending.localStatus = "pending";
    setTimelineMessages(timeline, "channel-1", [pending]);

    appendTimelineMessage(timeline, message("real-1", "hello", { authorId: "viewer", authorName: "Paramount" }));

    expect(timeline.messages).toHaveLength(1);
    expect(timeline.messages[0]).toMatchObject({ id: "real-1", content: "hello" });
    expect(timeline.messages[0]?.localStatus).toBeUndefined();
  });

  test("replaces matching pending image uploads when gateway echoes the sent message", () => {
    const timeline = createTimelineState();
    const pending = message("local-1", "caption", { authorId: "viewer", authorName: "Paramount" });
    pending.localStatus = "pending";
    pending.attachments = [{ id: "local:0", filename: "image-1.png", contentType: "image/png", size: 1536, url: "" }];
    setTimelineMessages(timeline, "channel-1", [pending]);

    const echoed = message("real-1", "caption", { authorId: "viewer", authorName: "Paramount" });
    echoed.attachments = [{ id: "attachment-1", filename: "image-1.png", contentType: "image/png", size: 1536, url: "https://cdn.example/image-1.png" }];
    appendTimelineMessage(timeline, echoed);

    expect(timeline.messages).toHaveLength(1);
    expect(timeline.messages[0]).toMatchObject({ id: "real-1", content: "caption" });
    expect(timeline.messages[0]?.attachments[0]?.url).toBe("https://cdn.example/image-1.png");
    expect(timeline.messages[0]?.localStatus).toBeUndefined();
  });

  test("groups pending local messages with previous sent messages to avoid flicker", () => {
    const timeline = createTimelineState();
    const pending = message("local-2", "second", {
      authorId: "viewer",
      authorName: "Paramount",
      timestamp: Date.UTC(2026, 0, 1, 12, 1, 0),
    });
    pending.localStatus = "pending";
    setTimelineMessages(timeline, "channel-1", [
      message("message-1", "first", {
        authorId: "viewer",
        authorName: "Paramount",
        timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      }),
      pending,
    ]);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines.filter((line) => line.includes("Paramount 12:00"))).toHaveLength(1);
    expect(plainLines).not.toContain("");
    expect(plainLines[1]).toBe("first");
    expect(plainLines[2]).toBe("second");
    expect(rendered.lines[2]).toContain(theme.muted);
  });

  test("renders failed local messages with a visible failure line", () => {
    const timeline = createTimelineState();
    const failed = message("local-1", "try again", { authorId: "viewer", authorName: "Paramount" });
    failed.localStatus = "failed";
    failed.localError = "Discord denied access.";
    setTimelineMessages(timeline, "channel-1", [failed]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[0] ?? "")).toContain("Paramount 12:00 failed");
    expect(rendered.lines[0]).toContain(theme.error);
    expect(rendered.lines[1]).toContain(theme.muted);
    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("try again");
    expect(rendered.lines[2]).toContain(theme.failure);
    expect(stripAnsi(rendered.lines[2] ?? "")).toBe("✗ Discord denied access.");
  });

  test("groups quick consecutive messages from the same author", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [
      message("message-1", "first", {
        authorId: "viewer",
        authorName: "Paramount",
        timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      }),
      message("message-2", "second", {
        authorId: "viewer",
        authorName: "Paramount",
        timestamp: Date.UTC(2026, 0, 1, 12, 2, 0),
      }),
    ]);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines.filter((line) => line.includes("Paramount 12:00"))).toHaveLength(1);
    expect(plainLines).not.toContain("");
    expect(plainLines[1]).toBe("first");
    expect(plainLines[2]).toBe("second");
    expect(rendered.messageBounds.map((bound) => bound.groupId)).toEqual(["message-1", "message-1"]);
  });

  test("does not group messages from the same author after the grouping window", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [
      message("message-1", "first", {
        authorId: "viewer",
        authorName: "Paramount",
        timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      }),
      message("message-2", "second", {
        authorId: "viewer",
        authorName: "Paramount",
        timestamp: Date.UTC(2026, 0, 1, 12, 7, 0),
      }),
    ]);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines.some((line) => line.includes("Paramount 12:00"))).toBe(true);
    expect(plainLines.some((line) => line.includes("Paramount 12:07"))).toBe(true);
    expect(plainLines).toContain("");
  });

  test("renders sticker-only messages instead of empty message", () => {
    const timeline = createTimelineState();
    const sticker = message("message-1", "", { authorName: "Paramount" });
    sticker.stickerNames = ["catjam"];
    setTimelineMessages(timeline, "channel-1", [sticker]);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines).not.toContain("(empty message)");
    expect(plainLines[1]).toContain("[sticker] catjam");
  });

  test("renders attachments as individual openable-looking rows", () => {
    const timeline = createTimelineState();
    const withAttachments = message("message-1", "files", { authorName: "Paramount" });
    withAttachments.attachments = [
      { id: "a1", filename: "cat.png", contentType: "image/png", size: 1536, url: "https://cdn.example/cat.png" },
      { id: "a2", filename: "loop.gif", contentType: "image/gif", size: 2_200_000, url: "https://cdn.example/loop.gif" },
      { id: "a3", filename: "notes.pdf", contentType: "application/pdf", size: 42_000, url: "https://cdn.example/notes.pdf" },
    ];
    setTimelineMessages(timeline, "channel-1", [withAttachments]);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines[1]).toBe("files");
    expect(plainLines[2]).toBe("📎 cat.png • 1.5 KB");
    expect(plainLines[3]).toBe("📎 loop.gif • 2.1 MB");
    expect(plainLines[4]).toBe("📎 notes.pdf • 41 KB");
    expect(rendered.lines[2]).toContain(theme.accent);
    expect(rendered.lines[2]).toContain(theme.muted);
  });

  test("renders link embeds under their source line in muted color", () => {
    const timeline = createTimelineState();
    const linkEmbed = message("message-1", "first link https://example.com/story\nsecond link https://youtu.be/video", { authorName: "Paramount" });
    linkEmbed.embedsCount = 2;
    linkEmbed.embeds = [{
      type: "link",
      title: "Story title",
      url: "https://example.com/story",
      description: null,
      providerName: "Example News",
      authorName: null,
    }, {
      type: "video",
      title: "Video title",
      url: "https://youtu.be/video",
      description: null,
      providerName: "YouTube",
      authorName: null,
    }];
    const embedOnly = message("message-2", "", { authorName: "Paramount", timestamp: Date.UTC(2026, 0, 1, 12, 7, 0) });
    embedOnly.embedsCount = 2;
    setTimelineMessages(timeline, "channel-1", [linkEmbed, embedOnly]);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines).toContain("first link https://example.com/story");
    const firstLinkRow = plainLines.indexOf("first link https://example.com/story");
    expect(plainLines[firstLinkRow + 1]).toBe("↳ Example News: Story title");
    const secondLinkRow = plainLines.indexOf("second link https://youtu.be/video");
    expect(plainLines[secondLinkRow + 1]).toBe("↳ YouTube: Video title");
    expect(plainLines).toContain("↳ preview 1/2");
    expect(plainLines).toContain("↳ preview 2/2");
    expect(rendered.lines[firstLinkRow]).toContain(theme.accent);
    expect(rendered.lines[firstLinkRow + 1]).toContain(theme.muted);
    expect(rendered.lines[firstLinkRow + 1]).not.toContain(theme.accent);
    expect(plainLines).not.toContain("[embeds] 1");
  });

  test("renders guild authors with their highest colored role", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "hello", {
      authorId: "user-1",
      authorName: "Alice",
      guildId: "guild-1",
      roleIds: ["role-low", "role-high"],
    })]);
    setTimelineRenderContext(
      timeline,
      "viewer",
      false,
      { "guild-1": [
        { id: "role-low", color: 0xff0000, position: 1 },
        { id: "role-high", color: 0x00ff00, position: 3 },
      ] },
      {},
      1,
    );

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain(ansiTrueColor(0x00ff00));
    expect(rendered.lines[0]).not.toContain(ansiTrueColor(0xff0000));
  });

  test("renders guild authors with active channel guild when REST messages omit guild_id", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "hello", {
      authorId: "user-1",
      authorName: "Alice",
    })]);
    setTimelineRenderContext(
      timeline,
      "viewer",
      false,
      { "guild-1": [{ id: "role-1", color: 0x8844ff, position: 1 }] },
      { "guild-1": { "user-1": ["role-1"] } },
      1,
      "guild-1",
    );

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain(ansiTrueColor(0x8844ff));
  });

  test("renders guild authors with cached member role ids", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "hello", {
      authorId: "user-1",
      authorName: "Alice",
      guildId: "guild-1",
    })]);
    setTimelineRenderContext(
      timeline,
      "viewer",
      false,
      { "guild-1": [{ id: "role-1", color: 0x3366ff, position: 1 }] },
      { "guild-1": { "user-1": ["role-1"] } },
      1,
    );

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain(ansiTrueColor(0x3366ff));
  });

  test("renders @everyone and @here in accent color", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "ping @everyone and @here, not test@here", {
      guildId: "guild-1",
    })]);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("ping @everyone and @here, not test@here");
    expect(rendered.lines[1]?.match(new RegExp(theme.accent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).toHaveLength(2);
  });

  test("renders user mentions as colored display names in guild messages", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "hi <@123> and <@!456>", {
      guildId: "guild-1",
      mentionUsers: [
        { id: "123", username: "alice", displayName: "Alice", bot: false, roleIds: ["role-low", "role-high"] },
        { id: "456", username: "bravo", displayName: "Bravo", bot: false },
      ],
    })]);
    setTimelineRenderContext(
      timeline,
      "viewer",
      false,
      { "guild-1": [
        { id: "role-low", color: 0xff0000, position: 1 },
        { id: "role-high", color: 0x00ff00, position: 4 },
      ] },
      { "guild-1": { "456": ["role-low"] } },
      1,
    );

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("hi @Alice and @Bravo");
    expect(rendered.lines[1]).toContain(ansiTrueColor(0x00ff00));
    expect(rendered.lines[1]).toContain(ansiTrueColor(0xff0000));
  });

  test("renders user mentions with assigned direct-message colors", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "dm-1", [message("message-1", "cc <@123> <@999>", {
      mentionUsers: [
        { id: "123", username: "alice", displayName: "Alice", bot: false },
        { id: "999", username: "me", displayName: "Me", bot: false },
      ],
    })]);
    setTimelineRenderContext(timeline, "999", true);

    const rendered = renderTimelineLines(
      timeline,
      80,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("cc @Alice @Me");
    expect(rendered.lines[1]).toContain(dmAuthorColor("123"));
    expect(rendered.lines[1]).toContain(theme.accent);
  });

  test("renders other DM authors with deterministic colors", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "hello", { authorId: "other-user", authorName: "Alice" })]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      40,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(rendered.lines[0]).toContain(dmAuthorColor("other-user"));
    expect(rendered.lines[0]).not.toContain(theme.accent);
    expect(stripAnsi(rendered.lines[0] ?? "")).toContain("Alice 12:00");
  });

  test("renders call message types even when the call payload is missing", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("call-1", "", { type: 3 })]);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines).not.toContain("(empty message)");
    expect(plainLines[1]).toContain("☎ Call");
  });

  test("renders ended call messages with duration", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("call-1", "", {
      type: 3,
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
      call: {
        endedTimestamp: Date.UTC(2026, 0, 1, 13, 2, 3),
        participantIds: ["viewer", "other-user"],
      },
    })]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines).not.toContain("(empty message)");
    expect(plainLines[1]).toContain("✓ ☎ Call ended · 1:02:03 · 2 participants");
  });

  test("renders active calls with an animated frame and live duration", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("call-1", "", {
      type: 3,
      authorId: "other-user",
      authorName: "Alice",
      timestamp: Date.now() - 65_000,
      call: {
        endedTimestamp: null,
        participantIds: ["viewer", "other-user"],
      },
    })]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      1,
    );

    const plainLines = rendered.lines.map(stripAnsi);
    expect(plainLines[1]).toMatch(/^⠙ ☎ Call in progress · 1:0[45] · 2 participants$/);
  });

  test("renders incoming calls before the viewer joins", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("call-1", "", {
      type: 3,
      authorId: "other-user",
      authorName: "Alice",
      timestamp: Date.now() - 5_000,
      call: {
        endedTimestamp: null,
        participantIds: ["other-user"],
      },
    })]);
    setTimelineRenderContext(timeline, "viewer", true);

    const rendered = renderTimelineLines(
      timeline,
      60,
      10,
      { text: "", tone: "muted", loading: false },
      2,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toMatch(/^⠹ ☎ Incoming call · 0:0[45]$/);
  });

  test("renders markdown horizontal rules", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "channel-1", [message("message-1", "---")]);

    const rendered = renderTimelineLines(
      timeline,
      20,
      10,
      { text: "", tone: "muted", loading: false },
      0,
    );

    expect(stripAnsi(rendered.lines[1] ?? "")).toBe("────────────────────");
  });
});
