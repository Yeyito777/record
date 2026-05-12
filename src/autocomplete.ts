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
import { readdirSync } from "fs";
import { basename, dirname, resolve } from "path";
import { homedir } from "os";

export interface AutocompleteState {
  type: "command" | "macro" | "path" | "replace";
  selection: number;
  prefix: string;
  matches: CompletionItem[];
  /** Start offset for mid-message macro and path token completion. */
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
  // Path popup is dismissed on any typing — user must press Tab again.
  if (state.autocomplete?.type === "path") {
    state.autocomplete = null;
  }

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

  if ((autocomplete.type === "macro" || autocomplete.type === "path") && autocomplete.tokenStart !== undefined) {
    const before = state.editor.buffer.slice(0, autocomplete.tokenStart);
    const after = state.editor.buffer.slice(state.editor.cursor);
    let fillText = name;
    const lastSpace = autocomplete.type === "macro" ? autocomplete.prefix.lastIndexOf(" ") : -1;
    if (autocomplete.type === "macro" && lastSpace >= 0) {
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
    } else if (autocomplete.type === "path") {
      // Keep the currently completed/common-prefix path text. That mirrors the
      // Exocortex TUI behavior and makes Escape a useful way to close the popup
      // without undoing path progress.
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

/**
 * Try to tab-complete a path token at the cursor.
 *
 * Copied from Exocortex TUI's prompt autocomplete behavior: path completion is
 * not live while typing; pressing Tab completes path-looking tokens (`~/`,
 * `./`, `../`, `/...`). A single match fills directly. Multiple matches fill
 * the first match and show the autocomplete popup for further Tab cycling.
 */
export function tryPathComplete(state: AppState): boolean {
  const extracted = extractPathToken(state.editor.buffer, state.editor.cursor);
  if (!extracted) return false;

  const { token, start } = extracted;
  const fsMatches = getFilesystemMatches(token);

  // For /-prefixed tokens, also include macro matches, preserving Exocortex's
  // behavior when Tab is used on a slash-looking token.
  const macroMatches = token.startsWith("/") ? getMacroMatches(token) : [];
  const matches = [...fsMatches, ...macroMatches];
  if (matches.length === 0) return false;

  const before = state.editor.buffer.slice(0, start);
  const after = state.editor.buffer.slice(state.editor.cursor);

  if (matches.length === 1) {
    state.editor.buffer = before + matches[0].name + after;
    state.editor.cursor = before.length + matches[0].name.length;
    state.autocomplete = null;
    return true;
  }

  state.editor.buffer = before + matches[0].name + after;
  state.editor.cursor = before.length + matches[0].name.length;
  state.autocomplete = {
    type: "path",
    selection: 0,
    prefix: before + token + after,
    tokenStart: start,
    matches,
  };
  return true;
}

function extractPathToken(input: string, cursor: number): { token: string; start: number } | null {
  const start = tokenStart(input, cursor);
  const token = input.slice(start, cursor);
  if (token.length === 0) return null;

  if (
    token.startsWith("~/")
    || token.startsWith("./")
    || token.startsWith("../")
    || token === "~"
    || (token.startsWith("/") && token.length > 1)
  ) {
    return { token, start };
  }

  return null;
}

function getFilesystemMatches(pathToken: string): CompletionItem[] {
  if (pathToken === "~") {
    return [{ name: "~/", desc: "dir" }];
  }

  const home = homedir();
  let expanded = pathToken;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = home + expanded.slice(1);
  }

  let dir: string;
  let prefix: string;
  if (expanded.endsWith("/")) {
    dir = resolve(expanded);
    prefix = "";
  } else {
    dir = dirname(resolve(expanded));
    prefix = basename(expanded);
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const filtered = entries
      .filter((entry) => entry.name.startsWith(prefix) && (prefix.startsWith(".") || !entry.name.startsWith(".")))
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name);
      });

    const tokenDir = pathToken.endsWith("/")
      ? pathToken
      : pathToken.slice(0, pathToken.length - prefix.length);

    return filtered.map((entry) => {
      const isDir = entry.isDirectory();
      return { name: tokenDir + entry.name + (isDir ? "/" : ""), desc: isDir ? "dir" : "file" };
    });
  } catch {
    return [];
  }
}
