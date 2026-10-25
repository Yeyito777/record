import { afterEach, describe, expect, test } from "bun:test";
import {
  clipboardTextForCopy,
  copyToClipboard,
  editorTextFromClipboard,
  pasteFromClipboard,
  resolveClipboardCommands,
  setTextClipboardSystemForTest,
} from "./editor-clipboard";
import { decodeCustomEmojiMarkers } from "./customemoji";

function available(...commands: string[]): (command: string) => string | null {
  const installed = new Set(commands);
  return (command) => installed.has(command) ? `/usr/bin/${command}` : null;
}

describe("resolveClipboardCommands", () => {
  test("uses the native macOS clipboard tools", () => {
    expect(resolveClipboardCommands("darwin", undefined, available("pbcopy", "pbpaste"))).toEqual({
      copy: ["pbcopy"],
      paste: ["pbpaste"],
    });
  });

  test("keeps Wayland clipboard support", () => {
    expect(resolveClipboardCommands("linux", "wayland-0", available("wl-copy", "wl-paste"))).toEqual({
      copy: ["wl-copy"],
      paste: ["wl-paste", "--no-newline", "--type"],
      targets: ["wl-paste", "--list-types"],
    });
  });

  test("keeps X11 clipboard fallbacks", () => {
    expect(resolveClipboardCommands("linux", undefined, available("xclip"), ":0")).toEqual({
      copy: ["xclip", "-selection", "clipboard"],
      paste: ["xclip", "-selection", "clipboard", "-o", "-t"],
      targets: ["xclip", "-selection", "clipboard", "-o", "-t", "TARGETS"],
    });
    expect(resolveClipboardCommands("linux", undefined, available("xsel"), ":0")).toEqual({
      copy: ["xsel", "--clipboard", "--input"],
      paste: ["xsel", "--clipboard", "--output"],
    });
  });

  test("X11 tools need a display (an SSH session has none)", () => {
    expect(resolveClipboardCommands("linux", undefined, available("xclip", "xsel"), "")).toBeNull();
  });

  test("does not select an incomplete backend", () => {
    expect(resolveClipboardCommands("darwin", undefined, available("pbcopy"))).toBeNull();
    expect(resolveClipboardCommands("linux", "wayland-0", available("wl-copy"))).toBeNull();
  });

  test("keeps prompt custom emoji graphical internally and textual on the system clipboard", () => {
    const token = "<:aliencat_stare_2:1478284001298087936>";
    const editorText = editorTextFromClipboard(`look ${token}`);

    expect(editorText).not.toContain(token);
    expect(decodeCustomEmojiMarkers(editorText)).toBe(`look ${token}`);
    expect(clipboardTextForCopy(editorText)).toBe(`look ${token}`);
  });
});

describe("prompt clipboard fallbacks", () => {
  afterEach(() => setTextClipboardSystemForTest(null));

  test("without a clipboard tool, a put returns the last yank", () => {
    setTextClipboardSystemForTest({ platform: "linux", env: {}, which: () => null });
    copyToClipboard("yanked");
    expect(pasteFromClipboard()).toBe("yanked");
  });

  test("a failing copy switches to the in-memory register", async () => {
    const pastes: string[][] = [];
    setTextClipboardSystemForTest({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: (command) => command === "xsel" ? "/usr/bin/xsel" : null,
      copy: async () => 1,
      paste: (command) => { pastes.push(command); return { output: "stale", exitCode: 0 }; },
    });
    copyToClipboard("fresh");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pasteFromClipboard()).toBe("fresh");
    expect(pastes).toEqual([]);
  });

  test("an image on the clipboard is not put as text", () => {
    setTextClipboardSystemForTest({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      which: (command) => command.startsWith("wl-") ? `/usr/bin/${command}` : null,
      copy: async () => 0,
      paste: (command) => command.includes("--list-types")
        ? { output: "image/png\n", exitCode: 0 }
        : { output: "\x89PNG", exitCode: 0 },
    });
    copyToClipboard("last yank");
    expect(pasteFromClipboard()).toBe("last yank");
  });

  test("a put reads the clipboard's text type", () => {
    const pastes: string[][] = [];
    setTextClipboardSystemForTest({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: (command) => command === "xclip" ? "/usr/bin/xclip" : null,
      copy: async () => 0,
      paste: (command) => {
        pastes.push(command);
        return command.includes("TARGETS")
          ? { output: "TARGETS\nUTF8_STRING\nSTRING\n", exitCode: 0 }
          : { output: "text", exitCode: 0 };
      },
    });
    expect(pasteFromClipboard()).toBe("text");
    expect(pastes.at(-1)).toEqual(["xclip", "-selection", "clipboard", "-o", "-t", "UTF8_STRING"]);
  });

  test("clipboard text is cleaned like a bracketed paste", () => {
    expect(editorTextFromClipboard("x\r\ny\tz\x1b[31mR")).toBe("x\ny    zR");
  });
});
