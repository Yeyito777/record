import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { configDir } from "./config";
import type { DiscordGuild } from "./discord";
import type { SidebarSelectableItem } from "./sidebar";
import type { AppState } from "./state";

const TUI_STARTING_STATE_VERSION = 1;

export interface FocusedChannelStartingState {
  guildId: string;
  channelId: string;
}

interface ClosedSidebarStartingState {
  open: false;
}

interface OpenSidebarStartingState {
  open: true;
  currentFolderId: string | null;
  focusedGuildId: string | null;
  expandedGuildId: string | null;
  collapsedCategoryIds: string[];
  selectedItem: SidebarSelectableItem | null;
  scrollOffset: number;
}

export interface TuiStartingState {
  version: typeof TUI_STARTING_STATE_VERSION;
  accountId: string | null;
  focusedChannel: FocusedChannelStartingState | null;
  sidebar: ClosedSidebarStartingState | OpenSidebarStartingState;
}

export function tuiStartingStatePath(): string {
  return join(configDir(), "storage", "tui-state.json");
}

function copySidebarItem(item: SidebarSelectableItem | null): SidebarSelectableItem | null {
  if (!item) return null;
  if (item.type === "up") return { type: "up" };
  if (item.type === "channel") return { type: "channel", id: item.id, guildId: item.guildId };
  return { type: item.type, id: item.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) return undefined;
  return Array.from(new Set(value));
}

function parseSidebarItem(value: unknown): SidebarSelectableItem | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  if (value.type === "up") return { type: "up" };
  if (value.type === "guild" || value.type === "folder") {
    const id = parseOptionalId(value.id);
    return typeof id === "string" ? { type: value.type, id } : undefined;
  }
  if (value.type === "channel") {
    const id = parseOptionalId(value.id);
    const guildId = parseOptionalId(value.guildId);
    return typeof id === "string" && typeof guildId === "string"
      ? { type: "channel", id, guildId }
      : undefined;
  }
  return undefined;
}

function parseFocusedChannel(value: unknown): FocusedChannelStartingState | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const guildId = parseOptionalId(value.guildId);
  const channelId = parseOptionalId(value.channelId);
  return typeof guildId === "string" && typeof channelId === "string"
    ? { guildId, channelId }
    : undefined;
}

function parseStartingState(value: unknown): TuiStartingState | null {
  if (!isRecord(value) || value.version !== TUI_STARTING_STATE_VERSION || !isRecord(value.sidebar)) return null;

  const accountId = parseOptionalId(value.accountId);
  const focusedChannel = parseFocusedChannel(value.focusedChannel);
  if (accountId === undefined || focusedChannel === undefined || typeof value.sidebar.open !== "boolean") return null;

  if (!value.sidebar.open) {
    return {
      version: TUI_STARTING_STATE_VERSION,
      accountId,
      focusedChannel,
      sidebar: { open: false },
    };
  }

  const currentFolderId = parseOptionalId(value.sidebar.currentFolderId);
  const focusedGuildId = parseOptionalId(value.sidebar.focusedGuildId);
  const expandedGuildId = parseOptionalId(value.sidebar.expandedGuildId);
  const collapsedCategoryIds = parseIdList(value.sidebar.collapsedCategoryIds);
  const selectedItem = parseSidebarItem(value.sidebar.selectedItem);
  const scrollOffset = value.sidebar.scrollOffset;
  if (currentFolderId === undefined
      || focusedGuildId === undefined
      || expandedGuildId === undefined
      || collapsedCategoryIds === undefined
      || selectedItem === undefined
      || typeof scrollOffset !== "number"
      || !Number.isSafeInteger(scrollOffset)
      || scrollOffset < 0) {
    return null;
  }

  return {
    version: TUI_STARTING_STATE_VERSION,
    accountId,
    focusedChannel,
    sidebar: {
      open: true,
      currentFolderId,
      focusedGuildId,
      expandedGuildId,
      collapsedCategoryIds,
      selectedItem,
      scrollOffset,
    },
  };
}

export function captureTuiStartingState(
  state: Pick<AppState, "auth" | "channelList" | "timeline" | "sidebar">,
  pendingAccountId: string | null = null,
): TuiStartingState {
  const channelId = state.timeline.channelId ?? state.channelList.activeChannelId;
  const guildId = state.channelList.activeChannel?.guildId ?? state.channelList.guildId;
  const focusedChannel = channelId && guildId ? { guildId, channelId } : null;
  const sidebar = state.sidebar.open
    ? {
        open: true as const,
        currentFolderId: state.sidebar.currentFolderId,
        focusedGuildId: state.sidebar.focusedGuildId,
        expandedGuildId: state.sidebar.expandedGuildId,
        collapsedCategoryIds: Array.from(new Set(state.sidebar.collapsedCategoryIds)),
        selectedItem: copySidebarItem(state.sidebar.selectedItem),
        scrollOffset: Math.max(0, Math.floor(state.sidebar.scrollOffset)),
      }
    : { open: false as const };

  return {
    version: TUI_STARTING_STATE_VERSION,
    accountId: state.auth.user?.id ?? pendingAccountId,
    focusedChannel,
    sidebar,
  };
}

/** Seed local UI state before authoritative server and channel lists arrive. */
export function applyTuiStartingState(state: AppState, startingState: TuiStartingState): void {
  const focusedChannel = startingState.focusedChannel;
  if (focusedChannel) {
    state.channelList.guildId = focusedChannel.guildId;
    state.channelList.activeChannelId = focusedChannel.channelId;
    if (state.channelList.activeChannel?.id !== focusedChannel.channelId) {
      state.channelList.activeChannel = null;
    }
    state.timeline.channelId = focusedChannel.channelId;
  }

  state.sidebar.open = startingState.sidebar.open;
  if (!startingState.sidebar.open) return;

  state.sidebar.currentFolderId = startingState.sidebar.currentFolderId;
  state.sidebar.focusedGuildId = startingState.sidebar.focusedGuildId;
  state.sidebar.expandedGuildId = startingState.sidebar.expandedGuildId;
  state.sidebar.collapsedCategoryIds = [...startingState.sidebar.collapsedCategoryIds];
  state.sidebar.selectedItem = copySidebarItem(startingState.sidebar.selectedItem);
  state.sidebar.selectedIndex = 0;
  state.sidebar.scrollOffset = startingState.sidebar.scrollOffset;
}

/** Only restore a saved channel after authentication confirms its account and guild still exist. */
export function availableStartingChannel(
  startingState: TuiStartingState,
  accountId: string,
  guilds: Pick<DiscordGuild, "id">[],
): FocusedChannelStartingState | null {
  if (startingState.accountId && startingState.accountId !== accountId) return null;
  const channel = startingState.focusedChannel;
  return channel && guilds.some((guild) => guild.id === channel.guildId) ? { ...channel } : null;
}

export function loadTuiStartingState(): TuiStartingState | null {
  try {
    return parseStartingState(JSON.parse(readFileSync(tuiStartingStatePath(), "utf8")));
  } catch {
    return null;
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let directoryFd: number | null = null;
  try {
    directoryFd = openSync(directory, "r");
    fsyncSync(directoryFd);
  } catch {
    // Some platforms do not allow directories to be opened/fsynced. The file
    // replacement is still atomic there; this sync is only for crash durability.
  } finally {
    if (directoryFd !== null) {
      try { closeSync(directoryFd); } catch { /* best effort */ }
    }
  }
}

function atomicWriteFile(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let tempFd: number | null = null;

  try {
    // Keep the temporary file beside its destination so rename is one atomic
    // filesystem operation. Sync the complete JSON before replacing old state.
    tempFd = openSync(tempPath, "wx", 0o600);
    writeFileSync(tempFd, contents, "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    renameSync(tempPath, path);
    syncDirectoryBestEffort(directory);
  } catch (error) {
    if (tempFd !== null) {
      try { closeSync(tempFd); } catch { /* best effort */ }
    }
    try { rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function saveTuiStartingState(startingState: TuiStartingState): void {
  atomicWriteFile(tuiStartingStatePath(), `${JSON.stringify(startingState, null, 2)}\n`);
}
