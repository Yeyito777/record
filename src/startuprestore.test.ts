import { describe, expect, test } from "bun:test";

import { INSTAGRAM_GUILD_ID, WHATSAPP_GUILD_ID } from "./chatproviders";
import { setChannelList } from "./channels";
import { applyTuiStartingState, type TuiStartingState } from "./startingstate";
import { StartingStateRestorer } from "./startuprestore";
import { createInitialState, type AppState } from "./state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const SAVED_SIDEBAR = {
  open: true as const,
  currentFolderId: null,
  focusedGuildId: "g1",
  expandedGuildId: "g1",
  collapsedCategoryIds: [],
  selectedItem: { type: "guild" as const, id: "g1" },
  scrollOffset: 3,
};

function savedState(guildId: string, channelId: string, sidebarOpen: boolean): TuiStartingState {
  return {
    version: 1,
    accountId: "me",
    focusedChannel: { guildId, channelId },
    sidebar: sidebarOpen ? SAVED_SIDEBAR : { open: false },
  } as TuiStartingState;
}

/** Launch as main.ts does: seed synchronously, restore later. */
function launch(saved: TuiStartingState) {
  const state = createInitialState("token", "/tmp/record-config.json");
  state.auth.user = { id: "me", username: "me", globalName: "Me", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
  state.sidebar.guilds = [{ id: "g1", name: "One", icon: null }];
  setChannelList(state.channelList, "g1", [
    { id: "c1", guildId: "g1", parentId: null, name: "saved", topic: null, position: 0, type: 0, nsfw: false },
    { id: "c2", guildId: "g1", parentId: null, name: "other", topic: null, position: 1, type: 0, nsfw: false },
  ]);
  applyTuiStartingState(state, saved);
  const providerRestore = deferred<boolean>();
  const guildLoad = deferred<void>();
  const opened: string[] = [];
  const restorer = new StartingStateRestorer({
    state,
    scheduleRender: () => {},
    instagram: { isConnected: true, restoreChannel: async (channelId) => { opened.push(channelId); return providerRestore.promise; } },
    whatsapp: { restoreCachedChannel: async (channelId) => { opened.push(channelId); return providerRestore.promise; } },
    loadGuildChannels: async () => guildLoad.promise,
    loadChannelMessages: async (_state: AppState, _token: string, channelId: string) => { opened.push(channelId); },
  }, saved);
  return { state, restorer, providerRestore, guildLoad, opened };
}

const cases = [
  { name: "Discord", guildId: "g1", channelId: "c1" },
  { name: "WhatsApp", guildId: WHATSAPP_GUILD_ID, channelId: "wa:123@s.whatsapp.net" },
  { name: "Instagram", guildId: INSTAGRAM_GUILD_ID, channelId: "ig:456" },
];

describe("deferred starting-state restore", () => {
  for (const { name, guildId, channelId } of cases) {
    const finish = async (run: ReturnType<typeof launch>) => {
      const restoring = run.restorer.restore("token");
      run.providerRestore.resolve(true);
      run.guildLoad.resolve();
      await restoring;
    };

    test(`a sidebar the user toggled while it loaded stays as they left it (${name})`, async () => {
      for (const savedOpen of [false, true]) {
        const run = launch(savedState(guildId, channelId, savedOpen));
        expect(run.state.sidebar.open).toBe(savedOpen);
        run.restorer.userInput(() => { run.state.sidebar.open = !run.state.sidebar.open; });
        await finish(run);
        expect(run.state.sidebar.open).toBe(!savedOpen);
      }
    });

    test(`a sidebar cursor the user moved is not put back (${name})`, async () => {
      const run = launch(savedState(guildId, channelId, true));
      run.restorer.userInput(() => {
        run.state.sidebar.selectedItem = { type: "guild", id: "g9" };
        run.state.sidebar.scrollOffset = 0;
      });
      await finish(run);
      expect(run.state.sidebar.open).toBe(true);
      expect(run.state.sidebar.selectedItem).toEqual({ type: "guild", id: "g9" });
      expect(run.state.sidebar.scrollOffset).toBe(0);
    });

    test(`another chat the user opened is not switched back (${name})`, async () => {
      const run = launch(savedState(guildId, channelId, false));
      run.restorer.userInput(() => {
        run.state.channelList.activeChannelId = "c2";
        run.state.timeline.channelId = "c2";
      });
      await finish(run);
      expect(run.state.timeline.channelId).toBe("c2");
      expect(run.opened.filter((id) => id === channelId)).toEqual([]);
    });

    test(`without user input the restore works as before (${name})`, async () => {
      const run = launch(savedState(guildId, channelId, true));
      run.state.sidebar.open = false;
      await finish(run);
      expect(run.state.sidebar.open).toBe(true);
      expect(run.state.sidebar.scrollOffset).toBe(3);
      expect(run.state.timeline.channelId).toBe(channelId);
    });
  }

  test("a chat opened during the restore's own loading (async open) also wins", async () => {
    const run = launch(savedState("g1", "c1", false));
    const restoring = run.restorer.restore("token");
    run.restorer.userInput(() => {});
    run.state.channelList.activeChannelId = "c2";
    run.state.timeline.channelId = "c2";
    run.guildLoad.resolve();
    await restoring;
    expect(run.state.timeline.channelId).toBe("c2");
    // Only the revalidation started at launch, before the user acted; the
    // restore does not open the saved channel again afterwards.
    expect(run.opened).toEqual(["c1"]);
  });
});
