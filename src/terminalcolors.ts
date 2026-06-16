/**
 * Terminal color capability detection and ANSI color downsampling.
 *
 * Record themes are authored as direct RGB colors, but macOS Terminal.app often
 * advertises only xterm-256color. In that case, emit xterm-256 colors instead
 * of truecolor escapes that can render incorrectly.
 */

const ESC = "\x1b[";

export type TerminalColorLevel = "truecolor" | "256" | "16";

export interface TerminalColorEnv {
  TERM?: string;
  COLORTERM?: string;
  TERM_PROGRAM?: string;
  RECORD_TUI_COLOR?: string;
  EXOCORTEX_TUI_COLOR?: string;
  FORCE_COLOR?: string;
  NO_COLOR?: string;
}

const XTERM_256_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const ANSI_16_RGB: Array<[number, number, number]> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function distanceSq(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

function nearestIndex(levels: readonly number[], value: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const dist = Math.abs(value - levels[i]);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

export function rgbToXterm256(rIn: number, gIn: number, bIn: number): number {
  const r = clampByte(rIn);
  const g = clampByte(gIn);
  const b = clampByte(bIn);

  const ri = nearestIndex(XTERM_256_LEVELS, r);
  const gi = nearestIndex(XTERM_256_LEVELS, g);
  const bi = nearestIndex(XTERM_256_LEVELS, b);
  const cubeCode = 16 + (36 * ri) + (6 * gi) + bi;
  const cubeR = XTERM_256_LEVELS[ri];
  const cubeG = XTERM_256_LEVELS[gi];
  const cubeB = XTERM_256_LEVELS[bi];
  const cubeDist = distanceSq(r, g, b, cubeR, cubeG, cubeB);

  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma > 12) return cubeCode;

  const avg = (r + g + b) / 3;
  const grayIndex = avg <= 8 ? 0 : avg >= 248 ? 23 : Math.round((avg - 8) / 10);
  const grayValue = 8 + (grayIndex * 10);
  const grayCode = 232 + grayIndex;
  const grayDist = distanceSq(r, g, b, grayValue, grayValue, grayValue);

  return grayDist < cubeDist ? grayCode : cubeCode;
}

export function xterm256ToRgb(codeIn: number): [number, number, number] | null {
  const code = Math.round(codeIn);
  if (code < 0 || code > 255) return null;
  if (code < 16) return ANSI_16_RGB[code];
  if (code >= 232) {
    const value = 8 + ((code - 232) * 10);
    return [value, value, value];
  }

  const n = code - 16;
  const ri = Math.floor(n / 36);
  const gi = Math.floor((n % 36) / 6);
  const bi = n % 6;
  return [XTERM_256_LEVELS[ri], XTERM_256_LEVELS[gi], XTERM_256_LEVELS[bi]];
}

export function rgbToAnsi16(rIn: number, gIn: number, bIn: number): number {
  const r = clampByte(rIn);
  const g = clampByte(gIn);
  const b = clampByte(bIn);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI_16_RGB.length; i++) {
    const [pr, pg, pb] = ANSI_16_RGB[i];
    const dist = distanceSq(r, g, b, pr, pg, pb);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function sgr16(kind: 38 | 48, index: number): string {
  if (kind === 38) return `${ESC}${index < 8 ? 30 + index : 90 + index - 8}m`;
  return `${ESC}${index < 8 ? 40 + index : 100 + index - 8}m`;
}

export function rgbToAnsi(kind: 38 | 48, r: number, g: number, b: number, level: TerminalColorLevel): string {
  if (level === "truecolor") return `${ESC}${kind};2;${clampByte(r)};${clampByte(g)};${clampByte(b)}m`;
  if (level === "256") return `${ESC}${kind};5;${rgbToXterm256(r, g, b)}m`;
  return sgr16(kind, rgbToAnsi16(r, g, b));
}

export function hexToRgb(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, "");
  const expanded = raw.length === 3 ? raw.split("").map((ch) => ch + ch).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return [255, 255, 255];
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16),
  ];
}

export function hexToAnsiColor(kind: 38 | 48, hex: string, level: TerminalColorLevel): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToAnsi(kind, r, g, b, level);
}

const TRUECOLOR_SGR_RE = /\x1b\[(38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/g;
const SGR_RE = /\x1b\[([0-9;]*)m/g;

function ansi16SgrToIndex(kind: 38 | 48, code: number): number | null {
  const normalBase = kind === 38 ? 30 : 40;
  const brightBase = kind === 38 ? 90 : 100;
  if (code >= normalBase && code <= normalBase + 7) return code - normalBase;
  if (code >= brightBase && code <= brightBase + 7) return 8 + code - brightBase;
  return null;
}

export function ansiColorToRgb(ansi: string, kind: 38 | 48): [number, number, number] | null {
  for (const match of ansi.matchAll(SGR_RE)) {
    const params = match[1].split(";").filter(Boolean).map(Number);
    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (code === kind && params[i + 1] === 2) {
        return [clampByte(params[i + 2]), clampByte(params[i + 3]), clampByte(params[i + 4])];
      }
      if (code === kind && params[i + 1] === 5) {
        return xterm256ToRgb(params[i + 2]);
      }
      const ansi16 = ansi16SgrToIndex(kind, code);
      if (ansi16 !== null) return ANSI_16_RGB[ansi16];
    }
  }
  return null;
}

export function adaptAnsiTruecolor(text: string, level: TerminalColorLevel): string {
  if (level === "truecolor" || !text.includes(";2;")) return text;
  return text.replace(TRUECOLOR_SGR_RE, (_match, kind: string, r: string, g: string, b: string) => (
    rgbToAnsi(Number(kind) as 38 | 48, Number(r), Number(g), Number(b), level)
  ));
}

function normalizeOverride(value: string | undefined): TerminalColorLevel | null {
  switch (value?.trim().toLowerCase()) {
    case "3":
    case "truecolor":
    case "24bit":
    case "24-bit":
    case "rgb":
      return "truecolor";
    case "2":
    case "256":
    case "256color":
    case "8bit":
    case "8-bit":
      return "256";
    case "1":
    case "16":
    case "ansi":
    case "basic":
      return "16";
    default:
      return null;
  }
}

export function detectTerminalColorLevel(env: TerminalColorEnv = process.env as unknown as TerminalColorEnv): TerminalColorLevel {
  const explicit = normalizeOverride(env.RECORD_TUI_COLOR ?? env.EXOCORTEX_TUI_COLOR);
  if (explicit) return explicit;

  const forced = normalizeOverride(env.FORCE_COLOR);
  if (forced) return forced;

  const term = (env.TERM ?? "").toLowerCase();
  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();

  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) return "truecolor";
  if (term.includes("direct") || term.includes("truecolor") || term.includes("24bit")) return "truecolor";
  if (/^(xterm-kitty|wezterm|foot|foot-extra|alacritty|rio|ghostty|st|st-.*)$/.test(term)) return "truecolor";
  if (["wezterm", "ghostty", "kitty", "iterm.app"].includes(termProgram)) return "truecolor";
  if (termProgram === "apple_terminal") return "256";
  if (term.includes("256color") || term.includes("256")) return "256";
  return "16";
}
