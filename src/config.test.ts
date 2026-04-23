import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, test } from "bun:test";

import { loadSavedLogins, saveSavedLogins, savedLoginsPath } from "./config";

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
});
