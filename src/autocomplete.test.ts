import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { acceptAutocomplete, cycleAutocomplete, dismissAutocomplete, tryPathComplete, updateAutocomplete } from "./autocomplete";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";
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

  test("suggests emoji after a colon trigger", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "that was :so";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches[0]).toMatchObject({ name: "😭", desc: ":sob:" });
    expect(typeof state.autocomplete?.matches[0]?.color).toBe("string");
    cycleAutocomplete(state, 1);
    expect(state.editor.buffer).toBe("that was 😭");
  });

  test("accepting autocomplete keeps the filled completion", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "that was :so";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);
    cycleAutocomplete(state, 1);
    acceptAutocomplete(state);

    expect(state.autocomplete).toBeNull();
    expect(state.editor.buffer).toBe("that was 😭");
    expect(state.editor.cursor).toBe("that was 😭".length);
  });

  test("explicitly dismissing autocomplete still restores the original prefix", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "that was :so";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);
    cycleAutocomplete(state, 1);
    dismissAutocomplete(state);

    expect(state.autocomplete).toBeNull();
    expect(state.editor.buffer).toBe("that was :so");
    expect(state.editor.cursor).toBe("that was :so".length);
  });

  test("shows common emoji after a bare colon trigger", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = ":";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches.slice(0, 4).map((match) => match.desc)).toEqual([":sob:", ":joy:", ":rofl:", ":skull:"]);
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

  test("limits direct message mention suggestions to the active direct message", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = DIRECT_MESSAGES_GUILD_ID;
    state.channelList.channels = [
      {
        id: "dm-1",
        guildId: DIRECT_MESSAGES_GUILD_ID,
        parentId: null,
        name: "Alice",
        topic: null,
        position: 0,
        type: 1,
        nsfw: false,
        recipients: [{ id: "alice", username: "alice", displayName: "Alice", bot: false }],
      },
    ];
    state.channelList.activeChannelId = "dm-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.memberList.guildId = DIRECT_MESSAGES_GUILD_ID;
    state.memberList.channelId = "dm-1";
    state.memberList.members = [
      { id: "self", username: "self", displayName: "Self", bot: false },
      { id: "alice", username: "alice", displayName: "Alice", bot: false },
    ];
    state.memberList.cache.set(`${DIRECT_MESSAGES_GUILD_ID}:dm-1`, [
      { id: "self", username: "self", displayName: "Self", bot: false },
      { id: "alice", username: "alice", displayName: "Alice", bot: false },
    ]);
    state.memberList.cache.set("guild-1:channel-1", [
      { id: "bob", username: "bob", displayName: "Bob", bot: false },
      { id: "carol", username: "carol", displayName: "Carol", bot: false },
    ]);
    state.editor.buffer = "@";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches.map((match) => match.name)).toEqual(["@Alice"]);
  });

  test("shows macros alongside slash commands at the prompt start", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/k";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.type).toBe("command");
    expect(state.autocomplete?.matches).toEqual([{ name: "/kao", desc: "Kaomoji" }]);
    cycleAutocomplete(state, 1);
    expect(state.editor.buffer).toBe("/kao");
  });

  test("shows /kao emotion args at the prompt start", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/kao f";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.type).toBe("command");
    expect(state.autocomplete?.matches).toEqual([{ name: "flustered", desc: "(⁄ ⁄>⁄ ▽ ⁄<⁄ ⁄)" }]);
    cycleAutocomplete(state, 1);
    expect(state.editor.buffer).toBe("/kao flustered");
  });

  test("shows macro completions for slash tokens mid-message", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "hello /k";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.type).toBe("macro");
    expect(state.autocomplete?.matches).toEqual([{ name: "/kao", desc: "Kaomoji" }]);
    cycleAutocomplete(state, 1);
    expect(state.editor.buffer).toBe("hello /kao");
  });

  test("shows macro arg completions for slash tokens mid-message", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "hello /kao h";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.type).toBe("macro");
    expect(state.autocomplete?.matches).toEqual([{ name: "happy", desc: "ヽ(o＾▽＾o)ノ" }]);
    cycleAutocomplete(state, 1);
    expect(state.editor.buffer).toBe("hello /kao happy");
  });

  test("dismissing mid-message macro autocomplete restores only the macro token", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "hello /k friend";
    state.editor.cursor = "hello /k".length;

    updateAutocomplete(state);
    cycleAutocomplete(state, 1);
    dismissAutocomplete(state);

    expect(state.autocomplete).toBeNull();
    expect(state.editor.buffer).toBe("hello /k friend");
    expect(state.editor.cursor).toBe("hello /k".length);
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

  test("shows volume completions for mic and speaker commands", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/mic volume ";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches.map((match) => match.name)).toEqual(["100%", "75%", "50%", "25%", "0%"]);

    state.editor.buffer = "/speaker volume 7";
    state.editor.cursor = state.editor.buffer.length;
    updateAutocomplete(state);

    expect(state.autocomplete?.matches.map((match) => match.name)).toEqual(["75%"]);
  });

  test("tab-completes a single absolute file path match", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-path-ac-test-"));
    writeFileSync(join(dir, "cat.png"), "png");
    const prefix = join(dir, "ca");

    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = `/upload ${prefix}`;
    state.editor.cursor = state.editor.buffer.length;

    expect(tryPathComplete(state)).toBe(true);
    expect(state.editor.buffer).toBe(`/upload ${join(dir, "cat.png")}`);
    expect(state.editor.cursor).toBe(state.editor.buffer.length);
    expect(state.autocomplete).toBeNull();
  });

  test("tab-completes path matches with directories first and cycles them", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-path-ac-test-"));
    mkdirSync(join(dir, "alpha-dir"));
    writeFileSync(join(dir, "alpha-file.txt"), "hello");
    const prefix = join(dir, "al");

    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = `/upload ${prefix}`;
    state.editor.cursor = state.editor.buffer.length;

    expect(tryPathComplete(state)).toBe(true);
    expect(state.autocomplete?.type).toBe("path");
    expect(state.autocomplete?.matches).toEqual([
      { name: `${join(dir, "alpha-dir")}/`, desc: "dir" },
      { name: join(dir, "alpha-file.txt"), desc: "file" },
    ]);
    expect(state.editor.buffer).toBe(`/upload ${join(dir, "alpha-dir")}/`);

    cycleAutocomplete(state, 1);
    expect(state.editor.buffer).toBe(`/upload ${join(dir, "alpha-file.txt")}`);

    dismissAutocomplete(state);
    expect(state.editor.buffer).toBe(`/upload ${join(dir, "alpha-file.txt")}`);
  });

  test("does not tab-complete bare non-path tokens", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/upload cat";
    state.editor.cursor = state.editor.buffer.length;

    expect(tryPathComplete(state)).toBe(false);
    expect(state.editor.buffer).toBe("/upload cat");
  });
});
