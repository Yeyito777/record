import { describe, expect, test } from "bun:test";

import { handlePromptPrefixBackspace } from "./promptbackspace";
import { createInitialState, type AppState } from "./state";

function stateWithReply(): AppState {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.replyTarget = {
    messageId: "message-1",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "user-1",
    authorDisplayName: "Alice",
    authorColor: "",
    summary: "hello",
    timestamp: 0,
    mention: false,
  };
  return state;
}

function stateWithEdit(): AppState {
  const state = createInitialState(null, "/tmp/record-config.json");
  state.editTarget = {
    messageId: "message-1",
    channelId: "channel-1",
    authorDisplayName: "Alice",
    authorColor: "",
    summary: "hello",
    originalContent: "hello",
    timestamp: 0,
  };
  return state;
}

describe("handlePromptPrefixBackspace", () => {
  test("removes a pending image before canceling a reply", () => {
    const state = stateWithReply();
    state.pendingImages = [
      { mediaType: "image/png", base64: "", sizeBytes: 1, filename: "image-1.png" },
    ];
    state.editor.cursor = 0;

    expect(handlePromptPrefixBackspace(state)).toBe("image");

    expect(state.pendingImages).toEqual([]);
    expect(state.replyTarget).not.toBeNull();
  });

  test("cancels a pending reply when backspacing at cursor zero with no images", () => {
    const state = stateWithReply();
    state.editor.cursor = 0;

    expect(handlePromptPrefixBackspace(state)).toBe("reply");

    expect(state.replyTarget).toBeNull();
  });

  test("removes a pending image before canceling an edit", () => {
    const state = stateWithEdit();
    state.pendingImages = [
      { mediaType: "image/png", base64: "", sizeBytes: 1, filename: "image-1.png" },
    ];
    state.editor.cursor = 0;

    expect(handlePromptPrefixBackspace(state)).toBe("image");

    expect(state.pendingImages).toEqual([]);
    expect(state.editTarget).not.toBeNull();
  });

  test("cancels a pending edit when backspacing at cursor zero with no images", () => {
    const state = stateWithEdit();
    state.editor.cursor = 0;

    expect(handlePromptPrefixBackspace(state)).toBe("edit");

    expect(state.editTarget).toBeNull();
  });

  test("does not cancel a pending reply when the cursor is not at zero", () => {
    const state = stateWithReply();
    state.editor.buffer = "hello";
    state.editor.cursor = 1;

    expect(handlePromptPrefixBackspace(state)).toBeNull();

    expect(state.replyTarget).not.toBeNull();
  });

  test("does not cancel a pending edit when the cursor is not at zero", () => {
    const state = stateWithEdit();
    state.editor.buffer = "hello";
    state.editor.cursor = 1;

    expect(handlePromptPrefixBackspace(state)).toBeNull();

    expect(state.editTarget).not.toBeNull();
  });
});
