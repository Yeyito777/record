/**
 * Prompt syntax highlighting for slash commands.
 *
 * Adapted from the Exocortex TUI prompt highlighter.
 */

import { COMMAND_LIST, getCommandArgs } from "./commands";
import { MACRO_LIST, getMacroArgs } from "./macros";
import { promptMentionSpans } from "./mentions";
import type { AppState } from "./state";
import { theme } from "./theme";

interface Span {
  start: number;
  end: number;
}

const VALID_NAMES = new Set([
  ...COMMAND_LIST.map((command) => command.name),
  ...MACRO_LIST.map((macro) => macro.name),
  "/exit",
]);

const COMMAND_SPAN_RE = /(^|[ \t\n])(\/\S+(?:[ \t]+\S+)*)/gm;

function findCommandSpans(buffer: string, state: AppState): Span[] {
  const spans: Span[] = [];
  const validArgs = { ...getCommandArgs(state), ...getMacroArgs() };
  COMMAND_SPAN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = COMMAND_SPAN_RE.exec(buffer)) !== null) {
    const boundary = match[1];
    const full = match[2];
    const commandStart = match.index + boundary.length;

    const wordRe = /\S+/g;
    const wordPositions: Array<{ word: string; end: number }> = [];
    let wordMatch: RegExpExecArray | null;
    while ((wordMatch = wordRe.exec(full)) !== null) {
      wordPositions.push({ word: wordMatch[0], end: wordMatch.index + wordMatch[0].length });
    }
    if (wordPositions.length === 0) continue;

    const baseCommand = full.slice(0, wordPositions[0].end);
    if (!VALID_NAMES.has(baseCommand)) continue;

    let spanEnd = commandStart + wordPositions[0].end;
    let key = baseCommand;

    for (let i = 1; i < wordPositions.length; i++) {
      if (validArgs[key]?.some((arg) => arg.name === wordPositions[i].word)) {
        spanEnd = commandStart + wordPositions[i].end;
        key = `${key} ${wordPositions[i].word}`;
      } else {
        break;
      }
    }

    spans.push({ start: commandStart, end: spanEnd });
  }

  return spans;
}

export function highlightPromptViewport(
  visibleText: string,
  buffer: string,
  viewportStart: number,
  state: AppState,
): string {
  if (visibleText.length === 0) return visibleText;

  const viewportEnd = viewportStart + visibleText.length;
  const regions: Array<{ start: number; end: number; color: string; priority: number }> = [];

  for (const span of findCommandSpans(buffer, state)) {
    if (span.end <= viewportStart || span.start >= viewportEnd) continue;
    regions.push({
      start: Math.max(0, span.start - viewportStart),
      end: Math.min(visibleText.length, span.end - viewportStart),
      color: theme.command,
      priority: 2,
    });
  }

  for (const span of promptMentionSpans(state, buffer)) {
    if (span.end <= viewportStart || span.start >= viewportEnd) continue;
    regions.push({
      start: Math.max(0, span.start - viewportStart),
      end: Math.min(visibleText.length, span.end - viewportStart),
      color: span.color,
      priority: 1,
    });
  }

  const selected: Array<{ start: number; end: number; color: string }> = [];
  for (const region of regions.sort((left, right) => left.start - right.start || right.priority - left.priority)) {
    if (region.end <= region.start) continue;
    if (selected.some((existing) => region.start < existing.end && region.end > existing.start)) continue;
    selected.push(region);
  }
  selected.sort((left, right) => left.start - right.start);

  if (selected.length === 0) return `${theme.text}${visibleText}${theme.reset}`;

  let out = theme.text;
  let pos = 0;
  for (const region of selected) {
    if (region.start > pos) out += visibleText.slice(pos, region.start);
    out += region.color + visibleText.slice(region.start, region.end) + theme.text;
    pos = region.end;
  }
  if (pos < visibleText.length) out += visibleText.slice(pos);
  return out + theme.reset;
}
