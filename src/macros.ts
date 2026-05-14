/**
 * Macro command definitions and expansion.
 *
 * Mirrored from the Exocortex TUI macro ergonomics: macros are inline
 * text-replacement shortcuts, not real slash commands. They can appear at the
 * start, middle, or after a newline in a message, autocomplete like commands,
 * and expand immediately before the message is sent.
 */

import type { CompletionItem } from "./commands";

interface MacroArg {
  name: string;
  desc: string;
  expansion: string;
  args?: MacroArg[];
}

interface MacroDef {
  name: string;
  desc: string;
  expansion: string;
  args?: MacroArg[];
}

const KAOMOJI = {
  generic: "(・∀・)",
  happy: "ヽ(o＾▽＾o)ノ",
  sad: "(╥﹏╥)",
  worried: "(´-﹏-；)",
  angry: "(╬ Ò﹏Ó)",
  flustered: "(⁄ ⁄>⁄ ▽ ⁄<⁄ ⁄)",
  embarassed: "(⁄ ⁄•⁄ω⁄•⁄ ⁄)",
  what: "(・・ ) ?",
  wave: "(｡･ω･)ﾉﾞ",
  sleepy: "(－ω－)",
} as const;

const MACROS: MacroDef[] = [
  {
    name: "/kao",
    desc: "Kaomoji",
    expansion: KAOMOJI.generic,
    args: [
      { name: "happy", desc: KAOMOJI.happy, expansion: KAOMOJI.happy },
      { name: "sad", desc: KAOMOJI.sad, expansion: KAOMOJI.sad },
      { name: "worried", desc: KAOMOJI.worried, expansion: KAOMOJI.worried },
      { name: "angry", desc: KAOMOJI.angry, expansion: KAOMOJI.angry },
      { name: "flustered", desc: KAOMOJI.flustered, expansion: KAOMOJI.flustered },
      { name: "embarassed", desc: KAOMOJI.embarassed, expansion: KAOMOJI.embarassed },
      { name: "what", desc: KAOMOJI.what, expansion: KAOMOJI.what },
      { name: "wave", desc: KAOMOJI.wave, expansion: KAOMOJI.wave },
      { name: "sleepy", desc: KAOMOJI.sleepy, expansion: KAOMOJI.sleepy },
    ],
  },
];

function flattenExpansions(prefix: string, node: { expansion: string; args?: MacroArg[] }): [string, string][] {
  const entries: [string, string][] = [[prefix, node.expansion]];
  for (const arg of node.args ?? []) {
    entries.push(...flattenExpansions(`${prefix} ${arg.name}`, arg));
  }
  return entries;
}

function flattenArgLists(prefix: string, node: { args?: MacroArg[] }): [string, CompletionItem[]][] {
  if (!node.args || node.args.length === 0) return [];
  const entries: [string, CompletionItem[]][] = [
    [prefix, node.args.map((arg) => ({ name: arg.name, desc: arg.desc }))],
  ];
  for (const arg of node.args) {
    entries.push(...flattenArgLists(`${prefix} ${arg.name}`, arg));
  }
  return entries;
}

const STATIC_MACRO_MAP: Record<string, string> = Object.fromEntries(
  MACROS.flatMap((macro) => flattenExpansions(macro.name, macro)),
);

const STATIC_MACRO_ARGS: Record<string, CompletionItem[]> = Object.fromEntries(
  MACROS.flatMap((macro) => flattenArgLists(macro.name, macro)),
);

/** Autocomplete entries for base macro names. */
export const MACRO_LIST: CompletionItem[] = MACROS.map((macro) => ({ name: macro.name, desc: macro.desc }));

/** Expansion text keyed by "/name" or "/name arg1 ...". */
export function getMacroMap(): Record<string, string> {
  return {
    ...STATIC_MACRO_MAP,
    "/kao embarrassed": KAOMOJI.embarassed,
  };
}

/** Sub-argument completions keyed by "/name" or "/name arg1 ...". */
export function getMacroArgs(): Record<string, CompletionItem[]> {
  return STATIC_MACRO_ARGS;
}

/**
 * Expand macro commands in message text.
 *
 * Captures a slash token plus following word arguments, then tries the longest
 * matching macro prefix. Unrecognized trailing words are preserved after the
 * expansion, matching Exocortex TUI behavior.
 */
export function expandMacros(text: string): string {
  const macroMap = getMacroMap();

  return text.replace(/(?<=^|\s)(\/[\w-]+(?:[ \t]+[\w-]+)*)/gm, (full) => {
    const words = full.split(/[ \t]+/);
    for (let len = words.length; len >= 1; len--) {
      const key = words.slice(0, len).join(" ");
      if (macroMap[key]) {
        const remainder = words.slice(len).join(" ");
        return remainder ? `${macroMap[key]} ${remainder}` : macroMap[key];
      }
    }
    return full;
  });
}
