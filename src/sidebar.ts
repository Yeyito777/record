/**
 * Servers sidebar with collapsible guild/category/channel tree.
 */

import { randomUUID } from "crypto";

import type { CompletionItem } from "./commands";
import { isFixedTopLevelGuildId, WHATSAPP_GUILD_ID } from "./chatproviders";
import { DIRECT_MESSAGES_GUILD_ID, compareSnowflakesDesc, isThreadChannel, type DiscordChannel, type DiscordGuild } from "./discord";
import { graphemeBoundaryAtOrAfter, nextGraphemeEnd, previousGraphemeStart } from "./editor-buffer";
import type { KeyEvent } from "./input";
import { loadingLabel } from "./loading";
import type { ServerActionModalState } from "./serveractions";
import { getViewportByWidth, padRight, termWidth, truncate } from "./textwidth";
import { theme } from "./theme";
import {
  scrollByAmountWithCursorInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
} from "./vimscroll";

export const SIDEBAR_WIDTH = 28;

export type SidebarEntryKind = "guild" | "folder" | "up" | "category" | "channel" | "voice-member" | "delimiter" | "loading";
export type SidebarSearchDirection = "forward" | "backward";
export type SidebarSearchBarMode = "search" | "command";
export type SidebarFolderPromptPurpose = "create_folder" | "move_items" | "rename_folder";

export interface SidebarFolder {
  id: string;
  name: string;
  parentId: string | null;
  pinned: boolean;
  sortOrder: number;
}

export interface SidebarGuildPlacement {
  folderId: string | null;
  pinned: boolean;
  sortOrder: number;
}

export interface SidebarChannelPlacement {
  pinned: boolean;
  sortOrder: number;
}

/** Local ordering for conversation rows inside provider-owned sidebar roots. */
export type SidebarChannelLayout = Record<string, Record<string, SidebarChannelPlacement>>;

export interface SidebarFolderLayout {
  folders: SidebarFolder[];
  guildPlacements: Record<string, SidebarGuildPlacement>;
}

export type SidebarItemRef = { type: "guild" | "folder"; id: string };
export type SidebarSelectableItem = SidebarItemRef | { type: "channel"; id: string; guildId: string } | { type: "up" };

export interface SidebarFolderPromptAutocompleteState {
  selection: number;
  prefix: string;
  matches: CompletionItem[];
}

export interface SidebarFolderPromptState {
  purpose: SidebarFolderPromptPurpose;
  input: string;
  cursorPos: number;
  items: SidebarItemRef[];
  folderId?: string;
  autocomplete?: SidebarFolderPromptAutocompleteState | null;
}

export type SidebarSearchKeyResult =
  | { type: "handled" }
  | { type: "abort" };

export interface SidebarSearchState {
  barOpen: boolean;
  barMode: SidebarSearchBarMode;
  direction: SidebarSearchDirection;
  query: string;
  barInput: string;
  barCursorPos: number;
  highlightsVisible: boolean;
  savedSelectedEntry: Pick<SidebarEntry, "kind" | "id" | "guildId"> | null;
  savedSelectedIndex: number;
  savedScrollOffset: number;
}

export interface SidebarEntry {
  kind: SidebarEntryKind;
  id: string;
  guildId: string;
  channelId?: string;
  userId?: string;
  label: string;
  depth: number;
  channelType?: number;
  notificationCount?: number;
  muted?: boolean;
  selfMuted?: boolean;
  deafened?: boolean;
  localMuted?: boolean;
  streaming?: boolean;
  cameraOn?: boolean;
  self?: boolean;
  color?: string;
  hidden?: boolean;
  selected: boolean;
  active: boolean;
  expanded: boolean;
  item?: SidebarSelectableItem;
  childCount?: number;
  searchMatched?: boolean;
}

export interface SidebarVoiceMember {
  userId: string;
  displayName: string;
  muted?: boolean;
  selfMuted?: boolean;
  deafened?: boolean;
  localMuted?: boolean;
  streaming?: boolean;
  cameraOn?: boolean;
  self?: boolean;
  color?: string;
}

export interface SidebarVisibilityOptions {
  showHiddenChannels?: boolean;
  /** Authenticated Discord user used to retain threads they created. */
  currentUserId?: string | null;
}

export interface SidebarState {
  open: boolean;
  guilds: DiscordGuild[];
  selectedIndex: number;
  focusedGuildId: string | null;
  activeGuildId: string | null;
  expandedGuildId: string | null;
  collapsedCategoryIds: string[];
  folders: SidebarFolder[];
  currentFolderId: string | null;
  guildPlacements: Record<string, SidebarGuildPlacement>;
  channelPlacementsByGuildId: SidebarChannelLayout;
  selectedItem: SidebarSelectableItem | null;
  visualAnchor: SidebarItemRef | null;
  pendingDeleteItem: SidebarItemRef | null;
  prompt: SidebarFolderPromptState | null;
  loadingGuildId: string | null;
  scrollOffset: number;
  loading: boolean;
  requestId: number;
  /** Cached channels by guild id, including the synthetic direct-message guild. */
  cachedChannelsByGuildId: Record<string, DiscordChannel[]>;
  voiceMembersByChannelId: Record<string, SidebarVoiceMember[]>;
  search: SidebarSearchState | null;
  serverActionModal: ServerActionModalState | null;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    guilds: [],
    selectedIndex: 0,
    focusedGuildId: null,
    activeGuildId: null,
    expandedGuildId: null,
    collapsedCategoryIds: [],
    folders: [],
    currentFolderId: null,
    guildPlacements: {},
    channelPlacementsByGuildId: {},
    selectedItem: null,
    visualAnchor: null,
    pendingDeleteItem: null,
    prompt: null,
    loadingGuildId: null,
    scrollOffset: 0,
    loading: false,
    requestId: 0,
    cachedChannelsByGuildId: {},
    voiceMembersByChannelId: {},
    search: null,
    serverActionModal: null,
  };
}

function isSelectableEntry(entry: SidebarEntry): boolean {
  return entry.kind !== "loading" && entry.kind !== "delimiter";
}

function sameSidebarItem(a: SidebarSelectableItem | null | undefined, b: SidebarSelectableItem | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "up" && b.type === "up") return true;
  return "id" in a && "id" in b && a.id === b.id;
}

function sidebarItemKey(item: SidebarSelectableItem | null | undefined): string | null {
  if (!item) return null;
  if (item.type === "up") return "up";
  if (item.type === "channel") return `channel:${item.guildId}:${item.id}`;
  return `${item.type}:${item.id}`;
}

function isMovableSidebarItem(item: SidebarSelectableItem | null | undefined): item is SidebarItemRef {
  return item?.type === "guild" || item?.type === "folder";
}

function guildPlacement(sidebar: SidebarState, guildId: string): SidebarGuildPlacement {
  const index = sidebar.guilds.findIndex((guild) => guild.id === guildId);
  return sidebar.guildPlacements[guildId] ?? { folderId: null, pinned: false, sortOrder: index < 0 ? 0 : index };
}

function itemParent(sidebar: SidebarState, item: SidebarItemRef): string | null | undefined {
  if (item.type === "guild") return guildPlacement(sidebar, item.id).folderId ?? null;
  return sidebar.folders.find((folder) => folder.id === item.id)?.parentId ?? null;
}

function itemPinned(sidebar: SidebarState, item: SidebarItemRef): boolean | undefined {
  if (item.type === "guild") return guildPlacement(sidebar, item.id).pinned;
  return sidebar.folders.find((folder) => folder.id === item.id)?.pinned;
}

function itemSortOrder(sidebar: SidebarState, item: SidebarItemRef): number {
  if (item.type === "guild") return guildPlacement(sidebar, item.id).sortOrder;
  return sidebar.folders.find((folder) => folder.id === item.id)?.sortOrder ?? 0;
}

function compareSidebarOrder(a: { pinned: boolean; sortOrder: number; name: string }, b: { pinned: boolean; sortOrder: number; name: string }): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

function normalizeSidebarPlacement(sidebar: SidebarState): void {
  const validFolderIds = new Set(sidebar.folders.map((folder) => folder.id));
  const validGuildIds = new Set(sidebar.guilds.map((guild) => guild.id));
  sidebar.folders = sidebar.folders.map((folder, index) => ({
    ...folder,
    parentId: folder.parentId && validFolderIds.has(folder.parentId) && folder.parentId !== folder.id ? folder.parentId : null,
    pinned: Boolean(folder.pinned),
    sortOrder: Number.isFinite(folder.sortOrder) ? folder.sortOrder : index,
  }));
  for (const [guildId, placement] of Object.entries(sidebar.guildPlacements)) {
    if (!validGuildIds.has(guildId)) {
      delete sidebar.guildPlacements[guildId];
      continue;
    }
    if (isFixedTopLevelGuildId(guildId)) {
      delete sidebar.guildPlacements[guildId];
      continue;
    }
    sidebar.guildPlacements[guildId] = {
      folderId: placement.folderId && validFolderIds.has(placement.folderId) ? placement.folderId : null,
      pinned: Boolean(placement.pinned),
      sortOrder: Number.isFinite(placement.sortOrder) ? placement.sortOrder : sidebar.guilds.findIndex((guild) => guild.id === guildId),
    };
  }
  if (sidebar.currentFolderId && !validFolderIds.has(sidebar.currentFolderId)) sidebar.currentFolderId = null;
  if (sidebar.visualAnchor && itemParent(sidebar, sidebar.visualAnchor) === undefined) sidebar.visualAnchor = null;
}

export function sidebarFolderLayout(sidebar: SidebarState): SidebarFolderLayout {
  normalizeSidebarPlacement(sidebar);
  return {
    folders: sidebar.folders.map((folder) => ({ ...folder })),
    guildPlacements: Object.fromEntries(Object.entries(sidebar.guildPlacements).map(([guildId, placement]) => [guildId, { ...placement }])),
  };
}

export function sidebarChannelLayoutForGuild(sidebar: SidebarState, guildId: string): Record<string, SidebarChannelPlacement> {
  return Object.fromEntries(Object.entries(sidebar.channelPlacementsByGuildId[guildId] ?? {}).map(([channelId, placement]) => [
    channelId,
    { pinned: Boolean(placement.pinned), sortOrder: placement.sortOrder },
  ]));
}

export function applySidebarChannelLayoutForGuild(
  sidebar: SidebarState,
  guildId: string,
  layout: Record<string, SidebarChannelPlacement> | null | undefined,
): void {
  const placements: Record<string, SidebarChannelPlacement> = {};
  for (const [channelId, placement] of Object.entries(layout ?? {})) {
    if (!channelId || !placement || !Number.isFinite(placement.sortOrder)) continue;
    placements[channelId] = { pinned: Boolean(placement.pinned), sortOrder: placement.sortOrder };
  }
  sidebar.channelPlacementsByGuildId[guildId] = placements;
}

export function applySidebarFolderLayout(sidebar: SidebarState, layout: SidebarFolderLayout | null | undefined): void {
  sidebar.folders = (layout?.folders ?? []).map((folder, index) => ({
    id: folder.id,
    name: folder.name || "Folder",
    parentId: folder.parentId ?? null,
    pinned: Boolean(folder.pinned),
    sortOrder: Number.isFinite(folder.sortOrder) ? folder.sortOrder : index,
  }));
  sidebar.guildPlacements = Object.fromEntries(Object.entries(layout?.guildPlacements ?? {}).map(([guildId, placement]) => [guildId, {
    folderId: placement.folderId ?? null,
    pinned: Boolean(placement.pinned),
    sortOrder: Number.isFinite(placement.sortOrder) ? placement.sortOrder : 0,
  }]));
  normalizeSidebarPlacement(sidebar);
}

export function currentSidebarFolder(sidebar: SidebarState): SidebarFolder | null {
  return sidebar.currentFolderId ? sidebar.folders.find((folder) => folder.id === sidebar.currentFolderId) ?? null : null;
}

export function sidebarFolderPath(sidebar: SidebarState, folderId: string | null | undefined): string {
  if (!folderId) return "";
  const names: string[] = [];
  const seen = new Set<string>();
  let folder = sidebar.folders.find((candidate) => candidate.id === folderId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    names.unshift(folder.name);
    folder = folder.parentId ? sidebar.folders.find((candidate) => candidate.id === folder?.parentId) : undefined;
  }
  return names.join("/");
}

function parentOfCurrentFolder(sidebar: SidebarState): string | null {
  return currentSidebarFolder(sidebar)?.parentId ?? null;
}

function descendantFolderIds(sidebar: SidebarState, folderId: string): Set<string> {
  const ids = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of sidebar.folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

function clampSelectedIndex(sidebar: SidebarState, entries: SidebarEntry[]): number {
  if (entries.length === 0) return 0;

  const clamped = Math.max(0, Math.min(sidebar.selectedIndex, entries.length - 1));
  if (isSelectableEntry(entries[clamped])) return clamped;

  for (let offset = 1; offset < entries.length; offset++) {
    const down = clamped + offset;
    if (down < entries.length && isSelectableEntry(entries[down])) return down;

    const up = clamped - offset;
    if (up >= 0 && isSelectableEntry(entries[up])) return up;
  }

  return 0;
}

function findSelectableEntryIndex(entries: SidebarEntry[], start: number, end: number, step: -1 | 1): number | null {
  for (let index = start; step > 0 ? index <= end : index >= end; index += step) {
    const entry = entries[index];
    if (entry && isSelectableEntry(entry)) return index;
  }
  return null;
}

export function clearSidebarData(sidebar: SidebarState): void {
  sidebar.guilds = [];
  sidebar.selectedIndex = 0;
  sidebar.focusedGuildId = null;
  sidebar.activeGuildId = null;
  sidebar.expandedGuildId = null;
  sidebar.collapsedCategoryIds = [];
  sidebar.folders = [];
  sidebar.currentFolderId = null;
  sidebar.guildPlacements = {};
  sidebar.channelPlacementsByGuildId = {};
  sidebar.selectedItem = null;
  sidebar.visualAnchor = null;
  sidebar.pendingDeleteItem = null;
  sidebar.prompt = null;
  sidebar.loadingGuildId = null;
  sidebar.scrollOffset = 0;
  sidebar.loading = false;
  sidebar.cachedChannelsByGuildId = {};
  sidebar.voiceMembersByChannelId = {};
  sidebar.search = null;
  sidebar.serverActionModal = null;
}

export function setSidebarGuilds(sidebar: SidebarState, guilds: DiscordGuild[]): void {
  const previousMutedByGuildId = new Map(sidebar.guilds.map((guild) => [guild.id, guild.muted]));
  const previousGuildIds = new Set(sidebar.guilds.map((guild) => guild.id));
  sidebar.guilds = guilds.map((guild, index) => ({
    ...guild,
    muted: guild.muted ?? previousMutedByGuildId.get(guild.id),
  }));
  for (const [guildId] of Object.entries(sidebar.guildPlacements)) {
    if (!guilds.some((guild) => guild.id === guildId)) delete sidebar.guildPlacements[guildId];
  }
  for (const [index, guild] of sidebar.guilds.entries()) {
    if (isFixedTopLevelGuildId(guild.id)) continue;
    if (!sidebar.guildPlacements[guild.id]) {
      sidebar.guildPlacements[guild.id] = {
        folderId: null,
        pinned: false,
        sortOrder: previousGuildIds.has(guild.id) ? sidebar.guilds.findIndex((candidate) => candidate.id === guild.id) : index,
      };
    }
  }
  normalizeSidebarPlacement(sidebar);
  sidebar.selectedIndex = Math.max(0, Math.min(sidebar.selectedIndex, Math.max(0, guilds.length - 1)));

  if (sidebar.activeGuildId && !guilds.some((guild) => guild.id === sidebar.activeGuildId)) {
    sidebar.activeGuildId = null;
  }
  if (sidebar.focusedGuildId && !guilds.some((guild) => guild.id === sidebar.focusedGuildId)) {
    sidebar.focusedGuildId = null;
  }
  if (sidebar.expandedGuildId && !guilds.some((guild) => guild.id === sidebar.expandedGuildId)) {
    sidebar.expandedGuildId = null;
  }
  if (sidebar.serverActionModal && !guilds.some((guild) => guild.id === sidebar.serverActionModal?.guildId)) {
    sidebar.serverActionModal = null;
  }
}

export function setSidebarGuildMuted(sidebar: SidebarState, guildId: string, muted: boolean): boolean {
  const index = sidebar.guilds.findIndex((guild) => guild.id === guildId);
  if (index < 0) return false;
  sidebar.guilds[index] = { ...sidebar.guilds[index]!, muted };
  return true;
}

export function setSidebarCachedChannels(sidebar: SidebarState, guildId: string, channels: DiscordChannel[]): void {
  const previousMutedByChannelId = new Map((sidebar.cachedChannelsByGuildId[guildId] ?? []).map((channel) => [channel.id, channel.muted]));
  sidebar.cachedChannelsByGuildId[guildId] = channels.map((channel) => ({
    ...channel,
    muted: channel.muted ?? previousMutedByChannelId.get(channel.id),
  }));
}

export function clearSidebarCachedChannels(sidebar: SidebarState): void {
  sidebar.cachedChannelsByGuildId = {};
}

export function sidebarChannelsForGuild(sidebar: SidebarState, activeChannels: DiscordChannel[], guildId: string): DiscordChannel[] {
  const byId = new Map<string, DiscordChannel>();
  for (const channel of sidebar.cachedChannelsByGuildId[guildId] ?? []) {
    byId.set(channel.id, channel);
  }
  for (const channel of activeChannels) {
    if (channel.guildId === guildId) {
      const cached = byId.get(channel.id);
      // WhatsApp's provider cache is rebuilt from its persisted chat state, while
      // the active channel list can briefly retain the pre-hydration snapshot.
      // Prefer the provider value so stale false/true flags cannot hide or retain a mute.
      const muted = guildId === WHATSAPP_GUILD_ID
        ? cached?.muted ?? channel.muted
        : channel.muted ?? cached?.muted;
      byId.set(channel.id, { ...channel, muted });
    }
  }
  return Array.from(byId.values());
}

/** Make a newly opened channel visible and selected without moving focus to the sidebar. */
export function revealSidebarChannel(
  sidebar: SidebarState,
  activeChannels: DiscordChannel[],
  guildId: string,
  channelId: string,
  options: SidebarVisibilityOptions = {},
): boolean {
  const channels = sidebarChannelsForGuild(sidebar, activeChannels, guildId);
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel) return false;

  const parent = isThreadChannel(channel) && channel.parentId
    ? channels.find((candidate) => candidate.id === channel.parentId) ?? null
    : channel;
  const categoryId = parent?.parentId && channels.some((candidate) => candidate.id === parent.parentId && candidate.type === 4)
    ? parent.parentId
    : null;
  if (categoryId) {
    sidebar.collapsedCategoryIds = sidebar.collapsedCategoryIds.filter((id) => id !== categoryId);
  }

  const guildParent = itemParent(sidebar, { type: "guild", id: guildId });
  sidebar.currentFolderId = guildParent === undefined ? null : guildParent;
  sidebar.expandedGuildId = guildId;
  sidebar.focusedGuildId = guildId;
  sidebar.selectedItem = { type: "channel", id: channelId, guildId };

  const entries = buildSidebarEntries(sidebar, activeChannels, 0, new Set(), "⋯", new Map(), new Map(), options);
  const index = entries.findIndex((entry) => entry.kind === "channel" && entry.guildId === guildId && entry.id === channelId);
  if (index < 0) return false;
  sidebar.selectedIndex = index;
  return true;
}

function allSidebarChannels(sidebar: SidebarState, activeChannels: DiscordChannel[]): DiscordChannel[] {
  const byId = new Map<string, DiscordChannel>();
  for (const channels of Object.values(sidebar.cachedChannelsByGuildId)) {
    for (const channel of channels) byId.set(channel.id, channel);
  }
  for (const channel of activeChannels) {
    const cached = byId.get(channel.id);
    byId.set(channel.id, { ...channel, muted: channel.muted ?? cached?.muted });
  }
  return Array.from(byId.values());
}

export interface SidebarGuildMoveResult {
  guild: DiscordGuild;
  previousGuilds: DiscordGuild[];
  nextGuilds: DiscordGuild[];
}

function assignItemSortOrder(sidebar: SidebarState, item: SidebarItemRef, sortOrder: number): void {
  if (item.type === "guild") {
    const existing = guildPlacement(sidebar, item.id);
    sidebar.guildPlacements[item.id] = { ...existing, sortOrder };
    return;
  }
  const folder = sidebar.folders.find((candidate) => candidate.id === item.id);
  if (folder) folder.sortOrder = sortOrder;
}

function assignItemParent(sidebar: SidebarState, item: SidebarItemRef, parentId: string | null): void {
  if (item.type === "guild") {
    if (isFixedTopLevelGuildId(item.id)) return;
    const existing = guildPlacement(sidebar, item.id);
    sidebar.guildPlacements[item.id] = { ...existing, folderId: parentId };
    return;
  }
  const folder = sidebar.folders.find((candidate) => candidate.id === item.id);
  if (folder) folder.parentId = parentId;
}

function assignItemPinned(sidebar: SidebarState, item: SidebarItemRef, pinned: boolean): void {
  if (item.type === "guild") {
    if (isFixedTopLevelGuildId(item.id)) return;
    const existing = guildPlacement(sidebar, item.id);
    sidebar.guildPlacements[item.id] = { ...existing, pinned };
    return;
  }
  const folder = sidebar.folders.find((candidate) => candidate.id === item.id);
  if (folder) folder.pinned = pinned;
}

type SidebarOrderEntry = { type: "guild" | "folder"; id: string; pinned: boolean; sortOrder: number };

function sidebarOrderEntries(sidebar: SidebarState, parentId: string | null): SidebarOrderEntry[] {
  const entries: SidebarOrderEntry[] = [];
  for (const folder of sidebar.folders) {
    if ((folder.parentId ?? null) === parentId) {
      entries.push({ type: "folder", id: folder.id, pinned: folder.pinned, sortOrder: folder.sortOrder });
    }
  }
  for (const guild of sidebar.guilds) {
    if (isFixedTopLevelGuildId(guild.id)) continue;
    const placement = guildPlacement(sidebar, guild.id);
    if ((placement.folderId ?? null) === parentId) {
      entries.push({ type: "guild", id: guild.id, pinned: placement.pinned, sortOrder: placement.sortOrder });
    }
  }
  return entries.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder);
}

function nextUnpinnedOrderInFolder(sidebar: SidebarState, parentId: string | null, excludeId?: string): number {
  let minOrder = 0;
  for (const entry of sidebarOrderEntries(sidebar, parentId)) {
    if (!entry.pinned && entry.id !== excludeId && entry.sortOrder < minOrder) minOrder = entry.sortOrder;
  }
  return minOrder - 1;
}

function nextPinnedOrderInFolder(sidebar: SidebarState, parentId: string | null, excludeId?: string): number {
  let maxOrder = -Infinity;
  for (const entry of sidebarOrderEntries(sidebar, parentId)) {
    if (entry.pinned && entry.id !== excludeId && entry.sortOrder > maxOrder) maxOrder = entry.sortOrder;
  }
  return maxOrder === -Infinity ? 0 : maxOrder + 1;
}

function currentFolderRef(sidebar: SidebarState): SidebarItemRef | undefined {
  return sidebar.currentFolderId ? { type: "folder", id: sidebar.currentFolderId } : undefined;
}

function topLevelCurrentFolderRef(sidebar: SidebarState): SidebarItemRef | undefined {
  let folder = currentSidebarFolder(sidebar);
  if (!folder) return undefined;
  const seen = new Set<string>();
  while (folder.parentId && !seen.has(folder.id)) {
    seen.add(folder.id);
    const parent = sidebar.folders.find((candidate) => candidate.id === folder?.parentId);
    if (!parent) break;
    folder = parent;
  }
  return { type: "folder", id: folder.id };
}

function siblingMovableItems(sidebar: SidebarState, parentId: string | null, pinned?: boolean): SidebarItemRef[] {
  return folderVisibleItems({ ...sidebar, currentFolderId: parentId }).map(({ item }) => item)
    .filter((item) => item.type !== "guild" || !isFixedTopLevelGuildId(item.id))
    .filter((item) => pinned === undefined || itemPinned(sidebar, item) === pinned);
}

function normalizeSiblingSortOrders(sidebar: SidebarState, parentId: string | null, pinned?: boolean): void {
  const siblings = siblingMovableItems(sidebar, parentId, pinned);
  siblings.forEach((item, index) => assignItemSortOrder(sidebar, item, index));
}

export function selectedSidebarItems(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): SidebarItemRef[] {
  const selected = getSelectedSidebarEntry(sidebar, channels, options).item;
  if (!isMovableSidebarItem(selected)) return [];
  if (!sidebar.visualAnchor) return [selected];
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options)
    .filter((entry) => isMovableSidebarItem(entry.item));
  const anchorIndex = entries.findIndex((entry) => sameSidebarItem(entry.item, sidebar.visualAnchor));
  const selectedIndex = entries.findIndex((entry) => sameSidebarItem(entry.item, selected));
  if (anchorIndex < 0 || selectedIndex < 0) return [selected];
  const start = Math.min(anchorIndex, selectedIndex);
  const end = Math.max(anchorIndex, selectedIndex);
  return entries.slice(start, end + 1).map((entry) => entry.item as SidebarItemRef);
}

function nextItemAfterRemovingItems(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  items: SidebarItemRef[],
  options: SidebarVisibilityOptions = {},
): SidebarSelectableItem | null {
  const removedKeys = new Set(items.map((item) => sidebarItemKey(item)));
  const rowsBefore = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options)
    .filter((entry): entry is SidebarEntry & { item: Exclude<SidebarSelectableItem, { type: "channel" }> } => (
      Boolean(entry.item) && entry.item?.type !== "channel"
    ));
  const removedIndices = rowsBefore
    .map((entry, index) => removedKeys.has(sidebarItemKey(entry.item)) ? index : -1)
    .filter((index) => index !== -1);
  const rowsAfter = rowsBefore.filter((entry) => !removedKeys.has(sidebarItemKey(entry.item)));
  if (rowsAfter.length === 0) return null;
  const removedIndex = removedIndices.length === 0 ? 0 : Math.min(...removedIndices);
  const nextIndex = Math.min(removedIndex, rowsAfter.length - 1);
  return rowsAfter[nextIndex]?.item ?? null;
}

function requestFocusAfterMovingItemsOutOfView(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  items: SidebarItemRef[],
  options: SidebarVisibilityOptions = {},
): void {
  const next = nextItemAfterRemovingItems(sidebar, channels, items, options);
  sidebar.selectedItem = next?.type === "up" ? null : next;
  if (!sidebar.selectedItem) sidebar.selectedIndex = 0;
}

interface LocalMoveSidebarItemsOptions {
  preservePinned?: boolean;
  placement?: "bottom";
}

function moveSidebarItems(
  sidebar: SidebarState,
  items: SidebarItemRef[],
  parentId: string | null,
  before?: SidebarItemRef,
  options: LocalMoveSidebarItemsOptions = {},
): boolean {
  const safeParent = parentId && sidebar.folders.some((folder) => folder.id === parentId) ? parentId : null;
  const seen = new Set<string>();
  const movableItems: SidebarItemRef[] = [];
  for (const item of items) {
    if (item.type === "guild" && isFixedTopLevelGuildId(item.id)) continue;
    const key = sidebarItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (item.type === "folder") {
      if (!sidebar.folders.some((folder) => folder.id === item.id)) continue;
      if (item.id === safeParent || (safeParent && descendantFolderIds(sidebar, item.id).has(safeParent))) continue;
    } else if (!sidebar.guilds.some((guild) => guild.id === item.id)) {
      continue;
    }
    movableItems.push(item);
  }
  if (movableItems.length === 0) return false;

  const movingKeys = new Set(movableItems.map((item) => sidebarItemKey(item)));
  const destinationEntries = sidebarOrderEntries(sidebar, safeParent)
    .filter((entry) => !movingKeys.has(`${entry.type}:${entry.id}`));
  const preservedPinned = options.preservePinned ? itemPinned(sidebar, movableItems[0]!) : undefined;
  const hasHomogeneousPinnedState = preservedPinned !== undefined && movableItems.every((item) => itemPinned(sidebar, item) === preservedPinned);
  const anchorEntries = hasHomogeneousPinnedState
    ? destinationEntries.filter((entry) => entry.pinned === preservedPinned)
    : destinationEntries;
  const beforeEntry = before && itemParent(sidebar, before) === safeParent
    ? anchorEntries.find((entry) => entry.type === before.type && entry.id === before.id)
    : undefined;
  const beforeIndex = beforeEntry ? anchorEntries.findIndex((entry) => entry.type === beforeEntry.type && entry.id === beforeEntry.id) : -1;
  const previousEntry = beforeIndex > 0 ? anchorEntries[beforeIndex - 1] : undefined;

  let startOrder: number;
  let step: number;
  if (beforeEntry) {
    startOrder = previousEntry
      ? previousEntry.sortOrder + ((beforeEntry.sortOrder - previousEntry.sortOrder) / (movableItems.length + 1))
      : beforeEntry.sortOrder - movableItems.length;
    step = previousEntry ? (beforeEntry.sortOrder - previousEntry.sortOrder) / (movableItems.length + 1) : 1;
  } else if (options.placement === "bottom") {
    const placementEntries = hasHomogeneousPinnedState ? anchorEntries : destinationEntries;
    const maxOrder = placementEntries.reduce((max, entry) => Math.max(max, entry.sortOrder), -Infinity);
    startOrder = maxOrder === -Infinity ? 0 : maxOrder + 1;
    step = 1;
  } else {
    startOrder = nextUnpinnedOrderInFolder(sidebar, safeParent) - movableItems.length;
    step = 1;
  }

  let order = startOrder - step;
  for (const item of movableItems) {
    order += step;
    assignItemParent(sidebar, item, safeParent);
    assignItemPinned(sidebar, item, options.preservePinned ? itemPinned(sidebar, item) ?? false : false);
    assignItemSortOrder(sidebar, item, order);
  }
  return true;
}

export function moveSelectedSidebarItem(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  direction: "up" | "down",
  options: SidebarVisibilityOptions = {},
): boolean {
  const items = selectedSidebarItems(sidebar, channels, options);
  if (items.length === 0) return false;
  const parentId = itemParent(sidebar, items[0]);
  const pinned = itemPinned(sidebar, items[0]);
  if (parentId === undefined || pinned === undefined) return false;
  if (!items.every((item) => itemParent(sidebar, item) === parentId && itemPinned(sidebar, item) === pinned)) return false;
  normalizeSiblingSortOrders(sidebar, parentId, pinned);
  const siblings = siblingMovableItems(sidebar, parentId, pinned);
  const selectedKeys = new Set(items.map((item) => sidebarItemKey(item)));
  const indices = siblings.map((item, index) => selectedKeys.has(sidebarItemKey(item)) ? index : -1).filter((index) => index >= 0);
  if (indices.length !== items.length) return false;
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  if (direction === "up") {
    if (first <= 0) return false;
    const block = siblings.splice(first, items.length);
    siblings.splice(first - 1, 0, ...block);
  } else {
    if (last >= siblings.length - 1) return false;
    const block = siblings.splice(first, items.length);
    siblings.splice(first + 1, 0, ...block);
  }
  siblings.forEach((item, index) => assignItemSortOrder(sidebar, item, index));
  const orderedSiblingGuildIds = siblings.filter((item): item is SidebarItemRef & { type: "guild" } => item.type === "guild").map((item) => item.id);
  if (orderedSiblingGuildIds.length > 0) {
    const rank = new Map(orderedSiblingGuildIds.map((id, index) => [id, index]));
    sidebar.guilds = sidebar.guilds.slice().sort((a, b) => {
      if (isFixedTopLevelGuildId(a.id) || isFixedTopLevelGuildId(b.id)) {
        const fixedOrder = (id: string): number => id === DIRECT_MESSAGES_GUILD_ID ? 0 : id === WHATSAPP_GUILD_ID ? 1 : 2;
        const order = fixedOrder(a.id) - fixedOrder(b.id);
        if (order !== 0) return order;
      }
      const ar = rank.get(a.id);
      const br = rank.get(b.id);
      if (ar === undefined && br === undefined) return 0;
      if (ar === undefined) return 1;
      if (br === undefined) return -1;
      return ar - br;
    });
  }
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  const selectedKey = sidebarItemKey(items[0]);
  const nextIndex = entries.findIndex((entry) => sidebarItemKey(entry.item) === selectedKey);
  if (nextIndex >= 0) sidebar.selectedIndex = nextIndex;
  return true;
}

export function moveSelectedSidebarGuild(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  direction: "up" | "down",
  options: SidebarVisibilityOptions = {},
): SidebarGuildMoveResult | null {
  const entry = getSelectedSidebarEntry(sidebar, channels, options);
  if (entry.kind !== "guild" || isFixedTopLevelGuildId(entry.guildId)) return null;

  const fromIndex = sidebar.guilds.findIndex((guild) => guild.id === entry.guildId);
  if (fromIndex < 0) return null;

  const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
  const target = sidebar.guilds[toIndex];
  if (!target || isFixedTopLevelGuildId(target.id)) return null;

  const previousGuilds = sidebar.guilds.slice();
  const nextGuilds = sidebar.guilds.slice();
  nextGuilds[fromIndex] = target;
  nextGuilds[toIndex] = sidebar.guilds[fromIndex]!;
  sidebar.guilds = nextGuilds;

  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  const selectedIndex = entries.findIndex((candidate) => candidate.kind === "guild" && candidate.guildId === entry.guildId);
  if (selectedIndex >= 0) sidebar.selectedIndex = selectedIndex;

  return { guild: nextGuilds[toIndex]!, previousGuilds, nextGuilds };
}

function selectedPrivateConversationEntry(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  options: SidebarVisibilityOptions,
): SidebarEntry | null {
  const entry = getSelectedSidebarEntry(sidebar, channels, options);
  return entry.kind === "channel" && isFixedTopLevelGuildId(entry.guildId) ? entry : null;
}

function privateConversationChannels(sidebar: SidebarState, channels: DiscordChannel[], guildId: string): DiscordChannel[] {
  return sortChannelsForSidebar(
    sidebar,
    guildId,
    sidebarChannelsForGuild(sidebar, channels, guildId).filter((channel) => channel.type !== 4),
  );
}

function materializePrivateConversationPlacements(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  guildId: string,
): DiscordChannel[] {
  const ordered = privateConversationChannels(sidebar, channels, guildId);
  const sourceIndex = new Map(ordered.map((channel, index) => [channel.id, index]));
  const placements: Record<string, SidebarChannelPlacement> = Object.fromEntries(
    Object.entries(sidebar.channelPlacementsByGuildId[guildId] ?? {}).map(([channelId, placement]) => [channelId, { ...placement }]),
  );
  for (const [index, channel] of ordered.entries()) {
    if (placements[channel.id]) continue;
    const placement = effectiveChannelPlacement(sidebar, guildId, channel, sourceIndex.get(channel.id) ?? index, ordered);
    placements[channel.id] = { ...placement };
  }
  sidebar.channelPlacementsByGuildId[guildId] = placements;
  return ordered;
}

function focusPrivateConversationAfterMutation(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  guildId: string,
  channelId: string,
  options: SidebarVisibilityOptions,
): void {
  sidebar.selectedItem = { type: "channel", id: channelId, guildId };
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  const nextIndex = entries.findIndex((entry) => entry.kind === "channel" && entry.guildId === guildId && entry.id === channelId);
  if (nextIndex >= 0) sidebar.selectedIndex = nextIndex;
}

/** Move a DM/WhatsApp conversation by one row inside its current pin section. */
export function moveSelectedPrivateConversation(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  direction: "up" | "down",
  options: SidebarVisibilityOptions = {},
): string | null {
  const selected = selectedPrivateConversationEntry(sidebar, channels, options);
  if (!selected) return null;

  const ordered = privateConversationChannels(sidebar, channels, selected.guildId);
  const selectedChannel = ordered.find((channel) => channel.id === selected.id);
  if (!selectedChannel) return null;
  const selectedPinned = effectiveChannelPlacement(
    sidebar,
    selected.guildId,
    selectedChannel,
    ordered.indexOf(selectedChannel),
    ordered,
  ).pinned;
  const siblings = ordered.filter((channel, index) => (
    effectiveChannelPlacement(sidebar, selected.guildId, channel, index, ordered).pinned === selectedPinned
  ));
  const fromIndex = siblings.findIndex((channel) => channel.id === selected.id);
  const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= siblings.length) return null;

  materializePrivateConversationPlacements(sidebar, channels, selected.guildId);
  const placements = sidebar.channelPlacementsByGuildId[selected.guildId] ?? {};
  const selectedPlacement = placements[selected.id];
  const target = siblings[toIndex]!;
  if (!selectedPlacement || !placements[target.id]) return null;
  const selectedOrder = selectedPlacement.sortOrder;
  selectedPlacement.sortOrder = placements[target.id]!.sortOrder;
  placements[target.id]!.sortOrder = selectedOrder;
  focusPrivateConversationAfterMutation(sidebar, channels, selected.guildId, selected.id, options);
  return selected.guildId;
}

/** Toggle a DM/WhatsApp conversation at the same section boundaries as Exocortex. */
export function toggleSelectedPrivateConversationPinned(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  options: SidebarVisibilityOptions = {},
): string | null {
  const selected = selectedPrivateConversationEntry(sidebar, channels, options);
  if (!selected) return null;

  materializePrivateConversationPlacements(sidebar, channels, selected.guildId);
  const placements = sidebar.channelPlacementsByGuildId[selected.guildId] ?? {};
  const placement = placements[selected.id];
  if (!placement) return null;
  const nextPinned = !placement.pinned;
  const destinationOrders = Object.entries(placements)
    .filter(([channelId, candidate]) => channelId !== selected.id && candidate.pinned === nextPinned)
    .map(([, candidate]) => candidate.sortOrder);
  placement.pinned = nextPinned;
  placement.sortOrder = nextPinned
    ? (destinationOrders.length > 0 ? Math.max(...destinationOrders) + 1 : 0)
    : (destinationOrders.length > 0 ? Math.min(...destinationOrders) - 1 : 0);
  focusPrivateConversationAfterMutation(sidebar, channels, selected.guildId, selected.id, options);
  return selected.guildId;
}

export function applySidebarGuildMuteSettings(sidebar: SidebarState, mutedByGuildId: Record<string, boolean>): void {
  sidebar.guilds = sidebar.guilds.map((guild) => (
    Object.prototype.hasOwnProperty.call(mutedByGuildId, guild.id)
      ? { ...guild, muted: mutedByGuildId[guild.id] }
      : guild
  ));
}

export function applySidebarChannelMuteSettings(sidebar: SidebarState, mutedByChannelId: Record<string, boolean>): void {
  for (const [guildId, channels] of Object.entries(sidebar.cachedChannelsByGuildId)) {
    sidebar.cachedChannelsByGuildId[guildId] = channels.map((channel) => (
      Object.prototype.hasOwnProperty.call(mutedByChannelId, channel.id)
        ? { ...channel, muted: mutedByChannelId[channel.id] }
        : channel
    ));
  }
}

export function setSidebarChannelMuted(sidebar: SidebarState, channelId: string, muted: boolean): boolean {
  let changed = false;
  for (const [guildId, channels] of Object.entries(sidebar.cachedChannelsByGuildId)) {
    const index = channels.findIndex((channel) => channel.id === channelId);
    if (index < 0) continue;
    const nextChannels = channels.slice();
    nextChannels[index] = { ...nextChannels[index]!, muted };
    sidebar.cachedChannelsByGuildId[guildId] = nextChannels;
    changed = true;
  }
  return changed;
}

export function sidebarCachedGuilds(sidebar: SidebarState): DiscordGuild[] {
  return sidebar.guilds.filter((guild) => !isFixedTopLevelGuildId(guild.id));
}

export function isSidebarGuildMuted(sidebar: SidebarState, guildId: string | null | undefined): boolean {
  if (!guildId || isFixedTopLevelGuildId(guildId)) return false;
  return Boolean(sidebar.guilds.find((guild) => guild.id === guildId)?.muted);
}

export function isSidebarChannelMuted(sidebar: SidebarState, channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  return Object.values(sidebar.cachedChannelsByGuildId)
    .some((channels) => channels.some((channel) => channel.id === channelId && channel.muted));
}

function findAllCaseInsensitiveMatchStarts(text: string, query: string): number[] {
  if (!query) return [];

  const matches: number[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let pos = 0;

  while (pos <= lowerText.length - lowerQuery.length) {
    const idx = lowerText.indexOf(lowerQuery, pos);
    if (idx === -1) break;
    matches.push(idx);
    pos = idx + 1;
  }

  return matches;
}

function findNextSortedMatch(matches: number[], fromPos: number, direction: SidebarSearchDirection): number | null {
  if (matches.length === 0) return null;

  if (direction === "forward") {
    for (const matchPos of matches) {
      if (matchPos > fromPos) return matchPos;
    }
    return matches[0] ?? null;
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i]! < fromPos) return matches[i]!;
  }
  return matches[matches.length - 1] ?? null;
}

function searchableChannelLabel(channel: DiscordChannel): string {
  return channel.name || "(unnamed)";
}

function textMatchesQuery(text: string, query: string): boolean {
  return findAllCaseInsensitiveMatchStarts(text, query).length > 0;
}

function searchableGuildLabel(guild: DiscordGuild): string {
  return guild.name || "(unnamed)";
}

function searchableFolderLabel(folder: SidebarFolder): string {
  return folder.name || "Folder";
}

function channelMatchesQuery(channel: DiscordChannel, query: string): boolean {
  return textMatchesQuery(searchableChannelLabel(channel), query);
}

function guildMatchesQuery(guild: DiscordGuild, query: string): boolean {
  return textMatchesQuery(searchableGuildLabel(guild), query);
}

function folderMatchesQuery(folder: SidebarFolder, query: string): boolean {
  return textMatchesQuery(searchableFolderLabel(folder), query);
}

export function getActiveSidebarSearchQuery(sidebar: Pick<SidebarState, "search">): string | null {
  const search = sidebar.search;
  if (!search) return null;
  if (search.barOpen && search.barMode === "search") {
    return search.barInput || (search.highlightsVisible ? search.query : null);
  }
  if (search.highlightsVisible && search.query) return search.query;
  return null;
}

function pushGuildEntry(
  entries: SidebarEntry[],
  guild: DiscordGuild,
  sidebar: SidebarState,
  guildNotificationCounts: ReadonlyMap<string, number>,
  expanded: boolean,
  depth = 0,
  searchMatched = false,
): void {
  entries.push({
    kind: "guild",
    id: guild.id,
    guildId: guild.id,
    label: guild.name || "(unnamed)",
    depth,
    notificationCount: guild.muted ? 0 : guildNotificationCounts.get(guild.id) ?? 0,
    muted: Boolean(guild.muted),
    selected: false,
    active: guild.id === (sidebar.focusedGuildId ?? sidebar.activeGuildId),
    expanded,
    item: { type: "guild", id: guild.id },
    searchMatched,
  });
}

function pushFolderEntry(
  entries: SidebarEntry[],
  folder: SidebarFolder,
  sidebar: SidebarState,
  guildNotificationCounts: ReadonlyMap<string, number>,
  searchMatched = false,
): void {
  const descendants = descendantFolderIds(sidebar, folder.id);
  const childGuilds = sidebar.guilds.filter((guild) => !isFixedTopLevelGuildId(guild.id) && descendants.has(guildPlacement(sidebar, guild.id).folderId ?? ""));
  const notificationCount = childGuilds.reduce((sum, guild) => sum + (guild.muted ? 0 : guildNotificationCounts.get(guild.id) ?? 0), 0);
  entries.push({
    kind: "folder",
    id: folder.id,
    guildId: folder.id,
    label: folder.name,
    depth: 0,
    notificationCount,
    selected: false,
    active: false,
    expanded: false,
    item: { type: "folder", id: folder.id },
    childCount: childGuilds.length,
    searchMatched,
  });
}

function pushUpEntry(entries: SidebarEntry[]): void {
  entries.push({
    kind: "up",
    id: "..",
    guildId: "..",
    label: "..",
    depth: 0,
    selected: false,
    active: false,
    expanded: false,
    item: { type: "up" },
  });
}

function pushChannelEntry(
  entries: SidebarEntry[],
  guildId: string,
  channel: DiscordChannel,
  depth: number,
  typingChannelIds: ReadonlySet<string>,
  typingFrame: string,
  channelNotificationCounts: ReadonlyMap<string, number>,
  voiceMembersByChannelId: Readonly<Record<string, readonly SidebarVoiceMember[]>>,
  searchMatched = false,
): void {
  entries.push({
    kind: "channel",
    id: channel.id,
    guildId,
    label: channelEntryLabel(channel, typingChannelIds, typingFrame),
    depth,
    channelType: channel.type,
    notificationCount: channel.muted ? 0 : channelNotificationCounts.get(channel.id) ?? 0,
    muted: Boolean(channel.muted),
    hidden: Boolean(channel.hidden),
    selected: false,
    active: false,
    expanded: false,
    item: { type: "channel", id: channel.id, guildId },
    searchMatched,
  });
  pushVoiceMemberEntries(entries, guildId, channel, depth + 1, voiceMembersByChannelId);
}

function sortThreadRows(threads: readonly DiscordChannel[]): DiscordChannel[] {
  return threads.slice().sort((left, right) => {
    const recency = (!left.lastMessageId || /^\d+$/.test(left.lastMessageId))
      && (!right.lastMessageId || /^\d+$/.test(right.lastMessageId))
      ? compareSnowflakesDesc(left.lastMessageId, right.lastMessageId)
      : 0;
    return recency || left.position - right.position || left.name.localeCompare(right.name);
  });
}

function pushChannelAndThreads(
  entries: SidebarEntry[],
  guildId: string,
  channel: DiscordChannel,
  threads: readonly DiscordChannel[],
  depth: number,
  typingChannelIds: ReadonlySet<string>,
  typingFrame: string,
  channelNotificationCounts: ReadonlyMap<string, number>,
  voiceMembersByChannelId: Readonly<Record<string, readonly SidebarVoiceMember[]>>,
  searchMatchedChannelIds?: ReadonlySet<string>,
): void {
  pushChannelEntry(
    entries,
    guildId,
    channel,
    depth,
    typingChannelIds,
    typingFrame,
    channelNotificationCounts,
    voiceMembersByChannelId,
    searchMatchedChannelIds?.has(channel.id) ?? false,
  );
  for (const thread of sortThreadRows(threads.filter((candidate) => candidate.parentId === channel.id))) {
    pushChannelEntry(
      entries,
      guildId,
      thread,
      depth + 1,
      typingChannelIds,
      typingFrame,
      channelNotificationCounts,
      voiceMembersByChannelId,
      searchMatchedChannelIds?.has(thread.id) ?? false,
    );
  }
}

function pushChannelSectionDelimiter(entries: SidebarEntry[], guildId: string): void {
  entries.push({
    kind: "delimiter",
    id: `${guildId}::pinned-delimiter`,
    guildId,
    label: "",
    depth: 1,
    selected: false,
    active: false,
    expanded: false,
  });
}

function pushVoiceMemberEntries(
  entries: SidebarEntry[],
  guildId: string,
  channel: DiscordChannel,
  depth: number,
  voiceMembersByChannelId: Readonly<Record<string, readonly SidebarVoiceMember[]>>,
): void {
  if (channel.type !== 2 && channel.type !== 13) return;
  const members = voiceMembersByChannelId[channel.id] ?? [];
  members.forEach((member, index) => pushSidebarVoiceMemberEntry(entries, guildId, channel.id, member, depth, index));
}

function pushSidebarVoiceMemberEntry(
  entries: SidebarEntry[],
  guildId: string,
  channelId: string,
  member: SidebarVoiceMember,
  depth: number,
  index: number,
): void {
  entries.push({
    kind: "voice-member",
    id: `${channelId}:${member.userId}:${index}`,
    guildId,
    channelId,
    userId: member.userId,
    label: member.displayName || member.userId,
    depth,
    muted: member.muted,
    selfMuted: member.selfMuted,
    deafened: member.deafened,
    localMuted: member.localMuted,
    streaming: member.streaming,
    cameraOn: member.cameraOn,
    self: member.self,
    color: member.color,
    selected: false,
    active: false,
    expanded: false,
  });
}

function effectiveChannelPlacement(
  sidebar: SidebarState,
  guildId: string,
  channel: DiscordChannel,
  sourceIndex: number,
  channels: readonly DiscordChannel[],
): SidebarChannelPlacement {
  const stored = sidebar.channelPlacementsByGuildId[guildId]?.[channel.id];
  if (stored) return stored;

  const existing = Object.values(sidebar.channelPlacementsByGuildId[guildId] ?? {});
  const pinned = Boolean(channel.pinned);
  const sameSectionOrders = existing.filter((placement) => placement.pinned === pinned).map((placement) => placement.sortOrder);
  if (sameSectionOrders.length === 0) return { pinned, sortOrder: channel.position };

  // A newly discovered conversation belongs at the top of its section, while
  // conversations that have never had a custom layout retain provider order.
  return {
    pinned,
    sortOrder: Math.min(...sameSectionOrders) - channels.length + sourceIndex,
  };
}

function sortChannelsForSidebar(sidebar: SidebarState, guildId: string, channels: DiscordChannel[]): DiscordChannel[] {
  if (!isFixedTopLevelGuildId(guildId)) {
    return channels.slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  const sourceIndex = new Map(channels.map((channel, index) => [channel.id, index]));
  return channels.slice().sort((a, b) => {
    const aIndex = sourceIndex.get(a.id) ?? 0;
    const bIndex = sourceIndex.get(b.id) ?? 0;
    const aPlacement = effectiveChannelPlacement(sidebar, guildId, a, aIndex, channels);
    const bPlacement = effectiveChannelPlacement(sidebar, guildId, b, bIndex, channels);
    if (aPlacement.pinned !== bPlacement.pinned) return aPlacement.pinned ? -1 : 1;
    return aPlacement.sortOrder - bPlacement.sortOrder || aIndex - bIndex || a.name.localeCompare(b.name);
  });
}

function pushPrivateConversationChannels(
  entries: SidebarEntry[],
  sidebar: SidebarState,
  guildId: string,
  channels: DiscordChannel[],
  typingChannelIds: ReadonlySet<string>,
  typingFrame: string,
  channelNotificationCounts: ReadonlyMap<string, number>,
  searchMatched = false,
): void {
  const ordered = sortChannelsForSidebar(sidebar, guildId, channels);
  const pinned = ordered.filter((channel, index) => effectiveChannelPlacement(sidebar, guildId, channel, index, ordered).pinned);
  const unpinned = ordered.filter((channel, index) => !effectiveChannelPlacement(sidebar, guildId, channel, index, ordered).pinned);

  if (pinned.length > 0) {
    for (const channel of pinned) {
      pushChannelEntry(entries, guildId, channel, 1, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId, searchMatched);
    }
    if (unpinned.length > 0) pushChannelSectionDelimiter(entries, guildId);
  }
  for (const channel of unpinned) {
    pushChannelEntry(entries, guildId, channel, 1, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId, searchMatched);
  }
}

/**
 * Discord syncs every active thread the user can view, while its Thread Member
 * payload identifies only threads the user has joined. Keep the sidebar scoped
 * to those joined threads, plus threads created by the authenticated user.
 */
export function isSidebarThreadRelevant(channel: DiscordChannel, currentUserId?: string | null): boolean {
  if (!isThreadChannel(channel)) return true;
  return channel.thread?.joined === true
    || Boolean(currentUserId && channel.thread?.ownerId === currentUserId);
}

function isVisibleSidebarChannelRow(channel: DiscordChannel, options: SidebarVisibilityOptions): boolean {
  return channel.type !== 4
    && isSidebarThreadRelevant(channel, options.currentUserId)
    && (!isThreadChannel(channel) || !channel.thread?.archived)
    && (options.showHiddenChannels || !channel.hidden);
}

function buildSidebarSearchEntries(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  loadingFrameIndex: number,
  query: string,
  typingChannelIds: ReadonlySet<string>,
  typingFrame: string,
  channelNotificationCounts: ReadonlyMap<string, number>,
  guildNotificationCounts: ReadonlyMap<string, number>,
  options: SidebarVisibilityOptions,
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  const allChannels = allSidebarChannels(sidebar, channels);

  normalizeSidebarPlacement(sidebar);
  for (const folder of sidebar.folders) {
    if (folderMatchesQuery(folder, query)) {
      pushFolderEntry(entries, folder, sidebar, guildNotificationCounts, true);
    }
  }

  for (const guild of sidebar.guilds) {
    const guildMatched = guildMatchesQuery(guild, query);
    const guildChannels = allChannels.filter((channel) => channel.guildId === guild.id);
    const visibleGuildChannels = guildChannels
      .filter((channel) => isVisibleSidebarChannelRow(channel, options));
    const matchingChannelRows = visibleGuildChannels.filter((channel) => channelMatchesQuery(channel, query));
    if (!guildMatched && matchingChannelRows.length === 0) continue;

    const showUnfilteredChildren = guildMatched && sidebar.expandedGuildId === guild.id;
    pushGuildEntry(entries, guild, sidebar, guildNotificationCounts, showUnfilteredChildren || matchingChannelRows.length > 0, 0, guildMatched);

    if (showUnfilteredChildren) {
      pushExpandedGuildChildren(entries, sidebar, channels, guild, loadingFrameIndex, typingChannelIds, typingFrame, channelNotificationCounts, options);
      continue;
    }

    if (matchingChannelRows.length === 0) continue;

    if (isFixedTopLevelGuildId(guild.id)) {
      pushPrivateConversationChannels(entries, sidebar, guild.id, matchingChannelRows, typingChannelIds, typingFrame, channelNotificationCounts, true);
      continue;
    }

    const matchedIds = new Set(matchingChannelRows.map((channel) => channel.id));
    const visibleThreads = visibleGuildChannels.filter(isThreadChannel);
    const visibleParentRows = visibleGuildChannels.filter((channel) => !isThreadChannel(channel));
    const matchedParentIds = new Set(
      matchingChannelRows
        .filter(isThreadChannel)
        .map((thread) => thread.parentId)
        .filter((parentId): parentId is string => Boolean(parentId)),
    );
    const displayedParents = visibleParentRows.filter((channel) => matchedIds.has(channel.id) || matchedParentIds.has(channel.id));
    const displayedThreads = visibleThreads.filter((thread) => matchedIds.has(thread.id));
    const guildCategories = guildChannels
      .filter((channel) => channel.type === 4)
      .filter((category) => options.showHiddenChannels || !category.hidden)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const categoryIds = new Set(guildCategories.map((category) => category.id));
    const uncategorized = displayedParents
      .filter((channel) => !channel.parentId || !categoryIds.has(channel.parentId))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    for (const channel of uncategorized) {
      pushChannelAndThreads(entries, guild.id, channel, displayedThreads, 1, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId, matchedIds);
    }

    const displayedParentIds = new Set(displayedParents.map((channel) => channel.id));
    for (const thread of sortThreadRows(displayedThreads.filter((candidate) => !candidate.parentId || !displayedParentIds.has(candidate.parentId)))) {
      pushChannelEntry(entries, guild.id, thread, 1, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId, true);
    }

    for (const category of guildCategories) {
      const categoryChannels = displayedParents
        .filter((channel) => channel.parentId === category.id)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      if (categoryChannels.length === 0) continue;

      entries.push({
        kind: "category",
        id: category.id,
        guildId: guild.id,
        label: category.name,
        depth: 1,
        muted: Boolean(category.muted),
        hidden: Boolean(category.hidden),
        selected: false,
        active: false,
        expanded: true,
      });

      for (const channel of categoryChannels) {
        pushChannelAndThreads(entries, guild.id, channel, displayedThreads, 2, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId, matchedIds);
      }
    }
  }

  return entries;
}

function pushExpandedGuildChildren(
  entries: SidebarEntry[],
  sidebar: SidebarState,
  channels: DiscordChannel[],
  guild: DiscordGuild,
  loadingFrameIndex: number,
  typingChannelIds: ReadonlySet<string>,
  typingFrame: string,
  channelNotificationCounts: ReadonlyMap<string, number>,
  options: SidebarVisibilityOptions,
): void {
  const visibleGuildChannels = sidebarChannelsForGuild(sidebar, channels, guild.id);
  const loadingExpandedGuild = sidebar.loadingGuildId === guild.id
    || (guild.id === DIRECT_MESSAGES_GUILD_ID && sidebar.loading);
  if (loadingExpandedGuild && visibleGuildChannels.length === 0) {
    entries.push({
      kind: "loading",
      id: `${guild.id}::loading`,
      guildId: guild.id,
      label: loadingLabel("Loading…", loadingFrameIndex),
      depth: 1,
      selected: false,
      active: false,
      expanded: false,
    });
    return;
  }

  const visibleChannelRows = visibleGuildChannels.filter((channel) => isVisibleSidebarChannelRow(channel, options));
  if (isFixedTopLevelGuildId(guild.id)) {
    pushPrivateConversationChannels(entries, sidebar, guild.id, visibleChannelRows, typingChannelIds, typingFrame, channelNotificationCounts);
    return;
  }
  const guildCategories = visibleGuildChannels
    .filter((channel) => channel.type === 4)
    .filter((category) => options.showHiddenChannels
      || visibleChannelRows.some((channel) => channel.parentId === category.id)
      || visibleChannelRows.some((thread) => {
        if (!isThreadChannel(thread) || !thread.parentId) return false;
        const parent = visibleChannelRows.find((channel) => channel.id === thread.parentId);
        return parent?.parentId === category.id;
      }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const categoryIds = new Set(guildCategories.map((category) => category.id));
  const threadRows = visibleChannelRows.filter(isThreadChannel);
  const parentRows = visibleChannelRows.filter((channel) => !isThreadChannel(channel));
  const uncategorized = parentRows
    .filter((channel) => !channel.parentId || !categoryIds.has(channel.parentId))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  for (const channel of uncategorized) {
    pushChannelAndThreads(entries, guild.id, channel, threadRows, 1, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId);
  }

  const parentIds = new Set(parentRows.map((channel) => channel.id));
  for (const thread of sortThreadRows(threadRows.filter((candidate) => !candidate.parentId || !parentIds.has(candidate.parentId)))) {
    pushChannelEntry(entries, guild.id, thread, 1, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId);
  }

  for (const category of guildCategories) {
    const collapsed = sidebar.collapsedCategoryIds.includes(category.id);
    entries.push({
      kind: "category",
      id: category.id,
      guildId: guild.id,
      label: category.name,
      depth: 1,
      muted: Boolean(category.muted),
      hidden: Boolean(category.hidden),
      selected: false,
      active: false,
      expanded: !collapsed,
    });

    if (collapsed) continue;

    const categoryChannels = parentRows
      .filter((channel) => channel.parentId === category.id)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    for (const channel of categoryChannels) {
      pushChannelAndThreads(entries, guild.id, channel, threadRows, 2, typingChannelIds, typingFrame, channelNotificationCounts, sidebar.voiceMembersByChannelId);
    }
  }
}

function folderVisibleItems(sidebar: SidebarState): Array<{ item: SidebarItemRef; pinned: boolean; sortOrder: number; name: string }> {
  const parentId = sidebar.currentFolderId;
  const folders = sidebar.folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .map((folder) => ({ item: { type: "folder" as const, id: folder.id }, pinned: folder.pinned, sortOrder: folder.sortOrder, name: folder.name }));
  const guilds = sidebar.guilds
    .filter((guild) => isFixedTopLevelGuildId(guild.id) ? parentId === null : (guildPlacement(sidebar, guild.id).folderId ?? null) === parentId)
    .map((guild) => {
      const placement = guildPlacement(sidebar, guild.id);
      const fixedSortOrder = guild.id === DIRECT_MESSAGES_GUILD_ID
        ? Number.MIN_SAFE_INTEGER
        : guild.id === WHATSAPP_GUILD_ID
          ? Number.MIN_SAFE_INTEGER + 1
          : placement.sortOrder;
      return { item: { type: "guild" as const, id: guild.id }, pinned: isFixedTopLevelGuildId(guild.id) ? false : placement.pinned, sortOrder: fixedSortOrder, name: guild.name };
    });
  return [...folders, ...guilds].sort(compareSidebarOrder);
}

export function buildSidebarEntries(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  loadingFrameIndex = 0,
  typingChannelIds: ReadonlySet<string> = new Set(),
  typingFrame = "⋯",
  channelNotificationCounts: ReadonlyMap<string, number> = new Map(),
  guildNotificationCounts: ReadonlyMap<string, number> = new Map(),
  options: SidebarVisibilityOptions = {},
): SidebarEntry[] {
  const query = getActiveSidebarSearchQuery(sidebar);
  const entries: SidebarEntry[] = query
    ? buildSidebarSearchEntries(sidebar, channels, loadingFrameIndex, query, typingChannelIds, typingFrame, channelNotificationCounts, guildNotificationCounts, options)
    : [];

  if (!query) {
    normalizeSidebarPlacement(sidebar);
    if (sidebar.currentFolderId) pushUpEntry(entries);

    for (const { item } of folderVisibleItems(sidebar)) {
      if (item.type === "folder") {
        const folder = sidebar.folders.find((candidate) => candidate.id === item.id);
        if (folder) pushFolderEntry(entries, folder, sidebar, guildNotificationCounts);
        continue;
      }

      const guild = sidebar.guilds.find((candidate) => candidate.id === item.id);
      if (!guild) continue;
      const isExpanded = guild.id === sidebar.expandedGuildId;
      pushGuildEntry(entries, guild, sidebar, guildNotificationCounts, isExpanded);
      if (isExpanded) {
        pushExpandedGuildChildren(entries, sidebar, channels, guild, loadingFrameIndex, typingChannelIds, typingFrame, channelNotificationCounts, options);
      }
    }
  }

  const requestedKey = sidebarItemKey(sidebar.selectedItem);
  if (requestedKey) {
    const requestedIndex = entries.findIndex((entry) => sidebarItemKey(entry.item) === requestedKey);
    if (requestedIndex >= 0) sidebar.selectedIndex = requestedIndex;
  }
  const clampedIndex = clampSelectedIndex(sidebar, entries);
  sidebar.selectedIndex = clampedIndex;
  sidebar.selectedItem = entries[clampedIndex]?.item ?? null;

  return entries.map((entry, index) => ({
    ...entry,
    selected: index === clampedIndex,
    active: entry.kind === "guild"
      ? entry.guildId === (sidebar.focusedGuildId ?? sidebar.activeGuildId)
      : entry.active,
  }));
}

function channelEntryLabel(channel: DiscordChannel, typingChannelIds: ReadonlySet<string>, typingFrame: string): string {
  const name = channel.hidden ? `🔒 ${channel.name}` : channel.name;
  return typingChannelIds.has(channel.id) ? `${name} ${typingFrame}` : name;
}

function channelEntryMarker(channelType: number | undefined): string {
  if (channelType === 2) return "🔊 ";
  if (channelType === 13) return "🎙 ";
  if (channelType === 10 || channelType === 11 || channelType === 12) return "↳ ";
  if (channelType === 15 || channelType === 16) return "▤ ";
  return "# ";
}

function voiceMemberNameLabel(entry: SidebarEntry): string {
  return `${entry.label}${entry.self ? " (you)" : ""}`;
}

function voiceMemberStatusSuffix(entry: SidebarEntry): string {
  return `${entry.muted ? " 🔇" : ""}${entry.localMuted ? " 🔕" : ""}${entry.deafened ? " 🎧" : ""}`;
}

function selectedEntrySnapshot(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions): Pick<SidebarEntry, "kind" | "id" | "guildId"> | null {
  const entry = getSelectedSidebarEntry(sidebar, channels, options);
  return entry.id ? { kind: entry.kind, id: entry.id, guildId: entry.guildId } : null;
}

function focusSidebarEntryBySnapshot(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  snapshot: Pick<SidebarEntry, "kind" | "id" | "guildId"> | null,
  fallbackIndex: number,
  options: SidebarVisibilityOptions,
): void {
  if (snapshot) {
    const previousIndex = sidebar.selectedIndex;
    const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
    sidebar.selectedIndex = previousIndex;
    const index = entries.findIndex((entry) => entry.kind === snapshot.kind && entry.id === snapshot.id && entry.guildId === snapshot.guildId);
    if (index >= 0) {
      sidebar.selectedIndex = index;
      sidebar.selectedItem = entries[index]?.item ?? null;
      return;
    }
  }
  sidebar.selectedIndex = Math.max(0, fallbackIndex);
  sidebar.selectedItem = null;
}

function buildSidebarSearchState(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  barMode: SidebarSearchBarMode,
  direction: SidebarSearchDirection,
  options: SidebarVisibilityOptions,
): SidebarSearchState {
  return {
    barOpen: true,
    barMode,
    direction,
    query: sidebar.search?.query ?? "",
    barInput: "",
    barCursorPos: 0,
    highlightsVisible: sidebar.search?.highlightsVisible ?? false,
    savedSelectedEntry: selectedEntrySnapshot(sidebar, channels, options),
    savedSelectedIndex: sidebar.selectedIndex,
    savedScrollOffset: sidebar.scrollOffset,
  };
}

function restoreSidebarSearchOrigin(sidebar: SidebarState, channels: DiscordChannel[], search: SidebarSearchState, options: SidebarVisibilityOptions): void {
  sidebar.scrollOffset = search.savedScrollOffset;
  focusSidebarEntryBySnapshot(sidebar, channels, search.savedSelectedEntry, search.savedSelectedIndex, options);
}

function findNextSidebarSearchMatch(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  query: string,
  fromIndex: number,
  direction: SidebarSearchDirection,
  options: SidebarVisibilityOptions,
): number | null {
  if (!query) return null;
  const entries = buildSidebarSearchEntries(sidebar, channels, 0, query, new Set(), "⋯", new Map(), new Map(), options);
  const candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isSelectableEntry(entry) && entry.searchMatched)
    .map(({ index }) => index);
  return findNextSortedMatch(candidates, fromIndex, direction);
}

function liveSidebarSearchToNearestMatch(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions): void {
  const search = sidebar.search;
  if (!search || !search.barOpen || search.barMode !== "search") return;

  if (!search.barInput) {
    restoreSidebarSearchOrigin(sidebar, channels, search, options);
    return;
  }

  const matchIndex = findNextSidebarSearchMatch(sidebar, channels, search.barInput, search.savedSelectedIndex, search.direction, options);
  if (matchIndex != null) {
    sidebar.selectedItem = null;
    sidebar.selectedIndex = matchIndex;
  }
}

function replaceSidebarSearchBarInput(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions, nextInput: string, nextCursorPos: number): void {
  const search = sidebar.search;
  if (!search) return;
  search.barInput = nextInput;
  search.barCursorPos = nextCursorPos;
  liveSidebarSearchToNearestMatch(sidebar, channels, options);
}

function insertIntoSidebarSearchBar(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions, text: string): void {
  const search = sidebar.search;
  if (!search || !text) return;
  replaceSidebarSearchBarInput(
    sidebar,
    channels,
    options,
    search.barInput.slice(0, search.barCursorPos) + text + search.barInput.slice(search.barCursorPos),
    search.barCursorPos + text.length,
  );
}

function normalizeSidebarSearchPaste(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
}

function executeSidebarCommand(sidebar: SidebarState, command: string): SidebarSearchKeyResult {
  const search = sidebar.search;
  if (!search) return { type: "handled" };

  switch (command) {
    case "noh":
      search.highlightsVisible = false;
      revealFocusedGuildAfterSearch(sidebar);
      return { type: "handled" };
    default:
      return { type: "handled" };
  }
}

function revealFocusedGuildAfterSearch(sidebar: SidebarState): void {
  const guildId = sidebar.focusedGuildId;
  if (!guildId || !sidebar.guilds.some((guild) => guild.id === guildId)) {
    sidebar.currentFolderId = null;
    sidebar.expandedGuildId = null;
    sidebar.selectedItem = null;
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = 0;
    return;
  }

  const parentId = itemParent(sidebar, { type: "guild", id: guildId });
  sidebar.currentFolderId = parentId === undefined ? null : parentId;
  sidebar.expandedGuildId = guildId;
  sidebar.selectedItem = { type: "guild", id: guildId };
  sidebar.selectedIndex = 0;
  sidebar.scrollOffset = 0;
  sidebar.visualAnchor = null;
}

export function openSidebarSearchBar(sidebar: SidebarState, channels: DiscordChannel[], direction: SidebarSearchDirection, options: SidebarVisibilityOptions = {}): void {
  sidebar.search = buildSidebarSearchState(sidebar, channels, "search", direction, options);
}

export function openSidebarCommandBar(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  sidebar.search = buildSidebarSearchState(sidebar, channels, "command", sidebar.search?.direction ?? "forward", options);
}

export function closeSidebarSearchBar(sidebar: SidebarState, channels: DiscordChannel[], cancel: boolean, options: SidebarVisibilityOptions = {}): void {
  const search = sidebar.search;
  if (!search) return;

  if (cancel) restoreSidebarSearchOrigin(sidebar, channels, search, options);

  search.barOpen = false;
  search.barInput = "";
  search.barCursorPos = 0;
}

export function jumpToSidebarSearchMatch(sidebar: SidebarState, channels: DiscordChannel[], direction: SidebarSearchDirection, options: SidebarVisibilityOptions = {}): boolean {
  const search = sidebar.search;
  if (!search?.query) return false;

  const matchIndex = findNextSidebarSearchMatch(sidebar, channels, search.query, sidebar.selectedIndex, direction, options);
  if (matchIndex == null) return false;

  search.highlightsVisible = true;
  sidebar.selectedItem = null;
  sidebar.selectedIndex = matchIndex;
  return true;
}

export function handleSidebarSearchBarKey(sidebar: SidebarState, channels: DiscordChannel[], key: KeyEvent, options: SidebarVisibilityOptions = {}): SidebarSearchKeyResult {
  const search = sidebar.search;
  if (!search?.barOpen) return { type: "handled" };

  if (key.type === "ctrl-q") {
    closeSidebarSearchBar(sidebar, channels, true, options);
    return { type: "handled" };
  }

  if (key.type === "escape") {
    closeSidebarSearchBar(sidebar, channels, true, options);
    return { type: "handled" };
  }

  if (key.type === "enter") {
    if (search.barMode === "command") {
      const result = executeSidebarCommand(sidebar, search.barInput.trim());
      closeSidebarSearchBar(sidebar, channels, false, options);
      return result;
    }

    if (search.barInput) {
      search.query = search.barInput;
      search.highlightsVisible = true;
      liveSidebarSearchToNearestMatch(sidebar, channels, options);
    }
    closeSidebarSearchBar(sidebar, channels, false, options);
    return { type: "handled" };
  }

  if (key.type === "backspace") {
    if (search.barCursorPos > 0) {
      replaceSidebarSearchBarInput(
        sidebar,
        channels,
        options,
        search.barInput.slice(0, search.barCursorPos - 1) + search.barInput.slice(search.barCursorPos),
        search.barCursorPos - 1,
      );
    } else if (search.barInput.length === 0) {
      closeSidebarSearchBar(sidebar, channels, true, options);
    }
    return { type: "handled" };
  }

  if (key.type === "delete") {
    if (search.barCursorPos < search.barInput.length) {
      replaceSidebarSearchBarInput(
        sidebar,
        channels,
        options,
        search.barInput.slice(0, search.barCursorPos) + search.barInput.slice(search.barCursorPos + 1),
        search.barCursorPos,
      );
    }
    return { type: "handled" };
  }

  if (key.type === "left") {
    if (search.barCursorPos > 0) search.barCursorPos--;
    return { type: "handled" };
  }

  if (key.type === "right") {
    if (search.barCursorPos < search.barInput.length) search.barCursorPos++;
    return { type: "handled" };
  }

  if (key.type === "home") {
    search.barCursorPos = 0;
    return { type: "handled" };
  }

  if (key.type === "end") {
    search.barCursorPos = search.barInput.length;
    return { type: "handled" };
  }

  if (key.type === "paste" && key.text) {
    insertIntoSidebarSearchBar(sidebar, channels, options, normalizeSidebarSearchPaste(key.text));
    return { type: "handled" };
  }

  if (key.type === "char" && key.char) {
    insertIntoSidebarSearchBar(sidebar, channels, options, key.char);
    return { type: "handled" };
  }

  return { type: "handled" };
}

function getSidebarPromptBar(prompt: SidebarFolderPromptState, width: number): string {
  const label = prompt.purpose === "create_folder" ? "Folder" : prompt.purpose === "move_items" ? "Move" : "Rename";
  const prefix = `${label}: `;
  const maxWidth = Math.max(0, width - termWidth(prefix));
  const viewport = getViewportByWidth(prompt.input, prompt.cursorPos, maxWidth);
  const placeholder = prompt.purpose === "move_items" ? "folder" : "name";
  const displayText = viewport.visibleText ? padRight(viewport.visibleText, maxWidth) : padRight(placeholder, maxWidth);
  const textStyle = viewport.visibleText ? theme.text : theme.dim;
  return theme.sidebarBg + theme.accent + prefix + theme.text + textStyle + displayText;
}

function getSidebarPromptAutocompleteRows(prompt: SidebarFolderPromptState, width: number, visibleRows: number): string[] {
  const autocomplete = prompt.autocomplete;
  if (!autocomplete || autocomplete.matches.length === 0 || visibleRows <= 0) return [];
  const { matches, selection } = autocomplete;
  const maxName = matches.reduce((max, item) => Math.max(max, termWidth(item.name)), 0);
  const markerWidth = 2;
  const nameWidth = Math.min(maxName + 1, Math.max(0, Math.floor((width - markerWidth) * 0.6)));
  const descWidth = Math.max(0, width - markerWidth - nameWidth);
  const winSize = Math.min(matches.length, visibleRows);
  let winStart = 0;
  if (matches.length > winSize && selection >= 0) {
    winStart = Math.max(0, Math.min(selection - Math.floor(winSize / 2), matches.length - winSize));
  }
  const rows: string[] = [];
  for (let vi = 0; vi < winSize; vi++) {
    const index = winStart + vi;
    const item = matches[index]!;
    const isSelected = selection === index;
    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const marker = isSelected ? "▸ " : "  ";
    const indicator = vi === 0 && winStart > 0 ? "▲" : vi === winSize - 1 && winStart + winSize < matches.length ? "▼" : "";
    const descBodyWidth = Math.max(0, descWidth - termWidth(indicator));
    rows.push(bg + theme.accent + marker + theme.text + padRight(item.name, nameWidth) + theme.dim + padRight(item.desc, descBodyWidth) + indicator + theme.reset);
  }
  return rows;
}

export function getSidebarSearchBarViewport(search: SidebarSearchState, width: number): { line: string; cursorCol: number } {
  const prompt = search.barMode === "command"
    ? ":"
    : (search.direction === "forward" ? "/" : "?");
  const placeholder = search.barMode === "command" ? "command" : "search";
  const maxWidth = Math.max(0, width - 2);
  const viewport = getViewportByWidth(search.barInput, search.barCursorPos, maxWidth);
  const visibleText = viewport.visibleText;
  const displayText = visibleText ? padRight(visibleText, maxWidth) : padRight(placeholder, maxWidth);
  const textStyle = visibleText ? theme.text : theme.dim;

  return {
    line: theme.sidebarBg
      + theme.accent + prompt
      + theme.text + " "
      + textStyle + displayText,
    cursorCol: 2 + viewport.cursorCol,
  };
}

export function getSelectedSidebarEntry(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): SidebarEntry {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  return entries[Math.max(0, Math.min(sidebar.selectedIndex, Math.max(0, entries.length - 1)))] ?? {
    kind: "guild",
    id: "",
    guildId: "",
    label: "",
    depth: 0,
    selected: true,
    active: false,
    expanded: false,
  };
}

export interface SidebarHit {
  entry: SidebarEntry;
  index: number;
}

/** Map a 1-based terminal row to a selectable row in the visible sidebar. */
export function sidebarHitTest(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  screenRow: number,
  totalRows: number,
  options: SidebarVisibilityOptions = {},
): SidebarHit | null {
  // The title and separator are chrome, not list entries.
  if (screenRow <= 2) return null;

  const viewportRows = sidebarViewportRows(totalRows, sidebar);
  const viewportIndex = screenRow - 3;
  // This also excludes filler rows and the search/prompt/autocomplete area.
  if (viewportIndex < 0 || viewportIndex >= viewportRows) return null;

  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  const index = sidebar.scrollOffset + viewportIndex;
  const entry = entries[index];
  if (!entry || !isSelectableEntry(entry)) return null;
  return { entry, index };
}

/** Focus the selectable sidebar entry at a terminal row without activating it. */
export function focusSidebarAtMouse(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  screenRow: number,
  totalRows: number,
  options: SidebarVisibilityOptions = {},
): SidebarEntry | null {
  const hit = sidebarHitTest(sidebar, channels, screenRow, totalRows, options);
  if (!hit) return null;
  sidebar.selectedIndex = hit.index;
  sidebar.selectedItem = hit.entry.item ?? null;
  sidebar.pendingDeleteItem = null;
  return hit.entry;
}

/** Scroll only the sidebar viewport (positive values move toward later rows). */
export function scrollSidebarAtMouse(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  delta: number,
  totalRows: number,
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  const viewportRows = sidebarViewportRows(totalRows, sidebar);
  const maxScroll = Math.max(0, entries.length - viewportRows);
  const requested = Math.max(0, Math.min(sidebar.scrollOffset + delta, maxScroll));
  sidebar.scrollOffset = snapSidebarViewportStart(
    entries,
    viewportRows,
    requested,
    delta < 0 ? -1 : delta > 0 ? 1 : 0,
    sidebar.selectedIndex,
  );
}

export function moveSidebarSelection(sidebar: SidebarState, channels: DiscordChannel[], delta: number, options: SidebarVisibilityOptions = {}): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  const selectableIndices = entries
    .map((entry, index) => (isSelectableEntry(entry) ? index : -1))
    .filter((index) => index >= 0);

  if (selectableIndices.length === 0) {
    sidebar.selectedIndex = 0;
    return;
  }

  const currentIndex = selectableIndices.includes(sidebar.selectedIndex)
    ? sidebar.selectedIndex
    : clampSelectedIndex(sidebar, entries);
  const currentPos = Math.max(0, selectableIndices.indexOf(currentIndex));
  const nextPos = Math.max(0, Math.min(currentPos + delta, selectableIndices.length - 1));
  sidebar.selectedIndex = selectableIndices[nextPos] ?? currentIndex;
  sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
}

function sidebarPromptAutocompleteVisibleRows(sidebar: SidebarState | undefined, totalRows: number): number {
  const autocomplete = sidebar?.prompt?.autocomplete;
  if (!sidebar?.prompt || sidebar.search?.barOpen || !autocomplete?.matches.length) return 0;
  return Math.min(autocomplete.matches.length, Math.max(0, Math.min(5, totalRows - 5)));
}

function sidebarViewportRows(totalRows: number, sidebar?: SidebarState): number {
  const bottomBarRows = sidebar?.search?.barOpen ? 1 : sidebar?.prompt ? 1 + sidebarPromptAutocompleteVisibleRows(sidebar, totalRows) : 0;
  return Math.max(0, totalRows - 2 - bottomBarRows);
}

function clampSidebarViewportToSelection(sidebar: SidebarState, entries: SidebarEntry[], viewportRows: number): void {
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = 0;
    return;
  }

  sidebar.selectedIndex = clampSelectedIndex(sidebar, entries);
  let scrollOffset = sidebar.scrollOffset;
  if (sidebar.selectedIndex < scrollOffset) {
    scrollOffset = sidebar.selectedIndex;
  } else if (sidebar.selectedIndex >= scrollOffset + viewportRows) {
    scrollOffset = sidebar.selectedIndex - viewportRows + 1;
  }
  sidebar.scrollOffset = snapSidebarViewportStart(entries, viewportRows, scrollOffset, 0, sidebar.selectedIndex);
}

function snapSidebarViewportStart(
  entries: SidebarEntry[],
  viewportRows: number,
  requestedStart: number,
  direction: -1 | 0 | 1,
  selectedIndex: number,
): number {
  const start = Math.max(0, Math.min(requestedStart, Math.max(0, entries.length - 1)));
  if (entries[start]?.kind !== "delimiter") return start;

  const scan = (step: -1 | 1): number | null => {
    for (let index = start + step; index >= 0 && index < entries.length; index += step) {
      if (entries[index]?.kind !== "delimiter") return index;
    }
    return null;
  };
  const backward = scan(-1);
  const forward = scan(1);
  if (direction < 0) return backward ?? forward ?? start;
  if (direction > 0) return forward ?? backward ?? start;

  const keepsSelectionVisible = (candidate: number | null): candidate is number => (
    candidate !== null && selectedIndex >= candidate && selectedIndex < candidate + viewportRows
  );
  if (keepsSelectionVisible(forward)) return forward;
  if (keepsSelectionVisible(backward)) return backward;
  return forward ?? backward ?? start;
}

export function scrollSidebarSelection(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  dir: number,
  amount: number,
  totalRows: number,
  mode: "cursor" | "page" = "cursor",
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = 0;
    return;
  }

  sidebar.selectedIndex = clampSelectedIndex(sidebar, entries);
  const viewportRows = sidebarViewportRows(totalRows, sidebar);
  const next = mode === "page"
    ? scrollPageWithCursorInViewport({ totalLines: entries.length, viewportHeight: viewportRows, viewStart: sidebar.scrollOffset, cursorRow: sidebar.selectedIndex }, dir, amount)
    : scrollByAmountWithCursorInViewport({ totalLines: entries.length, viewportHeight: viewportRows, viewStart: sidebar.scrollOffset, cursorRow: sidebar.selectedIndex }, dir, amount);
  sidebar.selectedIndex = clampSelectedIndex({ ...sidebar, selectedIndex: next.cursorRow }, entries);
  sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
  sidebar.scrollOffset = snapSidebarViewportStart(
    entries,
    viewportRows,
    next.viewStart,
    dir > 0 ? -1 : 1,
    sidebar.selectedIndex,
  );
}

export function scrollSidebarSelectionLine(sidebar: SidebarState, channels: DiscordChannel[], dir: number, totalRows: number, options: SidebarVisibilityOptions = {}): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = 0;
    return;
  }

  sidebar.selectedIndex = clampSelectedIndex(sidebar, entries);
  const next = scrollLineWithStickyCursorInViewport({
    totalLines: entries.length,
    viewportHeight: sidebarViewportRows(totalRows, sidebar),
    viewStart: sidebar.scrollOffset,
    cursorRow: sidebar.selectedIndex,
  }, dir);
  sidebar.selectedIndex = clampSelectedIndex({ ...sidebar, selectedIndex: next.cursorRow }, entries);
  sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
  sidebar.scrollOffset = snapSidebarViewportStart(
    entries,
    sidebarViewportRows(totalRows, sidebar),
    next.viewStart,
    dir > 0 ? -1 : 1,
    sidebar.selectedIndex,
  );
}

export function jumpSidebarSelectionToVisibleEdge(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  totalRows: number,
  edge: "top" | "bottom",
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = 0;
    return;
  }

  const viewportRows = sidebarViewportRows(totalRows, sidebar);
  if (viewportRows <= 0) return;

  const maxScroll = Math.max(0, entries.length - viewportRows);
  sidebar.scrollOffset = Math.max(0, Math.min(sidebar.scrollOffset, maxScroll));
  sidebar.selectedIndex = clampSelectedIndex(sidebar, entries);

  const selectVisibleEdge = (): number | null => {
    const viewStart = sidebar.scrollOffset;
    const viewEnd = Math.min(viewStart + viewportRows - 1, entries.length - 1);
    return edge === "top"
      ? findSelectableEntryIndex(entries, viewStart, viewEnd, 1)
      : findSelectableEntryIndex(entries, viewEnd, viewStart, -1);
  };

  let targetIndex = selectVisibleEdge();
  if (targetIndex == null) return;

  if (targetIndex === sidebar.selectedIndex) {
    const halfPage = Math.floor(viewportRows / 2);
    sidebar.scrollOffset = edge === "top"
      ? Math.max(0, sidebar.scrollOffset - halfPage)
      : Math.min(maxScroll, sidebar.scrollOffset + halfPage);
    targetIndex = selectVisibleEdge();
    if (targetIndex == null) return;
  }

  sidebar.selectedIndex = targetIndex;
  sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
}

export function jumpSidebarSelectionToEdge(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  totalRows: number,
  edge: "top" | "bottom",
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = 0;
    sidebar.selectedItem = null;
    return;
  }

  const viewportRows = sidebarViewportRows(totalRows, sidebar);
  const maxScroll = Math.max(0, entries.length - viewportRows);
  const targetIndex = edge === "top"
    ? findSelectableEntryIndex(entries, 0, entries.length - 1, 1)
    : findSelectableEntryIndex(entries, entries.length - 1, 0, -1);

  if (targetIndex == null) {
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = edge === "top" ? 0 : maxScroll;
    sidebar.selectedItem = null;
    return;
  }

  sidebar.selectedIndex = targetIndex;
  sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
  sidebar.scrollOffset = edge === "top" ? 0 : maxScroll;
}

export function jumpSidebarSelectionToVisibleMiddle(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  totalRows: number,
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.scrollOffset = 0;
    return;
  }

  const viewportRows = sidebarViewportRows(totalRows, sidebar);
  if (viewportRows <= 0) return;

  const maxScroll = Math.max(0, entries.length - viewportRows);
  sidebar.scrollOffset = Math.max(0, Math.min(sidebar.scrollOffset, maxScroll));
  sidebar.selectedIndex = clampSelectedIndex(sidebar, entries);

  const viewStart = sidebar.scrollOffset;
  const viewEnd = Math.min(viewStart + viewportRows - 1, entries.length - 1);
  const middleRow = Math.floor((viewStart + viewEnd) / 2);
  const targetIndex = findSelectableEntryIndex(entries, middleRow, viewEnd, 1)
    ?? findSelectableEntryIndex(entries, middleRow - 1, viewStart, -1);

  if (targetIndex != null) {
    sidebar.selectedIndex = targetIndex;
    sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
  }
}

function jumpSidebarSelectionToKind(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  kind: Extract<SidebarEntryKind, "guild" | "category">,
  direction: -1 | 1,
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    return;
  }

  const currentIndex = clampSelectedIndex(sidebar, entries);
  for (let index = currentIndex + direction; index >= 0 && index < entries.length; index += direction) {
    if (entries[index]?.kind === kind) {
      sidebar.selectedIndex = index;
      sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
      return;
    }
  }
}

export function moveSidebarSelectionToPrevGuild(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  jumpSidebarSelectionToKind(sidebar, channels, "guild", -1, options);
}

export function moveSidebarSelectionToNextGuild(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  jumpSidebarSelectionToKind(sidebar, channels, "guild", 1, options);
}

export function moveSidebarSelectionToPrevCategory(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  jumpSidebarSelectionToKind(sidebar, channels, "category", -1, options);
}

export function moveSidebarSelectionToNextCategory(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  jumpSidebarSelectionToKind(sidebar, channels, "category", 1, options);
}

export function moveSidebarSelectionToPrevDirectMessage(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  jumpSidebarSelectionToGuildChannel(sidebar, channels, DIRECT_MESSAGES_GUILD_ID, -1, options);
}

export function moveSidebarSelectionToNextDirectMessage(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  jumpSidebarSelectionToGuildChannel(sidebar, channels, DIRECT_MESSAGES_GUILD_ID, 1, options);
}

export function moveSidebarSelectionToPrevAnyNotification(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  channelNotificationCounts: ReadonlyMap<string, number>,
  guildNotificationCounts: ReadonlyMap<string, number>,
  options: SidebarVisibilityOptions = {},
): void {
  jumpSidebarSelectionToAnyNotification(sidebar, channels, channelNotificationCounts, guildNotificationCounts, -1, options);
}

export function moveSidebarSelectionToNextAnyNotification(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  channelNotificationCounts: ReadonlyMap<string, number>,
  guildNotificationCounts: ReadonlyMap<string, number>,
  options: SidebarVisibilityOptions = {},
): void {
  jumpSidebarSelectionToAnyNotification(sidebar, channels, channelNotificationCounts, guildNotificationCounts, 1, options);
}

function jumpSidebarSelectionToGuildChannel(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  guildId: string,
  direction: -1 | 1,
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(sidebar, channels, 0, new Set(), "⋯", new Map(), new Map(), options);
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    return;
  }

  const candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "channel" && entry.guildId === guildId)
    .map(({ index }) => index);
  if (candidates.length === 0) return;

  const currentIndex = clampSelectedIndex(sidebar, entries);
  const nextIndex = direction > 0
    ? candidates.find((index) => index > currentIndex) ?? candidates[0]
    : candidates.findLast((index) => index < currentIndex) ?? candidates[candidates.length - 1];
  if (nextIndex !== undefined) {
    sidebar.selectedIndex = nextIndex;
    sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
  }
}

function jumpSidebarSelectionToAnyNotification(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  channelNotificationCounts: ReadonlyMap<string, number>,
  guildNotificationCounts: ReadonlyMap<string, number>,
  direction: -1 | 1,
  options: SidebarVisibilityOptions = {},
): void {
  const entries = buildSidebarEntries(
    sidebar,
    channels,
    0,
    new Set(),
    "⋯",
    channelNotificationCounts,
    guildNotificationCounts,
    options,
  );
  if (entries.length === 0) {
    sidebar.selectedIndex = 0;
    return;
  }

  const candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (entry.kind === "guild" || entry.kind === "channel")
      && (entry.notificationCount ?? 0) > 0)
    .map(({ index }) => index);
  if (candidates.length === 0) return;

  const currentIndex = clampSelectedIndex(sidebar, entries);
  const nextIndex = direction > 0
    ? candidates.find((index) => index > currentIndex) ?? candidates[0]
    : candidates.findLast((index) => index < currentIndex) ?? candidates[candidates.length - 1];
  if (nextIndex !== undefined) {
    sidebar.selectedIndex = nextIndex;
    sidebar.selectedItem = entries[sidebar.selectedIndex]?.item ?? null;
  }
}

export function enterSidebarFolder(sidebar: SidebarState, folderId: string): boolean {
  if (!sidebar.folders.some((folder) => folder.id === folderId)) return false;
  sidebar.currentFolderId = folderId;
  sidebar.expandedGuildId = null;
  sidebar.scrollOffset = 0;
  sidebar.visualAnchor = null;
  sidebar.selectedIndex = 0;
  return true;
}

export function leaveSidebarFolder(sidebar: SidebarState): boolean {
  if (!sidebar.currentFolderId) return false;
  const leaving = sidebar.currentFolderId;
  sidebar.currentFolderId = parentOfCurrentFolder(sidebar);
  sidebar.expandedGuildId = null;
  sidebar.scrollOffset = 0;
  sidebar.visualAnchor = null;
  sidebar.selectedItem = { type: "folder", id: leaving };
  return true;
}

export function toggleSidebarVisualSelection(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): boolean {
  const item = getSelectedSidebarEntry(sidebar, channels, options).item;
  if (!isMovableSidebarItem(item) || (item.type === "guild" && isFixedTopLevelGuildId(item.id))) return false;
  sidebar.visualAnchor = sidebar.visualAnchor ? null : item;
  sidebar.pendingDeleteItem = null;
  return true;
}

export function moveSidebarSelectionOut(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): boolean {
  if (!sidebar.currentFolderId) return false;
  const items = selectedSidebarItems(sidebar, channels, options).filter((item) => item.type !== "guild" || !isFixedTopLevelGuildId(item.id));
  const before = currentFolderRef(sidebar);
  if (items.length === 0 || !before) return false;
  sidebar.visualAnchor = null;
  return moveSidebarItems(sidebar, items, parentOfCurrentFolder(sidebar), before);
}

function normalizeMoveDestinationInput(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/$/, "") : trimmed;
}

function canTargetFolder(sidebar: SidebarState, folderId: string, items: SidebarItemRef[]): boolean {
  if (items.length > 0 && items.every((item) => itemParent(sidebar, item) === folderId)) return false;
  for (const item of items) {
    if (item.type !== "folder") continue;
    if (item.id === folderId || descendantFolderIds(sidebar, item.id).has(folderId)) return false;
  }
  return true;
}

function currentFolderDescendantDepth(sidebar: SidebarState, folderId: string): number | null {
  const currentFolderId = sidebar.currentFolderId;
  if (!currentFolderId) return null;

  const seen = new Set<string>();
  let depth = 0;
  let folder = sidebar.folders.find((candidate) => candidate.id === folderId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    const parentId = folder.parentId ?? null;
    if (!parentId) return null;
    depth++;
    if (parentId === currentFolderId) return depth;
    folder = sidebar.folders.find((candidate) => candidate.id === parentId);
  }
  return null;
}

function movePromptMatches(sidebar: SidebarState, input: string, items: SidebarItemRef[]): CompletionItem[] {
  const normalized = normalizeMoveDestinationInput(input).toLowerCase();
  const matchesPrefix = (value: string) => value.toLowerCase().startsWith(normalized);
  const special: CompletionItem[] = [
    { name: "/", desc: "root folder" },
    ...(sidebar.currentFolderId ? [{ name: "..", desc: "parent folder" }] : []),
  ].filter((item) => matchesPrefix(item.name));
  const folders = sidebar.folders
    .filter((folder) => canTargetFolder(sidebar, folder.id, items))
    .map((folder) => {
      const path = sidebarFolderPath(sidebar, folder.id);
      return { folder, path, name: path || folder.name, localDepth: currentFolderDescendantDepth(sidebar, folder.id) };
    })
    .filter(({ folder, path, name }) => !normalized || matchesPrefix(name) || matchesPrefix(folder.name) || path.toLowerCase().includes(`/${normalized}`))
    .sort((a, b) => {
      if (a.localDepth !== null || b.localDepth !== null) {
        if (a.localDepth === null) return 1;
        if (b.localDepth === null) return -1;
        if (a.localDepth !== b.localDepth) return a.localDepth - b.localDepth;
      }
      return a.name.localeCompare(b.name);
    });
  const localFolders = folders.filter(({ localDepth }) => localDepth !== null);
  const otherFolders = folders.filter(({ localDepth }) => localDepth === null);
  const toCompletion = ({ folder, name }: (typeof folders)[number]): CompletionItem => ({
    name,
    desc: folder.parentId ? `in ${sidebarFolderPath(sidebar, folder.parentId) || "/"}` : "top-level",
  });
  return [...special, ...localFolders.map(toCompletion), ...otherFolders.map(toCompletion)];
}

function findFolderDestination(sidebar: SidebarState, input: string): SidebarFolder | null | undefined {
  const raw = input.trim();
  if (!raw || raw === "/") return null;
  if (raw === "..") {
    const parentId = parentOfCurrentFolder(sidebar);
    return parentId ? sidebar.folders.find((folder) => folder.id === parentId) : null;
  }
  const normalized = normalizeMoveDestinationInput(raw).toLowerCase();
  const byPath = sidebar.folders.find((folder) => sidebarFolderPath(sidebar, folder.id).toLowerCase() === normalized);
  if (byPath) return byPath;
  const local = sidebar.folders.find((folder) => (folder.parentId ?? null) === sidebar.currentFolderId && folder.name.toLowerCase() === normalized);
  if (local) return local;
  return sidebar.folders.find((folder) => folder.name.toLowerCase() === normalized);
}

function updateMovePromptAutocomplete(sidebar: SidebarState): void {
  const prompt = sidebar.prompt;
  if (!prompt || prompt.purpose !== "move_items") return;
  const matches = movePromptMatches(sidebar, prompt.input, prompt.items);
  prompt.autocomplete = matches.length > 0 ? { selection: -1, prefix: prompt.input, matches } : null;
}

export function openSidebarCreateFolderPrompt(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): void {
  sidebar.prompt = { purpose: "create_folder", input: "", cursorPos: 0, items: sidebar.visualAnchor ? selectedSidebarItems(sidebar, channels, options) : [] };
  sidebar.pendingDeleteItem = null;
}

export function openSidebarMoveItemsPrompt(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): boolean {
  const items = selectedSidebarItems(sidebar, channels, options).filter((item) => item.type !== "guild" || !isFixedTopLevelGuildId(item.id));
  if (items.length === 0) return false;
  sidebar.prompt = { purpose: "move_items", input: "", cursorPos: 0, items, autocomplete: null };
  updateMovePromptAutocomplete(sidebar);
  return true;
}

export function openSidebarRenameFolderPrompt(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): boolean {
  const item = getSelectedSidebarEntry(sidebar, channels, options).item;
  if (item?.type !== "folder") return false;
  const folder = sidebar.folders.find((candidate) => candidate.id === item.id);
  if (!folder) return false;
  sidebar.prompt = { purpose: "rename_folder", input: "", cursorPos: 0, items: [], folderId: folder.id };
  return true;
}

export function unwrapSelectedSidebarFolder(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): boolean {
  const item = getSelectedSidebarEntry(sidebar, channels, options).item;
  if (item?.type !== "folder") return false;
  const folder = sidebar.folders.find((candidate) => candidate.id === item.id);
  if (!folder) return false;
  const parentId = folder.parentId ?? null;
  const children = sidebarOrderEntries(sidebar, folder.id).map((entry): SidebarItemRef => ({ type: entry.type, id: entry.id }));
  const fallback = nextItemAfterRemovingItems(sidebar, channels, [item], options);
  if (children.length > 0) moveSidebarItems(sidebar, children, parentId, item);
  sidebar.folders = sidebar.folders.filter((candidate) => candidate.id !== folder.id);
  sidebar.visualAnchor = null;
  sidebar.pendingDeleteItem = null;
  sidebar.selectedItem = children[0] ?? (fallback?.type === "up" ? null : fallback);
  if (!sidebar.selectedItem) sidebar.selectedIndex = 0;
  return true;
}

export function handleSidebarPromptKey(sidebar: SidebarState, key: KeyEvent, channels: DiscordChannel[] = [], options: SidebarVisibilityOptions = {}): boolean {
  const prompt = sidebar.prompt;
  if (!prompt) return false;
  if (key.type === "escape") { sidebar.prompt = null; return true; }
  if (key.type === "tab" || key.type === "backtab") {
    if (prompt.purpose === "move_items") {
      if (!prompt.autocomplete || prompt.autocomplete.matches.length === 0) updateMovePromptAutocomplete(sidebar);
      const autocomplete = prompt.autocomplete;
      if (autocomplete?.matches.length) {
        autocomplete.selection = key.type === "tab"
          ? (autocomplete.selection < 0 ? 0 : (autocomplete.selection + 1) % autocomplete.matches.length)
          : (autocomplete.selection <= 0 ? autocomplete.matches.length - 1 : autocomplete.selection - 1);
        const name = autocomplete.matches[autocomplete.selection]?.name;
        if (name) { prompt.input = name; prompt.cursorPos = name.length; }
      }
    }
    return true;
  }
  if (key.type === "enter") {
    const input = prompt.input.trim();
    sidebar.prompt = null;
    sidebar.visualAnchor = null;
    if (prompt.purpose === "create_folder") {
      if (!input) return true;
      const parentId = sidebar.currentFolderId;
      const items = prompt.items.filter((item) => item.type !== "guild" || !isFixedTopLevelGuildId(item.id));
      const selectedItemsInParent = items.filter((item) => itemParent(sidebar, item) === parentId);
      const selectedOrders = selectedItemsInParent.map((item) => itemSortOrder(sidebar, item));
      const selectedPinnedStates = selectedItemsInParent
        .map((item) => itemPinned(sidebar, item))
        .filter((pinned): pinned is boolean => typeof pinned === "boolean");
      const pinned = selectedPinnedStates.length > 0 && selectedPinnedStates.every(Boolean);
      const folder: SidebarFolder = {
        id: randomUUID(),
        name: input,
        parentId,
        pinned,
        sortOrder: selectedOrders.length > 0
          ? Math.min(...selectedOrders)
          : pinned ? nextPinnedOrderInFolder(sidebar, parentId) : nextUnpinnedOrderInFolder(sidebar, parentId),
      };
      sidebar.folders.push(folder);
      if (items.length > 0) moveSidebarItems(sidebar, items, folder.id);
      sidebar.selectedItem = { type: "folder", id: folder.id };
      return true;
    }
    if (prompt.purpose === "move_items") {
      const raw = input.trim();
      const destinationFolder = findFolderDestination(sidebar, raw);
      const destination = destinationFolder === undefined ? undefined : destinationFolder?.id ?? null;
      const before = raw === ".."
        ? currentFolderRef(sidebar)
        : (!raw || raw === "/")
          ? topLevelCurrentFolderRef(sidebar)
          : undefined;
      if (destination !== undefined && destination !== sidebar.currentFolderId) {
        requestFocusAfterMovingItemsOutOfView(sidebar, channels, prompt.items, options);
      }
      if (destination !== undefined) moveSidebarItems(sidebar, prompt.items, destination, before);
      return true;
    }
    if (prompt.purpose === "rename_folder" && prompt.folderId && input) {
      const folder = sidebar.folders.find((candidate) => candidate.id === prompt.folderId);
      if (folder) folder.name = input;
      return true;
    }
    return true;
  }
  if (key.type === "backspace") {
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    if (pos > 0) {
      const start = previousGraphemeStart(prompt.input, pos);
      prompt.input = prompt.input.slice(0, start) + prompt.input.slice(pos);
      prompt.cursorPos = start;
      updateMovePromptAutocomplete(sidebar);
    } else if (prompt.input.length === 0) sidebar.prompt = null;
    return true;
  }
  if (key.type === "delete") {
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    if (pos < prompt.input.length) {
      prompt.input = prompt.input.slice(0, pos) + prompt.input.slice(nextGraphemeEnd(prompt.input, pos));
      prompt.cursorPos = pos;
      updateMovePromptAutocomplete(sidebar);
    }
    return true;
  }
  if (key.type === "left") { prompt.cursorPos = previousGraphemeStart(prompt.input, prompt.cursorPos); return true; }
  if (key.type === "right") { prompt.cursorPos = nextGraphemeEnd(prompt.input, prompt.cursorPos); return true; }
  if (key.type === "home") { prompt.cursorPos = 0; return true; }
  if (key.type === "end") { prompt.cursorPos = prompt.input.length; return true; }
  if (key.type === "paste" && key.text) {
    const text = key.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    prompt.input = prompt.input.slice(0, pos) + text + prompt.input.slice(pos);
    prompt.cursorPos = pos + text.length;
    updateMovePromptAutocomplete(sidebar);
    return true;
  }
  if (key.type === "char" && key.char) {
    const pos = graphemeBoundaryAtOrAfter(prompt.input, prompt.cursorPos);
    prompt.input = prompt.input.slice(0, pos) + key.char + prompt.input.slice(pos);
    prompt.cursorPos = pos + key.char.length;
    updateMovePromptAutocomplete(sidebar);
    return true;
  }
  return true;
}

export function activateSelectedEntry(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): SidebarEntry | null {
  const entry = getSelectedSidebarEntry(sidebar, channels, options);
  if (!entry.id || entry.kind === "loading" || entry.kind === "delimiter") return null;

  if (entry.kind === "up") {
    leaveSidebarFolder(sidebar);
    return entry;
  }

  if (entry.kind === "folder") {
    enterSidebarFolder(sidebar, entry.id);
    return entry;
  }

  if (entry.kind === "guild") {
    sidebar.focusedGuildId = entry.guildId;
    if (sidebar.expandedGuildId === entry.guildId) {
      sidebar.expandedGuildId = null;
    } else {
      sidebar.expandedGuildId = entry.guildId;
    }
    return entry;
  }

  if (entry.kind === "category") {
    if (sidebar.collapsedCategoryIds.includes(entry.id)) {
      sidebar.collapsedCategoryIds = sidebar.collapsedCategoryIds.filter((id) => id !== entry.id);
    } else {
      sidebar.collapsedCategoryIds = [...sidebar.collapsedCategoryIds, entry.id];
    }
    return entry;
  }

  return entry;
}

function sidebarVisualKeys(sidebar: SidebarState, entries: SidebarEntry[]): Set<string | null> {
  if (!sidebar.visualAnchor) return new Set();
  const movableEntries = entries.filter((entry) => isMovableSidebarItem(entry.item));
  const anchorIndex = movableEntries.findIndex((entry) => sameSidebarItem(entry.item, sidebar.visualAnchor));
  const selected = entries[sidebar.selectedIndex]?.item ?? sidebar.selectedItem;
  const selectedIndex = movableEntries.findIndex((entry) => sameSidebarItem(entry.item, selected));
  if (anchorIndex < 0 || selectedIndex < 0) return new Set([sidebarItemKey(sidebar.visualAnchor)]);
  const start = Math.min(anchorIndex, selectedIndex);
  const end = Math.max(anchorIndex, selectedIndex);
  return new Set(movableEntries.slice(start, end + 1).map((entry) => sidebarItemKey(entry.item)));
}

export function renderSidebar(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  totalRows: number,
  focused = false,
  activeChannelId: string | null = null,
  loadingFrameIndex = 0,
  typingChannelIds: ReadonlySet<string> = new Set(),
  typingFrame = "⋯",
  channelNotificationCounts: ReadonlyMap<string, number> = new Map(),
  guildNotificationCounts: ReadonlyMap<string, number> = new Map(),
  options: SidebarVisibilityOptions = {},
): string[] {
  if (!sidebar.open) return [];

  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1;
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;
  const borderBg = theme.appBg ?? "";

  const folder = currentSidebarFolder(sidebar);
  const header = folder ? ` ${folder.name}/` : " Servers";
  rows.push(
    theme.sidebarBg + theme.text + theme.bold + padRight(header, innerWidth)
    + theme.reset + borderBg + borderFg + "│" + theme.reset,
  );

  rows.push(
    theme.sidebarBg + borderFg + "─".repeat(innerWidth) + borderBg + "┤" + theme.reset,
  );

  const entries = buildSidebarEntries(
    sidebar,
    channels,
    loadingFrameIndex,
    typingChannelIds,
    typingFrame,
    channelNotificationCounts,
    guildNotificationCounts,
    options,
  );
  const visualKeys = sidebarVisualKeys(sidebar, entries);
  const listRows = sidebarViewportRows(totalRows, sidebar);
  clampSidebarViewportToSelection(sidebar, entries, listRows);
  const scrollOffset = sidebar.scrollOffset;

  if (sidebar.loading && sidebar.guilds.length === 0) {
    rows.push(
      theme.sidebarBg + theme.muted + padRight(` ${loadingLabel("Loading servers…", loadingFrameIndex)}`, innerWidth)
      + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  } else if (entries.length === 0) {
    rows.push(
      theme.sidebarBg + theme.muted + padRight(getActiveSidebarSearchQuery(sidebar) ? " No matches" : " No servers", innerWidth)
      + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  } else {
    for (let i = 0; i < listRows; i++) {
      const entry = entries[scrollOffset + i];
      if (!entry) break;
      rows.push(renderEntryRow(entry, visualKeys, innerWidth, borderBg, borderFg, activeChannelId));
    }
  }

  if (sidebar.search?.barOpen) {
    while (rows.length < totalRows - 1) {
      rows.push(
        theme.sidebarBg + " ".repeat(innerWidth) + theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
    }
    rows.push(
      getSidebarSearchBarViewport(sidebar.search, innerWidth).line
      + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  } else if (sidebar.prompt) {
    const autocompleteRows = getSidebarPromptAutocompleteRows(sidebar.prompt, innerWidth, sidebarPromptAutocompleteVisibleRows(sidebar, totalRows));
    while (rows.length < totalRows - autocompleteRows.length - 1) {
      rows.push(
        theme.sidebarBg + " ".repeat(innerWidth) + theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
    }
    for (const row of autocompleteRows) {
      rows.push(row + theme.reset + borderBg + borderFg + "│" + theme.reset);
    }
    rows.push(
      getSidebarPromptBar(sidebar.prompt, innerWidth)
      + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  while (rows.length < totalRows) {
    rows.push(
      theme.sidebarBg + " ".repeat(innerWidth) + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  return rows;
}

function renderEntryRow(
  entry: SidebarEntry,
  visualKeys: ReadonlySet<string | null>,
  innerWidth: number,
  borderBg: string,
  borderFg: string,
  activeChannelId: string | null,
): string {
  if (entry.kind === "delimiter") {
    const indent = "  ".repeat(entry.depth);
    const ruleWidth = Math.max(0, innerWidth - termWidth(indent) - 1);
    return theme.reset + theme.sidebarBg + theme.muted
      + padRight(`${indent}${"─".repeat(ruleWidth)}`, innerWidth)
      + theme.reset + borderBg + borderFg + "│" + theme.reset;
  }

  if (entry.kind === "loading") {
    const prefix = "  ".repeat(entry.depth);
    const labelWidth = Math.max(0, innerWidth - termWidth(prefix));
    const title = padRight(entry.label, labelWidth);

    return theme.reset + theme.sidebarBg + theme.dim + theme.muted + prefix + title
      + theme.reset + borderBg + borderFg + "│" + theme.reset;
  }

  const itemKey = sidebarItemKey(entry.item);
  const isVisual = itemKey !== null && visualKeys.has(itemKey);
  const bg = entry.selected || isVisual ? theme.sidebarSelBg : theme.sidebarBg;
  const isActive = entry.kind === "channel" ? entry.id === activeChannelId : entry.active;
  const fg = entry.kind === "voice-member" && entry.color
    ? entry.color
    : entry.selected || isActive ? theme.text : theme.muted;
  const indent = "  ".repeat(entry.depth);
  const selectPrefix = entry.selected ? "▸ " : isVisual ? "│ " : "  ";
  const marker = entry.kind === "guild"
    ? entry.expanded ? "▾ " : "▸ "
    : entry.kind === "category"
      ? entry.expanded ? "▾ " : "▸ "
      : entry.kind === "channel"
        ? channelEntryMarker(entry.channelType)
        : entry.kind === "voice-member"
          ? "• "
        : "";
  const prefix = entry.kind === "channel" || entry.kind === "category" || entry.kind === "voice-member" ? `${indent}${marker}` : `${selectPrefix}${marker}`;

  if (entry.kind === "voice-member") {
    const rawLabel = voiceMemberNameLabel(entry);
    const statusSuffix = voiceMemberStatusSuffix(entry);
    const cameraIndicator = entry.cameraOn ? "📷" : "";
    const liveBadge = renderLiveBadge(Boolean(entry.streaming));
    const cameraWidth = cameraIndicator ? 1 + termWidth(cameraIndicator) : 0;
    const liveWidth = liveBadge ? 1 + liveBadge.width : 0;
    const contentWidth = Math.max(0, innerWidth - termWidth(prefix));
    const textWidth = Math.max(0, contentWidth - cameraWidth - liveWidth);
    const labelWidth = Math.max(0, textWidth - termWidth(statusSuffix));
    const clippedLabel = truncate(rawLabel, labelWidth);
    const title = padRight(`${clippedLabel}${statusSuffix}`, textWidth);
    const text = isActive ? `${theme.bold}${title}${theme.boldOff}` : title;

    return theme.reset + bg + fg + prefix + text
      + (cameraIndicator ? ` ${cameraIndicator}` : "")
      + (liveBadge ? ` ${liveBadge.text}` : "")
      + theme.reset + borderBg + borderFg + "│" + theme.reset;
  }

  const rawLabel = entry.kind === "folder"
    ? `📁 ${entry.label}/ ${entry.childCount ?? 0}`
    : entry.label || "unnamed";
  const badge = renderNotificationBadge(entry.notificationCount ?? 0);
  const muteIcon = (entry.kind === "guild" || entry.kind === "category" || entry.kind === "channel") && entry.muted ? " 🔕" : "";
  const badgeGap = badge ? 1 : 0;
  const badgeWidth = badge?.width ?? 0;
  const muteWidth = termWidth(muteIcon);
  const suffix = `${muteIcon}${badge ? `${" ".repeat(badgeGap)}${badge.text}` : ""}`;
  const labelWidth = Math.max(0, innerWidth - termWidth(prefix) - muteWidth - badgeGap - badgeWidth);
  const title = padRight(rawLabel, labelWidth);
  const text = isActive ? `${theme.bold}${title}${theme.boldOff}` : title;

  return theme.reset + bg + fg + prefix + text + suffix
    + theme.reset + borderBg + borderFg + "│" + theme.reset;
}

function renderNotificationBadge(count: number): { text: string; width: number } | null {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  const text = ` ${label} `;
  return {
    text: `${theme.notificationBg}${theme.notificationFg}${text}${theme.reset}`,
    width: termWidth(text),
  };
}

function renderLiveBadge(streaming: boolean): { text: string; width: number } | null {
  if (!streaming) return null;
  const text = "LIVE";
  return {
    text: `${theme.notificationBg}${theme.notificationFg}${theme.bold}${text}${theme.boldOff}${theme.reset}`,
    width: termWidth(text),
  };
}
