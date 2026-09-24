import type { DiscordChannel, DiscordMessage, DiscordMessageAttachment } from "../discord";
import { INSTAGRAM_GUILD_ID, instagramChannelId, instagramThreadIdFromChannelId } from "../chatproviders";
import { sanitizeTerminalLabel, sanitizeTerminalText } from "../whatsapp/sanitize";
import type { InstagramItem, InstagramThread, InstagramUser } from "./client";
import { isInstagramThreadMuted, type InstagramMuteOverrides } from "./mute";

export interface InstagramUiState {
  connection: { status: "idle" | "connecting" | "connected" | "error"; error?: string };
  account: { id: string; username: string; name: string } | null;
  threadsById: Record<string, InstagramThread>;
  muteOverridesByThreadId: InstagramMuteOverrides;
}

export function createInstagramUiState(): InstagramUiState {
  return { connection: { status: "idle" }, account: null, threadsById: {}, muteOverridesByThreadId: {} };
}

export function instagramChannels(state: InstagramUiState): DiscordChannel[] {
  return Object.values(state.threadsById)
    .sort((a, b) => Number(b.last_activity_at || 0) - Number(a.last_activity_at || 0))
    .map((thread, position) => ({
      id: instagramChannelId(thread.thread_id), guildId: INSTAGRAM_GUILD_ID, parentId: null,
      name: sanitizeTerminalLabel(thread.thread_title || thread.users.map(u => u.full_name || u.username).join(", ") || "Instagram chat"),
      topic: null, position, type: thread.is_group ? 3 : 1, nsfw: false,
      muted: isInstagramThreadMuted(state.muteOverridesByThreadId, thread),
      recipients: thread.users.map(user => ({ ...author(user), bot: false })),
    }));
}

function author(user: InstagramUser) {
  return {
    id: String(user.pk),
    username: sanitizeTerminalLabel(user.username || String(user.pk)),
    displayName: sanitizeTerminalLabel(user.full_name || user.username || String(user.pk)), bot: false,
  };
}

/** Only public HTTPS media URLs are handed to the generic attachment downloader. */
function mediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && [".cdninstagram.com", ".fbcdn.net", ".giphy.com"].some(domain => url.hostname.endsWith(domain))
      ? url.href : null;
  } catch { return null; }
}

function messageParts(item: InstagramItem): { content: string; attachments: DiscordMessageAttachment[] } {
  const attachments: DiscordMessageAttachment[] = [];
  let content = item.text || "";
  const addMedia = (media: any) => {
    const video = media?.video_versions?.[0]?.url;
    const image = media?.image_versions2?.candidates?.[0]?.url;
    const audio = media?.audio?.audio_src;
    const url = mediaUrl(audio || video || image);
    if (!url) return;
    const ext = audio ? "mp4" : video ? "mp4" : "jpg";
    attachments.push({
      id: `ig:${item.item_id}:${attachments.length}`, filename: `instagram-${item.item_id}.${ext}`,
      contentType: audio ? "audio/mp4" : video ? "video/mp4" : "image/jpeg", size: 0, url,
    });
  };
  switch (item.item_type) {
    case "text": break;
    case "link": content = item.link?.text || item.link?.link_context?.link_url || "[Link]"; break;
    case "media": addMedia(item.media); break;
    case "voice_media": addMedia(item.voice_media?.media); content ||= "[Voice message]"; break;
    // Do not download disappearing/view-once content or misrepresent encrypted messages.
    case "raven_media": content ||= "[Disappearing photo/video — open in Instagram]"; break;
    case "animated_media": {
      const url = mediaUrl(item.animated_media?.images?.fixed_height?.url || item.animated_media?.images?.original?.url);
      if (url) attachments.push({ id: `ig:${item.item_id}:gif`, filename: `instagram-${item.item_id}.gif`, contentType: "image/gif", size: 0, url });
      content ||= item.animated_media?.alt_text || "[GIF]";
      break;
    }
    case "clip":
    case "media_share": {
      const media = item.clip?.clip || item.media_share;
      addMedia(media);
      content ||= [media?.caption?.text, media?.code ? `https://www.instagram.com/p/${encodeURIComponent(media.code)}/` : ""].filter(Boolean).join("\n") || "[Shared post]";
      break;
    }
    case "reel_share":
    case "story_share": {
      const share = item.reel_share || item.story_share;
      addMedia(share?.media);
      content ||= share?.text || "[Shared story]";
      break;
    }
    case "action_log": content ||= item.action_log?.description || "[Instagram activity]"; break;
    case "video_call_event": content ||= "[Instagram call]"; break;
    default: content ||= `[${sanitizeTerminalLabel(item.item_type || "Unsupported message")} — open in Instagram]`;
  }
  return { content: sanitizeTerminalText(content || (attachments.length ? "" : "[Media unavailable]"), { multiline: true }), attachments };
}

export function instagramMessageToTimeline(state: InstagramUiState, thread: InstagramThread, item: InstagramItem): DiscordMessage {
  const user = String(item.user_id) === state.account?.id
    ? { pk: state.account.id, username: state.account.username, full_name: state.account.name }
    : [...thread.users, ...(thread.left_users || [])].find(u => String(u.pk) === String(item.user_id)) || { pk: item.user_id };
  const reactions = new Map<string, { count: number; me: boolean }>();
  for (const reaction of item.reactions?.emojis || []) {
    const name = sanitizeTerminalLabel(reaction.emoji || "");
    if (!name) continue;
    const current = reactions.get(name) || { count: 0, me: false };
    current.count++;
    current.me ||= String(reaction.sender_id) === state.account?.id;
    reactions.set(name, current);
  }
  for (const like of item.reactions?.likes || []) {
    const current = reactions.get("❤️") || { count: 0, me: false };
    current.count++;
    current.me ||= String(like.sender_id) === state.account?.id;
    reactions.set("❤️", current);
  }
  const quoted = item.replied_to_message as InstagramItem | undefined;
  const quotedUser = quoted && [...thread.users, user].find(u => String(u.pk) === String(quoted.user_id));
  return {
    id: String(item.item_id), channelId: instagramChannelId(thread.thread_id), guildId: INSTAGRAM_GUILD_ID,
    type: 0, ...messageParts(item), author: author(user),
    timestamp: Number(item.timestamp) / 1000 || 0, editedTimestamp: null,
    mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], mentionUsers: [],
    reply: quoted ? {
      messageId: String(quoted.item_id), channelId: instagramChannelId(thread.thread_id),
      authorId: String(quoted.user_id), authorDisplayName: quotedUser ? author(quotedUser).displayName : null,
      timestamp: Number(quoted.timestamp) / 1000 || null, summary: messageParts(quoted).content.slice(0, 160),
    } : null,
    call: null, stickerNames: [], embedsCount: 0,
    reactions: [...reactions].map(([name, reaction]) => ({ ...reaction, emoji: { id: null, name, animated: false } })),
  };
}

export function instagramTimelineMessages(state: InstagramUiState, channelId: string): DiscordMessage[] {
  const id = instagramThreadIdFromChannelId(channelId);
  const thread = id ? state.threadsById[id] : null;
  return thread ? thread.items.map(item => instagramMessageToTimeline(state, thread, item)).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)) : [];
}

/** Keep the historical cursor while inbox polling supplies only a recent window. */
export function mergeInstagramThread(state: InstagramUiState, incoming: InstagramThread, history = false): void {
  if (!/^\d+$/.test(incoming.thread_id)) return;
  const old = state.threadsById[incoming.thread_id];
  const items = new Map((old?.items || []).map(item => [String(item.item_id), item]));
  for (const item of incoming.items || []) if (item.item_id) items.set(String(item.item_id), item);
  const merged = { ...old, ...incoming, items: [...items.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)) };
  if (old && !history) {
    merged.oldest_cursor = old.oldest_cursor;
    merged.has_older = old.has_older;
  }
  state.threadsById[incoming.thread_id] = merged;
}
