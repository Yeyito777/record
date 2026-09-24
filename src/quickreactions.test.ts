import { describe, expect, test } from "bun:test";
import { whatsappChannelId } from "./chatproviders";
import type { DiscordMessage } from "./discord";
import { configuredQuickReaction, handleQuickReactionKey, resetQuickReaction } from "./quickreactions";
import { createInitialState, focusHistory } from "./state";

function setup() {
  const state = createInitialState(null, "/tmp/record-quick-test.json");
  const channelId = whatsappChannelId("friend@s.whatsapp.net");
  const message: DiscordMessage = {
    id: "message-1", channelId, type: 0, content: "hello", timestamp: Date.now(),
    editedTimestamp: null, author: { id: "other", username: "other", displayName: "Other", bot: false },
    mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [],
    reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
  };
  state.timeline.channelId = channelId;
  state.timeline.messages = [message];
  state.historyMessageBounds = [{ messageId: message.id, start: 0, end: 2, contentStart: 0, contentEnd: 2 }];
  focusHistory(state);
  const sent: { id: string; emoji: string }[] = [];
  const effects = {
    scheduleRender() {},
    async reactWhatsAppMessage(target: DiscordMessage, emoji: string) { sent.push({ id: target.id, emoji }); },
  };
  const space = (at: number) => handleQuickReactionKey(state, { type: "char", char: " " }, effects, at);
  return { state, message, sent, effects, space };
}

describe("quick reactions", () => {
  test("two spaces heart the selected message without altering the draft", async () => {
    const { state, sent, space } = setup();
    state.editor.buffer = "unfinished draft";
    state.editor.cursor = 3;
    expect(space(100)).toBe(true);
    expect(sent).toEqual([]);
    space(300);
    await Promise.resolve();
    expect(sent).toEqual([{ id: "message-1", emoji: "❤️" }]);
    expect(state.editor.buffer).toBe("unfinished draft");
    expect(state.editor.cursor).toBe(3);
    expect(state.chatFocus).toBe("history");
    space(350);
    expect(sent).toHaveLength(1);
  });

  test("uses the configured emoji and keeps an existing reaction composer intact", async () => {
    const { state, sent, space } = setup();
    state.quickReactionEmoji = "👍";
    state.reactionComposer = true;
    state.reactionTarget = { messageId: "another", channelId: state.timeline.channelId!, authorDisplayName: "A", summary: "" };
    state.editor.buffer = "👍";
    space(100); space(200);
    await Promise.resolve();
    expect(sent).toEqual([{ id: "message-1", emoji: "👍" }]);
    expect(state.reactionComposer).toBe(true);
    expect(state.reactionTarget.messageId).toBe("another");
    expect(state.editor.buffer).toBe("👍");
  });

  test("requires consecutive taps within the window on the same message", () => {
    const { state, message, sent, effects, space } = setup();
    space(100); space(600);
    expect(sent).toEqual([]);
    handleQuickReactionKey(state, { type: "char", char: "j" }, effects, 650);
    space(700);
    expect(sent).toEqual([]);
    state.timeline.messages.push({ ...message, id: "second" });
    state.historyMessageBounds[0]!.messageId = "second";
    space(750);
    expect(sent).toEqual([]);
    resetQuickReaction(state); // mouse/focus interaction
    space(800);
    expect(sent).toEqual([]);
  });

  test("ignores prompt typing, visual mode, pending motions and key repeats", () => {
    const { state, sent, effects, space } = setup();
    state.chatFocus = "prompt";
    expect(space(0)).toBe(false);
    expect(space(100)).toBe(false);
    state.chatFocus = "history";
    state.editor.mode = "visual";
    expect(space(200)).toBe(false);
    state.editor.mode = "normal";
    state.editor.pendingFind = "f";
    expect(space(250)).toBe(false);
    state.editor.pendingFind = null;
    space(300);
    handleQuickReactionKey(state, { type: "char", char: " ", event: "repeat" }, effects, 350);
    space(400);
    expect(sent).toEqual([]);
  });

  test("rejects pending messages and tolerates missing selection", () => {
    const { state, message, space, sent } = setup();
    message.localStatus = "pending";
    space(0); space(100);
    delete message.localStatus;
    state.historyMessageBounds = [];
    space(200); space(300);
    expect(sent).toEqual([]);
  });

  test("loads standard configured emoji and falls back for invalid settings", () => {
    expect(configuredQuickReaction(":thumbsup:")).toBe("👍");
    expect(configuredQuickReaction("🫶🏽")).toBe("🫶🏽");
    for (const value of [undefined, null, 42, "bad", "<:custom:123>"]) {
      expect(configuredQuickReaction(value)).toBe("❤️");
    }
  });
});
