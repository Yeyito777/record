import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCallWidgetCommand, cacheCallWidgetAvatar, cachedCallWidgetAvatarPath, callWidgetAvatarCachePath, defaultDiscordAvatarIndex, discordAvatarUrl, isCallWidgetAvatarImage, isDefaultDiscordAvatarUrl, stabilizeCallWidgetParticipantAvatars } from "./callwidget";

describe("call widget", () => {
  test("builds the external widget command", () => {
    expect(buildCallWidgetCommand("/tmp/widget")).toEqual(["/tmp/widget"]);
  });

  test("builds Discord avatar URLs", () => {
    expect(discordAvatarUrl("123", "hash", "0")).toBe("https://cdn.discordapp.com/avatars/123/hash.png?size=128");
    expect(discordAvatarUrl("123", "a_hash", "0")).toBe("https://cdn.discordapp.com/avatars/123/a_hash.gif?size=128");
  });

  test("falls back to default Discord avatars", () => {
    expect(defaultDiscordAvatarIndex("175928847299117063", "1337")).toBe(2);
    expect(discordAvatarUrl("175928847299117063", null, "1337")).toBe("https://cdn.discordapp.com/embed/avatars/2.png");
    expect(discordAvatarUrl("175928847299117063", null, "0")).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    expect(isDefaultDiscordAvatarUrl("https://cdn.discordapp.com/embed/avatars/2.png")).toBe(true);
    expect(isDefaultDiscordAvatarUrl("https://cdn.discordapp.com/avatars/123/hash.png?size=128")).toBe(false);
  });

  test("keeps a previously known custom avatar instead of regressing to a default avatar", () => {
    const memory = new Map<string, string>();
    const custom = discordAvatarUrl("123", "hash", null);
    const fallback = discordAvatarUrl("123", null, null);

    const first = stabilizeCallWidgetParticipantAvatars([{ id: "123", name: "Doggy", avatarUrl: custom, speaking: false, self: false }], memory);
    expect(first[0]?.avatarUrl).toBe(custom);

    const second = stabilizeCallWidgetParticipantAvatars([{ id: "123", name: "Doggy", avatarUrl: fallback, speaking: true, self: false }], memory);
    expect(second[0]?.avatarUrl).toBe(custom);
    expect(second[0]?.speaking).toBe(true);
  });

  test("recognizes supported avatar image formats", () => {
    expect(isCallWidgetAvatarImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isCallWidgetAvatarImage(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isCallWidgetAvatarImage(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });

  test("downloads avatars atomically and reuses the validated local cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "record-call-widget-avatar-"));
    const url = "https://cdn.discordapp.com/avatars/123/hash.png?size=128";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    let fetches = 0;
    const fetchAvatar = (async () => {
      fetches += 1;
      return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
    }) as unknown as typeof fetch;

    try {
      const path = await cacheCallWidgetAvatar(url, { cacheDir, fetchAvatar });
      expect(path).toBe(callWidgetAvatarCachePath(url, cacheDir));
      expect(path && existsSync(path)).toBe(true);
      expect(cachedCallWidgetAvatarPath(url, cacheDir)).toBe(path);
      expect(await cacheCallWidgetAvatar(url, { cacheDir, fetchAvatar })).toBe(path);
      expect(fetches).toBe(1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("does not cache non-image avatar responses", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "record-call-widget-avatar-invalid-"));
    const url = "https://cdn.discordapp.com/avatars/123/missing.png?size=128";
    try {
      const path = await cacheCallWidgetAvatar(url, {
        cacheDir,
        fetchAvatar: (async () => new Response("not an image", { status: 200 })) as unknown as typeof fetch,
      });
      expect(path).toBeNull();
      expect(existsSync(callWidgetAvatarCachePath(url, cacheDir))).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
