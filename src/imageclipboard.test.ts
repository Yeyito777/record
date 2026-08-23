import { describe, expect, test } from "bun:test";

import { resolveImageClipboardWriteCommand } from "./imageclipboard";

function available(...commands: string[]): (command: string) => string | null {
  const installed = new Set(commands);
  return (command) => installed.has(command) ? `/usr/bin/${command}` : null;
}

describe("image clipboard writing", () => {
  test("publishes binary MIME data through Wayland when available", () => {
    expect(resolveImageClipboardWriteCommand(
      "image/png",
      "linux",
      "wayland-0",
      available("wl-copy", "xclip"),
    )).toEqual(["wl-copy", "--type", "image/png"]);
  });

  test("publishes binary MIME data through the X11 clipboard", () => {
    expect(resolveImageClipboardWriteCommand(
      "image/png",
      "linux",
      undefined,
      available("xclip"),
    )).toEqual(["xclip", "-selection", "clipboard", "-t", "image/png"]);
  });

  test("does not treat a text-only xsel backend as image-capable", () => {
    expect(resolveImageClipboardWriteCommand(
      "image/png",
      "linux",
      undefined,
      available("xsel"),
    )).toBeNull();
  });
});
