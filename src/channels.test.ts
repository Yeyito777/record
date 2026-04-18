import { describe, expect, test } from "bun:test";

import {
  createChannelListState,
  getActiveChannel,
  setActiveChannel,
  setChannelList,
} from "./channels";

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
