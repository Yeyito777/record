import { describe, expect, test } from "bun:test";

import { cycleAutocomplete, updateAutocomplete } from "./autocomplete";
import { createInitialState } from "./state";

describe("autocomplete", () => {
  test("suggests saved usernames for /login", () => {
    const state = createInitialState(null, "/tmp/record-config.json", {
      alice: "token-1",
      bob: "token-2",
    });
    state.editor.buffer = "/login a";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches).toEqual([
      { name: "alice", desc: "saved login" },
    ]);
  });

  test("shows all saved usernames after /login space", () => {
    const state = createInitialState(null, "/tmp/record-config.json", {
      alice: "token-1",
      bob: "token-2",
    });
    state.editor.buffer = "/login ";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches).toEqual([
      { name: "alice", desc: "saved login" },
      { name: "bob", desc: "saved login" },
    ]);
  });

  test("suggests loaded users after an @ mention trigger", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.memberList.guildId = "guild-1";
    state.memberList.channelId = "channel-1";
    state.memberList.members = [
      { id: "user-1", username: "zosa", displayName: "Zosa", bot: false, roleIds: [] },
      { id: "self", username: "self", displayName: "Self", bot: false, roleIds: [] },
    ];
    state.editor.buffer = "hi @zo";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches[0]).toMatchObject({ name: "@Zosa", desc: "Zosa" });
    expect(typeof state.autocomplete?.matches[0]?.color).toBe("string");
    cycleAutocomplete(state, 1);
    expect(state.editor.buffer).toBe("hi @Zosa");
  });

  test("places broadcast and role mentions after user mentions", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.memberList.guildId = "guild-1";
    state.memberList.channelId = "channel-1";
    state.memberList.members = [{ id: "user-1", username: "alice", displayName: "Alice", bot: false, roleIds: [] }];
    state.guildRolesByGuildId["guild-1"] = [
      { id: "guild-1", name: "@everyone", color: 0, position: 0 },
      { id: "role-1", name: "artist", color: 0x3366ff, position: 1 },
    ];
    state.editor.buffer = "@";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches.map((match) => match.name)).toEqual(["@Alice", "@everyone", "@here", "@artist"]);
    expect(state.autocomplete?.matches.map((match) => match.desc)).toEqual(["Alice", "broadcast", "broadcast", "role"]);
  });

  test("shows nested command args after completing a subcommand", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/channels show-hidden ";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches).toEqual([
      { name: "on", desc: "Show inaccessible channel rows" },
      { name: "off", desc: "Hide inaccessible channel rows" },
    ]);
  });
});
