/**
 * Ephemeral typing indicator state.
 */

import { loadingFrame } from "./loading";

export interface TypingUser {
  id: string;
  displayName: string;
  expiresAt: number;
}

export interface TypingState {
  byChannelId: Record<string, TypingUser[]>;
}

const TYPING_TTL_MS = 9_000;

export function createTypingState(): TypingState {
  return { byChannelId: {} };
}

export function typingFrame(frameIndex: number): string {
  return loadingFrame(frameIndex);
}

export function recordTypingStart(
  typing: TypingState,
  channelId: string,
  user: { id: string; displayName: string },
  nowMs = Date.now(),
): void {
  const expiresAt = nowMs + TYPING_TTL_MS;
  const users = pruneTypingUsers(typing.byChannelId[channelId] ?? [], nowMs);
  const existing = users.find((entry) => entry.id === user.id);
  if (existing) {
    existing.displayName = user.displayName;
    existing.expiresAt = expiresAt;
  } else {
    users.push({ id: user.id, displayName: user.displayName, expiresAt });
  }
  typing.byChannelId[channelId] = users;
}

export function clearTypingUser(typing: TypingState, channelId: string, userId: string): void {
  const users = (typing.byChannelId[channelId] ?? []).filter((entry) => entry.id !== userId);
  if (users.length > 0) {
    typing.byChannelId[channelId] = users;
  } else {
    delete typing.byChannelId[channelId];
  }
}

export function getTypingUsers(typing: TypingState, channelId: string | null, viewerId: string | null, nowMs = Date.now()): TypingUser[] {
  if (!channelId) return [];
  const users = pruneTypingUsers(typing.byChannelId[channelId] ?? [], nowMs)
    .filter((entry) => entry.id !== viewerId);
  if (users.length > 0) {
    typing.byChannelId[channelId] = users;
  } else {
    delete typing.byChannelId[channelId];
  }
  return users;
}

export function pruneTypingState(typing: TypingState, nowMs = Date.now()): void {
  for (const [channelId, users] of Object.entries(typing.byChannelId)) {
    const pruned = pruneTypingUsers(users, nowMs);
    if (pruned.length > 0) {
      typing.byChannelId[channelId] = pruned;
    } else {
      delete typing.byChannelId[channelId];
    }
  }
}

export function channelsWithTyping(typing: TypingState, viewerId: string | null, nowMs = Date.now()): Set<string> {
  pruneTypingState(typing, nowMs);
  const channels = new Set<string>();
  for (const [channelId, users] of Object.entries(typing.byChannelId)) {
    if (users.some((entry) => entry.id !== viewerId)) {
      channels.add(channelId);
    }
  }
  return channels;
}

export function formatTypingUsers(users: TypingUser[]): string {
  if (users.length === 0) return "";
  if (users.length === 1) return `${users[0]!.displayName} is typing…`;
  if (users.length === 2) return `${users[0]!.displayName} and ${users[1]!.displayName} are typing…`;
  return "several people are typing…";
}

function pruneTypingUsers(users: TypingUser[], nowMs: number): TypingUser[] {
  return users.filter((entry) => entry.expiresAt > nowMs);
}
