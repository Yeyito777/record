import { describe, expect, test } from "bun:test";

import { resolveLoginCredential, submitCurrentBuffer, type AppEffects } from "./actions";
import { createInitialState } from "./state";

const effects: AppEffects = {
  scheduleRender: () => {},
  quit: () => {},
  applyThemeCursor: () => {},
  bootstrapSession: () => {},
};

describe("submitCurrentBuffer", () => {
  test("resolves saved login usernames before validation", () => {
    const state = createInitialState(null, "/tmp/record-config.json", { alice: "token-1" });

    expect(resolveLoginCredential(state, "alice")).toBe("token-1");
    expect(resolveLoginCredential(state, "raw-token")).toBe("raw-token");
  });

  test("non-command prompt text is cleared without warning", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "hello world";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("");
    expect(state.editor.buffer).toBe("");
  });

  test("empty prompt does nothing", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("");
  });
});
