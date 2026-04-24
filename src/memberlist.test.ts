import { describe, expect, test } from "bun:test";

import { DIRECT_MESSAGES_GUILD_ID } from "./discord";
import {
  cacheMemberList,
  createMemberListState,
  moveMemberListSelection,
  renderMemberList,
  setMemberListLoading,
  setMemberListMembers,
  setMemberListMessage,
} from "./memberlist";
import { theme } from "./theme";
import { termWidth } from "./textwidth";

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("member list", () => {
  test("renders a loading row while the member fetch is in flight", () => {
    const memberList = createMemberListState();
    memberList.open = true;
    setMemberListLoading(memberList, "guild-1", "channel-1");

    const rows = renderMemberList(memberList, 6, 1).map(stripAnsi);
    expect(rows[2]).toContain("Loading");
  });

  test("renders a generic empty-state message when no direct message is open", () => {
    const memberList = createMemberListState();
    memberList.open = true;
    memberList.guildId = DIRECT_MESSAGES_GUILD_ID;

    const rows = renderMemberList(memberList, 6, 0).map(stripAnsi);
    expect(rows[2]).toContain("No members.");
  });

  test("renders direct message participants and accents the viewer row", () => {
    const memberList = createMemberListState();
    memberList.open = true;
    const members = [
      { id: "self", username: "me", displayName: "Paramount", bot: false },
      { id: "other", username: "alice", displayName: "Alice", bot: false },
    ];
    setMemberListMembers(memberList, DIRECT_MESSAGES_GUILD_ID, "dm-1", members, "self");

    const rows = renderMemberList(memberList, 7, 0);
    const plainRows = rows.map(stripAnsi);
    expect(plainRows[0]).toContain("Members (2)");
    expect(plainRows.some((row) => row.includes("▸ Paramount"))).toBe(true);
    expect(plainRows.some((row) => row.includes("Alice"))).toBe(true);
    expect(rows.some((row) => row.includes(theme.accent) && row.includes("Paramount"))).toBe(true);
  });

  test("wraps long info/error messages inside the member list width", () => {
    const memberList = createMemberListState();
    memberList.open = true;
    setMemberListMessage(memberList, "guild-1", "channel-1", "Open a server channel to inspect a very long member list status message that should wrap cleanly.");

    const rows = renderMemberList(memberList, 8, 0).map(stripAnsi);
    expect(rows[2]).toContain("Open a server channel to");
    expect(rows[3]).toContain("inspect a very long member");
    expect(rows[4]).toContain("list status message that");
    for (const row of rows) {
      expect(termWidth(row)).toBe(28);
    }
  });

  test("moves selected member and scrolls to keep it visible", () => {
    const memberList = createMemberListState();
    memberList.open = true;
    const members = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      username: `user-${index}`,
      displayName: `User ${index}`,
      bot: false,
    }));
    setMemberListMembers(memberList, "guild-1", "channel-1", members);

    moveMemberListSelection(memberList, 6);
    renderMemberList(memberList, 5, 0);

    expect(memberList.selectedIndex).toBe(6);
    expect(memberList.scrollOffset).toBe(4);

    moveMemberListSelection(memberList, -5);
    renderMemberList(memberList, 5, 0);

    expect(memberList.selectedIndex).toBe(1);
    expect(memberList.scrollOffset).toBe(1);
  });

  test("highlights the viewer row and keeps all rows inside the panel width", () => {
    const memberList = createMemberListState();
    memberList.open = true;
    const members = [
      { id: "1", username: "alpha", displayName: "Alpha", bot: false },
      { id: "2", username: "bravo", displayName: "Bravo", bot: false },
      { id: "3", username: "catbot", displayName: "Cat Bot", bot: true },
    ];
    cacheMemberList(memberList, "guild-1", "channel-1", members);
    setMemberListMembers(memberList, "guild-1", "channel-1", members, "2");

    const rows = renderMemberList(memberList, 8, 0).map(stripAnsi);
    expect(rows[0]).toContain("Members (3)");
    expect(rows.some((row) => row.includes("▸ Bravo"))).toBe(true);
    expect(rows.some((row) => row.includes("Cat Bot [bot]"))).toBe(true);
    for (const row of rows) {
      expect(termWidth(row)).toBe(28);
    }
  });
});
