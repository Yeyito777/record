import { describe, expect, test } from "bun:test";

import { updateAutocomplete, cycleAutocomplete } from "./autocomplete";
import { createInitialState, type AppState } from "./state";
import {
  buildServerCommandAutocompleteRequest,
  getServerCommandArgumentCompletions,
  normalizeServerCommandIndex,
  serverCommandAvailable,
  setLoadedServerCommandIndex,
  tryServerCommand,
} from "./servercommands";

const GUILD_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000001";

function commandIndex(): Record<string, unknown> {
  return {
    version: "1",
    applications: [{
      id: "300000000000000001",
      name: "Dice Bot",
      permissions: {},
    }],
    application_commands: [
      {
        id: "400000000000000001",
        application_id: "300000000000000001",
        guild_id: GUILD_ID,
        version: "10",
        type: 1,
        name: "ping",
        description: "Check whether the bot is alive",
      },
      {
        id: "400000000000000002",
        application_id: "300000000000000001",
        guild_id: GUILD_ID,
        version: "11",
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
            options: [
              {
                type: 3,
                name: "mode",
                description: "Mode to use",
                required: true,
                choices: [
                  { name: "Fast mode", value: "fast" },
                  { name: "Safe mode", value: "safe" },
                ],
              },
              { type: 4, name: "count", description: "How many", min_value: 1, max_value: 5 },
              { type: 5, name: "enabled", description: "Whether enabled" },
              { type: 6, name: "user", description: "Target user" },
              { type: 11, name: "image", description: "Image attachment" },
            ],
          }],
        }],
      },
      {
        id: "400000000000000003",
        application_id: "300000000000000001",
        guild_id: GUILD_ID,
        version: "12",
        type: 1,
        name: "say",
        description: "Say text",
        options: [{ type: 3, name: "text", description: "Text", required: true, min_length: 2, max_length: 100 }],
      },
      {
        id: "400000000000000004",
        application_id: "300000000000000001",
        guild_id: GUILD_ID,
        version: "13",
        type: 1,
        name: "search",
        description: "Search things",
        options: [{ type: 3, name: "query", description: "Query", required: true, autocomplete: true }],
      },
      {
        id: "400000000000000005",
        application_id: "300000000000000001",
        guild_id: GUILD_ID,
        version: "14",
        type: 1,
        name: "admin-only",
        description: "Needs administrator",
        default_member_permissions: "8",
      },
      {
        id: "500000000000000001",
        application_id: "300000000000000001",
        guild_id: GUILD_ID,
        version: "1",
        type: 2,
        name: "User action",
        description: "",
      },
    ],
  };
}

function stateWithCommands(): AppState {
  const state = createInitialState("token", "/tmp/record-config.json");
  state.auth.user = {
    id: "600000000000000001",
    username: "self",
    globalName: "Self",
    discriminator: "0",
    avatar: null,
    bot: false,
    email: null,
    verified: null,
  };
  state.sidebar.guilds = [{ id: GUILD_ID, name: "Guild", icon: null, permissions: "1024" }];
  state.guildRolesByGuildId[GUILD_ID] = [{
    id: GUILD_ID,
    name: "@everyone",
    color: 0,
    position: 0,
    permissions: "1024",
  }];
  state.channelList.guildId = GUILD_ID;
  state.channelList.channels = [{
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    parentId: null,
    name: "general",
    topic: null,
    position: 0,
    type: 0,
    nsfw: false,
  }];
  state.channelList.activeChannelId = CHANNEL_ID;
  state.channelList.activeChannel = state.channelList.channels[0]!;
  state.timeline.channelId = CHANNEL_ID;
  setLoadedServerCommandIndex(state, GUILD_ID, commandIndex());
  return state;
}

describe("Discord server commands", () => {
  test("normalizes only chat-input commands and retains the raw command object", () => {
    const normalized = normalizeServerCommandIndex(commandIndex());

    expect(normalized.applications).toEqual([{ id: "300000000000000001", name: "Dice Bot" }]);
    expect(normalized.commands).toHaveLength(5);
    expect(normalized.commands[1]).toMatchObject({
      applicationName: "Dice Bot",
      name: "configure",
      options: [{ type: 2, name: "admin" }],
      raw: { id: "400000000000000002", application_id: "300000000000000001" },
    });
  });

  test("normalizes command-index localization default fields for invocation", () => {
    const normalized = normalizeServerCommandIndex({
      applications: [{ id: "app-1", name: "Translator" }],
      application_commands: [{
        id: "command-1",
        application_id: "app-1",
        version: "1",
        type: 1,
        name: "buscar",
        name_default: "search",
        description: "Buscar cosas",
        description_default: "Search things",
        options: [{ type: 3, name: "consulta", name_default: "query", description: "Consulta", description_default: "Query" }],
      }],
    });

    expect(normalized.commands).toMatchObject([{
      name: "search",
      description: "Search things",
      options: [{ name: "query", description: "Query" }],
    }]);
  });

  test("keeps commands usable when the optional applications list is absent", () => {
    const normalized = normalizeServerCommandIndex({
      applications: null,
      application_commands: [{
        id: "command-1",
        application_id: "app-1",
        version: "1",
        type: 1,
        name: "ping",
        description: "Ping",
      }],
    });

    expect(normalized.applications).toEqual([{ id: "app-1", name: "App app-1" }]);
    expect(normalized.commands).toMatchObject([{ name: "ping", applicationName: "App app-1" }]);
  });

  test("shows apps, commands, nested branches, options, and static choices", () => {
    const state = stateWithCommands();
    state.editor.buffer = "/di";
    state.editor.cursor = state.editor.buffer.length;
    updateAutocomplete(state);
    expect(state.autocomplete?.matches).toContainEqual({ name: "/@dice_bot", desc: "Dice Bot app" });

    state.editor.buffer = "/@dice_bot ";
    state.editor.cursor = state.editor.buffer.length;
    updateAutocomplete(state);
    expect(state.autocomplete?.matches.map((item) => item.name)).toEqual(["ping", "configure", "say", "search"]);

    expect(getServerCommandArgumentCompletions(state, "/@dice_bot configure ")).toEqual([
      { name: "admin", desc: "group — Admin commands" },
    ]);
    expect(getServerCommandArgumentCompletions(state, "/@dice_bot configure admin ")).toEqual([
      { name: "set", desc: "subcommand — Set a value" },
    ]);
    expect(getServerCommandArgumentCompletions(state, "/@dice_bot configure admin set --m")).toEqual([
      { name: "--mode=", desc: "required text — Mode to use" },
    ]);
    expect(getServerCommandArgumentCompletions(state, "/@dice_bot configure admin set --mode=f")).toEqual([
      { name: "--mode=fast", desc: "Fast mode" },
    ]);
  });

  test("Tab fills each app-command segment without dropping its prefix", () => {
    const state = stateWithCommands();
    state.editor.buffer = "/@dice_bot co";
    state.editor.cursor = state.editor.buffer.length;
    updateAutocomplete(state);

    cycleAutocomplete(state, 1);

    expect(state.editor.buffer).toBe("/@dice_bot configure");
  });

  test("parses nested options into Discord's typed interaction payload", () => {
    const state = stateWithCommands();
    state.pendingImages = [{
      filename: "chart.png",
      mediaType: "image/png",
      base64: Buffer.from("image").toString("base64"),
      sizeBytes: 5,
    }];

    const result = tryServerCommand(
      "/@dice_bot configure admin set --mode=fast --count=2 --enabled=true --user=<@700000000000000001> --image",
      state,
    );

    expect(result).toMatchObject({
      type: "server_command",
      request: {
        type: 2,
        applicationId: "300000000000000001",
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        data: {
          id: "400000000000000002",
          name: "configure",
          version: "11",
          type: 1,
          guild_id: GUILD_ID,
          attachments: [{ id: "0", filename: "chart.png" }],
          options: [{
            type: 2,
            name: "admin",
            options: [{
              type: 1,
              name: "set",
              options: [
                { type: 3, name: "mode", value: "fast" },
                { type: 4, name: "count", value: 2 },
                { type: 5, name: "enabled", value: true },
                { type: 6, name: "user", value: "700000000000000001" },
                { type: 11, name: "image", value: 0 },
              ],
            }],
          }],
        },
        uploads: [{ filename: "chart.png" }],
      },
    });
  });

  test("supports quoted option values", () => {
    const state = stateWithCommands();
    const result = tryServerCommand('/@dice_bot say --text="hello world"', state);

    expect(result).toMatchObject({
      type: "server_command",
      request: { data: { options: [{ type: 3, name: "text", value: "hello world" }] } },
    });
  });

  test("validates required options, types, choices, ranges, and attachments", () => {
    const state = stateWithCommands();

    expect(tryServerCommand("/@dice_bot configure admin set", state)).toEqual({
      type: "error",
      message: "Missing required option --mode.",
    });
    expect(tryServerCommand("/@dice_bot configure admin set --mode=turbo", state)).toEqual({
      type: "error",
      message: "--mode must use one of its listed choices.",
    });
    expect(tryServerCommand("/@dice_bot configure admin set --mode=fast --count=9", state)).toEqual({
      type: "error",
      message: "--count can be at most 5.",
    });
    expect(tryServerCommand("/@dice_bot configure admin set --mode=fast --image", state)).toEqual({
      type: "error",
      message: "--image needs an attached image.",
    });
    state.pendingImages = [{ mediaType: "image/png", base64: "aW1hZ2U=", sizeBytes: 5, filename: "extra.png" }];
    expect(tryServerCommand("/@dice_bot ping", state)).toEqual({
      type: "error",
      message: "This server command has no option for one or more attached images.",
    });
    state.pendingImages = [];
    expect(tryServerCommand('/@dice_bot say --text="x', state)).toEqual({
      type: "error",
      message: "Server command contains an unterminated quote.",
    });
  });

  test("handles explicit app namespace mistakes while retaining legacy input compatibility", () => {
    const state = stateWithCommands();

    expect(tryServerCommand("/@dice_bot", state)).toEqual({
      type: "error",
      message: "Choose a command for this app with Tab.",
    });
    expect(tryServerCommand("/@dice_bot not-a-command", state)).toEqual({
      type: "error",
      message: "Unknown command for this app. Use Tab to choose one.",
    });
    expect(tryServerCommand("/dice_bot not-a-command", state)).toBeNull();
    expect(tryServerCommand("/dice_bot ping", state)).toMatchObject({ type: "server_command" });
  });

  test("filters commands the current member cannot use", () => {
    const state = stateWithCommands();
    const command = state.serverCommands.guilds[GUILD_ID]!.commands.find((candidate) => candidate.name === "admin-only")!;

    expect(serverCommandAvailable(state, command)).toBe(false);
    expect(getServerCommandArgumentCompletions(state, "/@dice_bot ")?.map((item) => item.name)).not.toContain("admin-only");

    const ping = state.serverCommands.guilds[GUILD_ID]!.commands.find((candidate) => candidate.name === "ping")!;
    ping.permissions = { users: { [state.auth.user!.id]: false } };
    expect(serverCommandAvailable(state, ping)).toBe(false);

    state.guildRolesByGuildId[GUILD_ID]![0]!.permissions = "1032";
    expect(serverCommandAvailable(state, command)).toBe(true);
  });

  test("hides age-restricted commands outside age-restricted channels", () => {
    const state = stateWithCommands();
    const ping = state.serverCommands.guilds[GUILD_ID]!.commands.find((candidate) => candidate.name === "ping")!;
    ping.nsfw = true;

    expect(serverCommandAvailable(state, ping)).toBe(false);
    state.channelList.activeChannel!.nsfw = true;
    expect(serverCommandAvailable(state, ping)).toBe(true);
  });

  test("builds focused type-4 payloads and surfaces matching remote choices", () => {
    const state = stateWithCommands();
    const input = "/@dice_bot search --query=kit";
    const request = buildServerCommandAutocompleteRequest(state, input);

    expect(request).toMatchObject({
      type: 4,
      applicationId: "300000000000000001",
      data: {
        options: [{ type: 3, name: "query", value: "kit", focused: true }],
      },
    });
    state.serverCommands.autocomplete = {
      key: request!.key!,
      nonce: "nonce",
      status: "ready",
      choices: [{ name: "Kittens", value: "kittens" }],
    };
    expect(getServerCommandArgumentCompletions(state, input)).toEqual([
      { name: "--query=kittens", desc: "Kittens" },
    ]);
  });
});
