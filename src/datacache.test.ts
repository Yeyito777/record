import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, test } from "bun:test";

import { flushDataCacheSync, loadCachedChannelMessages, loadCachedGuildChannels, loadCachedGuildOrder, loadCachedMemberList, loadCachedSidebarChannelLayout, saveCachedChannelMessages, saveCachedGuildChannels, saveCachedGuildOrder, saveCachedGuilds, saveCachedMemberList, saveCachedSidebarChannelLayout, watchCachedGuildOrder } from "./datacache";

const previousXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("condition timed out"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("data cache", () => {
  test("saves and loads member lists per account, guild, and channel", () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-cache-test-"));

    saveCachedMemberList("account-1", "guild-1", "channel-1", [
      { id: "user-1", username: "alice", displayName: "Alice", bot: false },
    ]);

    expect(loadCachedMemberList("account-1", "guild-1", "channel-1")).toEqual([
      { id: "user-1", username: "alice", displayName: "Alice", bot: false },
    ]);
    expect(loadCachedMemberList("account-1", "guild-1", "channel-2")).toBeNull();
  });

  test("saves guild order in account-scoped files", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;

    saveCachedGuildOrder("account-1", ["guild-2", "guild-1", "guild-2"]);
    saveCachedGuildOrder("account-2", ["guild-3"]);

    expect(loadCachedGuildOrder("account-1")).toEqual(["guild-2", "guild-1"]);
    expect(loadCachedGuildOrder("account-2")).toEqual(["guild-3"]);
    expect(JSON.parse(readFileSync(join(xdg, "record", "accounts", "account-1", "guild-order.json"), "utf8")).guildIds).toEqual(["guild-2", "guild-1"]);
  });

  test("saves private conversation pinning and order per provider account", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;

    saveCachedSidebarChannelLayout("discord-user", {
      "@me::dms": {
        "dm-1": { pinned: true, sortOrder: 0 },
        "dm-2": { pinned: false, sortOrder: 1 },
      },
    });
    saveCachedSidebarChannelLayout("whatsapp:self", {
      "@me::whatsapp": {
        "wa:chat": { pinned: false, sortOrder: -1 },
      },
    });

    expect(loadCachedSidebarChannelLayout("discord-user")).toEqual({
      "@me::dms": {
        "dm-1": { pinned: true, sortOrder: 0 },
        "dm-2": { pinned: false, sortOrder: 1 },
      },
    });
    expect(loadCachedSidebarChannelLayout("whatsapp:self")).toEqual({
      "@me::whatsapp": {
        "wa:chat": { pinned: false, sortOrder: -1 },
      },
    });
  });

  test("watches account-scoped guild order file changes", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    const seen: Array<string[] | null> = [];
    const stop = watchCachedGuildOrder("account-1", (guildOrder) => {
      seen.push(guildOrder);
    });

    try {
      saveCachedGuildOrder("account-1", ["guild-2", "guild-1"]);
      await waitForCondition(() => seen.some((guildOrder) => guildOrder?.join(",") === "guild-2,guild-1"));
    } finally {
      stop();
    }
  });

  test("flushes pending guild cache writes synchronously", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;

    saveCachedGuilds("account-1", [
      { id: "guild-new", name: "New Guild", icon: null },
    ]);

    const cachePath = join(xdg, "record", "cache.json");
    expect(existsSync(cachePath)).toBe(false);

    flushDataCacheSync();

    expect(JSON.parse(readFileSync(cachePath, "utf8")).accounts["account-1"].guilds).toEqual([
      { id: "guild-new", name: "New Guild", icon: null },
    ]);
  });

  test("preserves gateway-only message cache markers across persistence", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;

    saveCachedChannelMessages("account-1", "dm-1", {
      channelId: "dm-1",
      messages: [{
        id: "message-1",
        channelId: "dm-1",
        guildId: null,
        type: 0,
        content: "from gateway",
        mentionEveryone: false,
        mentionRoleIds: [],
        mentionUserIds: [],
        mentionUsers: [],
        timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
        editedTimestamp: null,
        author: { id: "user-1", username: "alice", displayName: "Alice", bot: false },
        reply: null,
        call: null,
        attachments: [],
        stickerNames: [],
        embedsCount: 0,
      }],
      hasOlder: true,
      updatedAt: 1234,
      latestFetchedAt: null,
    });

    expect(loadCachedChannelMessages("account-1")["dm-1"]?.latestFetchedAt).toBeNull();
    flushDataCacheSync();
    expect(JSON.parse(readFileSync(join(xdg, "record", "cache.json"), "utf8")).accounts["account-1"].channelMessages["dm-1"].latestFetchedAt).toBeNull();
  });

  test("loads persisted REST-seeded message caches as stale instead of fresh", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;

    saveCachedChannelMessages("account-1", "channel-1", {
      channelId: "channel-1",
      messages: [],
      hasOlder: false,
      updatedAt: 1234,
      latestFetchedAt: 1234,
    });

    expect(loadCachedChannelMessages("account-1")["channel-1"]?.latestFetchedAt).toBe(0);
  });

  test("treats message caches without latest fetch metadata as unseeded", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;
    const recordDir = join(xdg, "record");
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, "cache.json"), JSON.stringify({
      version: 1,
      accounts: {
        "account-1": {
          savedAt: Date.now(),
          channelMessages: {
            "dm-1": {
              channelId: "dm-1",
              messages: [],
              hasOlder: true,
              updatedAt: 1234,
            },
          },
        },
      },
    }));

    expect(loadCachedChannelMessages("account-1")["dm-1"]?.latestFetchedAt).toBeNull();
  });

  test("does not persist derived channel display flags", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;

    saveCachedGuildChannels("account-1", "guild-1", [
      { id: "channel-1", guildId: "guild-1", parentId: null, name: "secret", topic: null, position: 0, type: 0, nsfw: false, hidden: true, permissionOverwrites: [] },
    ]);

    expect(loadCachedGuildChannels("account-1", "guild-1")).toEqual([
      { id: "channel-1", guildId: "guild-1", parentId: null, name: "secret", topic: null, position: 0, type: 0, nsfw: false, permissionOverwrites: [] },
    ]);

    flushDataCacheSync();
    expect(JSON.parse(readFileSync(join(xdg, "record", "cache.json"), "utf8")).accounts["account-1"].guildChannels["guild-1"]).toEqual([
      { id: "channel-1", guildId: "guild-1", parentId: null, name: "secret", topic: null, position: 0, type: 0, nsfw: false, permissionOverwrites: [] },
    ]);
  });

  test("ignores old guild channel caches without permission overwrites", () => {
    const xdg = mkdtempSync(join(tmpdir(), "record-cache-test-"));
    process.env.XDG_CONFIG_HOME = xdg;
    const recordDir = join(xdg, "record");
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, "cache.json"), JSON.stringify({
      version: 1,
      accounts: {
        "account-1": {
          savedAt: Date.now(),
          guildChannels: {
            "guild-1": [
              { id: "channel-1", guildId: "guild-1", parentId: null, name: "stale", topic: null, position: 0, type: 0, nsfw: false },
            ],
          },
        },
      },
    }));

    expect(loadCachedGuildChannels("account-1", "guild-1")).toBeNull();
  });
});
