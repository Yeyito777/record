import { describe, expect, test } from "bun:test";

import { applyGatewayMemberListOps, extractGatewayMembers } from "./membergateway";

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
});
