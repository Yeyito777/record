import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, test } from "bun:test";

import { getCommandArgs, tryCommand } from "./commands";
import { loadConfig } from "./config";
import { createInitialState } from "./state";

function withTempConfigHome(run: () => void): void {
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const tempDir = mkdtempSync(join(tmpdir(), "record-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  try {
    run();
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
}

describe("commands", () => {
  test("parses /login <token or username>", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const result = tryCommand("/login abc123", state);

    expect(result).toEqual({ type: "login", credential: "abc123" });
    expect(state.editor.buffer).toBe("");
  });

  test("parses /logout", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    const result = tryCommand("/logout", state);

    expect(result).toEqual({ type: "logout" });
    expect(state.editor.buffer).toBe("");
  });

  test("parses /refresh", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    const result = tryCommand("/refresh", state);

    expect(result).toEqual({ type: "refresh" });
    expect(state.editor.buffer).toBe("");
  });

  test("parses /upload <file-path>", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    const result = tryCommand("/upload ./screenshots/cat picture.png", state);

    expect(result).toEqual({ type: "upload", path: "./screenshots/cat picture.png" });
    expect(state.editor.buffer).toBe("");
  });

  test("rejects /upload without a path", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    const result = tryCommand("/upload", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /upload <file-path>");
  });

  test("parses voice call commands", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(tryCommand("/call", state)).toEqual({ type: "call" });
    expect(tryCommand("/hangup", state)).toEqual({ type: "hangup" });
    expect(tryCommand("/mute", state)).toEqual({ type: "mute", muted: null });
    expect(tryCommand("/mute on", state)).toEqual({ type: "mute", muted: true });
    expect(tryCommand("/mute off", state)).toEqual({ type: "mute", muted: false });
    expect(tryCommand("/deafen", state)).toEqual({ type: "deafen", deafened: null });
    expect(tryCommand("/deafen on", state)).toEqual({ type: "deafen", deafened: true });
    expect(tryCommand("/deafen off", state)).toEqual({ type: "deafen", deafened: false });
  });

  test("parses local volume commands with optional percent sign and clamps values", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(tryCommand("/mic volume 0", state)).toEqual({ type: "mic_volume", volume: 0 });
    expect(tryCommand("/mic volume 40%", state)).toEqual({ type: "mic_volume", volume: 40 });
    expect(tryCommand("/speaker volume 50%", state)).toEqual({ type: "speaker_volume", volume: 50 });
    expect(tryCommand("/speaker volume 150", state)).toEqual({ type: "speaker_volume", volume: 100 });
    expect(tryCommand("/mic volume -10", state)).toEqual({ type: "mic_volume", volume: 0 });
  });

  test("rejects invalid local volume commands", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(tryCommand("/mic volume loud", state)).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /mic volume <0-100>");

    expect(tryCommand("/speaker gain 50", state)).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /speaker volume <0-100>");
  });

  test("suggests local volume subcommands and values", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(getCommandArgs(state)["/mic"]).toEqual([{ name: "volume", desc: "Set local volume" }]);
    expect(getCommandArgs(state)["/speaker volume"]?.map((item) => item.name)).toEqual(["100%", "75%", "50%", "25%", "0%"]);
  });

  test("parses /status presence values", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(tryCommand("/status online", state)).toEqual({ type: "status", status: "online" });
    expect(tryCommand("/status idle", state)).toEqual({ type: "status", status: "idle" });
    expect(tryCommand("/status dnd", state)).toEqual({ type: "status", status: "dnd" });
    expect(tryCommand("/status invisible", state)).toEqual({ type: "status", status: "invisible" });
    expect(tryCommand("/status offline", state)).toEqual({ type: "status", status: "invisible" });
    expect(tryCommand("/status 4", state)).toEqual({ type: "status", status: "invisible" });
  });

  test("rejects invalid /status values", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    const result = tryCommand("/status busy", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /status <online|idle|dnd|invisible>");
  });

  test("suggests /status args", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(getCommandArgs(state)["/status"]).toEqual([
      { name: "online", desc: "Show as online" },
      { name: "idle", desc: "Show as idle" },
      { name: "dnd", desc: "Show as Do Not Disturb" },
      { name: "invisible", desc: "Show as offline" },
    ]);
  });

  test("toggles hidden channel display", () => {
    withTempConfigHome(() => {
      const state = createInitialState("token", "/tmp/record-config.json");

      expect(tryCommand("/channels show-hidden", state)).toEqual({ type: "handled" });
      expect(state.showHiddenChannels).toBe(true);
      expect(loadConfig().channels).toEqual({ showHidden: true });
      expect(state.notice.text).toContain("shown");
      expect(state.notice.tone).toBe("muted");
      expect(state.notice.statusLine).toBe(false);
      expect(state.notice.chat).toBe(true);

      expect(tryCommand("/channels show-hidden off", state)).toEqual({ type: "handled" });
      expect(state.showHiddenChannels).toBe(false);
      expect(loadConfig().channels).toEqual({ showHidden: false });
      expect(state.notice.text).toContain("hidden");
      expect(state.notice.tone).toBe("muted");
      expect(state.notice.statusLine).toBe(false);
      expect(state.notice.chat).toBe(true);
    });
  });

  test("rejects /login without a token", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const result = tryCommand("/login", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /login <token|username>");
  });

  test("suggests saved usernames as /login args", () => {
    const state = createInitialState(null, "/tmp/record-config.json", { zed: "tok-2", alice: "tok-1" });

    expect(getCommandArgs(state)["/login"]).toEqual([
      { name: "alice", desc: "saved login" },
      { name: "zed", desc: "saved login" },
    ]);
  });

  test("parses /theme whale", () => {
    withTempConfigHome(() => {
      const state = createInitialState(null, "/tmp/record-config.json");
      const result = tryCommand("/theme whale", state);

      expect(result).toEqual({ type: "theme_changed" });
      expect(state.notice.text).toContain("Theme set to whale");
    });
  });

  test("theme switching does not crash if saving fails", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousHome = process.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.HOME;

    try {
      const state = createInitialState(null, "/tmp/record-config.json");
      const result = tryCommand("/theme cerberus", state);

      expect(result).toEqual({ type: "theme_changed" });
      expect(state.notice.text).toContain("Theme set to cerberus, but saving failed:");
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;

      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
