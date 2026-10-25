import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readClipboardImages, resolveImageClipboardWriteCommand, setImageClipboardSystemForTest } from "./imageclipboard";

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

describe("reading clipboard images", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

  function fakeTools(handlers: Record<string, (args: string[]) => { status: number; stdout?: Buffer | string }>) {
    return ((command: string, args: string[] = []) => {
      if (command === "which") return { status: handlers[args[0]!] ? 0 : 1, stdout: Buffer.alloc(0) };
      const result = handlers[command]?.(args) ?? { status: 1 };
      return { status: result.status, stdout: Buffer.from(result.stdout ?? ""), stderr: Buffer.alloc(0) };
    }) as unknown as typeof import("child_process").spawnSync;
  }

  afterEach(() => setImageClipboardSystemForTest(null));

  test("a Finder-copied image file attaches the file, not its icon", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-finder-"));
    try {
      writeFileSync(join(dir, "shot.png"), PNG);
      const scripts: string[] = [];
      setImageClipboardSystemForTest({
        platform: "darwin",
        env: {},
        spawnSync: fakeTools({
          sips: () => ({ status: 0 }),
          osascript: (args) => {
            scripts.push(args.join(" "));
            return { status: 0, stdout: `${join(dir, "shot.png")}\n` };
          },
        }),
      });
      expect(readClipboardImages()).toEqual([
        { mediaType: "image/png", base64: PNG.toString("base64"), sizeBytes: PNG.length, filename: "shot.png" },
      ]);
      expect(scripts).toEqual(["-e POSIX path of (the clipboard as alias)"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a copied non-image file reports instead of attaching its icon", () => {
    const errors: string[] = [];
    setImageClipboardSystemForTest({
      platform: "darwin",
      env: {},
      spawnSync: fakeTools({ sips: () => ({ status: 0 }), osascript: () => ({ status: 0, stdout: "/Users/me/report.pdf\n" }) }),
    });
    expect(readClipboardImages((message) => errors.push(message))).toEqual([]);
    expect(errors).toEqual(["report.pdf is not an image; send files with /upload."]);
  });

  test("copied image data still pastes when no file is on the clipboard", () => {
    setImageClipboardSystemForTest({
      platform: "darwin",
      env: {},
      spawnSync: fakeTools({
        sips: () => ({ status: 0 }),
        osascript: (args) => {
          if (args[0] === "-e") return { status: 1 };
          writeFileSync(args[1]!, PNG);
          return { status: 0, stdout: "png\n" };
        },
      }),
    });
    expect(readClipboardImages().map((image) => image.mediaType)).toEqual(["image/png"]);
  });

  test("X11: copied image files beat the icon; fake image/png bytes are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-x11-"));
    try {
      writeFileSync(join(dir, "a.png"), PNG);
      const xclip = (targets: string, data: Record<string, Buffer | string>) => fakeTools({
        xclip: (args) => {
          const target = args[args.indexOf("-t") + 1]!;
          if (target === "TARGETS") return { status: 0, stdout: targets };
          return data[target] === undefined ? { status: 1 } : { status: 0, stdout: data[target] };
        },
      });
      setImageClipboardSystemForTest({
        platform: "linux", env: { DISPLAY: ":0" },
        spawnSync: xclip("TARGETS\ntext/uri-list\nimage/png\n", { "text/uri-list": `file://${join(dir, "a.png")}\n`, "image/png": Buffer.from("icon") }),
      });
      expect(readClipboardImages().map((image) => image.filename)).toEqual(["a.png"]);

      setImageClipboardSystemForTest({
        platform: "linux", env: { DISPLAY: ":0" },
        spawnSync: xclip("TARGETS\nimage/png\n", { "image/png": Buffer.from("not really a png") }),
      });
      expect(readClipboardImages()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
