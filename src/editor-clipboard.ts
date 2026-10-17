/**
 * Clipboard helpers for prompt editor yanks and puts.
 */

import { decodeCustomEmojiMarkers, replaceCustomEmojiTokens } from "./customemoji";

interface ClipboardCommands {
  copy: string[];
  paste: string[];
}

type CommandLookup = (command: string) => string | null;

const decoder = new TextDecoder();

let clipboardCommands: ClipboardCommands | null | undefined;
/** Text of the last linewise yank, while it is still what we last copied. */
let lastLinewiseYank: string | null = null;

/**
 * Resolve the native clipboard commands for the current platform.
 *
 * macOS ships pbcopy/pbpaste as part of the OS. Linux keeps its existing
 * Wayland-first behavior followed by the xclip and xsel fallbacks.
 */
export function resolveClipboardCommands(
  platform: NodeJS.Platform = process.platform,
  waylandDisplay: string | undefined = process.env.WAYLAND_DISPLAY,
  which: CommandLookup = Bun.which,
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
      paste: ["wl-paste", "--no-newline"],
    };
  }
  if (which("xclip")) {
    return {
      copy: ["xclip", "-selection", "clipboard"],
      paste: ["xclip", "-selection", "clipboard", "-o"],
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
  clipboardCommands = resolveClipboardCommands();
  return clipboardCommands;
}

export function clipboardTextForCopy(text: string): string {
  return decodeCustomEmojiMarkers(text);
}

export function editorTextFromClipboard(text: string): string {
  return replaceCustomEmojiTokens(text);
}

/**
 * Copy text to the system clipboard. `linewise` marks a whole-line yank
 * (yy, yj, Vy) so p/P put it back as lines.
 */
export function copyToClipboard(text: string, linewise = false): void {
  lastLinewiseYank = linewise ? text : null;
  const commands = detectClipboardCommands();
  if (!commands) return;

  try {
    const proc = Bun.spawn(commands.copy, { stdin: "pipe" });
    proc.stdin.write(clipboardTextForCopy(text));
    proc.stdin.end();
  } catch {
    // Clipboard is best-effort.
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

export function pasteFromClipboard(): string {
  const commands = detectClipboardCommands();
  if (!commands) return "";

  try {
    const result = Bun.spawnSync(commands.paste);
    return result.exitCode === 0 ? editorTextFromClipboard(decoder.decode(result.stdout)) : "";
  } catch {
    return "";
  }
}
