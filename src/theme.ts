/**
 * Theme system for record.
 *
 * Mirrored after the Exocortex TUI theme setup, with whale as the default.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";

import { configDir } from "./config";
import { cerberus } from "./themes/cerberus";
import { whale } from "./themes/whale";

export interface Theme {
  name: string;

  reset: string;

  bold: string;
  dim: string;
  italic: string;

  accent: string;
  text: string;
  muted: string;
  error: string;
  warning: string;
  success: string;
  prompt: string;
  tool: string;
  command: string;

  vimNormal: string;
  vimInsert: string;
  vimVisual: string;

  topbarBg: string;
  userBg: string;
  sidebarBg: string;
  sidebarSelBg: string;
  cursorBg: string;
  historyLineBg: string;
  selectionBg: string;
  searchBg: string;
  searchFg: string;
  appBg?: string;
  cursorColor?: string;

  borderFocused: string;
  borderUnfocused: string;

  boldOff: string;
  italicOff: string;
}

export const themes = {
  whale,
  cerberus,
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof themes;
export const THEME_NAMES = Object.keys(themes) as ThemeName[];

function themeConfigPath(): string {
  return `${configDir()}/theme.json`;
}

function loadPersistedThemeName(): ThemeName | null {
  try {
    const data = JSON.parse(readFileSync(themeConfigPath(), "utf8")) as { theme?: string };
    if (data.theme && data.theme in themes) {
      return data.theme as ThemeName;
    }
  } catch {
    // missing or malformed theme config: ignore
  }
  return null;
}

function persistThemeName(name: ThemeName): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(themeConfigPath(), `${JSON.stringify({ theme: name }, null, 2)}\n`, { mode: 0o600 });
}

export const theme: Theme = { ...whale };

const envTheme = process.env.RECORD_THEME;
if (envTheme && envTheme in themes) {
  Object.assign(theme, themes[envTheme as ThemeName]);
} else {
  const persisted = loadPersistedThemeName();
  if (persisted) {
    Object.assign(theme, themes[persisted]);
  }
}

export type NoticeTone = "muted" | "success" | "warning" | "error";

export function toneColor(tone: NoticeTone): string {
  switch (tone) {
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "error":
      return theme.error;
    case "muted":
    default:
      return theme.muted;
  }
}

const DM_AUTHOR_COLORS = [
  "\x1b[38;2;255;184;108m",
  "\x1b[38;2;189;147;249m",
  "\x1b[38;2;80;250;123m",
  "\x1b[38;2;255;121;198m",
  "\x1b[38;2;139;233;253m",
  "\x1b[38;2;241;250;140m",
  "\x1b[38;2;166;227;161m",
  "\x1b[38;2;250;179;135m",
] as const;

export function dmAuthorColor(userId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index++) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return DM_AUTHOR_COLORS[hash % DM_AUTHOR_COLORS.length];
}

export function setTheme(name: ThemeName): string | null {
  Object.assign(theme, themes[name]);
  try {
    persistThemeName(name);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
