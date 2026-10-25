/**
 * Slash command search shared by the autocomplete popup, prompt highlighting,
 * and submission. Ported from the Exocortex TUI (tui/src/slashsearch.ts).
 *
 * Words are case-insensitive exact substrings matched anywhere in a command or
 * argument name, and later words search nested arguments, so "/stat idle"
 * finds "/status idle" and "/noise on" finds "/noise-suppression on".
 * Submission expands such shorthands to the first ranked completion, the
 * popup's first row (resolveSlashShorthands). App commands (/@app …) keep
 * their own completion in servercommands.ts and are never rewritten here.
 */

import type { AppState } from "./state";
import { COMMAND_LIST, getCommandArgs, type CompletionItem } from "./commands";
import { MACRO_LIST, getMacroArgs } from "./macros";

// ── Types ───────────────────────────────────────────────────────────

/** Half-open character range into a completion's display name. */
export interface MatchRange {
  start: number;
  end: number;
}

/** A ranked slash completion; `matchRanges` mark the matched text in `name`. */
export interface SlashCompletion extends CompletionItem {
  matchRanges?: readonly MatchRange[];
  /**
   * Spellings of each path segment from the first `exact` one on; submission
   * expands to this completion only when every one was typed as a whole word.
   */
  exactForms?: readonly (readonly string[])[];
}

/** A typed shorthand that submission expands, e.g. "/model opus". */
export interface SlashShorthand {
  start: number;
  end: number;
  replacement: string;
}

type ArgRegistry = Record<string, CompletionItem[]>;

/** Nested argument completions available below a slash root, keyed by "/root arg …". */
type ArgRegistryFor = (rootName: string) => ArgRegistry;

interface SlashQuery {
  /** Lowercased whitespace-separated words. */
  words: string[];
  /** The query ends in whitespace, so its final word must be followed by a space. */
  trailingSpace: boolean;
}

interface PathMatch {
  /** Sum of word match qualities; lower is better. */
  score: number;
  /** Matched word ranges in the space-joined segment text. */
  ranges: MatchRange[];
}

interface RankedCompletion {
  completion: SlashCompletion;
  depth: number;
  score: number;
}

// ── Query parsing ───────────────────────────────────────────────────

export function completionInsertText(item: CompletionItem): string {
  return item.insertText ?? item.name;
}

function hasArgumentPrefix(raw: string): boolean {
  return /\s/.test(raw);
}

function slashBase(raw: string): string {
  return raw.split(/\s+/, 1)[0] ?? raw;
}

function parseSlashQuery(text: string): SlashQuery {
  return {
    words: text.toLowerCase().split(/\s+/).filter(Boolean),
    trailingSpace: /\s$/.test(text),
  };
}

// ── Path matching ───────────────────────────────────────────────────

/** Lowercased strings a segment can match: its name, insert text, and aliases. */
function segmentForms(item: CompletionItem, isRoot: boolean): string[] {
  // Root names match without their slash so "/del" can find "/model".
  const normalize = (form: string) => (isRoot ? form.slice(1) : form).toLowerCase();
  if (!item.insertText && !item.aliases?.length) return [normalize(item.name)];
  return [item.name, ...(item.insertText ? [item.insertText] : []), ...(item.aliases ?? [])].map(normalize);
}

/** 0 = the whole segment, 1 = starts the segment, 2 = starts after punctuation or a space, 3 = mid-word. */
function wordMatchQuality(text: string, at: number, end: number, segmentStart: number, segmentEnd: number): number {
  if (at === segmentStart) return end === segmentEnd ? 0 : 1;
  return /[\p{L}\p{N}]/u.test(text[at - 1]) ? 3 : 2;
}

/**
 * Match query words against a completion path (lowercased segments).
 *
 * Each word is an exact substring. A later word either continues the previous
 * one after a single space (multi-word names such as conversation titles) or
 * starts in a later segment, so "opus" can skip the provider segment and land
 * in "claude-opus-5-5". The final word must land in the final segment, or with
 * a trailing space be followed by a space that leads into it.
 */
function matchCompletionPath(
  segments: readonly string[],
  query: SlashQuery,
  firstWordSegment?: number,
): PathMatch | null {
  const { words, trailingSpace } = query;
  if (words.length === 0) return null;

  const text = segments.join(" ");
  const starts: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    starts.push(offset);
    offset += segment.length + 1;
  }
  const segmentAt = (index: number): number => {
    let segment = 0;
    while (segment + 1 < starts.length && starts[segment + 1] <= index) segment++;
    return segment;
  };
  const lastSegment = segments.length - 1;
  const ranges: MatchRange[] = [];

  const search = (wordIndex: number, prevEnd: number, prevSegment: number): number | null => {
    const word = words[wordIndex];
    for (let at = text.indexOf(word, prevEnd); at >= 0; at = text.indexOf(word, at + 1)) {
      const segment = segmentAt(at);
      if (wordIndex === 0) {
        if (firstWordSegment !== undefined && segment !== firstWordSegment) continue;
      } else if (segment <= prevSegment && !(at === prevEnd + 1 && text[prevEnd] === " ")) {
        continue;
      }

      const end = at + word.length;
      const quality = wordMatchQuality(text, at, end, starts[segment], starts[segment] + segments[segment].length);

      if (wordIndex === words.length - 1) {
        const landsInLast = trailingSpace
          ? text[end] === " " && end + 1 < text.length && segmentAt(end + 1) === lastSegment
          : segment === lastSegment;
        if (!landsInLast) continue;
        ranges[wordIndex] = { start: at, end };
        return quality;
      }

      const rest = search(wordIndex + 1, end, segment);
      if (rest !== null) {
        ranges[wordIndex] = { start: at, end };
        return quality + rest;
      }
    }
    return null;
  };

  const score = search(0, 0, 0);
  return score === null ? null : { score, ranges };
}

/** Best match across the final segment's name, insert text, and aliases; ranges always come from the name. */
function matchPath(
  path: readonly CompletionItem[],
  query: SlashQuery,
  includesRoot: boolean,
): PathMatch | null {
  const lastWord = query.words[query.words.length - 1];
  const lastForms = segmentForms(path[path.length - 1], includesRoot && path.length === 1);
  // Cheap reject: without a trailing space the final word must sit inside the final segment.
  if (!query.trailingSpace && !lastForms.some(form => form.includes(lastWord))) return null;
  const parents = path.slice(0, -1).map((item, i) => segmentForms(item, includesRoot && i === 0)[0]);

  let best: PathMatch | null = null;
  let nameRanges: MatchRange[] = [];
  for (let i = 0; i < lastForms.length; i++) {
    if (!query.trailingSpace && !lastForms[i].includes(lastWord)) continue;
    const match = matchCompletionPath([...parents, lastForms[i]], query, includesRoot ? 0 : undefined);
    if (!match) continue;
    if (i === 0) nameRanges = match.ranges;
    if (!best || match.score < best.score) best = match;
  }
  return best && { score: best.score, ranges: nameRanges };
}

// ── Ranked search ───────────────────────────────────────────────────

/** Depth-first walk of every completion path below `key`. */
function* completionPaths(
  registry: ArgRegistry,
  key: string,
  parents: readonly CompletionItem[],
): Generator<CompletionItem[]> {
  for (const item of registry[key] ?? []) {
    // Argument names are single words; a "<placeholder>" or multi-word hint is not a path.
    if (/\s/.test(item.name)) continue;
    const path = [...parents, item];
    yield path;
    yield* completionPaths(registry, `${key} ${item.name}`, path);
  }
}

/** One popup row for a path; the insert text always spells out the full slash input. */
function pathCompletion(
  path: readonly CompletionItem[],
  typedPrefix = "",
  textRanges: readonly MatchRange[] = [],
  belowExact = false,
): SlashCompletion {
  const last = path[path.length - 1];
  const name = path.map(item => item.name).join(" ");
  // Root segments match without their slash; skip ranges if lowercasing changed lengths.
  const offset = name.startsWith("/") ? 1 : 0;
  const matchRanges = textRanges.length > 0 && name.toLowerCase().length === name.length
    ? textRanges.map(range => ({ start: range.start + offset, end: range.end + offset }))
    : [];
  const highlight = matchRanges.length > 0 ? { matchRanges } : {};
  const firstExact = belowExact ? 0 : path.findIndex(item => item.exact);
  const exact = firstExact === -1 ? {} : {
    exactForms: path.slice(firstExact).map(item =>
      [item.name, ...(item.insertText ? [item.insertText] : []), ...(item.aliases ?? [])].map(form => form.toLowerCase())),
  };

  if (path.length === 1 && !typedPrefix) return { ...last, ...highlight, ...exact };
  return {
    name,
    desc: last.desc,
    insertText: typedPrefix + path.map(completionInsertText).join(" "),
    ...highlight,
    ...exact,
  };
}

/** Whether submission may expand `typed` into `completion`: its destructive segments are typed out. */
function typedOut(completion: SlashCompletion, typed: string): boolean {
  if (!completion.exactForms) return true;
  const words = new Set(typed.toLowerCase().split(/\s+/).filter(Boolean));
  return completion.exactForms.every(forms => forms.some(form => words.has(form)));
}

/** Shallow paths first, then stronger matches; ties keep registry order. */
function rankPaths(
  paths: Iterable<readonly CompletionItem[]>,
  query: SlashQuery,
  includesRoot: boolean,
  typedPrefix?: string,
  belowExact = false,
): RankedCompletion[] {
  const ranked: RankedCompletion[] = [];
  for (const path of paths) {
    const match = matchPath(path, query, includesRoot);
    if (match) {
      ranked.push({ completion: pathCompletion(path, typedPrefix, match.ranges, belowExact), depth: path.length, score: match.score });
    }
  }
  return ranked.sort((a, b) => a.depth - b.depth || a.score - b.score);
}

/** Whether a spelled-out key such as "/chrono cancel" passes through a destructive argument. */
function keyBelowExact(registry: ArgRegistry, key: string): boolean {
  const words = key.split(" ");
  for (let i = 1; i < words.length; i++) {
    const parent = words.slice(0, i).join(" ");
    if (registry[parent]?.some(item => item.exact && item.name === words[i])) return true;
  }
  return false;
}

/**
 * Search below the deepest registry key the input spells out exactly, e.g.
 * "/model " or "/model openai ". Returns null when no key is spelled out.
 */
function searchAnchoredArgs(raw: string, registry: ArgRegistry): RankedCompletion[] | null {
  const keys = Object.keys(registry).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (raw.slice(0, key.length).toLowerCase() !== key.toLowerCase() || !/\s/.test(raw[key.length] ?? "")) continue;
    const rest = raw.slice(key.length).trimStart();
    const typedPrefix = raw.slice(0, raw.length - rest.length);
    const query = parseSlashQuery(rest);
    const belowExact = keyBelowExact(registry, key);
    if (query.words.length === 0) {
      return (registry[key] ?? []).map(item => ({ completion: pathCompletion([item], typedPrefix, [], belowExact), depth: 1, score: 0 }));
    }
    return rankPaths(completionPaths(registry, key, []), query, false, typedPrefix, belowExact);
  }
  return null;
}

/**
 * Search slash roots by substring. The first word must match the root name;
 * any further words search that root's nested arguments.
 */
function searchRoots(raw: string, roots: readonly CompletionItem[], argsFor: ArgRegistryFor): SlashCompletion[] {
  const body = raw.slice(1);
  if (body === "") return [...roots];
  if (/^\s/.test(body)) return [];

  const query = parseSlashQuery(body);
  const [rootWord] = query.words;
  const searchArgs = query.words.length > 1 || query.trailingSpace;
  const paths: CompletionItem[][] = [];
  for (const root of roots) {
    if (!segmentForms(root, true)[0].includes(rootWord)) continue;
    paths.push([root]);
    if (searchArgs) paths.push(...completionPaths(argsFor(root.name), root.name, [root]));
  }
  return rankPaths(paths, query, true).map(ranked => ranked.completion);
}

/** A fully typed command path anchors the search; otherwise roots are searched by substring. */
function searchSlashCompletions(raw: string, roots: readonly CompletionItem[], argsFor: ArgRegistryFor): SlashCompletion[] {
  if (!raw.startsWith("/")) return [];
  if (hasArgumentPrefix(raw)) {
    const anchored = searchAnchoredArgs(raw, argsFor(slashBase(raw)));
    if (anchored) return anchored.map(ranked => ranked.completion);
  }
  return searchRoots(raw, roots, argsFor);
}

/** Macro arguments merged with Record's command arguments, built at most once per search. */
function slashArgRegistry(state: AppState): ArgRegistryFor {
  let registry: ArgRegistry | undefined;
  return () => registry ??= { ...getMacroArgs(), ...getCommandArgs(state) };
}

// ── Popup completions ───────────────────────────────────────────────

/** Completions for a single-line input starting with "/": commands and macros in one list. */
export function commandCompletions(state: AppState, input: string): SlashCompletion[] {
  return searchSlashCompletions(input.trimStart(), [...COMMAND_LIST, ...MACRO_LIST], slashArgRegistry(state));
}

/** Completions for a slash token mid-message: only macros are valid there. */
export function macroCompletions(token: string): SlashCompletion[] {
  return searchSlashCompletions(token.trimStart(), MACRO_LIST, () => getMacroArgs());
}

// ── Shorthand resolution ────────────────────────────────────────────

/**
 * A single-line prompt starting with "/" that submission would send as the
 * popup's first option for the same text, e.g. "/stat idle" → "/status idle".
 * Input that matches nothing (a thread name after /thread, an emoji after
 * /react, a status quote) is left alone, as are app commands and destructive
 * arguments that were not typed out.
 */
export function findSlashShorthand(state: AppState, text: string): SlashShorthand | null {
  const start = text.length - text.trimStart().length;
  const line = text.slice(start).trimEnd();
  if (!line.startsWith("/") || line.startsWith("/@") || line.includes("\n")) return null;
  // A lone one-letter word ("/s", "/j" tone tags) is a message, not a command guess.
  if (/^\/\S$/.test(line)) return null;
  const [best] = commandCompletions(state, line);
  if (!best || !typedOut(best, line)) return null;
  const replacement = completionInsertText(best);
  if (replacement === line) return null;
  return { start, end: start + line.length, replacement };
}

/** Expand a slash shorthand in submitted text, e.g. "/stat idle" → "/status idle". */
export function resolveSlashShorthands(state: AppState, text: string): string {
  const shorthand = findSlashShorthand(state, text);
  return shorthand ? text.slice(0, shorthand.start) + shorthand.replacement + text.slice(shorthand.end) : text;
}
