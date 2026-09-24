import { describe, expect, test } from "bun:test";
import type { DiscordMessage } from "./discord";
import { beginReactionComposer } from "./reactionprompt";
import { cancelPromptReaction, handlePromptPrefixBackspace } from "./promptbackspace";
import { restoreReactionDraft } from "./promptstate";
import { createInitialState } from "./state";

const message: DiscordMessage = {
  id: "m", channelId: "c", type: 0, content: "hello", timestamp: 0, editedTimestamp: null,
  author: { id: "a", username: "a", displayName: "A", bot: false },
  mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [],
  reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
};

describe("reaction draft suspension", () => {
  test("preserves draft text, cursor, undo, images, and reply target on cancellation", () => {
    const state = createInitialState(null, "/tmp/config.json");
    state.timeline.channelId = message.channelId;
    state.editor.buffer = "unfinished\nmessage";
    state.editor.cursor = 5;
    state.editor.undo.undoStack.push({ buffer: "unfinished", cursor: 4 });
    state.pendingImages = [{ base64: "abc", sizeBytes: 2, mediaType: "image/png", filename: "a.png" }];
    state.replyTarget = {
      messageId: "reply", channelId: "c", guildId: null, authorId: "a", authorDisplayName: "A",
      authorColor: "", summary: "reply", timestamp: 0, mention: false,
    };
    const editor = state.editor;
    const images = state.pendingImages;
    const reply = state.replyTarget;
    beginReactionComposer(state, message);
    expect(state.editor.buffer).toBe(":");
    expect(state.editor).not.toBe(editor);
    expect(state.pendingImages).toEqual([]);
    expect(state.replyTarget).toBeNull();
    state.editor.mode = "normal";
    expect(cancelPromptReaction(state)).toBe(true);
    expect(state.editor).toBe(editor);
    expect(state.editor.mode).toBe("normal");
    expect(state.editor.cursor).toBe(5);
    expect(state.editor.undo.undoStack).toEqual([{ buffer: "unfinished", cursor: 4 }]);
    expect(state.pendingImages).toBe(images);
    expect(state.replyTarget).toBe(reply);
    expect(state.reactionDraft).toBeNull();
  });

  test("backspace at zero restores the suspended draft and edit context", () => {
    const state = createInitialState(null, "/tmp/config.json");
    state.timeline.channelId = message.channelId;
    state.editor.buffer = "editing draft";
    state.editTarget = {
      messageId: "edit", channelId: "c", authorDisplayName: "A", authorColor: "",
      summary: "", originalContent: "old", timestamp: 0,
    };
    const target = state.editTarget;
    beginReactionComposer(state, message);
    expect(state.editTarget).toBeNull();
    state.editor.cursor = 0;
    expect(handlePromptPrefixBackspace(state)).toBe("reaction");
    expect(state.editor.buffer).toBe("editing draft");
    expect(state.editTarget).toBe(target);
  });

  test("reopening the composer preserves the original suspended draft", () => {
    const state = createInitialState(null, "/tmp/config.json");
    state.editor.buffer = "draft";
    beginReactionComposer(state, message);
    beginReactionComposer(state, { ...message, id: "another" });
    expect(restoreReactionDraft(state)).toBe(true);
    expect(state.editor.buffer).toBe("draft");
    expect(restoreReactionDraft(state)).toBe(false);
  });

  test("channel navigation cannot resurrect a suspended edit or reply in another chat", () => {
    const state = createInitialState(null, "/tmp/config.json");
    state.timeline.channelId = message.channelId;
    state.editor.buffer = "edited text";
    state.editTarget = {
      messageId: "edit", channelId: "c", authorDisplayName: "A", authorColor: "",
      summary: "", originalContent: "old", timestamp: 0,
    };
    state.replyTarget = {
      messageId: "reply", channelId: "c", guildId: null, authorId: "a", authorDisplayName: "A",
      authorColor: "", summary: "reply", timestamp: 0, mention: false,
    };
    beginReactionComposer(state, message);
    state.channelList.activeChannelId = "another-channel";
    expect(cancelPromptReaction(state)).toBe(true);
    expect(state.editor.buffer).toBe("edited text");
    expect(state.editTarget).toBeNull();
    expect(state.replyTarget).toBeNull();
  });
});
