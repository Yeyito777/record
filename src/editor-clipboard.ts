/**
 * Clipboard helpers for prompt editor yanks and puts.
 */

interface ClipboardCommands {
  copy: string[];
  paste: string[];
}

type CommandLookup = (command: string) => string | null;

const decoder = new TextDecoder();

let clipboardCommands: ClipboardCommands | null | undefined;

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

export function copyToClipboard(text: string): void {
  const commands = detectClipboardCommands();
  if (!commands) return;

  try {
    const proc = Bun.spawn(commands.copy, { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
  } catch {
    // Clipboard is best-effort.
  }
}

export function pasteFromClipboard(): string {
  const commands = detectClipboardCommands();
  if (!commands) return "";

  try {
    const result = Bun.spawnSync(commands.paste);
    return result.exitCode === 0 ? decoder.decode(result.stdout) : "";
  } catch {
    return "";
  }
}
