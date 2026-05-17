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

  test("parses local gain commands directly", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(tryCommand("/mic volume 0", state)).toEqual({ type: "mic_volume", volume: 0 });
    expect(tryCommand("/mic volume -20", state)).toEqual({ type: "mic_volume", volume: -20 });
    expect(tryCommand("/mic volume -3.5dB", state)).toEqual({ type: "mic_volume", volume: -3.5 });
    expect(tryCommand("/speaker volume +6", state)).toEqual({ type: "speaker_volume", volume: 6 });
    expect(tryCommand("/mic volume reset", state)).toEqual({ type: "mic_volume", volume: 0 });
  });

  test("shows current local gain when volume command has no value", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    state.audio.micVolume = -20;

    expect(tryCommand("/mic volume", state)).toEqual({ type: "handled" });
    expect(state.notice).toMatchObject({
      text: "Microphone record gain: -20dB",
      statusLine: true,
      chat: false,
    });
  });

  test("rejects invalid local volume commands", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(tryCommand("/mic volume loud", state)).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /mic volume [gain]");

    expect(tryCommand("/mic volume 40%", state)).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /mic volume [gain]");

    expect(tryCommand("/speaker gain 50", state)).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /speaker volume [gain]");
  });

  test("suggests local volume subcommands without fixed gain values", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(getCommandArgs(state)["/mic"]).toEqual([{ name: "volume", desc: "Set/show local gain" }]);
    expect(getCommandArgs(state)["/speaker volume"]).toBeUndefined();
  });

  test("shows current noise suppression when no mode is provided", () => {
    const state = createInitialState("token", "/tmp/record-config.json", {}, { noiseSuppression: "simple" });

    expect(tryCommand("/noise-suppression", state)).toEqual({ type: "handled" });
    expect(state.notice).toMatchObject({
      text: "Noise suppression: simple",
      statusLine: true,
      chat: false,
    });
  });

  test("parses noise suppression modes", () => {
    const state = createInitialState("token", "/tmp/record-config.json");

    expect(tryCommand("/noise-suppression off", state)).toEqual({ type: "noise_suppression", mode: "off" });
    expect(tryCommand("/noise-suppression simple", state)).toEqual({ type: "noise_suppression", mode: "simple" });
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

  test("shows current /status presence when no status is provided", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    state.auth.presenceStatus = "idle";

    expect(tryCommand("/status", state)).toEqual({ type: "handled" });
    expect(state.notice).toMatchObject({
      text: "Presence: idle",
      statusLine: true,
      chat: false,
    });
  });

  test("rejects invalid /status values", () => {
    const state = createInitialState("token", "/tmp/record-config.json");
    const result = tryCommand("/status busy", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /status [online|idle|dnd|invisible]");
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

  test("shows current /theme when no theme is provided", () => {
    withTempConfigHome(() => {
      const state = createInitialState(null, "/tmp/record-config.json");

      expect(tryCommand("/theme cerberus", state)).toEqual({ type: "theme_changed" });
      expect(tryCommand("/theme", state)).toEqual({ type: "handled" });
      expect(state.notice).toMatchObject({
        text: "Theme: cerberus",
        statusLine: true,
        chat: false,
      });
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
