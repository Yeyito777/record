import { describe, expect, test } from "bun:test";

import { updateAutocomplete } from "./autocomplete";
import { createInitialState } from "./state";

describe("autocomplete", () => {
  test("suggests saved usernames for /login", () => {
    const state = createInitialState(null, "/tmp/record-config.json", {
      alice: "token-1",
      bob: "token-2",
    });
    state.editor.buffer = "/login a";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches).toEqual([
      { name: "alice", desc: "saved login" },
    ]);
  });

  test("shows all saved usernames after /login space", () => {
    const state = createInitialState(null, "/tmp/record-config.json", {
      alice: "token-1",
      bob: "token-2",
    });
    state.editor.buffer = "/login ";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches).toEqual([
      { name: "alice", desc: "saved login" },
      { name: "bob", desc: "saved login" },
    ]);
  });

  test("shows nested command args after completing a subcommand", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/channels show-hidden ";
    state.editor.cursor = state.editor.buffer.length;

    updateAutocomplete(state);

    expect(state.autocomplete?.matches).toEqual([
      { name: "on", desc: "Show inaccessible channel rows" },
      { name: "off", desc: "Hide inaccessible channel rows" },
    ]);
  });
});
