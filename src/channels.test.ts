import { describe, expect, test } from "bun:test";

import {
  bumpDirectMessageChannel,
  createChannelListState,
  getActiveChannel,
  isBrowsableChannel,
  isTimelineChannel,
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
      { id: "old", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "Old", topic: null, position: 0, type: 1, nsfw: false, lastMessageId: "100" },
      { id: "new", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "New", topic: null, position: 1, type: 1, nsfw: false, lastMessageId: "200" },
    ]);

    expect(bumpDirectMessageChannel(channels, "old", "300")).toBe(true);

    expect(channels.channels.map((channel) => channel.id)).toEqual(["old", "new"]);
    expect(channels.channels[0]?.lastMessageId).toBe("300");
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

  test("keeps guild voice channels out of auto-browsing but allows opening their text chat", () => {
    const voice = { id: "voice", guildId: "guild-1", parentId: null, name: "Lounge", topic: null, position: 0, type: 2, nsfw: false };
    const text = { id: "text", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 1, type: 0, nsfw: false };
    const channels = createChannelListState();
    setChannelList(channels, "guild-1", [voice, text]);

    expect(isBrowsableChannel(voice)).toBe(false);
    expect(isBrowsableChannel(text)).toBe(true);
    expect(isTimelineChannel(voice)).toBe(true);
    expect(isTimelineChannel(text)).toBe(true);
    setActiveChannel(channels, "voice");
    expect(getActiveChannel(channels)).toBeNull();
    setActiveChannel(channels, "text");
    expect(getActiveChannel(channels)?.id).toBe("text");
  });

  test("treats threads as browsable message timelines and preserves known membership on updates", () => {
    const thread = {
      id: "thread-1",
      guildId: "guild-1",
      parentId: "text-1",
      name: "release talk",
      topic: null,
      position: 0,
      type: 11,
      nsfw: false,
      thread: {
        ownerId: "user-1",
        archived: false,
        locked: false,
        invitable: true,
        autoArchiveDuration: 1440,
        archiveTimestamp: null,
        createTimestamp: null,
        joined: true,
        messageCount: 1,
        memberCount: 2,
        totalMessageSent: 1,
      },
    };
    const channels = createChannelListState();
    setChannelList(channels, "guild-1", [thread]);
    setActiveChannel(channels, thread.id);

    expect(isBrowsableChannel(thread)).toBe(true);
    expect(isTimelineChannel(thread)).toBe(true);

    upsertChannel(channels, {
      ...thread,
      name: "renamed",
      thread: { ...thread.thread, joined: null, messageCount: 2 },
    });
    expect(getActiveChannel(channels)?.name).toBe("renamed");
    expect(getActiveChannel(channels)?.thread?.joined).toBe(true);
    expect(getActiveChannel(channels)?.thread?.messageCount).toBe(2);
  });
});
