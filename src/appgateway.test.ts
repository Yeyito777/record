import { describe, expect, test } from "bun:test";

import { extractCurrentUserRoleIdsByGuildId, extractGuildMuteSettings, extractInitialNotifications, extractReadyGuilds, mapCallGatewayEvent, mapVoiceServerUpdate, mapVoiceStateUpdate, typingDisplayName } from "./appgateway";
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

  test("uses mention count when READY includes guild mentions", () => {
    const notifications = extractInitialNotifications({
      guilds: [{ id: "guild-1", channels: [{ id: "channel-1", last_message_id: "200" }] }],
      read_state: {
        entries: [{ id: "channel-1", mention_count: 3, last_message_id: "200" }],
      },
    });

    expect(notifications).toEqual([{ channelId: "channel-1", guildId: "guild-1", count: 3 }]);
  });

  test("does not create initial guild notifications for regular unread messages", () => {
    const notifications = extractInitialNotifications({
      guilds: [{ id: "guild-1", channels: [{ id: "channel-1", last_message_id: "200" }] }],
      read_state: {
        entries: [{ id: "channel-1", mention_count: 0, last_message_id: "100" }],
      },
    });

    expect(notifications).toEqual([]);
  });

  test("extracts guild mute settings from READY", () => {
    expect(extractGuildMuteSettings({
      user_guild_settings: {
        entries: [
          { guild_id: "guild-1", muted: true },
          { guild_id: "guild-2", muted: false },
          { guild_id: null, muted: true },
        ],
      },
    })).toEqual({ "guild-1": true, "guild-2": false });
  });

  test("extracts current user role ids from READY merged members", () => {
    expect(extractCurrentUserRoleIdsByGuildId({
      guilds: [{ id: "guild-1" }, { id: "guild-2" }],
      merged_members: [
        [{ user_id: "me", roles: ["role-1", "role-2"] }],
        [{ user_id: "me", roles: [] }],
      ],
    })).toEqual({ "guild-1": ["role-1", "role-2"], "guild-2": [] });
  });

  test("uses member user data for typing display names", () => {
    expect(typingDisplayName({
      user_id: "708497088777945158",
      member: { user: { username: "teto", global_name: "Kasane Teto" } },
    })).toBe("Kasane Teto");
    expect(typingDisplayName({
      user_id: "708497088777945158",
      member: { nick: "Teto Nick" },
    })).toBe("Teto Nick");
  });

  test("maps voice gateway dispatch payloads", () => {
    expect(mapVoiceStateUpdate({
      user_id: "me",
      channel_id: "dm-1",
      session_id: "voice-session",
      self_mute: true,
      self_deaf: false,
      mute: false,
      deaf: false,
    })).toEqual({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session",
      selfMute: true,
      selfDeaf: false,
      mute: false,
      deaf: false,
    });

    expect(mapVoiceServerUpdate({ token: "voice-token", endpoint: "voice.example", guild_id: null })).toEqual({
      token: "voice-token",
      endpoint: "voice.example",
      guildId: null,
    });
  });

  test("maps call gateway events", () => {
    expect(mapCallGatewayEvent({
      channel_id: "dm-1",
      ringing: ["user-2"],
      region: "atl",
      voice_states: [
        { user_id: "user-1" },
        { user_id: "user-2" },
      ],
    })).toEqual({
      channelId: "dm-1",
      ringingUserIds: ["user-2"],
      region: "atl",
      voiceStateUserIds: ["user-1", "user-2"],
      isActive: true,
    });

    expect(mapCallGatewayEvent({
      channel_id: "dm-1",
      ringing: ["user-2"],
      voice_states: [],
    })?.isActive).toBe(false);
  });

  test("extracts guilds from READY", () => {
    expect(extractReadyGuilds({
      guilds: [
        { id: "guild-1", properties: { name: "One", icon: "icon-1" } },
        { id: "guild-2", name: "Two", icon: null },
        { id: "guild-3", unavailable: true },
      ],
    })).toEqual([
      { id: "guild-1", name: "One", icon: "icon-1" },
      { id: "guild-2", name: "Two", icon: null },
    ]);
  });
});
