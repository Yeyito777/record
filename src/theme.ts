/**
 * Theme system for record.
 *
 * Mirrored after the Exocortex TUI theme setup, with whale as the default.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";

import { configDir } from "./config";
import { adaptAnsiTruecolor, detectTerminalColorLevel, hexToAnsiColor, rgbToAnsi } from "./terminalcolors";
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
  failure: string;
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
  messageDeleteFg: string;
  selectionBg: string;
  searchBg: string;
  searchFg: string;
  notificationBg: string;
  notificationFg: string;
  pingBg: string;
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
export const terminalColorLevel = detectTerminalColorLevel();

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

function adaptThemeForTerminal(base: Theme): Theme {
  const adapted = { ...base };
  for (const key of Object.keys(adapted) as Array<keyof Theme>) {
    const value = adapted[key];
    if (key === "name" || key === "cursorColor" || typeof value !== "string") continue;
    (adapted as Record<keyof Theme, string | undefined>)[key] = adaptAnsiTruecolor(value, terminalColorLevel);
  }
  return adapted;
}

export const theme: Theme = adaptThemeForTerminal(whale);

const envTheme = process.env.RECORD_THEME;
if (envTheme && envTheme in themes) {
  Object.assign(theme, adaptThemeForTerminal(themes[envTheme as ThemeName]));
} else {
  const persisted = loadPersistedThemeName();
  if (persisted) {
    Object.assign(theme, adaptThemeForTerminal(themes[persisted]));
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

const DM_AUTHOR_BASE_COLORS = [
  [255, 184, 108],
  [189, 147, 249],
  [80, 250, 123],
  [255, 121, 198],
  [139, 233, 253],
  [241, 250, 140],
  [166, 227, 161],
  [250, 179, 135],
] as const;

const DM_AUTHOR_TINTS = [
  -0.18,
  -0.15,
  -0.12,
  -0.09,
  -0.06,
  -0.03,
  0,
  0.03,
  0.06,
  0.09,
  0.12,
  0.15,
  0.18,
  0.21,
  0.24,
  0.27,
] as const;

export const DM_AUTHOR_COLOR_COUNT = DM_AUTHOR_BASE_COLORS.length * DM_AUTHOR_TINTS.length;

export function ansiTrueColor(color: number): string {
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  return rgbToAnsi(38, red, green, blue, terminalColorLevel);
}

export function dmAuthorColor(userId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index++) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  const baseColor = DM_AUTHOR_BASE_COLORS[hash % DM_AUTHOR_BASE_COLORS.length];
  const tint = DM_AUTHOR_TINTS[Math.floor(hash / DM_AUTHOR_BASE_COLORS.length) % DM_AUTHOR_TINTS.length];
  const [red, green, blue] = baseColor.map((channel) => tintChannel(channel, tint));
  return rgbToAnsi(38, red, green, blue, terminalColorLevel);
}

function tintChannel(channel: number, tint: number): number {
  if (tint < 0) {
    return Math.round(channel * (1 + tint));
  }
  return Math.round(channel + (255 - channel) * tint);
}

export function setTheme(name: ThemeName): string | null {
  Object.assign(theme, adaptThemeForTerminal(themes[name]));
  try {
    persistThemeName(name);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function hexToAnsi(hex: string): string {
  return hexToAnsiColor(38, hex, terminalColorLevel);
}

export function hexToAnsiBg(hex: string): string {
  return hexToAnsiColor(48, hex, terminalColorLevel);
}
