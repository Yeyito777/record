import { describe, expect, test } from "bun:test";

import { createInitialState } from "./state";

describe("state", () => {
  test("saved token does not populate the prompt buffer", () => {
    const state = createInitialState("Bot abc123", "/tmp/record-config.json");

    expect(state.editor.buffer).toBe("");
    expect(state.editor.mode).toBe("insert");
    expect(state.auth.savedToken).toBe("Bot abc123");
  });
});
