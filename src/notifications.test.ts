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
import { WHATSAPP_GUILD_ID } from "./chatproviders";

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

  test.each([WHATSAPP_GUILD_ID, DIRECT_MESSAGES_GUILD_ID])(
    "finishes notifications in focused block %s before hopping to other blocks",
    (focusedGuildId) => {
      const notifications = createNotificationState();
      recordChannelNotification(notifications, "other-1", "other");
      recordChannelNotification(notifications, "focused-1", focusedGuildId);
      recordChannelNotification(notifications, "other-2", "other");
      recordChannelNotification(notifications, "focused-2", focusedGuildId);

      // The open chat need not itself have an unread notification.
      expect(nextChannelNotification(notifications, "read-chat", focusedGuildId)?.channelId).toBe("focused-1");
      clearChannelNotifications(notifications, "focused-1");
      expect(nextChannelNotification(notifications, "focused-1", focusedGuildId)?.channelId).toBe("focused-2");
      clearChannelNotifications(notifications, "focused-2");
      expect(nextChannelNotification(notifications, "focused-2", focusedGuildId)?.channelId).toBe("other-1");
      clearChannelNotifications(notifications, "other-1");
      expect(nextChannelNotification(notifications, "other-1")?.channelId).toBe("other-2");
      clearChannelNotifications(notifications, "other-2");
      expect(nextChannelNotification(notifications, "other-2")).toBeNull();
    },
  );

  test("wraps within the current block before leaving it", () => {
    const notifications = createNotificationState();
    recordChannelNotification(notifications, "first", "guild");
    recordChannelNotification(notifications, "current", "guild");
    recordChannelNotification(notifications, "other", "elsewhere");

    expect(nextChannelNotification(notifications, "current")?.channelId).toBe("first");
    clearChannelNotifications(notifications, "first");
    // Do not get stuck reopening the current unread chat.
    expect(nextChannelNotification(notifications, "current")?.channelId).toBe("other");
    clearChannelNotifications(notifications, "other");
    expect(nextChannelNotification(notifications, "current")?.channelId).toBe("current");
  });

  test("explicit sidebar focus takes precedence over the open chat's block", () => {
    const notifications = createNotificationState();
    recordChannelNotification(notifications, "open-chat", "open-block");
    recordChannelNotification(notifications, "open-next", "open-block");
    recordChannelNotification(notifications, "selected-next", "selected-block");

    expect(nextChannelNotification(notifications, "open-chat", "selected-block")?.channelId).toBe("selected-next");
  });

  test("ignores nonpositive counts and falls back when the focused block is empty", () => {
    const notifications = createNotificationState();
    notifications.byChannelId = { zero: 0, negative: -1 };
    expect(nextChannelNotification(notifications, null, "empty")).toBeNull();

    recordChannelNotification(notifications, "unknown", null);
    expect(nextChannelNotification(notifications, null, "empty")).toEqual({ channelId: "unknown", guildId: null });
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
