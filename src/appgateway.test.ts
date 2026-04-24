import { describe, expect, test } from "bun:test";

import { extractInitialNotifications } from "./appgateway";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";

describe("app gateway helpers", () => {
  test("extracts initial unread DM notifications from READY read state", () => {
    const notifications = extractInitialNotifications({
      private_channels: [
        { id: "dm-1", last_message_id: "200" },
        { id: "dm-2", last_message_id: "300" },
      ],
      read_state: {
        entries: [
          { id: "dm-1", mention_count: 0, last_message_id: "100" },
          { id: "dm-2", mention_count: 0, last_message_id: "300" },
        ],
      },
    });

    expect(notifications).toEqual([{ channelId: "dm-1", guildId: DIRECT_MESSAGES_GUILD_ID, count: 1 }]);
  });

  test("uses mention count when READY includes mentions", () => {
    const notifications = extractInitialNotifications({
      guilds: [{ id: "guild-1", channels: [{ id: "channel-1", last_message_id: "200" }] }],
      read_state: {
        entries: [{ id: "channel-1", mention_count: 3, last_message_id: "200" }],
      },
    });

    expect(notifications).toEqual([{ channelId: "channel-1", guildId: "guild-1", count: 3 }]);
  });
});
