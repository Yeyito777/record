import { describe, expect, test } from "bun:test";

import { buildDemoInstagramData, DEMO_INSTAGRAM_PHOTOS_THREAD, DEMO_INSTAGRAM_SHARES_THREAD, DemoInstagramCdn, DemoInstagramClient } from "./instagram";

describe("demo Instagram", () => {
  const data = () => buildDemoInstagramData(Date.UTC(2026, 9, 25, 15, 0));

  test("chats carry shares with and without preview sizes, media with sizes, and the other kinds", () => {
    const world = data();
    const shares = world.threads.find((thread) => thread.id === DEMO_INSTAGRAM_SHARES_THREAD)!.messages;
    const kinds = new Set(shares.map((message) => message.content.kind === "share" ? `share:${message.content.share.kind}` : message.content.kind));
    for (const kind of ["share:post", "share:reel", "share:story", "share:link", "media", "sticker", "animated", "voice", "text", "system"]) {
      expect(kinds.has(kind)).toBe(true);
    }
    const previews = shares.flatMap((message) => message.content.kind === "share" && message.content.share.preview ? [message.content.share] : []);
    expect(previews.some((share) => share.previewWidth > 0)).toBe(true);
    expect(previews.some((share) => share.previewWidth === 0)).toBe(true);
    const photos = world.threads.find((thread) => thread.id === DEMO_INSTAGRAM_PHOTOS_THREAD)!.messages
      .flatMap((message) => message.content.kind === "media" ? message.content.items : []);
    expect(photos.length).toBeGreaterThan(30);
    expect(photos.every((item) => item.width > 0 && item.height > 0)).toBe(true);
    expect(photos.some((item) => item.height / item.width > 4)).toBe(true);
    expect(photos.some((item) => item.width / item.height > 4)).toBe(true);
    // The same world every run.
    expect(data().threads).toEqual(world.threads);
  });

  test("the inbox carries reduced previews; threads page older history; the CDN serves the size the URL names after a delay", async () => {
    const world = data();
    const client = new DemoInstagramClient({ data: world, olderPageDelayMs: 30, latencyMs: 0 });
    const inbox = await client.inbox();
    expect(inbox.threads.length).toBe(4);
    expect(inbox.threads.every((thread) => thread.messages.length <= 5 && !thread.detailLoaded)).toBe(true);
    const thread = await client.thread(DEMO_INSTAGRAM_SHARES_THREAD, "");
    expect(thread.messages.length).toBe(20);
    expect(thread.hasOlder).toBe(true);
    const started = performance.now();
    const older = await client.olderMessages(DEMO_INSTAGRAM_SHARES_THREAD, thread.cursor!);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(older.messages.length).toBe(20);
    expect(older.messages.every((message) => message.timestampMs < thread.messages[0]!.timestampMs)).toBe(true);

    const cdn = new DemoInstagramCdn({ minDelayMs: 50, maxDelayMs: 120 });
    const share = thread.messages.concat(older.messages).flatMap((message) => message.content.kind === "share" && message.content.share.preview ? [message.content.share.preview] : [])[0]!;
    const fetchStarted = performance.now();
    const response = await cdn.fetch(new URL(share), null);
    expect(performance.now() - fetchStarted).toBeGreaterThanOrEqual(45);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([0xffd8, 0x8950]).toContain(bytes.readUInt16BE(0));
  });
});
