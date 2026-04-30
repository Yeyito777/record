/**
 * Servers sidebar with collapsible guild/category/channel tree.
 */

import { DIRECT_MESSAGES_GUILD_ID, type DiscordChannel, type DiscordGuild } from "./discord";
import type { KeyEvent } from "./input";
import { loadingLabel } from "./loading";
import { getViewportByWidth, padRight, termWidth } from "./textwidth";
import { theme } from "./theme";
import {
  scrollByAmountWithCursorInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
} from "./vimscroll";

export const SIDEBAR_WIDTH = 28;

export type SidebarEntryKind = "guild" | "category" | "channel" | "loading";
export type SidebarSearchDirection = "forward" | "backward";
export type SidebarSearchBarMode = "search" | "command";

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
  label: string;
  depth: number;
  channelType?: number;
  notificationCount?: number;
  muted?: boolean;
  hidden?: boolean;
  selected: boolean;
  active: boolean;
  expanded: boolean;
}

export interface SidebarVisibilityOptions {
  showHiddenChannels?: boolean;
}

export interface SidebarState {
  open: boolean;
  guilds: DiscordGuild[];
  selectedIndex: number;
  activeGuildId: string | null;
  expandedGuildId: string | null;
  collapsedCategoryIds: string[];
  loadingGuildId: string | null;
  scrollOffset: number;
  loading: boolean;
  requestId: number;
  /** Cached channels by guild id, including the synthetic direct-message guild. */
  cachedChannelsByGuildId: Record<string, DiscordChannel[]>;
  search: SidebarSearchState | null;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    guilds: [],
    selectedIndex: 0,
    activeGuildId: null,
    expandedGuildId: null,
    collapsedCategoryIds: [],
    loadingGuildId: null,
    scrollOffset: 0,
    loading: false,
    requestId: 0,
    cachedChannelsByGuildId: {},
    search: null,
  };
}

function isSelectableEntry(entry: SidebarEntry): boolean {
  return entry.kind !== "loading";
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
  sidebar.activeGuildId = null;
  sidebar.expandedGuildId = null;
  sidebar.collapsedCategoryIds = [];
  sidebar.loadingGuildId = null;
  sidebar.scrollOffset = 0;
  sidebar.loading = false;
  sidebar.cachedChannelsByGuildId = {};
  sidebar.search = null;
}

export function setSidebarGuilds(sidebar: SidebarState, guilds: DiscordGuild[]): void {
  const previousMutedByGuildId = new Map(sidebar.guilds.map((guild) => [guild.id, guild.muted]));
  sidebar.guilds = guilds.map((guild) => ({
    ...guild,
    muted: guild.muted ?? previousMutedByGuildId.get(guild.id),
  }));
  sidebar.scrollOffset = 0;
  sidebar.selectedIndex = Math.max(0, Math.min(sidebar.selectedIndex, Math.max(0, guilds.length - 1)));

  if (sidebar.activeGuildId && !guilds.some((guild) => guild.id === sidebar.activeGuildId)) {
    sidebar.activeGuildId = null;
  }
  if (sidebar.expandedGuildId && !guilds.some((guild) => guild.id === sidebar.expandedGuildId)) {
    sidebar.expandedGuildId = null;
  }
}

export function setSidebarGuildMuted(sidebar: SidebarState, guildId: string, muted: boolean): boolean {
  const index = sidebar.guilds.findIndex((guild) => guild.id === guildId);
  if (index < 0) return false;
  sidebar.guilds[index] = { ...sidebar.guilds[index]!, muted };
  return true;
}

export function setSidebarCachedChannels(sidebar: SidebarState, guildId: string, channels: DiscordChannel[]): void {
  sidebar.cachedChannelsByGuildId[guildId] = channels.slice();
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
    if (channel.guildId === guildId) byId.set(channel.id, channel);
  }
  return Array.from(byId.values());
}

function allSidebarChannels(sidebar: SidebarState, activeChannels: DiscordChannel[]): DiscordChannel[] {
  const byId = new Map<string, DiscordChannel>();
  for (const channels of Object.values(sidebar.cachedChannelsByGuildId)) {
    for (const channel of channels) byId.set(channel.id, channel);
  }
  for (const channel of activeChannels) byId.set(channel.id, channel);
  return Array.from(byId.values());
}

export interface SidebarGuildMoveResult {
  guild: DiscordGuild;
  previousGuilds: DiscordGuild[];
  nextGuilds: DiscordGuild[];
}

export function moveSelectedSidebarGuild(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  direction: "up" | "down",
  options: SidebarVisibilityOptions = {},
): SidebarGuildMoveResult | null {
  const entry = getSelectedSidebarEntry(sidebar, channels, options);
  if (entry.kind !== "guild" || entry.guildId === DIRECT_MESSAGES_GUILD_ID) return null;

  const fromIndex = sidebar.guilds.findIndex((guild) => guild.id === entry.guildId);
  if (fromIndex < 0) return null;

  const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
  const target = sidebar.guilds[toIndex];
  if (!target || target.id === DIRECT_MESSAGES_GUILD_ID) return null;

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

export function applySidebarGuildMuteSettings(sidebar: SidebarState, mutedByGuildId: Record<string, boolean>): void {
  sidebar.guilds = sidebar.guilds.map((guild) => (
    Object.prototype.hasOwnProperty.call(mutedByGuildId, guild.id)
      ? { ...guild, muted: mutedByGuildId[guild.id] }
      : guild
  ));
}

export function sidebarCachedGuilds(sidebar: SidebarState): DiscordGuild[] {
  return sidebar.guilds.filter((guild) => guild.id !== DIRECT_MESSAGES_GUILD_ID);
}

export function isSidebarGuildMuted(sidebar: SidebarState, guildId: string | null | undefined): boolean {
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return false;
  return Boolean(sidebar.guilds.find((guild) => guild.id === guildId)?.muted);
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

function channelMatchesQuery(channel: DiscordChannel, query: string): boolean {
  return findAllCaseInsensitiveMatchStarts(searchableChannelLabel(channel), query).length > 0;
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
): void {
  entries.push({
    kind: "guild",
    id: guild.id,
    guildId: guild.id,
    label: guild.name || "(unnamed)",
    depth: 0,
    notificationCount: guild.muted ? 0 : guildNotificationCounts.get(guild.id) ?? 0,
    muted: Boolean(guild.muted),
    selected: false,
    active: guild.id === sidebar.activeGuildId,
    expanded,
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
): void {
  entries.push({
    kind: "channel",
    id: channel.id,
    guildId,
    label: channelEntryLabel(channel, typingChannelIds, typingFrame),
    depth,
    channelType: channel.type,
    notificationCount: channelNotificationCounts.get(channel.id) ?? 0,
    hidden: Boolean(channel.hidden),
    selected: false,
    active: false,
    expanded: false,
  });
}

function sortChannelsForSidebar(channels: DiscordChannel[]): DiscordChannel[] {
  return channels.slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

function buildSidebarSearchEntries(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  query: string,
  typingChannelIds: ReadonlySet<string>,
  typingFrame: string,
  channelNotificationCounts: ReadonlyMap<string, number>,
  guildNotificationCounts: ReadonlyMap<string, number>,
  options: SidebarVisibilityOptions,
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  const allChannels = allSidebarChannels(sidebar, channels);

  for (const guild of sidebar.guilds) {
    const guildChannels = allChannels.filter((channel) => channel.guildId === guild.id);
    const visibleChannelRows = guildChannels
      .filter((channel) => channel.type !== 4 && (options.showHiddenChannels || !channel.hidden))
      .filter((channel) => channelMatchesQuery(channel, query));
    if (visibleChannelRows.length === 0) continue;

    pushGuildEntry(entries, guild, sidebar, guildNotificationCounts, true);

    if (guild.id === DIRECT_MESSAGES_GUILD_ID) {
      for (const channel of sortChannelsForSidebar(visibleChannelRows)) {
        pushChannelEntry(entries, guild.id, channel, 1, typingChannelIds, typingFrame, channelNotificationCounts);
      }
      continue;
    }

    const guildCategories = guildChannels
      .filter((channel) => channel.type === 4)
      .filter((category) => options.showHiddenChannels || !category.hidden)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const categoryIds = new Set(guildCategories.map((category) => category.id));
    const uncategorized = visibleChannelRows
      .filter((channel) => !channel.parentId || !categoryIds.has(channel.parentId))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    for (const channel of uncategorized) {
      pushChannelEntry(entries, guild.id, channel, 1, typingChannelIds, typingFrame, channelNotificationCounts);
    }

    for (const category of guildCategories) {
      const categoryChannels = visibleChannelRows
        .filter((channel) => channel.parentId === category.id)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      if (categoryChannels.length === 0) continue;

      entries.push({
        kind: "category",
        id: category.id,
        guildId: guild.id,
        label: category.name,
        depth: 1,
        hidden: Boolean(category.hidden),
        selected: false,
        active: false,
        expanded: true,
      });

      for (const channel of categoryChannels) {
        pushChannelEntry(entries, guild.id, channel, 2, typingChannelIds, typingFrame, channelNotificationCounts);
      }
    }
  }

  return entries;
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
    ? buildSidebarSearchEntries(sidebar, channels, query, typingChannelIds, typingFrame, channelNotificationCounts, guildNotificationCounts, options)
    : [];

  if (!query) {
    for (const guild of sidebar.guilds) {
      const isExpanded = guild.id === sidebar.expandedGuildId;
      pushGuildEntry(entries, guild, sidebar, guildNotificationCounts, isExpanded);

      if (!isExpanded) continue;

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
        continue;
      }

      const visibleChannelRows = visibleGuildChannels.filter((channel) => channel.type !== 4 && (options.showHiddenChannels || !channel.hidden));
      const guildCategories = visibleGuildChannels
        .filter((channel) => channel.type === 4)
        .filter((category) => options.showHiddenChannels || visibleChannelRows.some((channel) => channel.parentId === category.id))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      const categoryIds = new Set(guildCategories.map((category) => category.id));
      const uncategorized = visibleChannelRows
        .filter((channel) => !channel.parentId || !categoryIds.has(channel.parentId))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

      for (const channel of uncategorized) {
        pushChannelEntry(entries, guild.id, channel, 1, typingChannelIds, typingFrame, channelNotificationCounts);
      }

      for (const category of guildCategories) {
        const collapsed = sidebar.collapsedCategoryIds.includes(category.id);
        entries.push({
          kind: "category",
          id: category.id,
          guildId: guild.id,
          label: category.name,
          depth: 1,
          hidden: Boolean(category.hidden),
          selected: false,
          active: false,
          expanded: !collapsed,
        });

        if (collapsed) continue;

        const categoryChannels = visibleChannelRows
          .filter((channel) => channel.parentId === category.id)
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

        for (const channel of categoryChannels) {
          pushChannelEntry(entries, guild.id, channel, 2, typingChannelIds, typingFrame, channelNotificationCounts);
        }
      }
    }
  }

  const clampedIndex = clampSelectedIndex(sidebar, entries);
  sidebar.selectedIndex = clampedIndex;

  return entries.map((entry, index) => ({
    ...entry,
    selected: index === clampedIndex,
    active: entry.kind === "guild"
      ? entry.guildId === sidebar.activeGuildId
      : entry.active,
  }));
}

function channelEntryLabel(channel: DiscordChannel, typingChannelIds: ReadonlySet<string>, typingFrame: string): string {
  const name = channel.hidden ? `🔒 ${channel.name}` : channel.name;
  return typingChannelIds.has(channel.id) ? `${name} ${typingFrame}` : name;
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
      return;
    }
  }
  sidebar.selectedIndex = Math.max(0, fallbackIndex);
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
  const entries = buildSidebarSearchEntries(sidebar, channels, query, new Set(), "⋯", new Map(), new Map(), options);
  const candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "channel")
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
  if (matchIndex != null) sidebar.selectedIndex = matchIndex;
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
      return { type: "handled" };
    default:
      return { type: "handled" };
  }
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

  if (key.type === "escape" || key.type === "ctrl-c") {
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
}

function sidebarViewportRows(totalRows: number, sidebar?: SidebarState): number {
  return Math.max(0, totalRows - 2 - (sidebar?.search?.barOpen ? 1 : 0));
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
  sidebar.scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, entries.length - viewportRows)));
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
  sidebar.scrollOffset = next.viewStart;
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
  sidebar.scrollOffset = next.viewStart;
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

  if (targetIndex != null) sidebar.selectedIndex = targetIndex;
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
  }
}

export function activateSelectedEntry(sidebar: SidebarState, channels: DiscordChannel[], options: SidebarVisibilityOptions = {}): SidebarEntry | null {
  const entry = getSelectedSidebarEntry(sidebar, channels, options);
  if (!entry.id || entry.kind === "loading") return null;

  if (entry.kind === "guild") {
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

  rows.push(
    theme.sidebarBg + theme.text + theme.bold + padRight(" Servers", innerWidth)
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
      rows.push(renderEntryRow(entry, innerWidth, borderBg, borderFg, activeChannelId));
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
  innerWidth: number,
  borderBg: string,
  borderFg: string,
  activeChannelId: string | null,
): string {
  if (entry.kind === "loading") {
    const prefix = "  ".repeat(entry.depth);
    const labelWidth = Math.max(0, innerWidth - termWidth(prefix));
    const title = padRight(entry.label, labelWidth);

    return theme.reset + theme.sidebarBg + theme.dim + theme.muted + prefix + title
      + theme.reset + borderBg + borderFg + "│" + theme.reset;
  }

  const bg = entry.selected ? theme.sidebarSelBg : theme.sidebarBg;
  const isActive = entry.kind === "channel" ? entry.id === activeChannelId : entry.active;
  const fg = entry.selected || isActive ? theme.text : theme.muted;
  const indent = "  ".repeat(entry.depth);
  const marker = entry.kind === "guild"
    ? entry.expanded ? "▾ " : "▸ "
    : entry.kind === "category"
      ? entry.expanded ? "▾ " : "▸ "
      : "# ";
  const prefix = `${indent}${marker}`;
  const badge = renderNotificationBadge(entry.notificationCount ?? 0);
  const muteIcon = entry.kind === "guild" && entry.muted ? " 🔕" : "";
  const badgeGap = badge ? 1 : 0;
  const badgeWidth = badge?.width ?? 0;
  const muteWidth = termWidth(muteIcon);
  const labelWidth = Math.max(0, innerWidth - termWidth(prefix) - muteWidth - badgeGap - badgeWidth);
  const title = padRight(entry.label || "unnamed", labelWidth);
  const text = isActive ? `${theme.bold}${title}${theme.boldOff}` : title;
  const suffix = `${muteIcon}${badge ? `${" ".repeat(badgeGap)}${badge.text}` : ""}`;

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
