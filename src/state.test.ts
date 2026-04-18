import { describe, expect, test } from "bun:test";

import { createInitialState, cycleFocus, focusHistory } from "./state";

describe("state", () => {
  test("saved token does not populate the prompt buffer", () => {
    const state = createInitialState("Bot abc123", "/tmp/record-config.json");

    expect(state.editor.buffer).toBe("");
    expect(state.editor.mode).toBe("insert");
    expect(state.auth.savedToken).toBe("Bot abc123");
  });

  test("starts focused on the prompt inside chat", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    expect(state.panelFocus).toBe("chat");
    expect(state.chatFocus).toBe("prompt");
    expect(state.editor.mode).toBe("insert");
  });

  test("panel focus cycling preserves chat subfocus", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.sidebar.open = true;
    focusHistory(state);

    cycleFocus(state);
    expect(state.panelFocus).toBe("sidebar");
    expect(state.chatFocus).toBe("history");

    cycleFocus(state);
    expect(state.panelFocus).toBe("chat");
    expect(state.chatFocus).toBe("history");
  });
});
