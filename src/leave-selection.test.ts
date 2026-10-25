import { describe, expect, test } from "bun:test";

import { removeSessionGuild } from "./session";
import { getSelectedSidebarEntry, setSidebarGuilds } from "./sidebar";
import { createInitialState } from "./state";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";
import { instagramGuild, whatsappGuild } from "./chatproviders";

describe("leaving a server", () => {
  const setup = () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    setSidebarGuilds(state.sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: "Direct Messages", icon: null },
      whatsappGuild(),
      instagramGuild(),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, name: `Guild ${i}`, icon: null })),
    ]);
    // An expanded server above: more sidebar rows than servers.
    const channels = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, guildId: "g0", parentId: null, name: `chan-${i}`, topic: null, position: i, type: 0, nsfw: false }));
    state.channelList.guildId = "g0";
    state.channelList.channels = channels;
    state.sidebar.expandedGuildId = "g0";
    const select = (id: string) => {
      for (let row = 0; row < 40; row++) {
        state.sidebar.selectedIndex = row;
        state.sidebar.selectedItem = null;
        if (getSelectedSidebarEntry(state.sidebar, state.channelList.channels).id === id) return;
      }
      throw new Error(`no row for ${id}`);
    };
    return { state, select };
  };

  test("the server disappears and the selection moves to the next one", () => {
    const { state, select } = setup();
    select("g3");
    expect(removeSessionGuild(state, "g3")).toBe(true);
    expect(state.sidebar.guilds.some((guild) => guild.id === "g3")).toBe(false);
    expect(getSelectedSidebarEntry(state.sidebar, state.channelList.channels).id).toBe("g4");
  });

  test("a server removed elsewhere (kicked, left on another device) keeps the selection on its server", () => {
    const { state, select } = setup();
    select("g4");
    removeSessionGuild(state, "g1");
    expect(getSelectedSidebarEntry(state.sidebar, state.channelList.channels).id).toBe("g4");
  });
});
