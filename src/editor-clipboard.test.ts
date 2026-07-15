import { describe, expect, test } from "bun:test";
import { resolveClipboardCommands } from "./editor-clipboard";

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
});
