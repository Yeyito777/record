import { describe, expect, test } from "bun:test";

import {
  channelNotificationCounts,
  clearChannelNotifications,
  createNotificationState,
  guildNotificationCounts,
  recordChannelNotification,
  setChannelNotificationCount,
} from "./notifications";

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
});
