/**
 * Prompt mention helpers: loaded-user autocomplete, coloring, and send-time conversion.
 */

import { DIRECT_MESSAGES_GUILD_ID, type DiscordGuildMember, type DiscordMessage, type DiscordRole } from "./discord";
import type { AppState } from "./state";
import { ansiTrueColor, dmAuthorColor, theme } from "./theme";
import { resolvePrimaryRoleColor } from "./timeline";

export type MentionCandidateKind = "user" | "broadcast" | "role";

export interface MentionCandidate {
  id: string;
  username: string;
  displayName: string;
  roleIds?: string[];
  token: string;
  color: string;
  kind: MentionCandidateKind;
  rank: number;
}

export interface PromptMentionSpan {
  start: number;
  end: number;
  color: string;
}

export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

const MENTION_BOUNDARY_RE = /(^|[\s([{])@([A-Za-z0-9._-]*)$/;
const MENTION_TOKEN_RE = /(^|[\s([{])@([A-Za-z0-9._-]+)/g;
const BROADCAST_MENTION_TOKENS = new Set(["everyone", "here"]);

function activeGuildId(state: AppState): string | null {
  return state.channelList.activeChannel?.guildId ?? state.channelList.guildId ?? null;
}

function validMentionToken(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function compactMentionKey(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9._-]/g, "");
}

function preferredToken(member: DiscordGuildMember): string {
  if (validMentionToken(member.displayName)) return member.displayName;
  if (validMentionToken(member.username)) return member.username;
  const compact = compactMentionKey(member.displayName || member.username);
  return compact || member.id;
}

function mentionAliases(candidate: Pick<MentionCandidate, "username" | "displayName" | "token">): string[] {
  return [...new Set([
    candidate.token,
    candidate.username,
    candidate.displayName,
    compactMentionKey(candidate.displayName),
  ].map(compactMentionKey).filter(Boolean))];
}

function preferredRoleToken(role: DiscordRole): string {
  const name = role.name ?? role.id;
  if (validMentionToken(name)) return name;
  const compact = compactMentionKey(name);
  return compact || role.id;
}

function roleDisplayName(role: DiscordRole): string {
  return role.name?.trim() || role.id;
}

function roleColor(role: DiscordRole): string {
  return role.color > 0 ? ansiTrueColor(role.color) : theme.accent;
}

function roleIsMentionable(role: DiscordRole, guildId: string): boolean {
  return role.id !== guildId && Boolean(role.name?.trim());
}

function memberHasBetterName(next: DiscordGuildMember, existing: MentionCandidate): boolean {
  if (/^\d{15,25}$/.test(existing.displayName) && !/^\d{15,25}$/.test(next.displayName)) return true;
  if (existing.displayName === existing.username && next.displayName !== next.username) return true;
  return false;
}

function colorForMember(state: AppState, member: DiscordGuildMember): string {
  const guildId = activeGuildId(state);
  if (guildId === DIRECT_MESSAGES_GUILD_ID) {
    return member.id === state.auth.user?.id ? theme.accent : dmAuthorColor(member.id);
  }

  if (guildId) {
    const roleIds = member.roleIds ?? state.memberRoleIdsByGuildId[guildId]?.[member.id] ?? [];
    const color = resolvePrimaryRoleColor(state.guildRolesByGuildId[guildId] ?? [], roleIds);
    if (color) return ansiTrueColor(color);
  }

  return theme.accent;
}

function addCandidate(state: AppState, byId: Map<string, MentionCandidate>, member: DiscordGuildMember | null | undefined): void {
  if (!member || member.id === state.auth.user?.id) return;
  const existing = byId.get(member.id);
  if (existing) {
    if (member.roleIds && member.roleIds.length > 0 && (!existing.roleIds || existing.roleIds.length === 0)) {
      existing.roleIds = member.roleIds;
      existing.color = colorForMember(state, member);
    }
    if (memberHasBetterName(member, existing)) {
      existing.username = member.username;
      existing.displayName = member.displayName;
      existing.token = preferredToken(member);
    }
    return;
  }

  byId.set(member.id, {
    id: member.id,
    username: member.username,
    displayName: member.displayName,
    roleIds: member.roleIds,
    token: preferredToken(member),
    color: colorForMember(state, member),
    kind: "user",
    rank: 0,
  });
}

function nonUserMentionCandidates(state: AppState): MentionCandidate[] {
  const guildId = activeGuildId(state);
  if (!guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return [];

  const broadcast: MentionCandidate[] = ["here", "everyone"].map((token) => ({
    id: token,
    username: token,
    displayName: token,
    token,
    color: theme.accent,
    kind: "broadcast" as const,
    rank: 1,
  }));

  const roles = (state.guildRolesByGuildId[guildId] ?? [])
    .filter((role) => roleIsMentionable(role, guildId))
    .map((role) => ({
      id: role.id,
      username: roleDisplayName(role),
      displayName: roleDisplayName(role),
      token: preferredRoleToken(role),
      color: roleColor(role),
      kind: "role" as const,
      rank: 2,
    }));

  return [...broadcast, ...roles];
}

function addMessageUsers(state: AppState, byId: Map<string, MentionCandidate>, message: DiscordMessage): void {
  addCandidate(state, byId, {
    id: message.author.id,
    username: message.author.username,
    displayName: message.author.displayName,
    bot: message.author.bot,
    roleIds: message.author.roleIds,
  });
  for (const mention of message.mentionUsers ?? []) addCandidate(state, byId, mention);
}

export function loadedMentionCandidates(state: AppState): MentionCandidate[] {
  const byId = new Map<string, MentionCandidate>();
  const guildId = activeGuildId(state);
  const channelId = state.channelList.activeChannelId ?? state.timeline.channelId;

  for (const recipient of state.channelList.activeChannel?.recipients ?? []) addCandidate(state, byId, recipient);

  if (guildId === DIRECT_MESSAGES_GUILD_ID) {
    if (state.memberList.guildId === guildId && state.memberList.channelId === channelId) {
      for (const member of state.memberList.members) addCandidate(state, byId, member);
    }
  } else if (!guildId || state.memberList.guildId === guildId) {
    for (const member of state.memberList.members) addCandidate(state, byId, member);
  }

  for (const [key, members] of state.memberList.cache.entries()) {
    if (guildId === DIRECT_MESSAGES_GUILD_ID) {
      if (!channelId || key !== `${DIRECT_MESSAGES_GUILD_ID}:${channelId}`) continue;
    } else if (guildId && !key.startsWith(`${guildId}:`)) {
      continue;
    }
    for (const member of members) addCandidate(state, byId, member);
  }

  if (state.timeline.channelId === channelId) {
    for (const message of state.timeline.messages) addMessageUsers(state, byId, message);
  }

  const activeCached = channelId ? state.messageCacheByChannelId[channelId]?.messages ?? [] : [];
  for (const message of activeCached) addMessageUsers(state, byId, message);

  if (guildId && guildId !== DIRECT_MESSAGES_GUILD_ID) {
    for (const entry of Object.values(state.messageCacheByChannelId)) {
      for (const message of entry.messages) {
        if (message.guildId === guildId) addMessageUsers(state, byId, message);
      }
    }
  }

  return [...byId.values(), ...nonUserMentionCandidates(state)]
    .sort((left, right) => left.rank - right.rank || left.token.localeCompare(right.token, undefined, { sensitivity: "base" }));
}

export function mentionQueryAtCursor(buffer: string, cursor: number): MentionQuery | null {
  const clampedCursor = Math.max(0, Math.min(cursor, buffer.length));
  const beforeCursor = buffer.slice(0, clampedCursor);
  const match = beforeCursor.match(MENTION_BOUNDARY_RE);
  if (!match) return null;
  const boundary = match[1] ?? "";
  const query = match[2] ?? "";
  const start = clampedCursor - query.length - 1;
  return { start, end: clampedCursor, query: boundary.endsWith("@") ? "" : query };
}

export function mentionCandidateMatches(candidate: MentionCandidate, query: string): boolean {
  const key = compactMentionKey(query);
  if (!key) return true;
  return mentionAliases(candidate).some((alias) => alias.startsWith(key));
}

export function mentionCandidateForToken(state: AppState, token: string): MentionCandidate | null {
  const key = compactMentionKey(token);
  if (!key) return null;
  return loadedMentionCandidates(state).find((candidate) => mentionAliases(candidate).some((alias) => alias === key)) ?? null;
}

export function promptMentionSpans(state: AppState, buffer: string): PromptMentionSpan[] {
  const spans: PromptMentionSpan[] = [];
  MENTION_TOKEN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_TOKEN_RE.exec(buffer)) !== null) {
    const boundary = match[1] ?? "";
    const token = match[2] ?? "";
    const start = match.index + boundary.length;
    const candidate = mentionCandidateForToken(state, token);
    if (!candidate) continue;
    spans.push({ start, end: start + token.length + 1, color: candidate.color });
  }

  return spans;
}

export function resolvePromptMentionsForSend(state: AppState, content: string): string {
  return content.replace(MENTION_TOKEN_RE, (raw, boundary: string, token: string) => {
    const candidate = mentionCandidateForToken(state, token);
    if (!candidate) return raw;
    if (candidate.kind === "broadcast") return `${boundary}@${candidate.token}`;
    if (candidate.kind === "role") return `${boundary}<@&${candidate.id}>`;
    return `${boundary}<@${candidate.id}>`;
  });
}

export function promptMentionUsers(state: AppState, content: string): DiscordGuildMember[] {
  const byId = new Map<string, DiscordGuildMember>();
  MENTION_TOKEN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_TOKEN_RE.exec(content)) !== null) {
    const token = match[2] ?? "";
    const candidate = mentionCandidateForToken(state, token);
    if (!candidate || candidate.kind !== "user") continue;
    byId.set(candidate.id, {
      id: candidate.id,
      username: candidate.username,
      displayName: candidate.displayName,
      bot: false,
      roleIds: candidate.roleIds,
    });
  }

  return [...byId.values()];
}
