import { PROVIDER_SYSTEM_MESSAGE_TYPE, type DiscordChannel, type DiscordMessage, type DiscordMessageAttachment, type DiscordMessageEmbed } from "../discord";
import { INSTAGRAM_GUILD_ID, instagramChannelId, instagramThreadIdFromChannelId } from "../chatproviders";
import { sanitizeTerminalLabel, sanitizeTerminalText } from "../whatsapp/sanitize";
import {
  callTitle, contentSummary, displayNameForFbid, effectiveCallOutcome, isThreadUnread, threadTitle, unreadMessages,
  type IgMessage, type IgReplyPreview, type IgShare, type IgThread, type IgUser,
} from "./model";
import { isInstagramThreadMuted, type InstagramMuteOverrides } from "./mute";

/** A send Instagram hasn't acknowledged (yet). Never resubmitted automatically. */
export interface InstagramOutgoing {
  localId: string;
  threadId: string;
  text: string;
  reply: IgReplyPreview | null;
  /** Client message id: a refreshed thread carrying it means the send landed. */
  otid: string;
  createdAt: number;
  status: "pending" | "failed" | "unconfirmed";
  error?: string;
}

export interface InstagramAccount { id: string; fbid: string; username: string; name: string }

export interface InstagramUiState {
  connection: { status: "idle" | "connecting" | "connected" | "error"; error?: string };
  account: InstagramAccount | null;
  threadsById: Record<string, IgThread>;
  muteOverridesByThreadId: InstagramMuteOverrides;
  /** Pending message requests, newest first (shown after the inbox). */
  requestIds: string[];
  hiddenRequestCount: number;
  outgoing: InstagramOutgoing[];
  /** A "/dm <user>" chat that doesn't exist on Instagram until the first send. */
  draftUsers: Record<string, IgUser>;
  /** True while the sidebar shows the disk cache, before the first resync. */
  fromCache: boolean;
}

export function createInstagramUiState(): InstagramUiState {
  return {
    connection: { status: "idle" }, account: null, threadsById: {}, muteOverridesByThreadId: {},
    requestIds: [], hiddenRequestCount: 0, outgoing: [], draftUsers: {}, fromCache: false,
  };
}

export const INSTAGRAM_DRAFT_PREFIX = "u";

export function isDraftThreadId(id: string): boolean { return id.startsWith(INSTAGRAM_DRAFT_PREFIX); }

function threadViewerFbid(state: InstagramUiState, thread: IgThread): string {
  return thread.viewerFbid || state.account?.fbid || "";
}

/** Unread count for badges: messages (and calls) from others since the viewer's watermark. */
export function instagramUnreadCount(state: InstagramUiState, thread: IgThread): number {
  if (isInstagramThreadMuted(state.muteOverridesByThreadId, { thread_id: thread.id, muted: thread.muted })) return 0;
  const withViewer = thread.viewerFbid ? thread : { ...thread, viewerFbid: state.account?.fbid ?? "" };
  if (!isThreadUnread(withViewer)) return 0;
  return Math.max(1, unreadMessages(withViewer).length);
}

function channel(state: InstagramUiState, thread: IgThread, position: number, request = false): DiscordChannel {
  const name = sanitizeTerminalLabel(threadTitle(thread)) || "Instagram chat";
  return {
    id: instagramChannelId(thread.id), guildId: INSTAGRAM_GUILD_ID, parentId: null,
    name: request ? `Request · ${name}` : name, topic: null, position, type: thread.isGroup ? 3 : 1, nsfw: false,
    muted: isInstagramThreadMuted(state.muteOverridesByThreadId, { thread_id: thread.id, muted: thread.muted }),
    recipients: thread.users.map(user => ({ ...author(user), bot: false })),
    ...(!thread.isGroup && thread.users[0]?.picUrl ? { pictureUrl: thread.users[0].picUrl } : {}),
  };
}

/** Inbox chats by recent activity, then message requests, then "/dm" drafts. */
export function instagramChannels(state: InstagramUiState): DiscordChannel[] {
  const requests = new Set(state.requestIds);
  const inbox = Object.values(state.threadsById)
    .filter(thread => thread.folder === "inbox" && !requests.has(thread.id))
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  const pending = state.requestIds.map(id => state.threadsById[id]).filter((thread): thread is IgThread => !!thread);
  const drafts = Object.entries(state.draftUsers).map(([id, user]) => draftThread(state, id, user));
  return [
    ...inbox.map((thread, index) => channel(state, thread, index)),
    ...pending.map((thread, index) => channel(state, thread, inbox.length + index, true)),
    ...drafts.map((thread, index) => ({ ...channel(state, thread, inbox.length + pending.length + index), name: `New · ${sanitizeTerminalLabel(thread.users[0]?.username ?? "chat")}` })),
  ];
}

export function draftThread(state: InstagramUiState, id: string, user: IgUser): IgThread {
  return {
    id, legacyId: "", rawTitle: "", users: [user], viewerFbid: state.account?.fbid ?? "", isGroup: false,
    lastActivityMs: 0, messages: [], receipts: {}, markedUnread: false, muted: false, folder: "inbox",
    canSend: true, nicknames: {}, hasOlder: false, cursor: null, detailLoaded: true,
  };
}

/** The thread for a channel id (inbox, request or /dm draft). */
export function instagramThreadForChannel(state: InstagramUiState, channelId: string): IgThread | null {
  const id = instagramThreadIdFromChannelId(channelId);
  if (!id) return null;
  if (state.threadsById[id]) return state.threadsById[id]!;
  const draft = state.draftUsers[id];
  return draft ? draftThread(state, id, draft) : null;
}

function author(user: Pick<IgUser, "id" | "username" | "name">) {
  return {
    id: user.id,
    username: sanitizeTerminalLabel(user.username || user.id),
    displayName: sanitizeTerminalLabel(user.name || user.username || user.id), bot: false,
  };
}

function messageAuthor(state: InstagramUiState, thread: IgThread, fbid: string, fallbackName: string): DiscordMessage["author"] {
  if (fbid && fbid === threadViewerFbid(state, thread) && state.account) {
    return author({ id: state.account.id, username: state.account.username, name: state.account.name || "Me" });
  }
  const user = thread.users.find(candidate => candidate.fbid === fbid);
  if (user) {
    const shown = author(user);
    const nickname = thread.nicknames[user.id];
    return nickname ? { ...shown, displayName: sanitizeTerminalLabel(nickname) } : shown;
  }
  const name = sanitizeTerminalLabel(fallbackName) || "Instagram user";
  return { id: fbid || "unknown", username: name, displayName: name, bot: false };
}

const clean = (text: string) => sanitizeTerminalText(text, { multiline: true });
const label = (text: string) => sanitizeTerminalLabel(text);

function timeOfDay(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function attachment(message: IgMessage, index: number, kind: "image" | "video" | "audio", url: string,
  extra: Partial<DiscordMessageAttachment> = {}, name?: string): DiscordMessageAttachment {
  const ext = kind === "image" ? (/\.webp(?:\?|$)/.test(url) ? "webp" : "jpg") : "mp4";
  const contentType = kind === "image" ? (ext === "webp" ? "image/webp" : "image/jpeg") : kind === "video" ? "video/mp4" : "audio/mp4";
  return {
    id: `ig:${message.id}:${index}`,
    // CDN URLs are re-signed; the disk cache keys on the path, not the signature.
    cacheKey: `ig:${message.id}:${index}:${(() => { try { return new URL(url).pathname; } catch { return url; } })()}`,
    filename: name ?? `instagram-${index + 1}.${ext}`, contentType, size: 0, url, ...extra,
  };
}

/**
 * The picture's size, or (without one) the shape Instagram draws it in, as
 * pixels: chat holds that box while it loads. 9:16 for reels, stories and
 * vertical video, 4:5 posts, 3:4 phone photos, 1.91:1 link cards.
 */
const SHAPES = {
  portrait: [1080, 1920], post: [1080, 1350], photo: [1080, 1440], link: [1200, 630], square: [1080, 1080],
  sticker: [512, 512], artwork: [640, 640],
} as const;

function pictureSize(width: number, height: number, shape: keyof typeof SHAPES): Partial<DiscordMessageAttachment> {
  if (width > 0 && height > 0) return { width, height };
  const [placeholderWidth, placeholderHeight] = SHAPES[shape];
  return { placeholderWidth, placeholderHeight };
}

function shareShape(share: IgShare): keyof typeof SHAPES {
  if (share.portrait || share.kind === "reel" || share.kind === "story") return "portrait";
  return share.kind === "post" ? "post" : share.kind === "link" ? "link" : "square";
}

/** A shared reel: one video fetched on open (`media/<pk>/info/`), never a feed. */
export const INSTAGRAM_REEL_ATTACHMENT_PREFIX = "ig-reel:";

interface Parts { content: string; attachments: DiscordMessageAttachment[]; embeds: DiscordMessageEmbed[]; system: boolean }

function shareParts(state: InstagramUiState, thread: IgThread, message: IgMessage, incoming: boolean): Parts {
  if (message.content.kind !== "share") throw new Error("not a share");
  const share = message.content.share;
  const attachments: DiscordMessageAttachment[] = [];
  const embeds: DiscordMessageEmbed[] = [];
  const lines: string[] = [];
  const by = share.author ? ` by @${label(share.author)}` : "";
  const preview = () => {
    if (share.preview && !share.expired) {
      attachments.push(attachment(message, 0, "image", share.preview, pictureSize(share.previewWidth, share.previewHeight, shareShape(share)), "instagram-preview.jpg"));
    }
  };
  switch (share.kind) {
    case "post":
      lines.push(`↪ Shared a post${by}`);
      if (share.caption) lines.push(clean(share.caption).split("\n").slice(0, 3).join("\n"));
      if (share.url) lines.push(share.url);
      preview();
      break;
    case "reel":
      lines.push(`▶ Shared a reel${by}${share.caption ? `: ${label(share.caption).slice(0, 120)}` : ""}`);
      preview();
      // Opened as a single video file — no reel URL in the text, so no feed in a browser.
      if (share.code) {
        attachments.push({
          id: `${INSTAGRAM_REEL_ATTACHMENT_PREFIX}${share.code}`, cacheKey: `ig-reel:${share.code}`,
          filename: `reel${share.author ? `-${label(share.author)}` : ""}.mp4`, contentType: "video/mp4", size: 0,
          url: `https://www.instagram.com/reel/${encodeURIComponent(share.code)}/`,
        });
      }
      break;
    case "story": {
      const owner = share.username || share.author;
      const viewerOwns = owner && owner === state.account?.username;
      const who = viewerOwns ? "your" : owner ? `@${label(owner)}'s` : "a";
      const context = share.storyContext ?? "share";
      const mine = !incoming;
      const sentence = context === "reply" ? (mine ? `↩ You replied to ${who} story` : `↩ Replied to ${who} story`)
        : context === "reaction" ? (mine ? `You reacted to ${who} story` : `Reacted to ${who} story`)
        : context === "mention" ? (mine ? "You mentioned them in your story" : "Mentioned you in their story")
        : `Shared ${who} story`;
      lines.push(share.expired ? `${sentence} (no longer available)` : sentence);
      preview();
      break;
    }
    case "profile":
      lines.push(`👤 Shared a profile: @${label(share.username ?? "")}`);
      if (share.url) lines.push(share.url);
      break;
    case "link":
      if (share.url) lines.push(share.url);
      if (share.title || share.caption) {
        embeds.push({ type: "link", title: share.title ? label(share.title) : null, url: share.url ?? null,
          description: share.caption ? label(share.caption) : null, providerName: null, authorName: null });
      }
      preview();
      break;
    default:
      lines.push(`[${share.title ? label(share.title) : "Shared content unavailable"}]`);
  }
  if (share.text) lines.push(clean(share.text));
  return { content: lines.join("\n"), attachments, embeds, system: false };
}

function messageParts(state: InstagramUiState, thread: IgThread, message: IgMessage): Parts {
  const incoming = message.senderFbid !== threadViewerFbid(state, thread);
  const content = message.content;
  const none = (text: string, system = false): Parts => ({ content: text, attachments: [], embeds: [], system });
  switch (content.kind) {
    case "text": return none(clean(content.text));
    case "heart": return none("❤️");
    case "system": return none(clean(content.text), true);
    case "call": {
      const call = content.call;
      const outcome = effectiveCallOutcome(call, incoming, thread.isGroup);
      const icon = call.video ? "📹" : "☎";
      const caller = incoming ? label(displayNameForFbid(thread, message.senderFbid, message.senderName)) : "You";
      const parts = [`${outcome === "missed" && incoming ? "✕ " : ""}${icon} ${callTitle(call, incoming, thread.isGroup)}`];
      if (caller && (thread.isGroup || !incoming)) parts.push(caller);
      parts.push(timeOfDay(message.timestampMs));
      if (outcome === "ended" && call.duration) parts.push(label(call.duration));
      return none(parts.join(" · "), true);
    }
    case "media": {
      const attachments: DiscordMessageAttachment[] = [];
      content.items.forEach((item, index) => {
        const size = item.width && item.height ? { width: item.width, height: item.height } : {};
        if (item.video) {
          if (item.preview) attachments.push(attachment(message, index * 2, "image", item.preview, pictureSize(item.width, item.height, "portrait"), `video-${index + 1}-preview.jpg`));
          if (item.url) attachments.push(attachment(message, index * 2 + 1, "video", item.url, size, `instagram-video-${index + 1}.mp4`));
        } else if (item.url) {
          attachments.push(attachment(message, index * 2, "image", item.url, pictureSize(item.width, item.height, "photo")));
        }
      });
      return { content: "", attachments, embeds: [], system: false };
    }
    case "voice": {
      const seconds = Math.round(content.durationSecs);
      const text = `🎤 Voice message${seconds ? ` (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})` : ""}`;
      return { content: text, embeds: [], system: false,
        attachments: content.url ? [attachment(message, 0, "audio", content.url, content.durationSecs ? { durationSecs: content.durationSecs } : {}, "voice-message.mp4")] : [] };
    }
    case "animated": {
      const attachments: DiscordMessageAttachment[] = [];
      const size = content.width && content.height ? { width: content.width, height: content.height } : {};
      if (content.still) attachments.push(attachment(message, 0, "image", content.still, size, content.sticker ? "sticker.webp" : "gif.webp"));
      if (content.mp4 && !content.sticker) attachments.push(attachment(message, 1, "video", content.mp4, size, "gif.mp4"));
      return { content: attachments.length ? "" : "[GIF]", attachments, embeds: [], system: false };
    }
    case "sticker":
      return { content: content.url ? "" : `[Sticker${content.alt ? `: ${label(content.alt)}` : ""}]`, embeds: [], system: false,
        attachments: content.url ? [attachment(message, 0, "image", content.url, pictureSize(content.width ?? 0, content.height ?? 0, "sticker"), "sticker.webp")] : [] };
    case "disappearing":
      return none(`[View-once ${content.video ? "video" : "photo"} — open Instagram to view]`);
    case "share": return shareParts(state, thread, message, incoming);
    case "music":
      return { content: `🎵 ${label(content.title) || "Song"}${content.artist ? ` — ${label(content.artist)}` : ""}`, embeds: [], system: false,
        attachments: [
          ...(content.artwork ? [attachment(message, 0, "image", content.artwork, pictureSize(0, 0, "artwork"), "artwork.jpg")] : []),
          ...(content.audio ? [attachment(message, 1, "audio", content.audio, { durationSecs: 30 }, "song-preview.mp4")] : []),
        ] };
    case "unavailable": return none("[Message unavailable]");
    case "unsupported":
      // Inbox previews carry a reduced fragment: Instagram's own line says what it was.
      return none(clean(message.snippet || `[${content.text}]`));
  }
}

export function instagramMessageToTimeline(state: InstagramUiState, thread: IgThread, message: IgMessage): DiscordMessage {
  const parts = messageParts(state, thread, message);
  const viewerFbid = threadViewerFbid(state, thread);
  const reactions = new Map<string, { count: number; me: boolean }>();
  for (const reaction of message.reactions) {
    const name = label(reaction.emoji);
    if (!name) continue;
    const current = reactions.get(name) ?? { count: 0, me: false };
    current.count++;
    current.me ||= reaction.senderFbid === viewerFbid;
    reactions.set(name, current);
  }
  const quoted = message.replyTo;
  const quotedAuthor = quoted ? messageAuthor(state, thread, quoted.senderFbid, quoted.senderName) : null;
  const quotedTimestamp = quoted ? thread.messages.find(candidate => candidate.id === quoted.id)?.timestampMs ?? null : null;
  return {
    id: message.id, channelId: instagramChannelId(thread.id), guildId: INSTAGRAM_GUILD_ID,
    type: parts.system ? PROVIDER_SYSTEM_MESSAGE_TYPE : 0,
    content: message.forwarded && parts.content ? `[Forwarded] ${parts.content}` : parts.content,
    author: messageAuthor(state, thread, message.senderFbid, message.senderName),
    timestamp: message.timestampMs, editedTimestamp: message.edited ? message.timestampMs : null,
    mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], mentionUsers: [],
    reply: quoted ? {
      messageId: quoted.id, channelId: instagramChannelId(thread.id),
      authorId: quotedAuthor?.id ?? null, authorDisplayName: quotedAuthor?.displayName ?? null,
      timestamp: quotedTimestamp, summary: label(quoted.summary).slice(0, 160) || "(attachment)",
    } : null,
    call: null, attachments: parts.attachments, stickerNames: [],
    embedsCount: parts.embeds.length, embeds: parts.embeds,
    reactions: [...reactions].map(([name, reaction]) => ({ ...reaction, emoji: { id: null, name, animated: false } })),
  };
}

function outgoingToTimeline(state: InstagramUiState, thread: IgThread, send: InstagramOutgoing): DiscordMessage {
  const me = state.account;
  return {
    id: send.localId, channelId: instagramChannelId(thread.id), guildId: INSTAGRAM_GUILD_ID, type: 0,
    content: clean(send.text), author: author({ id: me?.id ?? "me", username: me?.username ?? "me", name: me?.name || "Me" }),
    timestamp: send.createdAt, editedTimestamp: null,
    mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], mentionUsers: [],
    reply: send.reply ? {
      messageId: send.reply.id, channelId: instagramChannelId(thread.id), authorId: null,
      authorDisplayName: label(send.reply.senderName) || null, timestamp: null, summary: label(send.reply.summary).slice(0, 160),
    } : null,
    call: null, attachments: [], stickerNames: [], embedsCount: 0,
    localStatus: send.status, ...(send.error ? { localError: send.error } : {}),
  };
}

export function instagramTimelineMessages(state: InstagramUiState, channelId: string): DiscordMessage[] {
  const thread = instagramThreadForChannel(state, channelId);
  if (!thread) return [];
  const messages = thread.messages.map(message => instagramMessageToTimeline(state, thread, message));
  const outgoing = state.outgoing.filter(send => send.threadId === thread.id).map(send => outgoingToTimeline(state, thread, send));
  return [...messages, ...outgoing].sort((a, b) => {
    const aLocal = a.localStatus ? 1 : 0, bLocal = b.localStatus ? 1 : 0;
    // Pending/failed sends stay below everything Instagram has confirmed.
    if (aLocal !== bLocal) return aLocal - bLocal;
    return a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

/** A one-line preview for a thread's newest item (statusline / notices). */
export function instagramThreadPreview(state: InstagramUiState, thread: IgThread): string {
  const newest = thread.messages.at(-1);
  if (!newest) return "";
  if (newest.content.kind === "unsupported" && newest.snippet) return label(newest.snippet);
  if (newest.content.kind === "call") {
    return callTitle(newest.content.call, newest.senderFbid !== threadViewerFbid(state, thread), thread.isGroup);
  }
  return label(contentSummary(newest.content));
}

export { unreadMessages };
