import type { KeyEvent } from "./input";
import { historyReactionMessage, parseReactionEmoji, reactToSelectedMessage, type ReactionEffects } from "./reactions";
import type { AppState } from "./state";

export const DEFAULT_QUICK_REACTION = "❤️";
const DOUBLE_SPACE_MS = 400;
const pending = new WeakMap<AppState, { channelId: string; messageId: string; at: number }>();

export function resetQuickReaction(state: AppState): void {
  pending.delete(state);
}

export function configuredQuickReaction(value: unknown): string {
  const emoji = typeof value === "string" ? parseReactionEmoji(value) : null;
  return emoji && !emoji.id ? emoji.name : DEFAULT_QUICK_REACTION;
}

/** Consume Space only in normal history; never interfere with typing/selection. */
export function handleQuickReactionKey(
  state: AppState, key: KeyEvent, effects: ReactionEffects, now = Date.now(),
): boolean {
  if (key.event === "release") return false;
  const eligible = state.panelFocus === "chat" && state.chatFocus === "history"
    && state.editor.mode === "normal" && !state.imageModal && !state.whatsapp.loginModal
    && !state.sidebar.serverActionModal && !state.voiceMessagePrompt
    && !state.editor.pendingKeys && !state.editor.pendingOperator && !state.editor.pendingFind
    && !state.editor.pendingReplace && !state.editor.pendingTextObjectModifier && state.editor.count === null;
  if (!eligible || key.type !== "char" || key.char !== " ") {
    resetQuickReaction(state);
    return false;
  }
  if (key.event === "repeat") {
    resetQuickReaction(state);
    return true;
  }
  if (state.messageDeletePending) {
    state.messageDeletePending = null;
    effects.scheduleRender();
  }
  const message = historyReactionMessage(state);
  if (!message || message.localStatus || message.id.startsWith("local:")) {
    resetQuickReaction(state);
    return true;
  }
  const previous = pending.get(state);
  if (previous?.channelId === message.channelId && previous.messageId === message.id
    && now >= previous.at && now - previous.at <= DOUBLE_SPACE_MS) {
    resetQuickReaction(state);
    void reactToSelectedMessage(state, state.quickReactionEmoji, false, effects, {
      target: message, preservePrompt: true,
    });
  } else {
    pending.set(state, { channelId: message.channelId, messageId: message.id, at: now });
  }
  return true;
}
