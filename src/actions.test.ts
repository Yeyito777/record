import { describe, expect, test } from "bun:test";

import { submitCurrentBuffer, type AppEffects } from "./actions";
import { createInitialState } from "./state";

const effects: AppEffects = {
  scheduleRender: () => {},
  quit: () => {},
  applyThemeCursor: () => {},
  bootstrapSession: () => {},
};

describe("submitCurrentBuffer", () => {
  test("does not treat bare prompt text as a login token", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "hello world";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("Message sending is not implemented yet.");
    expect(state.editor.buffer).toBe("hello world");
  });

  test("empty prompt does nothing", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("");
  });
});
