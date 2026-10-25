/**
 * Prompt syntax highlighting for slash commands.
 *
 * Adapted from the Exocortex TUI prompt highlighter.
 */

import { COMMAND_LIST, getCommandArgs } from "./commands";
import { MACRO_LIST, getMacroArgs } from "./macros";
import { promptMentionSpans } from "./mentions";
import { getServerCommandPathLength } from "./servercommands";
import type { AppState } from "./state";
import { findSlashShorthand } from "./slashsearch";
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
    let spanEnd: number;
    if (VALID_NAMES.has(baseCommand)) {
      spanEnd = commandStart + wordPositions[0].end;
      let key = baseCommand;

      for (let i = 1; i < wordPositions.length; i++) {
        if (validArgs[key]?.some((arg) => arg.name === wordPositions[i].word)) {
          spanEnd = commandStart + wordPositions[i].end;
          key = `${key} ${wordPositions[i].word}`;
        } else {
          break;
        }
      }
    } else {
      const pathLength = getServerCommandPathLength(state, wordPositions.map(({ word }) => word));
      if (pathLength === 0) continue;
      spanEnd = commandStart + wordPositions[pathLength - 1].end;
    }

    spans.push({ start: commandStart, end: spanEnd });
  }

  return spans;
}

export interface PromptHighlightRegion {
  start: number;
  end: number;
  color: string;
}

/**
 * Highlighted regions of the whole prompt buffer: valid slash commands, then
 * resolvable mentions, never overlapping. Compute once per frame and share
 * across the visible rows; it scans the whole buffer.
 */
export function promptHighlightRegions(buffer: string, state: AppState): PromptHighlightRegion[] {
  const regions: Array<PromptHighlightRegion & { priority: number }> = [];
  if (buffer.includes("/")) {
    const spans = findCommandSpans(buffer, state);
    // A shorthand Enter would resolve ("/stat idle") is sendable, so it highlights too.
    const shorthand = findSlashShorthand(state, buffer);
    if (shorthand) {
      const span = spans.find((candidate) => candidate.start === shorthand.start);
      if (span) span.end = Math.max(span.end, shorthand.end);
      else spans.push({ start: shorthand.start, end: shorthand.end });
    }
    for (const span of spans) regions.push({ ...span, color: theme.command, priority: 2 });
  }
  if (buffer.includes("@")) {
    for (const span of promptMentionSpans(state, buffer)) regions.push({ ...span, priority: 1 });
  }

  const selected: PromptHighlightRegion[] = [];
  let lastEnd = -1;
  for (const region of regions.sort((left, right) => left.start - right.start || right.priority - left.priority)) {
    if (region.end <= region.start || region.start < lastEnd) continue;
    selected.push({ start: region.start, end: region.end, color: region.color });
    lastEnd = region.end;
  }
  return selected;
}

export function highlightPromptViewport(
  visibleText: string,
  buffer: string,
  viewportStart: number,
  state: AppState,
  regions: readonly PromptHighlightRegion[] = promptHighlightRegions(buffer, state),
): string {
  if (visibleText.length === 0) return visibleText;

  const viewportEnd = viewportStart + visibleText.length;
  let out = theme.text;
  let pos = 0;
  for (const region of regions) {
    if (region.end <= viewportStart) continue;
    if (region.start >= viewportEnd) break;
    const start = Math.max(0, region.start - viewportStart);
    const end = Math.min(visibleText.length, region.end - viewportStart);
    if (start > pos) out += visibleText.slice(pos, start);
    out += region.color + visibleText.slice(start, end) + theme.text;
    pos = end;
  }
  if (pos < visibleText.length) out += visibleText.slice(pos);
  return out + theme.reset;
}
