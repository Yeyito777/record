/**
 * Command, macro, mention, and emoji autocomplete for the prompt line.
 *
 * Macro behavior is intentionally copied from Exocortex TUI: command-style
 * completion at the start of a line includes both real commands and macros,
 * while slash tokens mid-message complete only macros.
 */

import type { AppState } from "./state";
import { COMMAND_LIST, getCommandArgs, type CompletionItem } from "./commands";
import { emojiCompletions, emojiQueryAtCursor } from "./emojis";
import { MACRO_LIST, getMacroArgs } from "./macros";
import { loadedMentionCandidates, mentionCandidateMatches, mentionQueryAtCursor } from "./mentions";

export interface AutocompleteState {
  type: "command" | "macro" | "replace";
  selection: number;
  prefix: string;
  matches: CompletionItem[];
  /** Start offset for mid-message macro token completion. */
  tokenStart?: number;
  /** Replacement range for mentions and emoji. */
  replaceStart?: number;
  replaceEnd?: number;
}

function escapeRegex(text: string): string {
  return text.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function matchArgCompletion(raw: string, registry: Record<string, CompletionItem[]>): CompletionItem[] | null {
  const entries = Object.entries(registry).sort((a, b) => b[0].length - a[0].length);
  for (const [command, args] of entries) {
    const re = new RegExp(`^${escapeRegex(command)}\\s+(.*)$`, "i");
    const match = raw.match(re);
    if (match) return args.filter((arg) => arg.name.toLowerCase().startsWith(match[1].toLowerCase()));
  }
  return null;
}

function getCommandMatches(state: AppState, input: string): CompletionItem[] {
  const raw = input.trimStart();
  if (!raw.startsWith("/")) return [];

  const argMatch = matchArgCompletion(raw, getCommandArgs(state)) ?? matchArgCompletion(raw, getMacroArgs());
  if (argMatch) return argMatch;

  const prefix = raw.toLowerCase();
  return [...COMMAND_LIST, ...MACRO_LIST].filter((command) => command.name.startsWith(prefix));
}

function getMacroMatches(token: string): CompletionItem[] {
  const raw = token.trimStart();
  if (!raw.startsWith("/")) return [];

  const argMatch = matchArgCompletion(raw, getMacroArgs());
  if (argMatch) return argMatch;

  const prefix = raw.toLowerCase();
  return MACRO_LIST.filter((macro) => macro.name.startsWith(prefix));
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function tokenStart(input: string, pos: number): number {
  let start = pos;
  while (start > 0 && !isWhitespace(input[start - 1])) start--;
  return start;
}

function atWordBoundary(input: string, pos: number): boolean {
  return pos === 0 || isWhitespace(input[pos - 1]);
}

function extractSlashToken(input: string, cursor: number): { token: string; start: number } | null {
  const wordStart = tokenStart(input, cursor);
  const currentWord = input.slice(wordStart, cursor);

  if (currentWord.startsWith("/") && atWordBoundary(input, wordStart)) {
    return { token: currentWord, start: wordStart };
  }

  let scanPos = wordStart;
  while (scanPos > 0 && (input[scanPos - 1] === " " || input[scanPos - 1] === "\t")) {
    const prevStart = tokenStart(input, scanPos - 1);
    const prevWord = input.slice(prevStart, scanPos - 1);

    if (prevWord.startsWith("/") && atWordBoundary(input, prevStart)) {
      return { token: input.slice(prevStart, cursor), start: prevStart };
    }

    scanPos = prevStart;
  }

  return null;
}

function getMentionMatches(state: AppState, query: string): CompletionItem[] {
  return loadedMentionCandidates(state)
    .filter((candidate) => mentionCandidateMatches(candidate, query))
    .map((candidate) => ({
      name: `@${candidate.token}`,
      desc: candidate.kind === "user"
        ? (candidate.username && candidate.username !== candidate.displayName ? candidate.displayName : "user")
        : candidate.kind,
      color: candidate.color,
    }));
}

export function updateAutocomplete(state: AppState): void {
  const mentionQuery = mentionQueryAtCursor(state.editor.buffer, state.editor.cursor);
  if (mentionQuery) {
    const matches = getMentionMatches(state, mentionQuery.query);
    if (matches.length > 0) {
      state.autocomplete = {
        type: "replace",
        selection: -1,
        prefix: state.editor.buffer,
        matches,
        replaceStart: mentionQuery.start,
        replaceEnd: mentionQuery.end,
      };
      return;
    }
  }

  const emojiQuery = emojiQueryAtCursor(state.editor.buffer, state.editor.cursor);
  if (emojiQuery) {
    const matches = emojiCompletions(emojiQuery.query);
    if (matches.length > 0) {
      state.autocomplete = {
        type: "replace",
        selection: -1,
        prefix: state.editor.buffer,
        matches,
        replaceStart: emojiQuery.start,
        replaceEnd: emojiQuery.end,
      };
      return;
    }
  }

  const trimmed = state.editor.buffer.trimStart();
  if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
    const matches = getCommandMatches(state, state.editor.buffer);
    if (matches.length > 0) {
      state.autocomplete = {
        type: "command",
        selection: -1,
        prefix: state.editor.buffer,
        matches,
      };
      return;
    }
  }

  const slashToken = extractSlashToken(state.editor.buffer, state.editor.cursor);
  if (slashToken) {
    const matches = getMacroMatches(slashToken.token);
    if (matches.length > 0) {
      state.autocomplete = {
        type: "macro",
        selection: -1,
        prefix: slashToken.token,
        tokenStart: slashToken.start,
        matches,
      };
      return;
    }
  }

  state.autocomplete = null;
}

function fillAutocomplete(state: AppState, name: string): void {
  const autocomplete = state.autocomplete;
  if (!autocomplete) return;

  if (autocomplete.type === "replace" && autocomplete.replaceStart !== undefined && autocomplete.replaceEnd !== undefined) {
    state.editor.buffer = autocomplete.prefix.slice(0, autocomplete.replaceStart)
      + name
      + autocomplete.prefix.slice(autocomplete.replaceEnd);
    state.editor.cursor = autocomplete.replaceStart + name.length;
    return;
  }

  if (autocomplete.type === "macro" && autocomplete.tokenStart !== undefined) {
    const before = state.editor.buffer.slice(0, autocomplete.tokenStart);
    const after = state.editor.buffer.slice(state.editor.cursor);
    let fillText = name;
    const lastSpace = autocomplete.prefix.lastIndexOf(" ");
    if (lastSpace >= 0) {
      fillText = autocomplete.prefix.slice(0, lastSpace + 1) + name;
    }
    state.editor.buffer = before + fillText + after;
    state.editor.cursor = before.length + fillText.length;
    return;
  }

  if (!name.startsWith("/")) {
    const lastSpace = autocomplete.prefix.lastIndexOf(" ");
    if (lastSpace >= 0) {
      state.editor.buffer = autocomplete.prefix.slice(0, lastSpace + 1) + name;
    } else {
      state.editor.buffer = name;
    }
  } else {
    state.editor.buffer = name;
  }

  state.editor.cursor = state.editor.buffer.length;
}

export function cycleAutocomplete(state: AppState, direction: 1 | -1): void {
  const autocomplete = state.autocomplete;
  if (!autocomplete || autocomplete.matches.length === 0) return;

  if (direction === 1) {
    autocomplete.selection = autocomplete.selection < 0 ? 0 : (autocomplete.selection + 1) % autocomplete.matches.length;
  } else {
    autocomplete.selection = autocomplete.selection <= 0 ? autocomplete.matches.length - 1 : (autocomplete.selection - 1);
  }

  fillAutocomplete(state, autocomplete.matches[autocomplete.selection].name);
}

export function dismissAutocomplete(state: AppState): void {
  const autocomplete = state.autocomplete;
  if (!autocomplete) return;

  if (autocomplete.selection >= 0) {
    if (autocomplete.type === "macro" && autocomplete.tokenStart !== undefined) {
      const before = state.editor.buffer.slice(0, autocomplete.tokenStart);
      const after = state.editor.buffer.slice(state.editor.cursor);
      state.editor.buffer = before + autocomplete.prefix + after;
      state.editor.cursor = autocomplete.tokenStart + autocomplete.prefix.length;
    } else {
      state.editor.buffer = autocomplete.prefix;
      state.editor.cursor = state.editor.buffer.length;
    }
  }

  state.autocomplete = null;
}

export function acceptAutocomplete(state: AppState): void {
  state.autocomplete = null;
}
