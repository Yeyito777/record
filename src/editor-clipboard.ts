/**
 * Clipboard helpers for prompt editor yanks and puts.
 */

type ClipboardBackend = "xclip" | "xsel" | "wl" | null;

const decoder = new TextDecoder();

let clipboardBackend: ClipboardBackend | undefined;

function detectClipboardBackend(): ClipboardBackend {
  if (clipboardBackend !== undefined) return clipboardBackend;

  if (process.env.WAYLAND_DISPLAY && Bun.which("wl-copy") && Bun.which("wl-paste")) {
    clipboardBackend = "wl";
    return clipboardBackend;
  }
  if (Bun.which("xclip")) {
    clipboardBackend = "xclip";
    return clipboardBackend;
  }
  if (Bun.which("xsel")) {
    clipboardBackend = "xsel";
    return clipboardBackend;
  }

  clipboardBackend = null;
  return clipboardBackend;
}

export function copyToClipboard(text: string): void {
  const backend = detectClipboardBackend();
  if (!backend) return;

  try {
    const command = backend === "wl"
      ? ["wl-copy"]
      : backend === "xclip"
        ? ["xclip", "-selection", "clipboard"]
        : ["xsel", "--clipboard", "--input"];
    const proc = Bun.spawn(command, { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
  } catch {
    // Clipboard is best-effort.
  }
}

export function pasteFromClipboard(): string {
  const backend = detectClipboardBackend();
  if (!backend) return "";

  try {
    const result = backend === "wl"
      ? Bun.spawnSync(["wl-paste", "--no-newline"])
      : backend === "xclip"
        ? Bun.spawnSync(["xclip", "-selection", "clipboard", "-o"])
        : Bun.spawnSync(["xsel", "--clipboard", "--output"]);
    return result.exitCode === 0 ? decoder.decode(result.stdout) : "";
  } catch {
    return "";
  }
}
