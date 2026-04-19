/**
 * Servers sidebar with collapsible guild/category/channel tree.
 */

import type { DiscordChannel, DiscordGuild } from "./discord";
import { loadingLabel } from "./loading";
import { padRight, termWidth } from "./textwidth";
import { theme } from "./theme";

export const SIDEBAR_WIDTH = 28;

export type SidebarEntryKind = "guild" | "category" | "channel" | "loading";

export interface SidebarEntry {
  kind: SidebarEntryKind;
  id: string;
  guildId: string;
  label: string;
  depth: number;
  selected: boolean;
  active: boolean;
  expanded: boolean;
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
  sidebar.guilds = guilds;
  sidebar.scrollOffset = 0;
  sidebar.selectedIndex = Math.max(0, Math.min(sidebar.selectedIndex, Math.max(0, guilds.length - 1)));

  if (!sidebar.activeGuildId || !guilds.some((guild) => guild.id === sidebar.activeGuildId)) {
    sidebar.activeGuildId = guilds[0]?.id ?? null;
  }
  if (!sidebar.expandedGuildId || !guilds.some((guild) => guild.id === sidebar.expandedGuildId)) {
    sidebar.expandedGuildId = sidebar.activeGuildId;
  }
}

export function buildSidebarEntries(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  loadingFrameIndex = 0,
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
      selected: false,
      active: guild.id === sidebar.activeGuildId,
      expanded: isExpanded,
    });

    if (!isExpanded) continue;

    if (sidebar.loadingGuildId === guild.id) {
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

    const guildCategories = channels
      .filter((channel) => channel.guildId === guild.id && channel.type === 4)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const uncategorized = channels
      .filter((channel) => channel.guildId === guild.id && channel.type !== 4 && !channel.parentId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    for (const channel of uncategorized) {
      entries.push({
        kind: "channel",
        id: channel.id,
        guildId: guild.id,
        label: channel.name,
        depth: 1,
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
        selected: false,
        active: false,
        expanded: !collapsed,
      });

      if (collapsed) continue;

      const categoryChannels = channels
        .filter((channel) => channel.guildId === guild.id && channel.type !== 4 && channel.parentId === category.id)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

      for (const channel of categoryChannels) {
        entries.push({
          kind: "channel",
          id: channel.id,
          guildId: guild.id,
          label: channel.name,
          depth: 2,
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

export function getSelectedSidebarEntry(sidebar: SidebarState, channels: DiscordChannel[]): SidebarEntry {
  const entries = buildSidebarEntries(sidebar, channels);
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

export function moveSidebarSelection(sidebar: SidebarState, channels: DiscordChannel[], delta: number): void {
  const entries = buildSidebarEntries(sidebar, channels);
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

function jumpSidebarSelectionToKind(
  sidebar: SidebarState,
  channels: DiscordChannel[],
  kind: Extract<SidebarEntryKind, "guild" | "category">,
  direction: -1 | 1,
): void {
  const entries = buildSidebarEntries(sidebar, channels);
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

export function moveSidebarSelectionToPrevGuild(sidebar: SidebarState, channels: DiscordChannel[]): void {
  jumpSidebarSelectionToKind(sidebar, channels, "guild", -1);
}

export function moveSidebarSelectionToNextGuild(sidebar: SidebarState, channels: DiscordChannel[]): void {
  jumpSidebarSelectionToKind(sidebar, channels, "guild", 1);
}

export function moveSidebarSelectionToPrevCategory(sidebar: SidebarState, channels: DiscordChannel[]): void {
  jumpSidebarSelectionToKind(sidebar, channels, "category", -1);
}

export function moveSidebarSelectionToNextCategory(sidebar: SidebarState, channels: DiscordChannel[]): void {
  jumpSidebarSelectionToKind(sidebar, channels, "category", 1);
}

export function activateSelectedEntry(sidebar: SidebarState, channels: DiscordChannel[]): SidebarEntry | null {
  const entry = getSelectedSidebarEntry(sidebar, channels);
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

  const entries = buildSidebarEntries(sidebar, channels, loadingFrameIndex);
  const listRows = Math.max(0, totalRows - 2);
  let scrollOffset = sidebar.scrollOffset;
  if (sidebar.selectedIndex < scrollOffset) {
    scrollOffset = sidebar.selectedIndex;
  } else if (sidebar.selectedIndex >= scrollOffset + listRows) {
    scrollOffset = sidebar.selectedIndex - listRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, entries.length - listRows)));
  sidebar.scrollOffset = scrollOffset;

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
  const labelWidth = Math.max(0, innerWidth - termWidth(prefix));
  const title = padRight(entry.label || "unnamed", labelWidth);
  const text = isActive ? `${theme.bold}${title}${theme.boldOff}` : title;

  return theme.reset + bg + fg + prefix + text
    + theme.reset + borderBg + borderFg + "│" + theme.reset;
}
