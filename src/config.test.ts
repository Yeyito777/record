import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, test } from "bun:test";

import { clearConfig, loadConfig, loadSavedLogins, saveConfig, saveSavedLogins, savedLoginsPath } from "./config";

const previousXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

describe("config", () => {
  test("saves and loads saved logins", () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-config-test-"));

    saveSavedLogins({ zed: " token-2 ", alice: "token-1" });

    expect(loadSavedLogins()).toEqual({ alice: "token-1", zed: "token-2" });
    expect(readFileSync(savedLoginsPath(), "utf8")).toContain('"alice": "token-1"');
  });

  test("preserves opener config when saving or clearing a token", () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-config-test-"));

    saveConfig({
      token: "old-token",
      openers: { url: { command: "browser", args: ["{target}"] }, rules: [] },
      channels: { showHidden: true },
    });
    saveConfig({ token: "new-token" });

    expect(loadConfig().openers).toEqual({ url: { command: "browser", args: ["{target}"] }, rules: [] });
    expect(loadConfig().channels).toEqual({ showHidden: true });
    expect(loadConfig().token).toBe("new-token");

    clearConfig();
    expect(loadConfig()).toEqual({
      openers: { url: { command: "browser", args: ["{target}"] }, rules: [] },
      channels: { showHidden: true },
    });
  });

  test("merges audio config updates", () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-config-test-"));

    saveConfig({ audio: { noiseSuppression: "simple", participantVolumes: { friend: 80 } } });
    saveConfig({ audio: { micGainDb: -20 } });

    expect(loadConfig().audio).toEqual({ noiseSuppression: "simple", participantVolumes: { friend: 80 }, micGainDb: -20 });
  });
});
