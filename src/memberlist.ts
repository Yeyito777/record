/**
 * Right-hand server member list panel.
 */

import { DIRECT_MESSAGES_GUILD_ID, type DiscordGuildMember, type DiscordRole } from "./discord";
import { loadingLabel } from "./loading";
import { padRight, sliceByWidth, termWidth, truncate, truncateToWidth } from "./textwidth";
import { ansiTrueColor, theme } from "./theme";
import { resolvePrimaryRoleColor } from "./timeline";
import {
  scrollByAmountWithCursorInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
} from "./vimscroll";

export const MEMBER_LIST_WIDTH = 28;

type MemberListRow =
  | { type: "member"; member: DiscordGuildMember; selected: boolean }
  | { type: "message"; text: string; tone: "muted" | "error" };

export interface MemberListState {
  open: boolean;
  guildId: string | null;
  channelId: string | null;
  viewerId: string | null;
  members: DiscordGuildMember[];
  loading: boolean;
  error: string | null;
  requestId: number;
  selectedIndex: number;
  scrollOffset: number;
  cache: Map<string, DiscordGuildMember[]>;
}

export function createMemberListState(): MemberListState {
  return {
    open: false,
    guildId: null,
    channelId: null,
    viewerId: null,
    members: [],
    loading: false,
    error: null,
    requestId: 0,
    selectedIndex: 0,
    scrollOffset: 0,
    cache: new Map(),
  };
}

export function clearMemberListData(memberList: MemberListState): void {
  memberList.guildId = null;
  memberList.channelId = null;
  memberList.viewerId = null;
  memberList.members = [];
  memberList.loading = false;
  memberList.error = null;
  memberList.requestId += 1;
  memberList.selectedIndex = 0;
  memberList.scrollOffset = 0;
  memberList.cache.clear();
}

export function setMemberListLoading(memberList: MemberListState, guildId: string, channelId: string): void {
  memberList.guildId = guildId;
  memberList.channelId = channelId;
  memberList.viewerId = null;
  memberList.members = [];
  memberList.loading = true;
  memberList.error = null;
  memberList.scrollOffset = 0;
  memberList.selectedIndex = 0;
}

export function setMemberListMessage(
  memberList: MemberListState,
  guildId: string | null,
  channelId: string | null,
  message: string,
): void {
  memberList.guildId = guildId;
  memberList.channelId = channelId;
  memberList.viewerId = null;
  memberList.members = [];
  memberList.loading = false;
  memberList.error = message;
  memberList.selectedIndex = 0;
  memberList.scrollOffset = 0;
}

export function setMemberListMembers(
  memberList: MemberListState,
  guildId: string,
  channelId: string,
  members: DiscordGuildMember[],
  viewerId: string | null = null,
): void {
  memberList.guildId = guildId;
  memberList.channelId = channelId;
  memberList.viewerId = viewerId;
  memberList.members = members;
  memberList.loading = false;
  memberList.error = null;

  const viewerIndex = viewerId ? members.findIndex((member) => member.id === viewerId) : -1;
  memberList.selectedIndex = viewerIndex >= 0 ? viewerIndex : 0;
  memberList.scrollOffset = 0;
}

export function getCachedMemberList(memberList: MemberListState, guildId: string, channelId: string): DiscordGuildMember[] | null {
  return memberList.cache.get(memberListCacheKey(guildId, channelId)) ?? null;
}

export function cacheMemberList(
  memberList: MemberListState,
  guildId: string,
  channelId: string,
  members: DiscordGuildMember[],
): void {
  memberList.cache.set(memberListCacheKey(guildId, channelId), members);
}

export function moveMemberListSelection(memberList: MemberListState, delta: number): void {
  if (memberList.members.length === 0) return;
  memberList.selectedIndex = Math.max(0, Math.min(memberList.selectedIndex + delta, memberList.members.length - 1));
}

export function scrollMemberListSelection(
  memberList: MemberListState,
  dir: number,
  amount: number,
  totalRows: number,
  mode: "cursor" | "page" = "cursor",
): void {
  if (memberList.members.length === 0) return;
  const viewportRows = memberListViewportRows(totalRows);
  const next = mode === "page"
    ? scrollPageWithCursorInViewport({ totalLines: memberList.members.length, viewportHeight: viewportRows, viewStart: memberList.scrollOffset, cursorRow: memberList.selectedIndex }, dir, amount)
    : scrollByAmountWithCursorInViewport({ totalLines: memberList.members.length, viewportHeight: viewportRows, viewStart: memberList.scrollOffset, cursorRow: memberList.selectedIndex }, dir, amount);
  memberList.selectedIndex = Math.max(0, Math.min(next.cursorRow, memberList.members.length - 1));
  memberList.scrollOffset = next.viewStart;
}

export function scrollMemberListSelectionLine(memberList: MemberListState, dir: number, totalRows: number): void {
  if (memberList.members.length === 0) return;
  const next = scrollLineWithStickyCursorInViewport({
    totalLines: memberList.members.length,
    viewportHeight: memberListViewportRows(totalRows),
    viewStart: memberList.scrollOffset,
    cursorRow: memberList.selectedIndex,
  }, dir);
  memberList.selectedIndex = Math.max(0, Math.min(next.cursorRow, memberList.members.length - 1));
  memberList.scrollOffset = next.viewStart;
}

export function jumpMemberListSelectionToVisibleEdge(
  memberList: MemberListState,
  totalRows: number,
  edge: "top" | "bottom",
): void {
  if (memberList.members.length === 0) return;

  const viewportRows = memberListViewportRows(totalRows);
  if (viewportRows <= 0) return;

  const maxScroll = Math.max(0, memberList.members.length - viewportRows);
  memberList.scrollOffset = Math.max(0, Math.min(memberList.scrollOffset, maxScroll));
  memberList.selectedIndex = Math.max(0, Math.min(memberList.selectedIndex, memberList.members.length - 1));

  const visibleStart = memberList.scrollOffset;
  const visibleEnd = Math.min(visibleStart + viewportRows - 1, memberList.members.length - 1);
  let targetIndex = edge === "top" ? visibleStart : visibleEnd;

  if (targetIndex === memberList.selectedIndex) {
    const halfPage = Math.floor(viewportRows / 2);
    memberList.scrollOffset = edge === "top"
      ? Math.max(0, memberList.scrollOffset - halfPage)
      : Math.min(maxScroll, memberList.scrollOffset + halfPage);
    const nextVisibleStart = memberList.scrollOffset;
    const nextVisibleEnd = Math.min(nextVisibleStart + viewportRows - 1, memberList.members.length - 1);
    targetIndex = edge === "top" ? nextVisibleStart : nextVisibleEnd;
  }

  memberList.selectedIndex = targetIndex;
}

export function jumpMemberListSelectionToEdge(
  memberList: MemberListState,
  totalRows: number,
  edge: "top" | "bottom",
): void {
  if (memberList.members.length === 0) return;

  const viewportRows = memberListViewportRows(totalRows);
  const maxScroll = Math.max(0, memberList.members.length - viewportRows);

  if (edge === "top") {
    memberList.selectedIndex = 0;
    memberList.scrollOffset = 0;
  } else {
    memberList.selectedIndex = memberList.members.length - 1;
    memberList.scrollOffset = maxScroll;
  }
}

export function jumpMemberListSelectionToVisibleMiddle(memberList: MemberListState, totalRows: number): void {
  if (memberList.members.length === 0) return;

  const viewportRows = memberListViewportRows(totalRows);
  if (viewportRows <= 0) return;

  const maxScroll = Math.max(0, memberList.members.length - viewportRows);
  memberList.scrollOffset = Math.max(0, Math.min(memberList.scrollOffset, maxScroll));
  memberList.selectedIndex = Math.max(0, Math.min(memberList.selectedIndex, memberList.members.length - 1));

  const visibleStart = memberList.scrollOffset;
  const visibleEnd = Math.min(visibleStart + viewportRows - 1, memberList.members.length - 1);
  memberList.selectedIndex = Math.floor((visibleStart + visibleEnd) / 2);
}

function memberListCacheKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

function memberListViewportRows(totalRows: number): number {
  return Math.max(0, totalRows - 2);
}

function memberLabel(member: DiscordGuildMember): string {
  return member.bot ? `${member.displayName} [bot]` : member.displayName;
}

function wrapMessageText(text: string, width: number): string[] {
  if (width <= 0) return [];

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (!current) {
        current = wrapFirstWord(word, width, lines);
        continue;
      }

      const candidate = `${current} ${word}`;
      if (termWidth(candidate) <= width) {
        current = candidate;
        continue;
      }

      lines.push(current);
      current = wrapFirstWord(word, width, lines);
    }

    if (current) lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function wrapFirstWord(word: string, width: number, lines: string[]): string {
  let remaining = word;
  while (termWidth(remaining) > width) {
    const [taken, rest] = sliceByWidth(remaining, width);
    if (!taken) {
      lines.push(remaining[0] ?? "");
      remaining = remaining.slice(1);
      continue;
    }
    lines.push(taken);
    remaining = rest;
  }
  return remaining;
}

function buildMemberListRows(memberList: MemberListState, innerWidth: number, loadingFrameIndex: number): MemberListRow[] {
  const messageRows = (text: string, tone: "muted" | "error"): MemberListRow[] => (
    wrapMessageText(text, innerWidth).map((line) => ({ type: "message", text: line, tone }))
  );

  if (!memberList.guildId || !memberList.channelId) {
    return messageRows("No members.", "muted");
  }

  if (memberList.loading) {
    return messageRows(loadingLabel("Loading…", loadingFrameIndex), "muted");
  }

  if (memberList.error) {
    return messageRows(memberList.error, "error");
  }

  if (memberList.members.length > 0) {
    return memberList.members.map((member, index) => ({
      type: "member",
      member,
      selected: index === memberList.selectedIndex,
    }));
  }

  return messageRows("No members.", "muted");
}

function messageToneColor(tone: "muted" | "error"): string {
  return tone === "error" ? theme.error : theme.muted;
}

function memberRoleColor(
  guildId: string | null,
  member: DiscordGuildMember,
  rolesByGuildId: Record<string, DiscordRole[]>,
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>>,
): string | null {
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return null;
  const roleIds = member.roleIds ?? memberRoleIdsByGuildId[guildId]?.[member.id] ?? [];
  const color = resolvePrimaryRoleColor(rolesByGuildId[guildId] ?? [], roleIds);
  return color ? ansiTrueColor(color) : null;
}

export function renderMemberList(
  memberList: MemberListState,
  totalRows: number,
  loadingFrameIndex = 0,
  focused = false,
  rolesByGuildId: Record<string, DiscordRole[]> = {},
  memberRoleIdsByGuildId: Record<string, Record<string, string[]>> = {},
): string[] {
  if (!memberList.open) return [];

  const rows: string[] = [];
  const innerWidth = MEMBER_LIST_WIDTH - 1;
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;
  const borderBg = theme.appBg ?? "";
  const title = memberList.members.length > 0 && !memberList.loading
    ? ` Members (${memberList.members.length})`
    : " Members";

  rows.push(
    borderBg + borderFg + "│" + theme.reset
    + theme.sidebarBg + theme.text + theme.bold + padRight(truncateToWidth(title, innerWidth), innerWidth)
    + theme.boldOff + theme.reset,
  );

  rows.push(
    borderBg + borderFg + "├" + theme.reset
    + theme.sidebarBg + borderFg + "─".repeat(innerWidth) + theme.reset,
  );

  const displayRows = buildMemberListRows(memberList, innerWidth, loadingFrameIndex);
  const listRows = memberListViewportRows(totalRows);
  const selectedRow = Math.max(0, Math.min(memberList.selectedIndex, Math.max(0, displayRows.length - 1)));

  let scrollOffset = memberList.scrollOffset;
  if (selectedRow < scrollOffset) {
    scrollOffset = selectedRow;
  } else if (selectedRow >= scrollOffset + listRows) {
    scrollOffset = selectedRow - listRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, displayRows.length - listRows)));
  memberList.scrollOffset = scrollOffset;

  for (let i = 0; i < listRows; i++) {
    const row = displayRows[scrollOffset + i];
    if (!row) {
      rows.push(borderBg + borderFg + "│" + theme.reset + theme.sidebarBg + " ".repeat(innerWidth) + theme.reset);
      continue;
    }

    if (row.type === "message") {
      rows.push(
        borderBg + borderFg + "│" + theme.reset
        + theme.sidebarBg + messageToneColor(row.tone) + padRight(truncateToWidth(` ${row.text}`, innerWidth), innerWidth)
        + theme.reset,
      );
      continue;
    }

    const isViewerInDm = memberList.guildId === DIRECT_MESSAGES_GUILD_ID && row.member.id === memberList.viewerId;
    const bg = row.selected ? theme.sidebarSelBg : theme.sidebarBg;
    const roleColor = memberRoleColor(memberList.guildId, row.member, rolesByGuildId, memberRoleIdsByGuildId);
    const fg = isViewerInDm ? theme.accent : roleColor ?? (row.selected ? theme.text : theme.muted);
    const prefix = row.selected ? "▸ " : "  ";
    const maxLabelWidth = Math.max(0, innerWidth - 2);
    const label = truncate(memberLabel(row.member), maxLabelWidth);
    const padded = padRight(label, maxLabelWidth);
    const title = row.selected ? `${theme.bold}${padded}${theme.boldOff}` : padded;

    rows.push(
      borderBg + borderFg + "│" + theme.reset
      + bg + fg + prefix + title + theme.reset,
    );
  }

  return rows;
}
