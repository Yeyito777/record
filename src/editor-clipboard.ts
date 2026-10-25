/**
 * Clipboard helpers for prompt editor yanks and puts.
 *
 * Copy is fire-and-forget. Paste is synchronous so a put stays one ordered
 * edit, but every clipboard command runs with a timeout so an unresponsive
 * selection owner cannot freeze the TUI. When no clipboard tool works (an SSH
 * session without DISPLAY, a missing tool, a failing copy) yanks and puts
 * fall back to an in-memory register, like Exocortex.
 */

import { decodeCustomEmojiMarkers, replaceCustomEmojiTokens } from "./customemoji";
import { sanitizePromptTextForInsertion } from "./prompttext";

interface ClipboardCommands {
  copy: string[];
  paste: string[];
  /** Lists the clipboard's types, so a put never reads an image as text. */
  targets?: string[];
}

type CommandLookup = (command: string) => string | null;

export interface TextClipboardSystem {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  which: CommandLookup;
  copy: (command: string[], text: string) => Promise<number>;
  paste: (command: string[]) => { output: string; exitCode: number };
}

/** Longest a put may wait on a clipboard tool before using the in-memory register. */
const PASTE_TIMEOUT_MS = 1500;
const TEXT_TARGETS = ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING", "TEXT"];

const decoder = new TextDecoder();

const defaultClipboardSystem: TextClipboardSystem = {
  platform: process.platform,
  env: process.env,
  which: (command) => Bun.which(command),
  copy: (command, text) => {
    const proc = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(text);
    proc.stdin.end();
    return proc.exited;
  },
  paste: (command) => {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore", timeout: PASTE_TIMEOUT_MS });
    return { output: decoder.decode(result.stdout), exitCode: result.exitCode ?? 1 };
  },
};

let clipboardSystem = defaultClipboardSystem;
let clipboardCommands: ClipboardCommands | null | undefined;
let inMemoryClipboard = "";
/** Text of the last linewise yank, while it is still what we last copied. */
let lastLinewiseYank: string | null = null;

/** Replace the system clipboard in tests (null restores the real one). */
export function setTextClipboardSystemForTest(overrides: Partial<TextClipboardSystem> | null): void {
  clipboardSystem = overrides ? { ...defaultClipboardSystem, ...overrides } : defaultClipboardSystem;
  clipboardCommands = undefined;
  inMemoryClipboard = "";
  lastLinewiseYank = null;
}

/**
 * Resolve the native clipboard commands for the current platform.
 *
 * macOS ships pbcopy/pbpaste as part of the OS. Linux prefers Wayland, then
 * xclip and xsel, which need an X display.
 */
export function resolveClipboardCommands(
  platform: NodeJS.Platform = process.platform,
  waylandDisplay: string | undefined = process.env.WAYLAND_DISPLAY,
  which: CommandLookup = Bun.which,
  display: string | undefined = process.env.DISPLAY,
): ClipboardCommands | null {
  if (platform === "darwin" && which("pbcopy") && which("pbpaste")) {
    return {
      copy: ["pbcopy"],
      paste: ["pbpaste"],
    };
  }

  if (waylandDisplay && which("wl-copy") && which("wl-paste")) {
    return {
      copy: ["wl-copy"],
      paste: ["wl-paste", "--no-newline", "--type"],
      targets: ["wl-paste", "--list-types"],
    };
  }
  if (!display) return null;
  if (which("xclip")) {
    return {
      copy: ["xclip", "-selection", "clipboard"],
      paste: ["xclip", "-selection", "clipboard", "-o", "-t"],
      targets: ["xclip", "-selection", "clipboard", "-o", "-t", "TARGETS"],
    };
  }
  if (which("xsel")) {
    return {
      copy: ["xsel", "--clipboard", "--input"],
      paste: ["xsel", "--clipboard", "--output"],
    };
  }

  return null;
}

function detectClipboardCommands(): ClipboardCommands | null {
  if (clipboardCommands !== undefined) return clipboardCommands;
  clipboardCommands = resolveClipboardCommands(
    clipboardSystem.platform,
    clipboardSystem.env.WAYLAND_DISPLAY,
    clipboardSystem.which,
    clipboardSystem.env.DISPLAY,
  );
  return clipboardCommands;
}

/** A clipboard tool failed: use the in-memory register from now on. */
function disableClipboardCommands(): void {
  clipboardCommands = null;
}

function pickTextTarget(availableTargets: string): string | null {
  const available = new Set(availableTargets.split(/\r?\n/).map((target) => target.trim()).filter(Boolean));
  return TEXT_TARGETS.find((target) => available.has(target)) ?? null;
}

export function clipboardTextForCopy(text: string): string {
  return decodeCustomEmojiMarkers(text);
}

/** Clipboard text as prompt text: custom emoji markers, no terminal controls, CRs or hard tabs. */
export function editorTextFromClipboard(text: string): string {
  return replaceCustomEmojiTokens(sanitizePromptTextForInsertion(text));
}

/**
 * Copy text to the system clipboard. `linewise` marks a whole-line yank
 * (yy, yj, Vy) so p/P put it back as lines.
 */
export function copyToClipboard(text: string, linewise = false): void {
  inMemoryClipboard = text;
  lastLinewiseYank = linewise ? text : null;
  const commands = detectClipboardCommands();
  if (!commands) return;

  try {
    clipboardSystem.copy(commands.copy, clipboardTextForCopy(text))
      .then((exitCode) => { if (exitCode !== 0) disableClipboardCommands(); })
      .catch(() => disableClipboardCommands());
  } catch {
    disableClipboardCommands();
  }
}

/**
 * Whether pasted text is still our last linewise yank. The clipboard only
 * holds text, so this is how p/P know to put lines (wl-paste --no-newline
 * drops the trailing newline, so accept the text without it too).
 */
export function isLinewiseClipboardText(text: string): boolean {
  return lastLinewiseYank !== null && (text === lastLinewiseYank || text + "\n" === lastLinewiseYank);
}

function readSystemClipboard(commands: ClipboardCommands): string | null {
  let paste = commands.paste;
  if (commands.targets) {
    const targets = clipboardSystem.paste(commands.targets);
    if (targets.exitCode !== 0) return null;
    // An image or file list on the clipboard is not text to put.
    const target = pickTextTarget(targets.output);
    if (!target) return null;
    paste = [...paste, target];
  }
  const { output, exitCode } = clipboardSystem.paste(paste);
  return exitCode === 0 ? output : null;
}

/** Text for p/P: the system clipboard, else the last yank. */
export function pasteFromClipboard(): string {
  const commands = detectClipboardCommands();
  let text: string | null = null;
  if (commands) {
    try {
      text = readSystemClipboard(commands);
    } catch {
      disableClipboardCommands();
    }
  }
  return editorTextFromClipboard(text ?? inMemoryClipboard);
}
