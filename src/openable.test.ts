import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultOpenersConfig, saveConfig } from "./config";
import type { DiscordMessageAttachment } from "./discord";
import {
  cachedAttachmentPath,
  cachedOpenableUrlPath,
  downloadAttachment,
  downloadableOpenableUrlFilename,
  downloadOpenableUrl,
  findOpenableTargetMatches,
  openTargetDetached,
  resolveOpenCommand,
  shouldDownloadTargetBeforeOpen,
  type AttachmentDownloadProgress,
} from "./openable";

const previousXdg = process.env.XDG_CONFIG_HOME;

function resetConfig(): void {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-openable-test-"));
  saveConfig({ openers: defaultOpenersConfig() });
}

beforeEach(resetConfig);

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

describe("openable target detection", () => {
  test("detects image, pdf, and audio/video paths", () => {
    expect(findOpenableTargetMatches("/tmp/a.png /tmp/b.webp /tmp/c.pdf /tmp/d.mp3 /tmp/e.mov").map((m) => m.target)).toEqual([
      "/tmp/a.png",
      "/tmp/b.webp",
      "/tmp/c.pdf",
      "/tmp/d.mp3",
      "/tmp/e.mov",
    ]);
  });

  test("detects relative and home-prefixed configured file paths", () => {
    expect(findOpenableTargetMatches("./out/a.md ../b.py ~/notes/c.txt").map((m) => m.target)).toEqual([
      "./out/a.md",
      "../b.py",
      "~/notes/c.txt",
    ]);
  });

  test("detects http and https links", () => {
    expect(findOpenableTargetMatches("See https://example.com/a?b=1 and http://localhost:3000.").map((m) => m.target)).toEqual([
      "https://example.com/a?b=1",
      "http://localhost:3000",
    ]);
  });

  test("does not double-detect URL paths as local files", () => {
    expect(findOpenableTargetMatches("https://example.com/reference.png")).toEqual([
      { target: "https://example.com/reference.png", start: 0, end: "https://example.com/reference.png".length },
    ]);
  });

  test("ignores unconfigured file extensions", () => {
    expect(findOpenableTargetMatches("/tmp/archive.zip")).toEqual([]);
  });
});

describe("openable target command resolution", () => {
  test("opens image and pdf paths with show", () => {
    expect(resolveOpenCommand("/tmp/reference.png")).toEqual({ command: "show", args: ["/tmp/reference.png"] });
    expect(resolveOpenCommand("/tmp/reference.pdf")).toEqual({ command: "show", args: ["/tmp/reference.pdf"] });
  });

  test("opens gif paths with configured play command", () => {
    expect(resolveOpenCommand("/tmp/loop.gif")).toEqual({ command: "video-play", args: ["/tmp/loop.gif"] });
  });

  test("opens links with xdg-open", () => {
    expect(resolveOpenCommand("https://example.com")).toEqual({ command: "xdg-open", args: ["https://example.com"] });
  });

  test("marks gif links for download before opening", () => {
    expect(shouldDownloadTargetBeforeOpen("https://cdn.example/loop.gif?width=320")).toBe(true);
    expect(downloadableOpenableUrlFilename("https://cdn.example/path/loop.gif?width=320")).toBe("loop.gif");
    expect(shouldDownloadTargetBeforeOpen("https://tenor.com/view/one-pice-gif-26834018")).toBe(true);
    expect(downloadableOpenableUrlFilename("https://tenor.com/view/one-pice-gif-26834018")).toBe("one-pice-gif-26834018.gif");
    expect(shouldDownloadTargetBeforeOpen("https://example.com/page")).toBe(false);
    expect(resolveOpenCommand("https://cdn.example/loop.gif?width=320")).toEqual({
      command: "xdg-open",
      args: ["https://cdn.example/loop.gif?width=320"],
    });
  });

  test("opens html paths with xdg-open", () => {
    expect(resolveOpenCommand("/tmp/reference.html")).toEqual({ command: "xdg-open", args: ["/tmp/reference.html"] });
  });

  test("opens audio/video paths with audio-play inside an ephemeral st terminal", () => {
    expect(resolveOpenCommand("/tmp/song.mp3")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec audio-play '/tmp/song.mp3'"],
    });
    expect(resolveOpenCommand("/tmp/clip.mov")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec audio-play '/tmp/clip.mov'"],
    });
  });

  test("opens code/text paths in nvim inside an ephemeral st terminal", () => {
    expect(resolveOpenCommand("/tmp/notes.md")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec nvim '/tmp/notes.md'"],
    });
  });

  test("quotes terminal-opened paths before passing them through zsh", () => {
    expect(resolveOpenCommand("/tmp/it's tricky.py")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec nvim '/tmp/it'\\''s tricky.py'"],
    });
    expect(resolveOpenCommand("/tmp/it's tricky.mp3")).toEqual({
      command: "st",
      args: ["-e", "zsh", "-ic", "exec audio-play '/tmp/it'\\''s tricky.mp3'"],
    });
  });

  test("does not open unconfigured extensions", () => {
    expect(resolveOpenCommand("/tmp/archive.zip")).toBeNull();
    expect(openTargetDetached("/tmp/archive.zip")).toBe(false);
  });

  test("uses opener commands configured in config.json", () => {
    saveConfig({
      openers: {
        url: { command: "browser", args: ["--new-tab", "{target}"] },
        rules: [
          { extensions: ["png"], command: "image-viewer", args: ["{path}"] },
          { extensions: ["log"], command: "term", args: ["-e", "editor {path:sh}"] },
        ],
      },
    });

    expect(findOpenableTargetMatches("/tmp/a.png /tmp/b.md /tmp/c.log https://example.com").map((m) => m.target)).toEqual([
      "/tmp/a.png",
      "/tmp/c.log",
      "https://example.com",
    ]);
    expect(resolveOpenCommand("https://example.com")).toEqual({
      command: "browser",
      args: ["--new-tab", "https://example.com"],
    });
    expect(resolveOpenCommand("/tmp/a.png")).toEqual({ command: "image-viewer", args: ["/tmp/a.png"] });
    expect(resolveOpenCommand("/tmp/it's tricky.log")).toEqual({
      command: "term",
      args: ["-e", "editor '/tmp/it'\\''s tricky.log'"],
    });
    expect(resolveOpenCommand("/tmp/b.md")).toBeNull();
  });

  test("can disable link opening from config.json", () => {
    saveConfig({
      openers: {
        url: null,
        rules: [{ extensions: ["txt"], command: "viewer", args: ["{path}"] }],
      },
    });

    expect(findOpenableTargetMatches("https://example.com /tmp/a.txt").map((m) => m.target)).toEqual(["/tmp/a.txt"]);
    expect(resolveOpenCommand("https://example.com")).toBeNull();
  });
});

describe("attachment downloads", () => {
  test("downloads attachments into the record attachment cache", async () => {
    const previousFetch = globalThis.fetch;
    const attachment: DiscordMessageAttachment = {
      id: "a1",
      filename: "image-1.png",
      contentType: "image/png",
      size: 4,
      url: "https://cdn.example/image-1.png",
    };

    globalThis.fetch = (() => Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])))) as unknown as typeof fetch;
    try {
      const result = await downloadAttachment(attachment);
      expect(result.ok).toBe(true);
      expect(result.cached).toBe(false);
      expect(result.path).toBe(cachedAttachmentPath(attachment));
      expect(existsSync(result.path ?? "")).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("reports attachment download progress", async () => {
    const previousFetch = globalThis.fetch;
    const attachment: DiscordMessageAttachment = {
      id: "progress-a1",
      filename: "progress-image.png",
      contentType: "image/png",
      size: 4,
      url: "https://cdn.example/progress-image.png",
    };
    const progress: AttachmentDownloadProgress[] = [];

    globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }), { headers: { "Content-Length": "4" } }))) as unknown as typeof fetch;

    try {
      const result = await downloadAttachment(attachment, { onProgress: (event) => progress.push(event) });
      expect(result.ok).toBe(true);
      expect(progress).toEqual([
        { receivedBytes: 0, totalBytes: 4 },
        { receivedBytes: 2, totalBytes: 4 },
        { receivedBytes: 4, totalBytes: 4 },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("downloadable openable links", () => {
  test("downloads gif links into the record openable cache", async () => {
    const previousFetch = globalThis.fetch;
    const target = "https://cdn.example/media/loop.gif?size=4096";

    globalThis.fetch = (() => Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])))) as unknown as typeof fetch;
    try {
      const result = await downloadOpenableUrl(target);
      expect(result.ok).toBe(true);
      expect(result.cached).toBe(false);
      expect(result.path).toBe(cachedOpenableUrlPath(target));
      expect(existsSync(result.path ?? "")).toBe(true);
      expect(resolveOpenCommand(result.path ?? "")).toEqual({ command: "video-play", args: [result.path ?? ""] });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("resolves Tenor view links to their GIF media before downloading", async () => {
    const previousFetch = globalThis.fetch;
    const target = "https://tenor.com/view/one-pice-gif-26834018";
    const mediaUrl = "https://media1.tenor.com/m/eui1tpq5mJQAAAAd/one-pice.gif";
    const fetched: string[] = [];

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === target) {
        return Promise.resolve(new Response(`<html><head><meta property="og:image" content="${mediaUrl}"></head></html>`));
      }
      if (url === mediaUrl) return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    try {
      const result = await downloadOpenableUrl(target);
      expect(result.ok).toBe(true);
      expect(result.path).toBe(cachedOpenableUrlPath(target));
      expect(result.path?.endsWith("one-pice-gif-26834018.gif")).toBe(true);
      expect(fetched).toEqual([target, mediaUrl]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
