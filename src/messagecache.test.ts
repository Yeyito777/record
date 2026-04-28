import { describe, expect, test } from "bun:test";

import {
  cachedChannelMessagesAreFresh,
  setCachedChannelMessages,
  upsertCachedChannelMessage,
  type ChannelMessageCache,
} from "./messagecache";
import type { DiscordMessage } from "./discord";

function message(id: string, content: string, options: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id,
    channelId: options.channelId ?? "channel-1",
    guildId: options.guildId ?? "guild-1",
    type: 0,
    content,
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    mentionUsers: [],
    timestamp: options.timestamp ?? Date.UTC(2026, 0, 1, 12, Number(id) || 0, 0),
    editedTimestamp: null,
    author: { id: "user-1", username: "tester", displayName: "Tester", bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
    ...options,
  };
}

describe("message cache", () => {
  test("merges fetched pages in chronological order", () => {
    const cache: ChannelMessageCache = {};

    setCachedChannelMessages(cache, "channel-1", [message("3", "three"), message("2", "two")], { updatedAt: 1000 });
    setCachedChannelMessages(cache, "channel-1", [message("1", "one")], { updatedAt: 2000, latestFetched: false });

    expect(cache["channel-1"]?.messages.map((entry) => entry.content)).toEqual(["one", "two", "three"]);
    expect(cache["channel-1"]?.latestFetchedAt).toBe(1000);
  });

  test("gateway messages keep a live cache fresh after a REST seed", () => {
    const cache: ChannelMessageCache = {};
    const entry = setCachedChannelMessages(cache, "channel-1", [message("1", "one")], { updatedAt: 1000 });

    expect(cachedChannelMessagesAreFresh(entry, 1100, 200)).toBe(true);

    const updated = upsertCachedChannelMessage(cache, message("2", "two", { timestamp: Date.UTC(2026, 0, 1, 12, 2, 0) }), { updatedAt: 2000 });

    expect(updated.latestFetchedAt).toBe(2000);
    expect(cachedChannelMessagesAreFresh(updated, 2100, 200)).toBe(true);
  });

  test("canonical gateway echoes replace matching pending local messages", () => {
    const cache: ChannelMessageCache = {};
    upsertCachedChannelMessage(cache, message("local:1", "hello", { localStatus: "pending" }));
    upsertCachedChannelMessage(cache, message("2", "hello"));

    expect(cache["channel-1"]?.messages.map((entry) => entry.id)).toEqual(["2"]);
    expect(cache["channel-1"]?.messages[0]?.localStatus).toBeUndefined();
  });

  test("canonical mention echoes replace friendly pending local messages", () => {
    const cache: ChannelMessageCache = {};
    upsertCachedChannelMessage(cache, message("local:1", "hi @Zosa", { localStatus: "pending", localSendContent: "hi <@user-1>" }));
    upsertCachedChannelMessage(cache, message("2", "hi <@user-1>"));

    expect(cache["channel-1"]?.messages.map((entry) => entry.id)).toEqual(["2"]);
    expect(cache["channel-1"]?.messages[0]?.localStatus).toBeUndefined();
  });
});
