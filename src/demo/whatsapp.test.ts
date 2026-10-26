import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDemoWhatsAppData, DEMO_WHATSAPP_PHOTOS_CHAT, DemoWhatsAppBackend } from "./whatsapp";
import type { WhatsAppHistoryEvent } from "../whatsapp/types";

describe("demo WhatsApp", () => {
  const data = () => buildDemoWhatsAppData(Date.UTC(2026, 9, 25, 15, 0));

  test("one chat is nearly all photos of real sizes, a few without dimensions, some with captions", () => {
    const messages = data().messagesByChatId.get(DEMO_WHATSAPP_PHOTOS_CHAT)!;
    const photos = messages.filter((message) => message.content.kind === "media");
    expect(photos.length).toBeGreaterThanOrEqual(200);
    expect(photos.length / messages.length).toBeGreaterThan(0.85);
    const media = photos.map((message) => message.content as Extract<typeof message.content, { kind: "media" }>);
    expect(new Set(media.map((content) => `${content.width}x${content.height}`)).size).toBeGreaterThan(8);
    expect(media.filter((content) => content.width === undefined).length).toBeGreaterThan(0);
    expect(media.filter((content) => content.caption).length).toBeGreaterThan(10);
    // The same world every run.
    expect(data().messagesByChatId.get(DEMO_WHATSAPP_PHOTOS_CHAT)).toEqual(messages);
  });

  test("connects with the recent messages, pages older history after a delay, and downloads media after 100-800 ms", async () => {
    const world = data();
    const backend = new DemoWhatsAppBackend({ data: world, olderPageDelayMs: 20, mediaDelayMinMs: 100, mediaDelayMaxMs: 800 });
    const histories: WhatsAppHistoryEvent[] = [];
    backend.on("history", (event) => { histories.push(event); });
    expect(await backend.startLogin()).toMatchObject({ status: "connected" });
    expect(backend.isConnected).toBe(true);
    const recent = histories[0]!.messages.filter((message) => message.chatId === DEMO_WHATSAPP_PHOTOS_CHAT);
    expect(recent.length).toBe(40);

    const oldest = recent[0]!;
    const requestId = await backend.fetchHistory(50, oldest.key, oldest.timestampMs!);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const page = histories.find((event) => event.requestId === requestId)!;
    expect(page.syncKind).toBe("on-demand");
    expect(page.messages.length).toBe(50);
    expect(page.messages.every((message) => message.timestampMs! < oldest.timestampMs!)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "record-demo-wa-"));
    try {
      const photo = recent.find((message) => message.content.kind === "media")!;
      const started = performance.now();
      const result = await backend.downloadMedia(photo, join(dir, "photo"));
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(95);
      expect(elapsed).toBeLessThan(2_500);
      const bytes = readFileSync(result.path);
      expect(bytes.length).toBe(result.sizeBytes);
      // JPEG from ffmpeg, PNG without it.
      expect([0xffd8, 0x8950]).toContain(bytes.readUInt16BE(0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await backend.shutdown();
    }
  });
});
