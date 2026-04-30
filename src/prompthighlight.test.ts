import { describe, expect, test } from "bun:test";

import { highlightPromptViewport } from "./prompthighlight";
import { createInitialState } from "./state";
import { ansiTrueColor, theme } from "./theme";

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("prompt highlighting", () => {
  test("colors macros and macro args like slash commands", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    const highlighted = highlightPromptViewport("hi /kao happy", "hi /kao happy", 0, state);

    expect(stripAnsi(highlighted)).toBe("hi /kao happy");
    expect(highlighted).toContain(`${theme.command}/kao happy${theme.text}`);
  });

  test("colors role and broadcast mentions", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.guildRolesByGuildId["guild-1"] = [
      { id: "role-1", name: "artist", color: 0x3366ff, position: 1 },
    ];

    const highlighted = highlightPromptViewport("hi @artist @here", "hi @artist @here", 0, state);

    expect(stripAnsi(highlighted)).toBe("hi @artist @here");
    expect(highlighted).toContain(ansiTrueColor(0x3366ff));
    expect(highlighted).toContain(theme.accent);
  });

  test("colors valid loaded mentions with their role color", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.guildRolesByGuildId["guild-1"] = [
      { id: "role-1", color: 0x3366ff, position: 1 },
    ];
    state.memberList.guildId = "guild-1";
    state.memberList.channelId = "channel-1";
    state.memberList.members = [{ id: "user-1", username: "zosa", displayName: "Zosa", bot: false, roleIds: ["role-1"] }];

    const highlighted = highlightPromptViewport("hi @zosa", "hi @zosa", 0, state);

    expect(stripAnsi(highlighted)).toBe("hi @zosa");
    expect(highlighted).toContain(ansiTrueColor(0x3366ff));
    expect(highlighted).toContain(theme.text);
  });
});
