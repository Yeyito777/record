/**
 * Prompt separator chrome.
 *
 * Keeps transient prompt context (reply/edit targets) attached to the prompt's
 * top separator instead of consuming a status-line block below the input.
 */

import type { AppState } from "./state";
import { theme } from "./theme";
import { termWidth, truncate } from "./textwidth";

const MAX_REPLY_SUMMARY_WIDTH = 40;
const MAX_EDIT_SUMMARY_WIDTH = 40;
const CONTEXT_LEADING_DASHES = 4;

interface PromptContextSegment {
  text: string;
  width: number;
}

function replySegment(state: AppState): PromptContextSegment | null {
  const target = state.replyTarget;
  if (!target) return null;

  const icon = "↩";
  const label = " Replying: ";
  const ping = target.mention ? "PING " : "";
  const name = `${target.authorDisplayName}: `;
  const summary = truncate(target.summary, MAX_REPLY_SUMMARY_WIDTH);
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
