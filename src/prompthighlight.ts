/**
 * Prompt syntax highlighting for slash commands.
 *
 * Adapted from the Exocortex TUI prompt highlighter.
 */

import { COMMAND_LIST, getCommandArgs } from "./commands";
import type { AppState } from "./state";
import { theme } from "./theme";

interface Span {
  start: number;
  end: number;
}

const VALID_NAMES = new Set([
  ...COMMAND_LIST.map((command) => command.name),
  "/exit",
]);

const COMMAND_SPAN_RE = /(^|[ \t\n])(\/\S+(?:[ \t]+\S+)*)/gm;

function findCommandSpans(buffer: string, state: AppState): Span[] {
  const spans: Span[] = [];
  const validArgs = getCommandArgs(state);
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
  const spans = findCommandSpans(buffer, state);
  if (spans.length === 0 || visibleText.length === 0) return visibleText;

  const viewportEnd = viewportStart + visibleText.length;
  const regions: Array<{ start: number; end: number }> = [];

  for (const span of spans) {
    if (span.end <= viewportStart || span.start >= viewportEnd) continue;
    regions.push({
      start: Math.max(0, span.start - viewportStart),
      end: Math.min(visibleText.length, span.end - viewportStart),
    });
  }

  if (regions.length === 0) return visibleText;

  let out = "";
  let pos = 0;
  for (const region of regions) {
    if (region.start > pos) out += visibleText.slice(pos, region.start);
    out += theme.command + visibleText.slice(region.start, region.end) + theme.reset;
    pos = region.end;
  }
  if (pos < visibleText.length) out += visibleText.slice(pos);
  return out;
}
