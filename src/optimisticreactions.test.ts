import { describe, expect, test } from "bun:test";
import { applyDiscordMessagePatch, type DiscordMessage, type DiscordMessagePatch, type DiscordMessageReactionUpdate } from "./discord";
import { patchCachedChannelMessage, setCachedChannelMessages } from "./messagecache";
import { patchCachedChannelPin, setCachedChannelPins } from "./pincache";
import { beginOptimisticReaction, reconcileOptimisticReactionPatch, resetOptimisticReactions } from "./optimisticreactions";
import { createInitialState } from "./state";
import { patchTimelineMessage } from "./timeline";

const emoji = { id: null, name: "👍", animated: false };
function setup() {
  const state = createInitialState("token", "/tmp/optimistic-reactions-test");
  const message: DiscordMessage = {
    id: "m", channelId: "c", type: 0, content: "",
    mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], timestamp: 0,
    editedTimestamp: null, author: { id: "u", username: "u", displayName: "u", bot: false },
    reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
    reactions: [{ emoji, count: 2, me: false }],
  };
  state.timeline.channelId = "c";
  state.timeline.messages = [message];
  setCachedChannelMessages(state.messageCacheByChannelId, "c", [message]);
  setCachedChannelPins(state.channelPinCacheByChannelId, "c", [message]);
  const begin = (remove = false) => beginOptimisticReaction(state, message, emoji, remove);
  const gateway = (update: DiscordMessageReactionUpdate) => {
    const patch = reconcileOptimisticReactionPatch(state, { id: "m", channelId: "c", reactionUpdate: update });
    patchCachedChannelMessage(state.messageCacheByChannelId, patch);
    patchCachedChannelPin(state.channelPinCacheByChannelId, patch);
    patchTimelineMessage(state.timeline, patch);
  };
  const check = (count: number, me: boolean) => {
    for (const message of [state.timeline.messages[0]!, state.messageCacheByChannelId.c!.messages[0]!,
      state.channelPinCacheByChannelId.c!.messages[0]!]) {
      expect(message.reactions?.[0]?.count ?? 0).toBe(count);
      expect(message.reactions?.[0]?.me ?? false).toBe(me);
    }
  };
  return { state, message, begin, gateway, check };
}
const add = { type: "add", emoji, me: true } as const;
const remove = { type: "remove", emoji, me: true } as const;

describe("optimistic reactions", () => {
  test("patches all views immediately; REST then gateway cannot double count", () => {
    const { begin, gateway, check } = setup();
    const operation = begin();
    check(3, true);
    operation.finish();
    gateway(add);
    gateway(add);
    check(3, true);
  });

  test("gateway success before REST error wins", () => {
    const { begin, gateway, check } = setup();
    const operation = begin();
    gateway(add);
    operation.finish(new Error("timeout"));
    check(3, true);
  });

  test("late echoes across add/remove/add never revert newest intent", () => {
    const { begin, gateway, check } = setup();
    const first = begin();
    const second = begin(true);
    const third = begin();
    first.finish();
    third.finish();
    second.finish();
    gateway(remove);
    check(3, true);
    gateway(add);
    check(3, true);
    gateway(add);
    check(3, true);
    gateway({ ...add, me: false });
    check(4, true);
  });

  test("failed add only rolls back self, preserving other users", () => {
    const { begin, gateway, check } = setup();
    const operation = begin();
    gateway({ ...add, me: false });
    operation.finish(false);
    check(3, false);
    // The timeout may have hidden a successful REST response.
    gateway(add);
    check(4, true);
  });

  test("failed remove restores self without restoring removed other users", () => {
    const { begin, gateway, check } = setup();
    begin().finish();
    gateway(add);
    const operation = begin(true);
    gateway({ ...remove, me: false });
    operation.finish(false);
    check(2, true);
  });

  test("out-of-order failures don't restore a failed prior intent", () => {
    const { begin, check } = setup();
    const first = begin();
    const second = begin(true);
    first.finish(false);
    check(2, false);
    second.finish(false);
    check(2, false);
  });

  for (const clear of [{ type: "clear" }, { type: "clearEmoji", emoji }] as const) {
    test(`${clear.type} is authoritative over pending requests and delayed echoes`, () => {
      const { begin, gateway, check } = setup();
      const old = begin();
      gateway(clear);
      old.finish(false);
      gateway(add);
      check(0, false);
      begin().finish();
      gateway(add);
      check(1, true);
    });
  }

  test("reset/account cache replacement invalidates old REST callbacks", () => {
    const { state, begin, check } = setup();
    const operation = begin();
    state.messageCacheByChannelId = { ...state.messageCacheByChannelId };
    operation.finish(false);
    check(3, true);
    const removal = begin(true);
    resetOptimisticReactions(state);
    removal.finish(false);
    check(2, false);
  });

  test("token switch invalidates callbacks even before identity hydration", () => {
    const { state, begin, check } = setup();
    const operation = begin();
    state.auth.savedToken = "another-account";
    operation.finish(false);
    check(3, true);
  });

  test("deferred REST completion after successor and gateway events preserves newest UI", async () => {
    const { begin, gateway, check } = setup();
    let resolve!: () => void;
    const deferred = new Promise<void>((done) => { resolve = done; });
    const old = begin();
    const request = deferred.then(() => old.finish(true));
    const latest = begin(true);
    gateway(add);
    check(2, false);
    latest.finish(true);
    resolve();
    await request;
    gateway(remove);
    check(2, false);
  });

  test("self updates are idempotent without optimistic state; others remain additive", () => {
    const { message } = setup();
    const patch = (reactionUpdate: DiscordMessageReactionUpdate): DiscordMessagePatch =>
      ({ id: "m", channelId: "c", reactionUpdate });
    let next = applyDiscordMessagePatch(message, patch(add));
    next = applyDiscordMessagePatch(next, patch(add));
    expect(next.reactions?.[0]?.count).toBe(3);
    next = applyDiscordMessagePatch(next, patch(remove));
    next = applyDiscordMessagePatch(next, patch(remove));
    expect(next.reactions?.[0]?.count).toBe(2);
    next = applyDiscordMessagePatch(next, patch({ ...add, me: false }));
    expect(next.reactions?.[0]?.count).toBe(3);
  });
});
