import { describe, expect, test } from "bun:test";

import { applyGatewayMemberListOps, extractGatewayMembers, MemberListGatewayClient } from "./membergateway";

describe("member gateway member-list ops", () => {
  test("builds a member list from an initial sync and preserves group rows for later updates", () => {
    const rows = applyGatewayMemberListOps([], [
      {
        op: "SYNC",
        range: [0, 99],
        items: [
          { group: { id: "online" } },
          { member: { user: { id: "1", username: "alpha", global_name: "Alpha" }, nick: null } },
          { group: { id: "offline" } },
          { member: { user: { id: "2", username: "bravo", global_name: null }, nick: "Bravo Nick" } },
        ],
      },
    ]);

    expect(rows).toHaveLength(4);
    expect(extractGatewayMembers(rows)).toEqual([
      { id: "1", username: "alpha", displayName: "Alpha", bot: false },
      { id: "2", username: "bravo", displayName: "Bravo Nick", bot: false },
    ]);
  });

  test("applies update, insert, and delete ops against the synced list", () => {
    const synced = applyGatewayMemberListOps([], [
      {
        op: "SYNC",
        range: [0, 99],
        items: [
          { group: { id: "online" } },
          { member: { user: { id: "1", username: "alpha", global_name: null }, nick: null } },
          { member: { user: { id: "2", username: "bravo", global_name: null }, nick: null } },
        ],
      },
    ]);

    const updated = applyGatewayMemberListOps(synced, [
      {
        op: "UPDATE",
        index: 2,
        item: { member: { user: { id: "2", username: "bravo", global_name: "Bravo" }, nick: null } },
      },
      {
        op: "INSERT",
        index: 2,
        item: { member: { user: { id: "3", username: "charlie", global_name: null, bot: true }, nick: "Charlie Bot" } },
      },
      {
        op: "DELETE",
        index: 1,
      },
    ]);

    expect(extractGatewayMembers(updated)).toEqual([
      { id: "3", username: "charlie", displayName: "Charlie Bot", bot: true },
      { id: "2", username: "bravo", displayName: "Bravo", bot: false },
    ]);
  });

  test("ignores sync chunks that do not start at zero", () => {
    const rows = applyGatewayMemberListOps([], [
      {
        op: "SYNC",
        range: [100, 199],
        items: [
          { member: { user: { id: "1", username: "alpha" }, nick: null } },
        ],
      },
    ]);

    expect(rows).toEqual([]);
  });

  test("treats gateway reconnect requests as a silent reconnect instead of a surfaced error", () => {
    const client = new MemberListGatewayClient("token") as any;
    let reconnected = 0;
    let errors = 0;

    client.subscription = {
      guildId: "guild-1",
      channelId: "channel-1",
      listId: "everyone",
      waitingForSync: false,
      rows: [],
      onMembers: () => {},
      onError: () => { errors += 1; },
    };
    client.reconnect = async () => { reconnected += 1; };

    client.handleMessage({ data: JSON.stringify({ op: 7, d: null }) });

    expect(reconnected).toBe(1);
    expect(errors).toBe(0);
  });

  test("reconnect resets sync state and resubscribes the active target", async () => {
    const client = new MemberListGatewayClient("token") as any;
    const subscription = {
      guildId: "guild-1",
      channelId: "channel-1",
      listId: "everyone",
      waitingForSync: false,
      rows: [{ type: "member", member: { id: "1", username: "alpha", displayName: "Alpha", bot: false } }],
      onMembers: () => {},
      onError: () => {},
    };
    const sent: Array<[string, string]> = [];

    client.subscription = subscription;
    client.ensureConnected = async () => {
      client.ready = true;
    };
    client.resetSocket = () => {
      client.ready = false;
    };
    client.sendSubscription = (guildId: string, channelId: string) => {
      sent.push([guildId, channelId]);
    };

    await client.reconnect();

    expect(subscription.listId).toBeNull();
    expect(subscription.waitingForSync).toBe(true);
    expect(subscription.rows).toEqual([]);
    expect(sent).toEqual([["guild-1", "channel-1"]]);
  });
});
