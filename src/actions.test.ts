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

  test("non-command prompt text requires a login before sending", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "hello world";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("Login first with /login <token|username>.");
    expect(state.editor.buffer).toBe("hello world");
  });

  test("image-only messages submit", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.pendingImages = [{ mediaType: "image/png", base64: "", sizeBytes: 1, filename: "image-1.png" }];

    submitCurrentBuffer(state, effects);

    expect(state.notice.text).toBe("Login first with /login <token|username>.");
  });

  test("empty prompt submits while editing", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      authorDisplayName: "Self",
      authorColor: "",
      summary: "original",
      originalContent: "original",
      timestamp: null,
    };

    submitCurrentBuffer(state, effects);

    expect(state.notice.text).toBe("Login first with /login <token|username>.");
  });

  test("empty prompt does nothing", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("");
  });
});
