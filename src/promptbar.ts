/**
 * Prompt separator chrome.
 *
 * Keeps transient prompt context (reply/edit targets) attached to the prompt's
 * top separator instead of consuming a status-line block below the input.
 */

import { DIRECT_MESSAGES_GUILD_ID, type DiscordGuildMember } from "./discord";
import type { AppState, ReplyTarget } from "./state";
import { ansiTrueColor, dmAuthorColor, theme } from "./theme";
import { termWidth, truncate } from "./textwidth";
import { resolvePrimaryRoleColor } from "./timeline";

const MAX_REPLY_SUMMARY_WIDTH = 40;
const MAX_EDIT_SUMMARY_WIDTH = 40;
const CONTEXT_LEADING_DASHES = 4;

interface PromptContextSegment {
  text: string;
  width: number;
}

function replyGuildId(state: AppState, target: ReplyTarget): string | null {
  return target.guildId
    ?? state.channelList.activeChannel?.guildId
    ?? state.channelList.guildId
    ?? null;
}

function replyMentionColor(state: AppState, target: ReplyTarget, user: DiscordGuildMember): string {
  const guildId = replyGuildId(state, target);
  if (guildId === DIRECT_MESSAGES_GUILD_ID) {
    return user.id === state.auth.user?.id ? theme.accent : dmAuthorColor(user.id);
  }
  if (!guildId) return "";

  const roleIds = user.roleIds ?? state.memberRoleIdsByGuildId[guildId]?.[user.id] ?? [];
  const color = resolvePrimaryRoleColor(state.guildRolesByGuildId[guildId] ?? [], roleIds);
  return color ? ansiTrueColor(color) : "";
}

function renderReplySummary(state: AppState, target: ReplyTarget): string {
  const guildId = replyGuildId(state, target);
  const rolesById = new Map((guildId ? state.guildRolesByGuildId[guildId] ?? [] : []).map((role) => [role.id, role]));
  const usersById = new Map((target.mentionUsers ?? []).map((user) => [user.id, user]));

  const withBroadcastMentions = target.summary.replace(/(^|[^\w@])@(everyone|here)\b/g, (_raw, prefix: string, mention: string) => (
    `${prefix}${theme.accent}@${mention}${theme.text}`
  ));
  const withRoleMentions = withBroadcastMentions.replace(/<@&([^>]+)>/g, (raw, roleId: string) => {
    const role = rolesById.get(roleId);
    if (!role) return raw;
    const color = role.color > 0 ? ansiTrueColor(role.color) : theme.accent;
    return `${color}@${role.name?.trim() || role.id}${theme.text}`;
  });

  return withRoleMentions.replace(/<@!?(\d+)>/g, (raw, userId: string) => {
    const user = usersById.get(userId);
    if (!user) return raw;
    const color = replyMentionColor(state, target, user);
    const label = `@${user.displayName}`;
    return color ? `${color}${label}${theme.text}` : label;
  });
}

function replySegment(state: AppState): PromptContextSegment | null {
  const target = state.replyTarget;
  if (!target) return null;

  const icon = "↩";
  const label = " Replying: ";
  const ping = target.mention ? "PING " : "";
  const name = `${target.authorDisplayName}: `;
  const summary = truncate(renderReplySummary(state, target), MAX_REPLY_SUMMARY_WIDTH);
  const nameColor = target.authorColor || theme.accent;
  const text = `${theme.muted}${icon}${label}${target.mention ? `${theme.accent}${ping}` : ""}${nameColor}${name}${theme.text}${summary}${theme.reset}`;

  return { text, width: termWidth(text) };
}

function editSegment(state: AppState): PromptContextSegment | null {
  const target = state.editTarget;
  if (!target) return null;

  const icon = "✎";
  const label = " Editing: ";
  const name = `${target.authorDisplayName}: `;
  const summary = truncate(target.summary, MAX_EDIT_SUMMARY_WIDTH);
  const nameColor = target.authorColor || theme.accent;
  const text = `${theme.muted}${icon}${label}${nameColor}${name}${theme.text}${summary}${theme.reset}`;

  return { text, width: termWidth(text) };
}

function activePromptContextSegment(state: AppState): PromptContextSegment | null {
  // Editing is mutually exclusive in normal use and has historically had the
  // higher transient-block priority, so prefer it if both fields are present.
  return editSegment(state) ?? replySegment(state);
}

export function renderPromptSeparator(state: AppState, width: number, separatorColor: string): string {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return "";

  const segment = activePromptContextSegment(state);
  if (!segment) {
    return `${separatorColor}${"─".repeat(safeWidth)}${theme.reset}`;
  }

  const leftWidth = Math.min(CONTEXT_LEADING_DASHES, Math.max(0, safeWidth - 1));
  const available = safeWidth - leftWidth;
  const reserveRightDash = available > 1 ? 1 : 0;
  const segmentWidth = Math.min(segment.width, Math.max(0, available - reserveRightDash));

  if (segmentWidth <= 0) {
    return `${separatorColor}${"─".repeat(safeWidth)}${theme.reset}`;
  }

  const segmentText = segmentWidth < segment.width ? truncate(segment.text, segmentWidth) : segment.text;
  const rightWidth = Math.max(0, safeWidth - leftWidth - termWidth(segmentText));

  return `${separatorColor}${"─".repeat(leftWidth)}${segmentText}${separatorColor}${"─".repeat(rightWidth)}${theme.reset}`;
}
