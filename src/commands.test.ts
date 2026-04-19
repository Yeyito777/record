import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, test } from "bun:test";

import { tryCommand } from "./commands";
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
  test("parses /login <token>", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const result = tryCommand("/login abc123", state);

    expect(result).toEqual({ type: "login", token: "abc123" });
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

  test("rejects /login without a token", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const result = tryCommand("/login", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /login <token>");
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
