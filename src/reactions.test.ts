import { afterEach, describe, expect, test } from "bun:test";
import { submitCurrentBuffer, type AppEffects } from "./actions";
import { whatsappChannelId } from "./chatproviders";
import { customEmojiMarker } from "./customemoji";
import { applyDiscordMessagePatch, type DiscordMessage, type DiscordMessagePatch } from "./discord";
import { parseReactionEmoji, reactToSelectedMessage } from "./reactions";
import { createInitialState, focusHistory, focusPrompt } from "./state";
import { beginReactionComposer } from "./reactionprompt";
import { reconcileOptimisticReactionPatch } from "./optimisticreactions";
import { renderTimelineLines } from "./timeline";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function setup(channelId = "channel-1") {
  const state = createInitialState("token", "/tmp/record-reactions-test.json");
  const message: DiscordMessage = {
    id: "message-1", channelId, type: 0, content: "hello",
    mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [],
    timestamp: Date.now(), editedTimestamp: null,
    author: { id: "other", username: "other", displayName: "Other", bot: false },
    reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
    reactions: [{ count: 2, me: false, emoji: { id: null, name: "👍", animated: false } }],
  };
  state.timeline.channelId = channelId;
  state.timeline.messages = [message];
  state.historyMessageBounds = [{ messageId: message.id, start: 0, end: 2, contentStart: 0, contentEnd: 2 }];
  state.historyCursor.row = 1;
  state.editor.buffer = "/react 👍";
  focusHistory(state);
  focusPrompt(state);
  return { state, message };
}

const effects = { scheduleRender() {} };

describe("reactions", () => {
  test("never routes Instagram reactions through Discord", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const { state, message } = setup("ig:123");
    await reactToSelectedMessage(state, "👍", false, effects, { target: message });
    await reactToSelectedMessage(state, "👍", true, effects, { target: message });
    expect(requests).toBe(0);
    expect(state.notice.text).toContain("Instagram reactions");
    expect(message.reactions?.[0]?.count).toBe(2);
  });

  test("accepts Unicode sequences, shortcodes and custom emoji", () => {
    for (const text of ["👍🏽", "❤️", "👨‍👩‍👧‍👦", "🇨🇦", "1️⃣", "🫠"]) {
      expect(parseReactionEmoji(text)?.name).toBe(text);
    }
    expect(parseReactionEmoji(":thumbsup:")?.name).toBe("👍");
    expect(parseReactionEmoji(":heart:")?.name).toBe("❤️");
    expect(parseReactionEmoji("<a:dance:123>")).toEqual({ id: "123", name: "dance", animated: true });
    expect(parseReactionEmoji(customEmojiMarker({ id: "123", name: "dance", animated: false }))?.id).toBe("123");
    for (const text of ["", "hello", "👍 👍", "👍❤️", ":not_an_emoji:", "1", "a"]) {
      expect(parseReactionEmoji(text)).toBeNull();
    }
  });

  test("adds/removes via encoded Discord REST paths with immediate counts and no success notice", async () => {
    const requests: { url: string; method: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init!.method! });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const { state } = setup();
    await reactToSelectedMessage(state, "👍", false, effects);
    expect(requests[0]).toEqual({
      url: `https://discord.com/api/v9/channels/channel-1/messages/message-1/reactions/${encodeURIComponent("👍")}/@me`,
      method: "PUT",
    });
    expect(state.timeline.messages[0]?.reactions?.[0]).toMatchObject({ count: 3, me: true });
    expect(state.notice.text).not.toContain("Reaction added");
    expect(state.editor.buffer).toBe("");
    await reactToSelectedMessage(state, "👍", true, effects);
    expect(requests[1]?.method).toBe("DELETE");
    expect(state.timeline.messages[0]?.reactions?.[0]).toMatchObject({ count: 2, me: false });
    await reactToSelectedMessage(state, "<:dance:123>", false, effects);
    expect(requests[2]?.url).toEndWith("/reactions/dance%3A123/@me");
  });

  test("delayed gateway echoes after opposite REST operations are applied only once", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const { state, message } = setup();
    await reactToSelectedMessage(state, "👍", false, effects);
    await reactToSelectedMessage(state, "👍", true, effects);
    await reactToSelectedMessage(state, "👍", false, effects);
    const patch: DiscordMessagePatch = {
      id: message.id, channelId: message.channelId,
      reactionUpdate: { type: "add", emoji: parseReactionEmoji("👍")!, me: true },
    };
    const added = applyDiscordMessagePatch(state.timeline.messages[0]!, reconcileOptimisticReactionPatch(state, patch));
    expect(added.reactions?.[0]).toMatchObject({ count: 3, me: true });
    patch.reactionUpdate = { type: "remove", emoji: parseReactionEmoji("👍")!, me: true };
    const removed = applyDiscordMessagePatch(added, reconcileOptimisticReactionPatch(state, patch));
    expect(removed.reactions?.[0]).toMatchObject({ count: 3, me: true });
    patch.reactionUpdate = { type: "add", emoji: parseReactionEmoji("👍")!, me: true };
    expect(applyDiscordMessagePatch(removed, reconcileOptimisticReactionPatch(state, patch)).reactions?.[0]).toMatchObject({ count: 3, me: true });
  });

  test("failure preserves the command and existing reactions", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Missing Permissions" }), { status: 403 })) as unknown as typeof fetch;
    const { state } = setup();
    await reactToSelectedMessage(state, "👍", false, effects);
    expect(state.editor.buffer).toBe("/react 👍");
    expect(state.timeline.messages[0]?.reactions?.[0]).toMatchObject({ count: 2, me: false });
    expect(state.notice.text).toContain("Could not add reaction");
  });

  test("rejects no selection, pending messages and invalid emoji without sending", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const { state, message } = setup();
    await reactToSelectedMessage(state, "hello", false, effects);
    message.localStatus = "pending";
    await reactToSelectedMessage(state, "👍", false, effects);
    delete message.localStatus;
    state.reactionTarget = null;
    await reactToSelectedMessage(state, "👍", false, effects);
    expect(state.notice.text).toContain("Select a message");
    expect(calls).toBe(0);
  });

  test("routes WhatsApp adds/removals without Discord and rejects custom emoji", async () => {
    const { state, message } = setup(whatsappChannelId("friend@s.whatsapp.net"));
    const sent: string[] = [];
    const waEffects = { ...effects, async reactWhatsAppMessage(target: DiscordMessage, emoji: string) {
      expect(target.id).toBe(message.id);
      sent.push(emoji);
    } };
    state.auth.savedToken = null;
    await reactToSelectedMessage(state, ":heart:", false, waEffects);
    await reactToSelectedMessage(state, "", true, waEffects);
    await reactToSelectedMessage(state, "<:dance:123>", false, waEffects);
    expect(sent).toEqual(["❤️", ""]);
  });

  test("in-flight reactions retain their original target and preserve a new draft", async () => {
    const { state } = setup();
    let finish!: () => void;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise<void>((resolve) => { finish = resolve; });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const first = reactToSelectedMessage(state, "👍", false, effects);
    await reactToSelectedMessage(state, "👍", false, effects);
    expect(calls).toBe(1);
    state.timeline.channelId = "other";
    state.timeline.messages = [];
    state.editor.buffer = "new draft";
    finish();
    await first;
    expect(state.timeline.messages).toEqual([]);
    expect(state.editor.buffer).toBe("new draft");
  });

  test("slash commands route through submission, not message sending", async () => {
    const { state } = setup(whatsappChannelId("friend@s.whatsapp.net"));
    const sent: string[] = [];
    const appEffects: AppEffects = {
      ...effects, quit() {}, applyThemeCursor() {}, bootstrapSession() {},
      loginWhatsApp() {}, logoutWhatsApp() {},
      sendWhatsAppMessage() { throw new Error("must not send text"); },
      async reactWhatsAppMessage(_message, emoji) { sent.push(emoji); },
    };
    state.editor.buffer = "/react :heart:";
    submitCurrentBuffer(state, appEffects);
    await Promise.resolve();
    expect(sent).toEqual(["❤️"]);
    state.editor.buffer = "/unreact";
    submitCurrentBuffer(state, appEffects);
    await Promise.resolve();
    expect(sent).toEqual(["❤️", ""]);
    state.editor.buffer = "/react 👍";
    state.pendingImages = [{ mediaType: "image/png", base64: "abc", sizeBytes: 2, filename: "test.png" }];
    submitCurrentBuffer(state, appEffects);
    await Promise.resolve();
    expect(sent).toEqual(["❤️", ""]);
    expect(state.notice.text).toContain("Remove attached images");
  });

  test("captures identity before composing and refuses a deleted or cross-channel target", async () => {
    const { state, message } = setup(whatsappChannelId("friend@s.whatsapp.net"));
    const sent: string[] = [];
    const waEffects = { ...effects, async reactWhatsAppMessage(target: DiscordMessage) { sent.push(target.id); } };
    // A live edit shifts the selected message away from the cursor's row.
    state.timeline.messages.push({ ...message, id: "different-message" });
    state.historyMessageBounds[0]!.messageId = "different-message";
    await reactToSelectedMessage(state, "👍", false, waEffects);
    expect(sent).toEqual(["message-1"]);
    state.timeline.messages.shift();
    await reactToSelectedMessage(state, "👍", false, waEffects);
    state.timeline.channelId = "another-channel";
    await reactToSelectedMessage(state, "👍", false, waEffects);
    expect(sent).toEqual(["message-1"]);
  });

  test("bare reaction composer sends emoji, not text, and exits after success", async () => {
    const { state } = setup(whatsappChannelId("friend@s.whatsapp.net"));
    const sent: string[] = [];
    const appEffects: AppEffects = {
      ...effects, quit() {}, applyThemeCursor() {}, bootstrapSession() {},
      loginWhatsApp() {}, logoutWhatsApp() {},
      sendWhatsAppMessage() { throw new Error("must not send text"); },
      async reactWhatsAppMessage(_message, emoji) { sent.push(emoji); },
    };
    state.reactionComposer = true;
    for (const invalid of [":", "hello", "/refresh"]) {
      state.editor.buffer = invalid;
      submitCurrentBuffer(state, appEffects);
      await Promise.resolve();
      expect(state.reactionComposer).toBe(true);
      expect(sent).toEqual([]);
    }
    state.editor.buffer = ":heart:";
    submitCurrentBuffer(state, appEffects);
    await Promise.resolve();
    expect(sent).toEqual(["❤️"]);
    expect(state.editor.buffer).toBe("");
    expect(state.reactionComposer).toBe(false);
  });

  test("bare composer retains its mode and buffer after transport failure", async () => {
    const { state } = setup();
    state.reactionComposer = true;
    state.editor.buffer = "👍";
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await reactToSelectedMessage(state, state.editor.buffer, false, effects);
    expect(state.reactionComposer).toBe(true);
    expect(state.editor.buffer).toBe("👍");
  });

  test("moving focus while composing does not replace the reaction target", () => {
    const { state, message } = setup();
    const target = state.reactionTarget;
    state.reactionComposer = true;
    state.timeline.messages.push({ ...message, id: "different" });
    state.historyMessageBounds[0]!.messageId = "different";
    focusHistory(state);
    focusPrompt(state);
    expect(state.reactionTarget).toBe(target);
  });

  test("completion does not clear a newer composer with the same emoji", async () => {
    const { state } = setup();
    state.reactionComposer = true;
    state.editor.buffer = "👍";
    let finish!: () => void;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const sending = reactToSelectedMessage(state, "👍", false, effects);
    state.reactionTarget = { ...state.reactionTarget!, messageId: "new-target" };
    finish();
    await sending;
    expect(state.reactionComposer).toBe(true);
    expect(state.editor.buffer).toBe("👍");
  });

  test("optimistic reaction restores a suspended draft before the request completes", async () => {
    const { state, message } = setup();
    state.editor.buffer = "draft in progress";
    state.editor.cursor = 4;
    const draftEditor = state.editor;
    beginReactionComposer(state, message);
    state.editor.buffer = "👍";
    let finish!: () => void;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const sending = reactToSelectedMessage(state, "👍", false, effects);
    expect(state.editor).toBe(draftEditor);
    expect(state.editor.buffer).toBe("draft in progress");
    expect(state.editor.cursor).toBe(4);
    expect(state.timeline.messages[0]?.reactions?.[0]).toMatchObject({ count: 3, me: true });
    state.editor.buffer = "continued typing";
    finish();
    await sending;
    expect(state.editor.buffer).toBe("continued typing");
    expect(state.notice.text).not.toContain("Reaction added");
  });

  test("bottom-pinned last-message reactions reveal the new row, but scrolled-up readers stay put", async () => {
    const { state, message } = setup();
    message.reactions = [];
    message.content = "first\nsecond\nthird\nfourth";
    renderTimelineLines(state.timeline, 40, 3, state.notice);
    state.timeline.scrollOffset = state.timeline.maxScroll;
    const oldMax = state.timeline.maxScroll;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const sending = reactToSelectedMessage(state, "👍", false, effects);
    expect(state.timeline.scrollOffset).toBe(Number.MAX_SAFE_INTEGER);
    const rendered = renderTimelineLines(state.timeline, 40, 3, state.notice);
    expect(state.timeline.maxScroll).toBe(oldMax + 1);
    expect(state.timeline.scrollOffset).toBe(state.timeline.maxScroll);
    expect(rendered.lines.join("\n")).toContain("👍 1");
    await sending;
    state.timeline.scrollOffset = 0;
    await reactToSelectedMessage(state, "❤️", false, effects);
    expect(state.timeline.scrollOffset).toBe(0);
  });

  test("a rejected optimistic reaction rolls back without losing the saved draft", async () => {
    const { state, message } = setup();
    state.editor.buffer = "keep this draft";
    state.pendingImages = [{ mediaType: "image/png", base64: "abc", sizeBytes: 2 }];
    const images = state.pendingImages;
    beginReactionComposer(state, message);
    state.editor.buffer = "👍";
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await reactToSelectedMessage(state, "👍", false, effects);
    expect(state.editor.buffer).toBe("keep this draft");
    expect(state.pendingImages).toBe(images);
    expect(state.timeline.messages[0]?.reactions?.[0]).toMatchObject({ count: 2, me: false });
    expect(state.notice.text).toContain("Could not add reaction");
  });
});
