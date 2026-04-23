import { afterEach, describe, expect, test } from "bun:test";

import { DIRECT_MESSAGES_GUILD_ID, fetchDirectMessages, formatChannelName, isDirectMessageChannel } from "./discord";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discord helpers", () => {
  test("formats direct messages without a hash prefix", () => {
    const dm = {
      id: "dm-1",
      guildId: DIRECT_MESSAGES_GUILD_ID,
      parentId: null,
      name: "Alice",
      topic: null,
      position: 0,
      type: 1,
      nsfw: false,
    };
    const guildChannel = {
      id: "chan-1",
      guildId: "guild-1",
      parentId: null,
      name: "general",
      topic: null,
      position: 0,
      type: 0,
      nsfw: false,
    };

    expect(isDirectMessageChannel(dm)).toBe(true);
    expect(formatChannelName(dm)).toBe("Alice");
    expect(formatChannelName(guildChannel)).toBe("#general");
  });

  test("sorts direct messages by most recent last_message_id", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify([
        {
          id: "dm-old",
          parent_id: null,
          type: 1,
          recipients: [{ id: "user-1", username: "littlebabel", global_name: "littlebabel" }],
          last_message_id: "100",
        },
        {
          id: "dm-new",
          parent_id: null,
          type: 1,
          recipients: [{ id: "user-2", username: "sfbabel", global_name: "zosa" }],
          last_message_id: "200",
        },
        {
          id: "group-null",
          parent_id: null,
          type: 3,
          name: "old group",
          recipients: [{ id: "user-3", username: "groupmate", global_name: null }],
          last_message_id: null,
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const directMessages = await fetchDirectMessages("token");

    expect(directMessages.map((channel) => channel.name)).toEqual(["zosa", "littlebabel", "old group"]);
    expect(directMessages.map((channel) => channel.position)).toEqual([0, 1, 2]);
  });
});
