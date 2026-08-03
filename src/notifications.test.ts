import { describe, expect, test } from "bun:test";

import {
  channelNotificationCounts,
  clearChannelNotifications,
  createNotificationState,
  guildNotificationCounts,
  nextChannelNotification,
  recordChannelNotification,
  setChannelNotificationCount,
  shouldNotifyForMessage,
} from "./notifications";
import { DIRECT_MESSAGES_GUILD_ID, type DiscordMessage } from "./discord";

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "message-1",
    channelId: "channel-1",
    guildId: "guild-1",
    type: 0,
    content: "hello",
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    timestamp: Date.now(),
    editedTimestamp: null,
    author: { id: "user-2", username: "other", displayName: "Other", bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
    ...overrides,
  };
}

describe("notifications", () => {
  test("tracks and clears channel notification counts", () => {
    const notifications = createNotificationState();
    recordChannelNotification(notifications, "channel-1", "guild-1");
    recordChannelNotification(notifications, "channel-1", "guild-1");

    expect(channelNotificationCounts(notifications).get("channel-1")).toBe(2);

    clearChannelNotifications(notifications, "channel-1");

    expect(channelNotificationCounts(notifications).get("channel-1")).toBeUndefined();
  });

  test("sets initial notification counts", () => {
    const notifications = createNotificationState();

    setChannelNotificationCount(notifications, "channel-1", "guild-1", 5);

    expect(channelNotificationCounts(notifications).get("channel-1")).toBe(5);
    expect(guildNotificationCounts(notifications, []).get("guild-1")).toBe(5);
  });

  test("aggregates counts by guild", () => {
    const notifications = createNotificationState();
    recordChannelNotification(notifications, "channel-1", "guild-1");
    recordChannelNotification(notifications, "channel-2", "guild-1");
    recordChannelNotification(notifications, "channel-2", "guild-1");

    expect(guildNotificationCounts(notifications, []).get("guild-1")).toBe(3);
  });

  test("cycles notified channels in insertion order", () => {
    const notifications = createNotificationState();
    recordChannelNotification(notifications, "channel-1", "guild-1");
    recordChannelNotification(notifications, "channel-2", "guild-2");

    expect(nextChannelNotification(notifications, null)).toEqual({ channelId: "channel-1", guildId: "guild-1" });
    expect(nextChannelNotification(notifications, "channel-1")).toEqual({ channelId: "channel-2", guildId: "guild-2" });
    expect(nextChannelNotification(notifications, "channel-2")).toEqual({ channelId: "channel-1", guildId: "guild-1" });

    clearChannelNotifications(notifications, "channel-1");
    expect(nextChannelNotification(notifications, null)).toEqual({ channelId: "channel-2", guildId: "guild-2" });
  });

  test("notifies for DMs, direct mentions, replies, calls, and own role mentions", () => {
    const context = {
      viewerId: "me",
      roleIdsByGuildId: { "guild-1": ["role-1"] },
      channels: [
        { id: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, parentId: null, name: "DM", topic: null, position: 0, type: 1, nsfw: false },
        { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false },
      ],
    };

    expect(shouldNotifyForMessage(message({ channelId: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID }), context)).toBe(true);
    expect(shouldNotifyForMessage(message({ mentionUserIds: ["me"] }), context)).toBe(true);
    expect(shouldNotifyForMessage(message({ content: "hi <@me>" }), context)).toBe(true);
    expect(shouldNotifyForMessage(message({ reply: { messageId: "old", authorId: "me", authorDisplayName: "Me", timestamp: null, summary: "old" } }), context)).toBe(true);
    expect(shouldNotifyForMessage(message({ call: { endedTimestamp: null, participantIds: [] } }), context)).toBe(true);
    expect(shouldNotifyForMessage(message({ mentionRoleIds: ["role-1"] }), context)).toBe(true);
  });

  test("does not notify for regular messages, everyone/here, other roles, or self messages", () => {
    const context = {
      viewerId: "me",
      roleIdsByGuildId: { "guild-1": ["role-1"] },
      channels: [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }],
    };

    expect(shouldNotifyForMessage(message(), context)).toBe(false);
    expect(shouldNotifyForMessage(message({ mentionEveryone: true, content: "@everyone" }), context)).toBe(false);
    expect(shouldNotifyForMessage(message({ mentionRoleIds: ["role-2"] }), context)).toBe(false);
    expect(shouldNotifyForMessage(message({ author: { id: "me", username: "me", displayName: "Me", bot: false }, content: "<@me>" }), context)).toBe(false);
  });
});
