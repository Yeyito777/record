import { describe, expect, test } from "bun:test";

import {
  bumpDirectMessageChannel,
  createChannelListState,
  getActiveChannel,
  setActiveChannel,
  setChannelList,
  upsertChannel,
} from "./channels";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";

describe("channel list state", () => {
  test("does not auto-activate a random channel when loading a guild", () => {
    const channels = createChannelListState();
    setChannelList(channels, "guild-1", [
      { id: "cat", guildId: "guild-1", parentId: null, name: "Category", topic: null, position: 0, type: 4, nsfw: false },
      { id: "1", guildId: "guild-1", parentId: "cat", name: "general", topic: null, position: 1, type: 0, nsfw: false },
      { id: "2", guildId: "guild-1", parentId: "cat", name: "random", topic: null, position: 2, type: 0, nsfw: false },
    ]);

    expect(getActiveChannel(channels)).toBeNull();

    setActiveChannel(channels, "2");
    expect(getActiveChannel(channels)?.id).toBe("2");
  });

  test("upserts gateway channel updates and keeps the active channel fresh", () => {
    const channels = createChannelListState();
    setChannelList(channels, "guild-1", [
      { id: "1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
    ]);
    setActiveChannel(channels, "1");

    upsertChannel(channels, { id: "1", guildId: "guild-1", parentId: null, name: "renamed", topic: null, position: 0, type: 0, nsfw: false });
    upsertChannel(channels, { id: "2", guildId: "guild-1", parentId: null, name: "new", topic: null, position: 1, type: 0, nsfw: false });

    expect(channels.channels.map((channel) => channel.name)).toEqual(["renamed", "new"]);
    expect(getActiveChannel(channels)?.name).toBe("renamed");
  });

  test("bumps direct message channels to the top when new messages arrive", () => {
    const channels = createChannelListState();
    setChannelList(channels, DIRECT_MESSAGES_GUILD_ID, [
      { id: "old", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Old", topic: null, position: 0, type: 1, nsfw: false },
      { id: "new", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "New", topic: null, position: 1, type: 1, nsfw: false },
    ]);

    bumpDirectMessageChannel(channels, "new");

    expect(channels.channels.map((channel) => channel.id)).toEqual(["new", "old"]);
  });

  test("keeps the active channel when browsing another guild", () => {
    const channels = createChannelListState();
    setChannelList(channels, "guild-1", [
      { id: "1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
    ]);
    setActiveChannel(channels, "1");

    setChannelList(channels, "guild-2", [
      { id: "9", guildId: "guild-2", parentId: null, name: "other", topic: null, position: 0, type: 0, nsfw: false },
    ]);

    expect(getActiveChannel(channels)?.id).toBe("1");
  });
});
