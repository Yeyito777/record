/**
 * Local self-reaction intents and bounded gateway echo receipts. Discord gives
 * reaction events no request ID: match self echoes FIFO by add/remove direction.
 * Receipts expire after two minutes (or capacity eviction); beyond that an event
 * is indistinguishable from a genuine change made by another client.
 */
import type { DiscordMessage, DiscordMessagePatch, DiscordMessageReactionEmoji } from "./discord";
import { patchCachedChannelMessage } from "./messagecache";
import { patchCachedChannelPin } from "./pincache";
import type { AppState } from "./state";
import { patchTimelineMessage } from "./timeline";

type Intent = { me: boolean; done: boolean; failed: boolean; echoed: boolean; cancelled: boolean };
type Entry = { channelId: string; id: string; emoji: DiscordMessageReactionEmoji; base: boolean; intents: Intent[]; touched: number };
type Store = { account: string | null; token: string | null; cache: AppState["messageCacheByChannelId"]; entries: Map<string, Entry> };
const stores = new WeakMap<AppState, Store>();
const TTL = 120_000;
const emojiKey = (emoji: DiscordMessageReactionEmoji) => emoji.id ?? emoji.name;
const key = (channelId: string, id: string, emoji: DiscordMessageReactionEmoji) =>
  JSON.stringify([channelId, id, emojiKey(emoji)]);

export function resetOptimisticReactions(state: AppState): void {
  stores.delete(state);
}

function storeFor(state: AppState): Store {
  let store = stores.get(state);
  const account = state.auth.user?.id ?? null;
  if (!store || store.account !== account || store.token !== state.auth.savedToken || store.cache !== state.messageCacheByChannelId) {
    store = { account, token: state.auth.savedToken, cache: state.messageCacheByChannelId, entries: new Map() };
    stores.set(state, store);
  }
  for (const [key, entry] of store.entries) {
    if (Date.now() - entry.touched > TTL) store.entries.delete(key);
  }
  return store;
}

function desired(entry: Entry): boolean {
  return entry.intents.findLast((intent) => !intent.failed && !intent.cancelled)?.me ?? entry.base;
}

function patchSelf(state: AppState, entry: Entry): void {
  const patch: DiscordMessagePatch = {
    id: entry.id, channelId: entry.channelId,
    reactionUpdate: { type: desired(entry) ? "add" : "remove", emoji: entry.emoji, me: true },
  };
  patchCachedChannelMessage(state.messageCacheByChannelId, patch);
  patchCachedChannelPin(state.channelPinCacheByChannelId, patch);
  if (state.timeline.channelId === entry.channelId) patchTimelineMessage(state.timeline, patch);
}

export interface OptimisticReactionOperation {
  /** No argument / true = success; false or an error = failure. Idempotent. */
  finish(result?: unknown): void;
}

export function beginOptimisticReaction(
  state: AppState, message: DiscordMessage, emoji: DiscordMessageReactionEmoji, remove: boolean,
): OptimisticReactionOperation {
  const store = storeFor(state);
  const entryKey = key(message.channelId, message.id, emoji);
  let entry = store.entries.get(entryKey);
  if (!entry) {
    // Prefer the live copy: the caller may hold a pre-update message.
    const live = state.timeline.messages.find((m) => m.channelId === message.channelId && m.id === message.id)
      ?? state.messageCacheByChannelId[message.channelId]?.messages.find((m) => m.id === message.id)
      ?? message;
    entry = { channelId: message.channelId, id: message.id, emoji: { ...emoji },
      base: live.reactions?.find((r) => emojiKey(r.emoji) === emojiKey(emoji))?.me ?? false,
      intents: [], touched: Date.now() };
    store.entries.set(entryKey, entry);
  }
  // Bound both the message/emoji table and each receipt queue.
  while (store.entries.size > 512) store.entries.delete(store.entries.keys().next().value!);
  if (entry.intents.length >= 128) {
    const oldest = entry.intents.shift()!;
    if (!oldest.failed && !oldest.cancelled) entry.base = oldest.me;
  }
  const intent: Intent = { me: !remove, done: false, failed: false, echoed: false, cancelled: false };
  entry.intents.push(intent);
  entry.touched = Date.now();
  patchSelf(state, entry);
  const captured = entry;
  return {
    finish(result) {
      if (intent.done) return;
      intent.done = true;
      if (intent.cancelled || storeFor(state) !== store || store.entries.get(entryKey) !== captured
        || !captured.intents.includes(intent)) return;
      // An observed gateway echo is stronger evidence than a REST error/timeout.
      intent.failed = result !== undefined && result !== true && !intent.echoed;
      captured.touched = Date.now();
      patchSelf(state, captured);
    },
  };
}

/** Run once before the same gateway patch is applied to all three views. */
export function reconcileOptimisticReactionPatch(state: AppState, patch: DiscordMessagePatch): DiscordMessagePatch {
  const store = storeFor(state);
  const update = patch.reactionUpdate;
  if (!update) return patch;
  if (update.type === "clear" || update.type === "clearEmoji") {
    for (const entry of store.entries.values()) {
      if (entry.id !== patch.id || entry.channelId !== patch.channelId
        || (update.type === "clearEmoji" && emojiKey(entry.emoji) !== emojiKey(update.emoji))) continue;
      entry.base = false;
      // Keep receipts to absorb pre-clear events, but never resurrect cleared UI.
      for (const intent of entry.intents) intent.cancelled = true;
      entry.touched = Date.now();
    }
    return patch;
  }
  if (!update.me) return patch;
  const entry = store.entries.get(key(patch.channelId, patch.id, update.emoji));
  if (!entry) return patch;
  const receipt = entry.intents.find((intent) => !intent.echoed && intent.me === (update.type === "add"));
  if (!receipt) {
    // An unmatched self event is a real external change, not an echo.
    entry.base = update.type === "add";
    if (entry.intents.every((intent) => intent.done || intent.cancelled)) {
      store.entries.delete(key(patch.channelId, patch.id, update.emoji));
      return patch;
    }
  } else {
    receipt.echoed = true;
    receipt.failed = false;
  }
  entry.touched = Date.now();
  return { ...patch, reactionUpdate: { type: desired(entry) ? "add" : "remove", emoji: entry.emoji, me: true } };
}
