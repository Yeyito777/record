/**
 * Deferred restore of the saved starting state (channel and sidebar).
 *
 * The saved state is applied once synchronously at launch; the rest (loading
 * the saved channel, re-applying the sidebar cursor) waits for authentication,
 * channel lists or a provider to connect. Anything the user changes in the
 * meantime wins: the restore never reopens or closes the sidebar they toggled,
 * never moves a sidebar cursor they moved, and never switches back to the saved
 * channel after they opened another one.
 */

import { findTimelineChannel, setActiveChannelEntry } from "./channels";
import { INSTAGRAM_GUILD_ID, WHATSAPP_GUILD_ID } from "./chatproviders";
import type { SessionEffects } from "./session";
import type { AppState } from "./state";
import { applyTuiStartingState, availableStartingChannel, type StartingStateOverrides, type TuiStartingState } from "./startingstate";
import { clearTimeline } from "./timeline";

export interface StartingStateRestorerDeps {
  state: AppState;
  scheduleRender: () => void;
  instagram: { readonly isConnected: boolean; restoreChannel(channelId: string): Promise<boolean> };
  whatsapp: { restoreCachedChannel(channelId: string): Promise<boolean> };
  loadGuildChannels(state: AppState, token: string, guildId: string, effects: SessionEffects, options: { openFirstChannel: boolean; focusGuild: boolean }): Promise<void>;
  loadChannelMessages(state: AppState, token: string, channelId: string, effects: SessionEffects): Promise<unknown>;
}

/** What the user can change that a deferred restore would otherwise overwrite. */
interface UserFacingSnapshot {
  sidebarOpen: boolean;
  sidebarCursor: string;
  channel: string;
}


function snapshot(state: AppState): UserFacingSnapshot {
  const sidebar = state.sidebar;
  return {
    sidebarOpen: sidebar.open,
    sidebarCursor: JSON.stringify([
      sidebar.selectedItem, sidebar.selectedIndex, sidebar.scrollOffset, sidebar.currentFolderId,
      sidebar.expandedGuildId, sidebar.focusedGuildId, sidebar.collapsedCategoryIds,
    ]),
    channel: `${state.timeline.channelId ?? ""}/${state.channelList.activeChannelId ?? ""}`,
  };
}

export class StartingStateRestorer {
  private pending: TuiStartingState | null;
  private readonly overrides: StartingStateOverrides = { sidebarOpen: false, sidebarCursor: false, channel: false };
  private userActed = false;
  /** Until the restore has finished (it awaits after taking `pending`). */
  private tracking: boolean;

  constructor(private readonly deps: StartingStateRestorerDeps, startingState: TuiStartingState | null) {
    this.pending = startingState;
    this.tracking = startingState !== null;
  }

  get pendingState(): TuiStartingState | null {
    return this.pending;
  }

  /**
   * Run one batch of user input. Whatever it changes is the user's choice and
   * is left alone by the deferred restore.
   */
  userInput(handle: () => void): void {
    if (!this.tracking) {
      handle();
      return;
    }
    this.userActed = true;
    const before = snapshot(this.deps.state);
    try {
      handle();
    } finally {
      const after = snapshot(this.deps.state);
      if (after.sidebarOpen !== before.sidebarOpen) this.overrides.sidebarOpen = true;
      if (after.sidebarCursor !== before.sidebarCursor) this.overrides.sidebarCursor = true;
      if (after.channel !== before.channel) this.overrides.channel = true;
    }
  }

  /** The user opened a conversation (some open paths finish asynchronously). */
  userOpenedChannel(): void {
    if (this.tracking) this.overrides.channel = true;
  }

  /**
   * Some ways of opening a chat finish after the key that started them (a
   * server's channel list loads first). Only user input can leave anything
   * but the saved conversation open, so after input, any other is the user's.
   */
  private noteChannelSwitch(saved: TuiStartingState["focusedChannel"]): boolean {
    if (this.overrides.channel) return true;
    if (!this.userActed || !saved) return false;
    const { state } = this.deps;
    const open = [state.timeline.channelId, state.channelList.activeChannelId].filter((id): id is string => Boolean(id));
    if (open.some((id) => id !== saved.channelId)) this.overrides.channel = true;
    return this.overrides.channel;
  }

  async restore(token: string | null, options: { deferUnavailableGuild?: boolean } = {}): Promise<void> {
    const { state, scheduleRender } = this.deps;
    const startingState = this.pending;
    if (!startingState) return;
    const effects = { scheduleRender };
    this.noteChannelSwitch(startingState.focusedChannel);

    const savedChannel = this.overrides.channel ? null : startingState.focusedChannel;
    const finish = (restoredChannel: boolean): void => {
      applyTuiStartingState(state, restoredChannel ? startingState : { ...startingState, focusedChannel: null }, this.overrides);
      this.tracking = false;
      scheduleRender();
    };

    if (savedChannel?.guildId === INSTAGRAM_GUILD_ID) {
      if (!this.deps.instagram.isConnected) return;
      this.pending = null;
      const restored = await this.deps.instagram.restoreChannel(savedChannel.channelId).catch(() => false);
      // The user may have acted while Instagram was loading the chat.
      finish(restored && !this.noteChannelSwitch(savedChannel));
      return;
    }
    if (savedChannel?.guildId === WHATSAPP_GUILD_ID) {
      this.pending = null;
      const restored = await this.deps.whatsapp.restoreCachedChannel(savedChannel.channelId);
      finish(restored && !this.noteChannelSwitch(savedChannel));
      return;
    }

    const accountId = state.auth.user?.id;
    if (!token || !accountId) return;
    if (startingState.accountId && startingState.accountId !== accountId) {
      this.pending = null;
      this.tracking = false;
      return;
    }

    const channelLocation = savedChannel ? availableStartingChannel({ ...startingState, focusedChannel: savedChannel }, accountId, state.sidebar.guilds) : null;
    if (savedChannel && !channelLocation && options.deferUnavailableGuild) return;
    this.pending = null;
    let restoredFocusedChannel = savedChannel === null;
    if (channelLocation) {
      const cachedChannel = state.channelList.guildId === channelLocation.guildId
        ? findTimelineChannel(state.channelList.channels, channelLocation.channelId)
        : null;
      // The first frame already contains this channel and its messages. Start
      // message hydration now instead of waiting for the channel-list REST call.
      const messageHydration = cachedChannel && !cachedChannel.hidden
        ? this.deps.loadChannelMessages(state, token, cachedChannel.id, effects)
        : null;
      await this.deps.loadGuildChannels(state, token, channelLocation.guildId, effects, { openFirstChannel: false, focusGuild: false });
      if (this.noteChannelSwitch(savedChannel)) {
        if (messageHydration) await messageHydration;
        finish(false);
        return;
      }
      const channel = findTimelineChannel(state.channelList.channels, channelLocation.channelId);
      if (channel && !channel.hidden) {
        if (messageHydration) await messageHydration;
        else await this.deps.loadChannelMessages(state, token, channel.id, effects);
        if (this.noteChannelSwitch(savedChannel)) {
          finish(false);
          return;
        }
        setActiveChannelEntry(state.channelList, channel);
        restoredFocusedChannel = true;
      }
    }

    if (savedChannel && !restoredFocusedChannel) {
      // Authentication has now disproved the optimistic cache preview. Invalidate
      // any in-flight message refresh before dropping inaccessible stale content.
      state.timeline.requestId += 1;
      clearTimeline(state.timeline);
      setActiveChannelEntry(state.channelList, null);
      if (state.sidebar.activeGuildId === savedChannel.guildId) state.sidebar.activeGuildId = null;
    }

    // Loading the active channel necessarily focuses its guild. Restore the
    // independently saved sidebar cursor only after that work has completed.
    finish(restoredFocusedChannel);
  }
}
