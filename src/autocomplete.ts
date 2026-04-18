/**
 * Command autocomplete for the prompt line.
 *
 * Based closely on the Exocortex TUI autocomplete flow, but narrowed to
 * record's slash commands.
 */

import type { AppState } from "./state";
import { COMMAND_LIST, getCommandArgs, type CompletionItem } from "./commands";

export interface AutocompleteState {
  selection: number;
  prefix: string;
  matches: CompletionItem[];
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

function getCommandMatches(input: string): CompletionItem[] {
  const raw = input.trimStart();
  if (!raw.startsWith("/")) return [];

  const argMatch = matchArgCompletion(raw, getCommandArgs());
  if (argMatch) return argMatch;

  const prefix = raw.toLowerCase();
  return COMMAND_LIST.filter((command) => command.name.startsWith(prefix));
}

export function updateAutocomplete(state: AppState): void {
  const trimmed = state.editor.buffer.trimStart();
  if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
    const matches = getCommandMatches(state.editor.buffer);
    if (matches.length > 0) {
      state.autocomplete = {
        selection: -1,
        prefix: state.editor.buffer,
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
    autocomplete.selection = autocomplete.selection <= 0 ? autocomplete.matches.length - 1 : autocomplete.selection - 1;
  }

  fillAutocomplete(state, autocomplete.matches[autocomplete.selection].name);
}

export function dismissAutocomplete(state: AppState): void {
  if (!state.autocomplete) return;

  if (state.autocomplete.selection >= 0) {
    state.editor.buffer = state.autocomplete.prefix;
    state.editor.cursor = state.editor.buffer.length;
  }

  state.autocomplete = null;
}
