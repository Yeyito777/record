/**
 * Servers sidebar with collapsible guild/category/channel tree.
 */

import { DIRECT_MESSAGES_GUILD_ID, type DiscordChannel, type DiscordGuild } from "./discord";
import { loadingLabel } from "./loading";
import { padRight, termWidth } from "./textwidth";
import { theme } from "./theme";
import {
  scrollByAmountWithCursorInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
} from "./vimscroll";

export const SIDEBAR_WIDTH = 28;

export type SidebarEntryKind = "guild" | "category" | "channel" | "loading";

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
  const entries: SidebarEntry[] = [];

  for (const guild of sidebar.guilds) {
    const isExpanded = guild.id === sidebar.expandedGuildId;
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
      expanded: isExpanded,
    });

    if (!isExpanded) continue;

    const visibleGuildChannels = channels.filter((channel) => channel.guildId === guild.id);
    if (sidebar.loadingGuildId === guild.id && visibleGuildChannels.length === 0) {
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
    const uncategorized = visibleChannelRows
      .filter((channel) => !channel.parentId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    for (const channel of uncategorized) {
      entries.push({
        kind: "channel",
        id: channel.id,
        guildId: guild.id,
        label: channelEntryLabel(channel, typingChannelIds, typingFrame),
        depth: 1,
        notificationCount: channelNotificationCounts.get(channel.id) ?? 0,
        hidden: Boolean(channel.hidden),
        selected: false,
        active: false,
        expanded: false,
      });
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
        entries.push({
          kind: "channel",
          id: channel.id,
          guildId: guild.id,
          label: channelEntryLabel(channel, typingChannelIds, typingFrame),
          depth: 2,
          notificationCount: channelNotificationCounts.get(channel.id) ?? 0,
          hidden: Boolean(channel.hidden),
          selected: false,
          active: false,
          expanded: false,
        });
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

function sidebarViewportRows(totalRows: number): number {
  return Math.max(0, totalRows - 2);
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
  const viewportRows = sidebarViewportRows(totalRows);
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
    viewportHeight: sidebarViewportRows(totalRows),
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

  const viewportRows = sidebarViewportRows(totalRows);
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

  const viewportRows = sidebarViewportRows(totalRows);
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
  const listRows = sidebarViewportRows(totalRows);
  clampSidebarViewportToSelection(sidebar, entries, listRows);
  const scrollOffset = sidebar.scrollOffset;

  if (sidebar.loading && sidebar.guilds.length === 0) {
    rows.push(
      theme.sidebarBg + theme.muted + padRight(` ${loadingLabel("Loading servers…", loadingFrameIndex)}`, innerWidth)
      + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  } else if (entries.length === 0) {
    rows.push(
      theme.sidebarBg + theme.muted + padRight(" No servers", innerWidth)
      + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  } else {
    for (let i = 0; i < listRows; i++) {
      const entry = entries[scrollOffset + i];
      if (!entry) break;
      rows.push(renderEntryRow(entry, innerWidth, borderBg, borderFg, activeChannelId));
    }
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
