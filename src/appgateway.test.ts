import { describe, expect, test } from "bun:test";

import { AppGatewayClient, extractCurrentUserRoleIdsByGuildId, extractGuildMuteSettings, extractGuildVoiceStates, extractInitialNotifications, extractReadyGuilds, extractReadyVoiceStates, mapCallGatewayEvent, mapGuildMembersChunk, mapVoiceServerUpdate, mapVoiceStateUpdate, typingDisplayName } from "./appgateway";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";

describe("app gateway helpers", () => {
  test("sends presence updates over the gateway", () => {
    const sent: unknown[] = [];
    const client = new AppGatewayClient("token", { onInitialNotifications: () => {}, onMessageCreate: () => {}, onMessageUpdate: () => {}, onMessageDelete: () => {}, onMessageDeleteBulk: () => {}, onMessageAck: () => {}, onChannelCreate: () => {}, onChannelUpdate: () => {}, onChannelDelete: () => {}, onTypingStart: () => {} }, "idle") as any;
    client.ready = true;
    client.ws = { readyState: WebSocket.OPEN, send: (payload: string) => sent.push(JSON.parse(payload)) };

    expect(client.updatePresenceStatus("dnd")).toBe(true);

    expect(sent).toEqual([{ op: 3, d: { status: "dnd", afk: false, since: 0, activities: [] } }]);
  });

  test("requests specific guild members over the gateway", () => {
    const sent: unknown[] = [];
    const client = new AppGatewayClient("token", { onInitialNotifications: () => {}, onMessageCreate: () => {}, onMessageUpdate: () => {}, onMessageDelete: () => {}, onMessageDeleteBulk: () => {}, onMessageAck: () => {}, onChannelCreate: () => {}, onChannelUpdate: () => {}, onChannelDelete: () => {}, onTypingStart: () => {} }) as any;
    client.ready = true;
    client.ws = { readyState: WebSocket.OPEN, send: (payload: string) => sent.push(JSON.parse(payload)) };

    expect(client.requestGuildMembers("guild-1", ["user-1", "user-1", "user-2"])).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      op: 8,
      d: {
        guild_id: ["guild-1"],
        query: null,
        limit: 2,
        presences: false,
        user_ids: ["user-1", "user-2"],
      },
    });
  });

  test("dispatches voice states from READY_SUPPLEMENTAL", () => {
    const updates: unknown[] = [];
    const client = new AppGatewayClient("token", { onInitialNotifications: () => {}, onVoiceStateUpdate: (update) => updates.push(update), onMessageCreate: () => {}, onMessageUpdate: () => {}, onMessageDelete: () => {}, onMessageDeleteBulk: () => {}, onMessageAck: () => {}, onChannelCreate: () => {}, onChannelUpdate: () => {}, onChannelDelete: () => {}, onTypingStart: () => {} }) as any;

    client.handleMessage({ data: JSON.stringify({
      op: 0,
      t: "READY_SUPPLEMENTAL",
      d: { guilds: [{ id: "guild-1", voice_states: [{ user_id: "user-1", channel_id: "voice-1", member: { user: { username: "alice", global_name: "Alice" }, roles: ["role-1"] } }] }] },
    }) });

    expect(updates).toEqual([{ userId: "user-1", channelId: "voice-1", guildId: "guild-1", sessionId: null, displayName: "Alice", roleIds: ["role-1"], selfMute: false, selfDeaf: false, mute: false, deaf: false }]);
  });

  test("dispatches message reaction gateway events as message patches", () => {
    const patches: unknown[] = [];
    const client = new AppGatewayClient("token", { onInitialNotifications: () => {}, onMessageCreate: () => {}, onMessageUpdate: (patch) => patches.push(patch), onMessageDelete: () => {}, onMessageDeleteBulk: () => {}, onMessageAck: () => {}, onChannelCreate: () => {}, onChannelUpdate: () => {}, onChannelDelete: () => {}, onTypingStart: () => {} }) as any;
    client.currentUserId = "viewer";

    client.handleMessage({ data: JSON.stringify({
      op: 0,
      t: "MESSAGE_REACTION_ADD",
      d: { message_id: "message-1", channel_id: "channel-1", user_id: "viewer", emoji: { id: null, name: "👍" } },
    }) });

    expect(patches).toEqual([{
      id: "message-1",
      channelId: "channel-1",
      guildId: undefined,
      reactionUpdate: { type: "add", emoji: { id: null, name: "👍", animated: false }, me: true },
    }]);
  });

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
      member: { nick: "Server Nick", roles: ["role-1"], user: { username: "yeyito", global_name: "Yeyito" } },
      self_mute: true,
      self_deaf: false,
      mute: false,
      deaf: false,
    })).toEqual({
      userId: "me",
      channelId: "dm-1",
      guildId: null,
      sessionId: "voice-session",
      displayName: "Yeyito",
      roleIds: ["role-1"],
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

  test("uses voice-state member nicknames when no user object is present", () => {
    expect(mapVoiceStateUpdate({
      user_id: "user-1",
      channel_id: "voice-1",
      member: { nick: "Server Nick", roles: ["role-1"] },
    })).toMatchObject({
      userId: "user-1",
      channelId: "voice-1",
      displayName: "Server Nick",
      roleIds: ["role-1"],
    });
  });

  test("maps requested guild member chunks", () => {
    expect(mapGuildMembersChunk({
      guild_id: "guild-1",
      members: [
        { user: { id: "user-1", username: "alice", global_name: "Alice", avatar: "avatar-1" }, roles: ["role-1"] },
        { user_id: "user-2", nick: "Nickname Only", roles: [] },
      ],
    })).toEqual({
      guildId: "guild-1",
      members: [
        { id: "user-1", username: "alice", displayName: "Alice", bot: false, avatar: "avatar-1", roleIds: ["role-1"] },
        { id: "user-2", username: "Nickname Only", displayName: "Nickname Only", bot: false, roleIds: [] },
      ],
    });
  });

  test("extracts initial guild voice states from READY", () => {
    expect(extractReadyVoiceStates({
      guilds: [{
        id: "guild-1",
        voice_states: [
          { user_id: "user-1", channel_id: "voice-1", session_id: "session-1", self_mute: false, self_deaf: false, mute: true, deaf: false },
        ],
      }],
    })).toEqual([{
      userId: "user-1",
      channelId: "voice-1",
      guildId: "guild-1",
      sessionId: "session-1",
      selfMute: false,
      selfDeaf: false,
      mute: true,
      deaf: false,
    }]);
  });

  test("extracts voice states from GUILD_CREATE payloads", () => {
    expect(extractGuildVoiceStates({
      id: "guild-1",
      voice_states: [
        { user_id: "user-1", channel_id: "voice-1", session_id: "session-1", member: { user: { username: "alice", global_name: "Alice" } } },
      ],
    })).toEqual([{
      userId: "user-1",
      channelId: "voice-1",
      guildId: "guild-1",
      sessionId: "session-1",
      displayName: "Alice",
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
    }]);
  });

  test("maps call gateway events", () => {
    expect(mapCallGatewayEvent({
      channel_id: "dm-1",
      ringing: ["user-2"],
      region: "atl",
      voice_states: [
        { user_id: "user-1", self_mute: true, self_deaf: false, mute: false, deaf: false },
        { user_id: "user-2", self_mute: false, self_deaf: true, mute: true, deaf: true },
      ],
    })).toEqual({
      channelId: "dm-1",
      ringingUserIds: ["user-2"],
      region: "atl",
      voiceStateUserIds: ["user-1", "user-2"],
      voiceStates: [
        { userId: "user-1", selfMute: true, selfDeaf: false, mute: false, deaf: false },
        { userId: "user-2", selfMute: false, selfDeaf: true, mute: true, deaf: true },
      ],
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
