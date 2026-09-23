import { isWhatsAppChannelId } from "./chatproviders";
import { decodeCustomEmojiMarkers } from "./customemoji";
import { setChannelMessageReaction, type DiscordMessage, type DiscordMessageReactionEmoji } from "./discord";
import { emojiCompletions } from "./emojis";
import { clearPrompt } from "./promptstate";
import type { SessionEffects } from "./session";
import { setNotice, type AppState } from "./state";

export function selectedReactionMessage(state: AppState): DiscordMessage | null {
  if (state.reactionTarget) {
    const target = state.reactionTarget;
    return state.timeline.messages.find((message) =>
      message.id === target.messageId && message.channelId === target.channelId
      && message.channelId === state.timeline.channelId) ?? null;
  }
  // A prompt-focused row can drift as live messages change height. Require
  // the identity captured on leaving history, rather than guessing a target.
  if (state.chatFocus !== "history") return null;
  const bound = state.historyMessageBounds.find(({ start, end }) =>
    state.historyCursor.row >= start && state.historyCursor.row < end);
  return state.timeline.messages.find((message) =>
    message.id === bound?.messageId && message.channelId === state.timeline.channelId) ?? null;
}

/** Accept one Unicode grapheme (including flags/ZWJ/skin tones) or a Discord token. */
export function parseReactionEmoji(input: string): DiscordMessageReactionEmoji | null {
  let text = decodeCustomEmojiMarkers(input).trim();
  const custom = text.match(/^<(a?):([A-Za-z0-9_]+):(\d+)>$/);
  if (custom) return { id: custom[3]!, name: custom[2]!, animated: custom[1] === "a" };
  const shortcode = text.match(/^:([A-Za-z0-9_+-]+):$/);
  if (shortcode) {
    text = emojiCompletions(shortcode[1]!).find((item) =>
      item.desc === `:${shortcode[1]!.toLowerCase()}:`)?.name ?? "";
  }
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  if (segments.length !== 1 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(text)) return null;
  return { id: null, name: text, animated: false };
}

const pending = new WeakMap<AppState, Set<string>>();

export interface ReactionEffects extends SessionEffects {
  reactWhatsAppMessage?: (message: DiscordMessage, emoji: string) => Promise<void>;
}

export async function reactToSelectedMessage(
  state: AppState, input: string, remove: boolean, effects: ReactionEffects,
): Promise<void> {
  const message = selectedReactionMessage(state);
  const fail = (text: string) => {
    setNotice(state, text, "warning");
    effects.scheduleRender();
  };
  if (!message) return fail("Select a message in history before reacting.");
  if (message.localStatus || message.id.startsWith("local:")) return fail("Wait until the message is sent before reacting.");
  const whatsapp = isWhatsAppChannelId(message.channelId);
  // WhatsApp has one reaction per sender; no emoji is needed to remove it.
  const emoji = remove && whatsapp && !input ? null : parseReactionEmoji(input);
  if (!emoji && !(whatsapp && remove && !input)) return fail("Choose one emoji (type :name then Tab).");
  if (whatsapp && emoji?.id) return fail("WhatsApp reactions require a standard emoji, not a Discord custom emoji.");
  const token = state.auth.savedToken;
  if (!whatsapp && !token) return fail("Log in to Discord before reacting.");
  if (whatsapp && !effects.reactWhatsAppMessage) return fail("WhatsApp is unavailable.");

  const key = `${message.channelId}/${message.id}`;
  const requests = pending.get(state) ?? new Set<string>();
  pending.set(state, requests);
  if (requests.has(key)) return fail("A reaction is already being sent for this message.");
  requests.add(key);
  const buffer = state.editor.buffer;
  try {
    if (whatsapp) {
      if (remove && emoji && !message.reactions?.some((reaction) => reaction.me && reaction.emoji.name === emoji.name)) {
        return fail("You haven't reacted with that emoji.");
      }
      await effects.reactWhatsAppMessage!(message, remove ? "" : emoji!.name);
    } else {
      await setChannelMessageReaction(token!, message.channelId, message.id, emoji!, remove);
      // Gateway events remain authoritative. Replaying REST acknowledgements
      // as deltas can resurrect an older reaction when opposite operations'
      // gateway echoes arrive after their REST responses.
      if (state.auth.savedToken !== token) return;
    }
    if (state.editor.buffer === buffer && state.timeline.channelId === message.channelId) clearPrompt(state);
    setNotice(state, remove ? "Reaction removed." : "Reaction added.", "success");
  } catch (error) {
    fail(`Could not ${remove ? "remove" : "add"} reaction: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    requests.delete(key);
    effects.scheduleRender();
  }
}
