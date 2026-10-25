import { describe, expect, test } from "bun:test";

import { createTimelineState, renderTimelineLines, setTimelineInlineImageState, setTimelineMessages, setTimelineRenderContext } from "./timeline";

const message = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, channelId: "c1", guildId: "g1", type: 0, content, mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], mentionUsers: [],
  timestamp: Date.UTC(2026, 0, 1, 12, Number(id)), editedTimestamp: null, author: { id: "u1", username: "alice", displayName: "Alice", bot: false },
  reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0, ...extra,
} as any);
const notice = { text: "", tone: "muted" as const };
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("timeline render cache", () => {
  test("refreshing the open chat reuses rendered messages but still shows every change", () => {
    const timeline = createTimelineState();
    setTimelineMessages(timeline, "c1", [message("1", "first"), message("2", "second")]);
    expect(plain(renderTimelineLines(timeline, 60, 20, notice).allLines)).toContain("second");

    // Same chat, a provider refresh: one message edited, one mutated in place.
    const mutated = message("1", "first");
    setTimelineMessages(timeline, "c1", [mutated, message("2", "second, edited", { editedTimestamp: 5 })], { preserveScroll: true });
    expect(plain(renderTimelineLines(timeline, 60, 20, notice).allLines)).toContain("second, edited");
    mutated.reactions = [{ emoji: { id: null, name: "🔥" }, count: 3, me: false }];
    setTimelineMessages(timeline, "c1", [mutated, message("2", "second, edited", { editedTimestamp: 5 })], { preserveScroll: true });
    expect(plain(renderTimelineLines(timeline, 60, 20, notice).allLines)).toContain("3");
  });

  test("role colour changes re-render authors in the open server", () => {
    const timeline = createTimelineState();
    const roles = { g1: [{ id: "r1", name: "Red", color: 0xff0000, position: 1 }] };
    const memberRoles: Record<string, Record<string, string[]>> = { g1: {} };
    setTimelineRenderContext(timeline, "viewer", false, roles, memberRoles, 0, "g1");
    setTimelineMessages(timeline, "c1", [message("1", "hello")]);
    const before = renderTimelineLines(timeline, 60, 20, notice).allLines.join("\n");
    memberRoles.g1!.u1 = ["r1"];
    setTimelineRenderContext(timeline, "viewer", false, roles, memberRoles, 1, "g1");
    const after = renderTimelineLines(timeline, 60, 20, notice).allLines.join("\n");
    expect(after).not.toBe(before);
  });
});

describe("live spinner frames", () => {
  test("re-rendering only loading-image messages gives the same rows as a full rebuild", () => {
    const attachment = (id: string) => ({ id, filename: `${id}.png`, contentType: "image/png", size: 10, url: `https://cdn.example/${id}.png`, width: 100, height: 80 });
    const messages = Array.from({ length: 40 }, (_unused, index) => message(String(index + 1), `line ${index}`, index % 7 === 3 ? { attachments: [attachment(`a${index}`)] } : {}));
    const build = (frame: number, fresh: boolean) => {
      const timeline = createTimelineState();
      setTimelineMessages(timeline, "c1", messages);
      for (const entry of messages) {
        for (const source of entry.attachments) setTimelineInlineImageState(timeline, { phase: "loading", attachmentId: source.id, filename: source.filename, sourceUrl: source.url, requestId: 1 });
      }
      if (!fresh) renderTimelineLines(timeline, 70, 30, notice, 0);
      return renderTimelineLines(timeline, 70, 30, notice, frame);
    };
    for (const frame of [1, 2, 5]) {
      const spliced = build(frame, false);
      const full = build(frame, true);
      expect(spliced.allLines).toEqual(full.allLines);
      expect(spliced.lineAnchors).toEqual(full.lineAnchors);
      expect(spliced.messageBounds).toEqual(full.messageBounds);
    }
  });
});
