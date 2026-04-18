import { describe, expect, test } from "bun:test";

import { tryCommand } from "./commands";
import { createInitialState } from "./state";

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

  test("rejects /login without a token", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const result = tryCommand("/login", state);

    expect(result).toEqual({ type: "handled" });
    expect(state.notice.text).toContain("Usage: /login <token>");
  });

  test("parses /theme whale", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const result = tryCommand("/theme whale", state);

    expect(result).toEqual({ type: "theme_changed" });
    expect(state.notice.text).toContain("Theme set to whale");
  });
});
