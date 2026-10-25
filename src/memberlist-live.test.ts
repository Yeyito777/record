import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { MemberListGatewayClient, type MemberListUpdateInfo } from "./membergateway";
import { disconnectMemberListGateway, syncMemberListForCurrentChannel } from "./session";
import { createInitialState } from "./state";
import type { DiscordGuildMember } from "./discord";

type Callbacks = { onMembers: (members: DiscordGuildMember[], info?: MemberListUpdateInfo) => void; onError: (error: Error) => void };

const member = (id: string): DiscordGuildMember => ({ id, username: id, displayName: id, bot: false } as DiscordGuildMember);

afterEach(() => {
  disconnectMemberListGateway();
});

describe("live member list", () => {
  test("keeps applying updates after the first list, and never lets a provisional replay stand in", () => {
    const subscriptions: Callbacks[] = [];
    const subscribe = spyOn(MemberListGatewayClient.prototype, "subscribe").mockImplementation(async function (_guildId: string, _channelId: string, callbacks: Callbacks) {
      subscriptions.push(callbacks);
    });
    try {
      const state = createInitialState("token", "/tmp/record-config.json");
      state.memberList.open = true;
      state.channelList.guildId = "guild-1";
      state.channelList.activeChannelId = "channel-1";
      state.channelList.activeChannel = { id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false } as any;
      syncMemberListForCurrentChannel(state, { scheduleRender: () => {} } as any);
      const callbacks = subscriptions.at(-1)!;

      callbacks.onMembers([member("other-channel")], { provisional: true });
      expect(state.memberList.members.map((entry) => entry.id)).toEqual(["other-channel"]);
      expect(state.memberList.cache.get("guild-1:channel-1")).toBeUndefined();

      callbacks.onMembers([member("alice")]);
      callbacks.onMembers([member("alice"), member("bob")]);
      expect(state.memberList.members.map((entry) => entry.id)).toEqual(["alice", "bob"]);
      expect(state.memberList.cache.get("guild-1:channel-1")?.map((entry) => entry.id)).toEqual(["alice", "bob"]);
    } finally {
      subscribe.mockRestore();
    }
  });
});
