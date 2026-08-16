import { describe, expect, test } from "bun:test";

import { highlightPromptViewport } from "./prompthighlight";
import { setLoadedServerCommandIndex } from "./servercommands";
import { createInitialState } from "./state";
import { ansiTrueColor, theme } from "./theme";

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function stateWithServerCommands() {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.channelList.guildId = "guild-1";
  state.channelList.channels = [{
    id: "channel-1",
    guildId: "guild-1",
    parentId: null,
    name: "general",
    topic: null,
    position: 0,
    type: 0,
    nsfw: false,
  }];
  state.channelList.activeChannelId = "channel-1";
  state.channelList.activeChannel = state.channelList.channels[0] ?? null;
  setLoadedServerCommandIndex(state, "guild-1", {
    applications: [{ id: "app-1", name: "Dice Bot" }],
    application_commands: [
      {
        id: "command-1",
        application_id: "app-1",
        version: "1",
        type: 1,
        name: "configure",
        description: "Configure the bot",
        options: [{
          type: 2,
          name: "admin",
          description: "Admin commands",
          options: [{
            type: 1,
            name: "set",
            description: "Set a value",
            options: [{ type: 3, name: "mode", description: "Mode to use" }],
          }],
        }],
      },
      {
        id: "command-2",
        application_id: "app-1",
        version: "1",
        type: 1,
        name: "secret",
        description: "Unavailable command",
        permissions: { user: false },
      },
    ],
  });
  return state;
}

describe("prompt highlighting", () => {
  test("colors macros and macro args like slash commands", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    const highlighted = highlightPromptViewport("hi /kao happy", "hi /kao happy", 0, state);

    expect(stripAnsi(highlighted)).toBe("hi /kao happy");
    expect(highlighted).toContain(`${theme.command}/kao happy${theme.text}`);
  });

  test("colors loaded app command and subcommand paths", () => {
    const state = stateWithServerCommands();
    const input = "run /@dice_bot configure admin set --mode=fast";

    const highlighted = highlightPromptViewport(input, input, 0, state);

    expect(stripAnsi(highlighted)).toBe(input);
    expect(highlighted).toContain(`${theme.command}/@dice_bot configure admin set${theme.text} --mode=fast`);
  });

  test("only extends app command highlighting through recognized path tokens", () => {
    const state = stateWithServerCommands();

    const appOnly = highlightPromptViewport("/@dice_bot unknown", "/@dice_bot unknown", 0, state);
    expect(appOnly).toContain(`${theme.command}/@dice_bot${theme.text} unknown`);

    const unavailable = highlightPromptViewport("/@dice_bot secret", "/@dice_bot secret", 0, state);
    expect(unavailable).toContain(`${theme.command}/@dice_bot${theme.text} secret`);

    const unknownApp = highlightPromptViewport("/@unknown configure", "/@unknown configure", 0, state);
    expect(unknownApp).toBe(`${theme.text}/@unknown configure${theme.reset}`);
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
