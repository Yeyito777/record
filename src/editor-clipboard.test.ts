import { describe, expect, test } from "bun:test";
import { clipboardTextForCopy, editorTextFromClipboard, resolveClipboardCommands } from "./editor-clipboard";
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
      paste: ["wl-paste", "--no-newline"],
    });
  });

  test("keeps X11 clipboard fallbacks", () => {
    expect(resolveClipboardCommands("linux", undefined, available("xclip"))).toEqual({
      copy: ["xclip", "-selection", "clipboard"],
      paste: ["xclip", "-selection", "clipboard", "-o"],
    });
    expect(resolveClipboardCommands("linux", undefined, available("xsel"))).toEqual({
      copy: ["xsel", "--clipboard", "--input"],
      paste: ["xsel", "--clipboard", "--output"],
    });
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
