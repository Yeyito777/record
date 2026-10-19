/**
 * Instagram Direct models parsed from IGD ("Slide") GraphQL payloads — a port
 * of Quiet's DirectModels/DirectCall (Quiet docs/API.md §7). Plain JSON so the
 * disk cache can store them. IDs stay strings: thread and user fbids exceed 2^53.
 */

export interface IgUser {
  /** Instagram user pk. */
  id: string;
  /** `interop_messaging_user_fbid`: what `sender_fbid` and read receipts use. */
  fbid: string;
  username: string;
  name: string;
  verified?: boolean;
}

export interface IgMediaItem {
  id: string;
  video: boolean;
  preview: string | null;
  url: string | null;
  width: number;
  height: number;
}

export type IgShareKind = "post" | "reel" | "story" | "profile" | "link" | "unavailable";
export type IgStoryContext = "share" | "reply" | "mention" | "reaction";

export interface IgShare {
  kind: IgShareKind;
  /** Shortcode for posts/reels. */
  code?: string;
  /** Story owner / profile username. */
  username?: string;
  storyId?: string;
  /** Link target (links), or the canonical instagram.com URL. */
  url?: string;
  title: string;
  caption: string;
  author: string;
  preview: string | null;
  previewWidth: number;
  previewHeight: number;
  /** Text sent with the share (a story reply, a note on a shared post). */
  text: string;
  storyContext?: IgStoryContext;
  expired: boolean;
}

export type IgCallOutcome = "missed" | "ended" | "started" | "unknown";

export interface IgCall {
  video: boolean;
  outcome: IgCallOutcome;
  /** Instagram's own (localized) sentence. */
  line: string;
  duration?: string;
}

export type IgContent =
  | { kind: "text"; text: string }
  | { kind: "heart" }
  | { kind: "system"; text: string }
  | { kind: "call"; call: IgCall }
  | { kind: "media"; items: IgMediaItem[] }
  | { kind: "voice"; url: string | null; durationSecs: number }
  | { kind: "animated"; mp4: string | null; still: string | null; width: number; height: number; sticker: boolean }
  | { kind: "sticker"; url: string | null; alt: string }
  | { kind: "disappearing"; video: boolean }
  | { kind: "share"; share: IgShare }
  | { kind: "music"; title: string; artist: string; artwork: string | null; audio: string | null }
  | { kind: "unavailable" }
  | { kind: "unsupported"; text: string };

export interface IgReplyPreview { id: string; senderFbid: string; senderName: string; summary: string }
export interface IgReaction { emoji: string; senderFbid: string }

export interface IgMessage {
  /** `message_id` ("mid.$…"). */
  id: string;
  senderFbid: string;
  senderName: string;
  timestampMs: number;
  offlineThreadingId?: string;
  content: IgContent;
  replyTo?: IgReplyPreview;
  reactions: IgReaction[];
  forwarded?: boolean;
  edited?: boolean;
  /** `igd_snippet`: Instagram's own preview line (inbox fallback). */
  snippet?: string;
}

export type IgFolder = "inbox" | "pending" | "spam";

export interface IgThread {
  /** `thread_fbid`: what IGD operations take. */
  id: string;
  /** 39-digit `thread_id`: what the read receipt takes. */
  legacyId: string;
  rawTitle: string;
  /** Other participants. */
  users: IgUser[];
  viewerFbid: string;
  isGroup: boolean;
  lastActivityMs: number;
  /** Oldest → newest. */
  messages: IgMessage[];
  /** participant fbid → read watermark (ms). */
  receipts: Record<string, number>;
  markedUnread: boolean;
  muted: boolean;
  folder: IgFolder;
  canSend: boolean;
  /** user pk → nickname. */
  nicknames: Record<string, string>;
  hasOlder: boolean;
  cursor: string | null;
  /** Messages came from the thread query (full content), not just an inbox preview. */
  detailLoaded: boolean;
  /** The thread query's viewer carries the account's username/name (the inbox's doesn't). */
  viewerUsername?: string;
  viewerName?: string;
}

type Json = Record<string, any>;
const obj = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const arr = (value: unknown): Json[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object") as Json[] : [];
const str = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const has = (json: Json, key: string): boolean => json[key] !== undefined && json[key] !== null;
const numericId = (value: string) => /^\d{1,40}$/.test(value);

/** Only public HTTPS Instagram/Meta CDN media URLs are ever downloaded. */
export function igMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
      && ["cdninstagram.com", "fbcdn.net", "instagram.com"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      ? url.href : null;
  } catch { return null; }
}

function user(json: Json): IgUser | null {
  const id = str(json.id) || str(json.pk);
  if (!numericId(id)) return null;
  return {
    id, fbid: str(json.interop_messaging_user_fbid), username: str(json.username),
    name: str(json.full_name), ...(json.is_verified ? { verified: true } : {}),
  };
}

// MARK: Calls

const VIDEO_WORDS = ["video", "videollamada", "videochamada", "visio", "videoanruf"];
const AUDIO_WORDS = ["audio", "voice", "vocale", "voz", "chiamata", "call", "llamada", "chamada", "appel", "anruf"];
const MISSED_WORDS = ["missed", "persa", "perso", "perdida", "perdido", "manque", "verpasst", "nao atendida", "no contestada",
  "non risposto", "senza risposta", "declined", "rifiutat", "unanswered"];
const ENDED_WORDS = ["ended", "terminat", "conclus", "finalizada", "finalizo", "termino", "encerrad", "termine", "beendet"];
const STARTED_WORDS = ["started", "avviat", "iniziat", "inicio", "comenzo", "iniciou", "demarre", "gestartet", "is calling", "sta chiamando"];

export function isCallContentType(contentType: string): boolean {
  const type = contentType.toUpperCase();
  return type.includes("CALL") && !type.includes("CALL_TO_ACTION");
}

/**
 * IG web call log items are admin text with Instagram's localized sentence
 * only: no structured type/direction/outcome (Quiet docs/API.md §7.10). Who
 * called = the sender; audio/video and the outcome come from keywords.
 */
export function parseCall(rawLine: string, contentType: string): IgCall {
  const line = rawLine.trim();
  const text = line.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const type = contentType.toUpperCase();
  const any = (words: string[]) => words.some(word => text.includes(word));
  const video = type.includes("AUDIO") || type.includes("VOICE") ? false
    : any(VIDEO_WORDS) ? true : any(AUDIO_WORDS) ? false : type.includes("VIDEO");
  let outcome: IgCallOutcome = any(MISSED_WORDS) ? "missed" : any(ENDED_WORDS) ? "ended" : any(STARTED_WORDS) ? "started" : "unknown";
  const duration = line.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/)?.[0]
    ?? line.match(/\b\d+\s?(?:min|mins|minutes|minuti|minutos|sec|secs|s|h|hr|ore|horas)\b/i)?.[0];
  if (duration && outcome === "unknown") outcome = "ended";
  return { video, outcome, line, ...(duration ? { duration } : {}) };
}

/** As the viewer experiences it: an incoming call not recorded as answered was missed. */
export function effectiveCallOutcome(call: IgCall, incoming: boolean, isGroup: boolean): IgCallOutcome {
  if (!incoming) return call.outcome;
  if (call.outcome === "unknown") return "missed";
  if (call.outcome === "started") return isGroup ? "started" : "missed";
  return call.outcome;
}

export function callTitle(call: IgCall, incoming: boolean, isGroup: boolean): string {
  switch (effectiveCallOutcome(call, incoming, isGroup)) {
    case "missed": return call.video ? "Missed video call" : "Missed call";
    case "ended": return call.video ? "Video call ended" : "Call ended";
    case "started": return call.video ? "Video call started" : "Call started";
    default: return call.video ? "Video call" : "Call";
  }
}

// MARK: Shares

/** `/p/<code>` post, `/reel/<code>` reel, `/stories/<user>/<pk>` story, `/<user>/` profile; else a link. */
export function classifyShareTarget(target: string): Pick<IgShare, "kind" | "code" | "username" | "storyId" | "url"> {
  let url: URL;
  try { url = new URL(target); } catch { return { kind: "unavailable" }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unavailable" };
  const host = url.hostname.toLowerCase();
  if (host === "l.instagram.com") {
    const wrapped = url.searchParams.get("u");
    if (wrapped) {
      try {
        const destination = new URL(wrapped);
        if (destination.protocol === "https:" || destination.protocol === "http:") return { kind: "link", url: destination.href };
      } catch { /* fall through */ }
    }
  }
  if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return { kind: "link", url: url.href };
  const parts = url.pathname.split("/").filter(Boolean);
  const at = (names: string[]) => parts.findIndex(part => names.includes(part));
  const post = at(["p", "tv"]);
  if (post >= 0 && parts[post + 1]) return { kind: "post", code: parts[post + 1], url: `https://www.instagram.com/p/${parts[post + 1]}/` };
  const reel = at(["reel", "reels"]);
  if (reel >= 0 && parts[reel + 1]) return { kind: "reel", code: parts[reel + 1], url: `https://www.instagram.com/reel/${parts[reel + 1]}/` };
  if (parts[0] === "stories" && parts[1]) return { kind: "story", username: parts[1], ...(parts[2] ? { storyId: parts[2] } : {}) };
  if (parts.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(parts[0]!)) {
    return { kind: "profile", username: parts[0], url: `https://www.instagram.com/${parts[0]}/` };
  }
  return { kind: "link", url: url.href };
}

function storyContext(contentType: string, hasText: boolean): IgStoryContext {
  if (contentType.includes("MENTION")) return "mention";
  if (contentType.includes("REACTION")) return "reaction";
  if (contentType.includes("REPLY") || hasText) return "reply";
  return "share";
}

function xma(content: Json, message: Json): IgContent {
  const x = obj(content.xma);
  const type = str(x.__typename);
  const contentType = str(message.content_type).toUpperCase();
  const note = str(content.xma_text_body);
  const first = (...keys: string[]) => keys.map(key => str(x[key])).find(Boolean) ?? "";
  const image = Object.keys(obj(x.preview_image)).length ? obj(x.preview_image) : obj(x.xmaPreviewImage);
  const target = first("target_url");
  const share: IgShare = {
    kind: "unavailable", title: first("title_text", "xmaTitle"), caption: first("caption_body_text", "subtitle_text"),
    author: first("header_title_text", "xmaHeaderTitle"),
    preview: igMediaUrl(image.url) ?? igMediaUrl(image.fallback_url),
    previewWidth: num(image.width), previewHeight: num(image.height), text: "", expired: false,
  };
  if (type === "SlideMessagePlaceholderXMA") return { kind: "share", share: { ...share, expired: true, caption: first("caption_body_text") } };
  if (type === "SlideMessageExpiredPlaceholderXMA") {
    return { kind: "share", share: { ...share, kind: "story", expired: true, text: note, storyContext: storyContext(contentType, Boolean(note)) } };
  }
  Object.assign(share, classifyShareTarget(target));
  if (share.kind === "link") share.text = note && note !== share.url && note !== target ? note : "";
  else if (note && note !== target) share.text = note;
  if (share.kind === "story") {
    const body = str(message.text_body);
    if (!share.text && body && body !== target) share.text = body;
    share.storyContext = storyContext(contentType, Boolean(share.text));
  }
  if (share.kind === "unavailable" && !share.preview && !share.title) {
    const body = str(message.text_body);
    return body ? { kind: "text", text: body } : { kind: "unsupported", text: "Shared content" };
  }
  if (share.kind === "unavailable" && (contentType.includes("STORY") || type === "SlideMessagePortraitXMA")) {
    share.kind = "story";
    if (share.author) share.username = share.author;
    share.storyContext = storyContext(contentType, Boolean(share.text));
  }
  return { kind: "share", share };
}

function mediaItem(json: Json, video: boolean): IgMediaItem | null {
  const preview = igMediaUrl(json.preview_cdn_url) ?? igMediaUrl(json.preview_cdn_fallback_url);
  const full = igMediaUrl(json.attachment_cdn_url) ?? igMediaUrl(json.attachment_cdn_fallback_url);
  if (!preview && !full) return null;
  return {
    id: str(json.attachment_fbid) || (full ?? preview)!, video,
    preview: preview ?? (video ? null : full), url: full ?? preview,
    width: num(json.preview_width), height: num(json.preview_height),
  };
}

/** The `content` union of a SlideMessage (Quiet docs/API.md §7.3, §7.9, §7.10). */
export function parseContent(message: Json): IgContent {
  const content = obj(message.content);
  const type = str(content.__typename);
  const contentType = str(message.content_type).toUpperCase();
  const text = str(message.text_body);
  if (contentType.includes("LIKE_HEART") || contentType.includes("HOT_LIKE") || contentType === "LIKE") return { kind: "heart" };
  if (isCallContentType(contentType) && (!type || type === "SlideMessageAdminText")) {
    const fragments = arr(content.text_fragments).map(fragment => str(fragment.plaintext)).join("");
    return { kind: "call", call: parseCall([fragments, text, str(message.igd_snippet)].find(Boolean) ?? "", contentType) };
  }
  switch (type) {
    case "SlideMessageText": {
      const body = str(content.text_body) || text;
      return body ? { kind: "text", text: body } : { kind: "unsupported", text: "Message" };
    }
    case "SlideMessageAdminText": {
      const line = arr(content.text_fragments).map(fragment => str(fragment.plaintext)).join("");
      return { kind: "system", text: line || text || "Conversation updated" };
    }
    case "SlideMessageImageContent": {
      const items = arr(content.attachments).map(item => mediaItem(item, false)).filter((item): item is IgMediaItem => !!item);
      return items.length ? { kind: "media", items } : { kind: "unsupported", text: "Sent a photo" };
    }
    case "SlideMessageVideosContent": {
      const items = arr(content.videos).map(item => mediaItem(item, true)).filter((item): item is IgMediaItem => !!item);
      return items.length ? { kind: "media", items } : { kind: "unsupported", text: "Sent a video" };
    }
    case "SlideMessageMultiMediaContent": {
      const items = arr(content.ordered_photo_video_attachments).map(item =>
        mediaItem(item, /video/i.test(str(item.__typename)) || has(item, "dash_manifest"))).filter((item): item is IgMediaItem => !!item);
      return items.length ? { kind: "media", items } : { kind: "unsupported", text: "Sent media" };
    }
    case "SlideMessageAudiosContent": {
      const clip = arr(content.audio_attachments)[0];
      return clip ? { kind: "voice", url: igMediaUrl(clip.attachment_cdn_url), durationSecs: num(clip.playable_duration_ms) / 1000 }
        : { kind: "unsupported", text: "Sent a voice message" };
    }
    case "SlideMessageAnimatedMediaContent": {
      const raw = arr(content.animated_media)[0] ?? obj(content.animated_media);
      const mp4 = igMediaUrl(raw.attachment_mp4_url);
      const still = igMediaUrl(raw.attachment_webp_url) ?? igMediaUrl(raw.preview_cdn_url);
      return mp4 || still ? { kind: "animated", mp4, still, width: num(raw.preview_width), height: num(raw.preview_height), sticker: Boolean(raw.is_sticker) }
        : { kind: "unsupported", text: "Sent a GIF" };
    }
    case "SlideMessageRavenImageContent": return { kind: "disappearing", video: false };
    case "SlideMessageRavenVideoContent": return { kind: "disappearing", video: true };
    case "SlideMessageXMAContent": return xma(content, message);
    case "SlideMessageMusicStickerXMAContent":
      return { kind: "music", title: str(content.title), artist: str(content.display_artist),
        artwork: igMediaUrl(content.preview_url), audio: igMediaUrl(content.web_30s_preview_download_url) };
    default:
      if (type.includes("Sticker")) {
        return { kind: "sticker", url: igMediaUrl(content.preview_url) ?? igMediaUrl(obj(content.preview_image).url), alt: str(content.alt_text) };
      }
      return text ? { kind: "text", text } : { kind: "unsupported", text: "This message isn't supported in Record yet" };
  }
}

/** One-line summary for previews and reply quotes. */
export function contentSummary(content: IgContent): string {
  switch (content.kind) {
    case "text": return content.text;
    case "heart": return "❤️";
    case "system": return content.text;
    case "call": return callTitle(content.call, false, false);
    case "media": return content.items.length > 1 ? `Sent ${content.items.length} photos` : content.items[0]?.video ? "Sent a video" : "Sent a photo";
    case "voice": return "Sent a voice message";
    case "animated": return content.sticker ? "Sent a sticker" : "Sent a GIF";
    case "sticker": return "Sent a sticker";
    case "disappearing": return content.video ? "Sent a video" : "Sent a photo";
    case "share": {
      const share = content.share;
      switch (share.kind) {
        case "post": return share.text || "Shared a post";
        case "reel": return share.text || "Shared a reel";
        case "story":
          if (share.storyContext === "reply" || share.storyContext === "reaction") return share.text || "Replied to a story";
          return share.storyContext === "mention" ? "Mentioned in a story" : "Shared a story";
        case "profile": return "Shared a profile";
        case "link": return share.text || share.url || "Shared a link";
        default: return "Shared content";
      }
    }
    case "music": return content.title ? `🎵 ${content.title}` : "Shared a song";
    case "unavailable": return "Message unavailable";
    case "unsupported": return content.text;
  }
}

export function isSystemContent(content: IgContent): boolean {
  return content.kind === "system" || content.kind === "call";
}

/** A SlideMessage node. */
export function parseMessage(json: Json, nowMs = Date.now()): IgMessage | null {
  const id = str(json.message_id) || str(json.id);
  if (!id) return null;
  const sender = obj(json.sender);
  const expiry = num(json.expiration_timestamp_ms);
  const content: IgContent = has(json, "tombstone_reason") || (expiry > 0 && expiry < nowMs) ? { kind: "unavailable" } : parseContent(json);
  const message: IgMessage = {
    id, senderFbid: str(json.sender_fbid) || str(sender.id), senderName: str(sender.name),
    timestampMs: num(json.timestamp_ms), content,
    reactions: arr(json.reactions).map(reaction => ({ emoji: str(reaction.reaction), senderFbid: str(reaction.sender_fbid) }))
      .filter(reaction => reaction.emoji),
  };
  const otid = str(json.offline_threading_id);
  if (otid) message.offlineThreadingId = otid;
  if (json.igd_is_forwarded) message.forwarded = true;
  if (arr(json.slide_edit_history).length) message.edited = true;
  const snippet = str(json.igd_snippet);
  if (snippet) message.snippet = snippet;
  const quoted = obj(json.replied_to_message);
  if (Object.keys(quoted).length) {
    message.replyTo = {
      id: str(quoted.message_id) || str(quoted.id),
      senderFbid: str(quoted.sender_fbid) || str(obj(quoted.sender).id),
      senderName: str(obj(quoted.sender).name),
      summary: has(quoted, "tombstone_reason") ? "Message unavailable" : contentSummary(parseContent(quoted)),
    };
  }
  return message;
}

const byTime = (a: IgMessage, b: IgMessage) => a.timestampMs - b.timestampMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** An `XFBIGDirectViewerThread` (`as_ig_direct_thread`). */
export function parseThread(json: Json, nowMs = Date.now()): IgThread | null {
  const id = str(json.thread_fbid) || str(json.id);
  if (!numericId(id)) return null;
  const viewer = obj(json.viewer);
  const viewerId = str(viewer.id) || str(json.viewer_id);
  const connection = obj(json.slide_messages);
  const messages = arr(connection.edges).map(edge => parseMessage(obj(edge.node), nowMs)).filter((m): m is IgMessage => !!m).sort(byTime);
  const info = obj(connection.page_info);
  const activity = num(json.last_activity_timestamp_ms);
  const tag = `${str(json.messaging_folder_tag)} ${str(json.system_folder)}`.toUpperCase();
  const receipts: Record<string, number> = {};
  for (const receipt of arr(json.slide_read_receipts)) {
    const fbid = str(receipt.participant_fbid);
    if (fbid) receipts[fbid] = num(receipt.watermark_timestamp_ms);
  }
  const nicknames: Record<string, string> = {};
  for (const entry of arr(json.nicknames)) if (str(entry.igid) && str(entry.nickname)) nicknames[str(entry.igid)] = str(entry.nickname);
  return {
    id, legacyId: str(json.thread_id), rawTitle: str(json.thread_title),
    users: arr(json.users).map(user).filter((u): u is IgUser => !!u && u.id !== viewerId),
    viewerFbid: str(viewer.interop_messaging_user_fbid),
    isGroup: Boolean(json.is_group) || str(json.thread_subtype).includes("GROUP"),
    lastActivityMs: activity || messages.at(-1)?.timestampMs || 0,
    messages, receipts, markedUnread: Boolean(json.marked_as_unread), muted: Boolean(json.is_muted),
    folder: tag.includes("SPAM") ? "spam" : tag.includes("PENDING") ? "pending" : "inbox",
    canSend: num(json.input_mode) === 0, nicknames,
    hasOlder: Boolean(info.has_next_page) && Boolean(str(info.end_cursor)), cursor: str(info.end_cursor) || null,
    detailLoaded: false,
    ...(str(viewer.username) ? { viewerUsername: str(viewer.username) } : {}),
    ...(str(viewer.full_name) ? { viewerName: str(viewer.full_name) } : {}),
  };
}

export interface IgThreadPage { threads: IgThread[]; cursor: string | null; hasNextPage: boolean }

export function parseThreadConnection(connection: Json, nowMs = Date.now()): IgThreadPage {
  const threads = arr(connection.edges).map(edge => {
    const node = obj(edge.node);
    return parseThread(has(node, "as_ig_direct_thread") ? obj(node.as_ig_direct_thread) : node, nowMs);
  }).filter((thread): thread is IgThread => !!thread);
  const info = obj(connection.page_info);
  const cursor = str(info.end_cursor) || null;
  return { threads, cursor, hasNextPage: Boolean(info.has_next_page) && !!cursor };
}

export interface IgInboxPage extends IgThreadPage {
  mailboxId: string;
  sequenceId: string;
  viewer: { id: string; fbid: string; username: string; name: string } | null;
}

export function parseInboxPage(data: Json, nowMs = Date.now()): IgInboxPage | null {
  const mailbox = has(data, "get_slide_mailbox_for_iris_subscription") ? obj(data.get_slide_mailbox_for_iris_subscription)
    : has(data, "fetch__SlideMailbox") ? obj(data.fetch__SlideMailbox) : null;
  if (!mailbox || !has(mailbox, "threads_by_folder")) return null;
  const page = parseThreadConnection(obj(mailbox.threads_by_folder), nowMs);
  const firstThread = obj(obj(arr(obj(mailbox.threads_by_folder).edges)[0]?.node).as_ig_direct_thread);
  const viewer = obj(firstThread.viewer);
  const viewerId = str(viewer.id) || str(firstThread.viewer_id);
  return {
    ...page, mailboxId: str(mailbox.id), sequenceId: str(mailbox.iris_inactive_subscription_uq_seq_id),
    viewer: viewerId ? { id: viewerId, fbid: str(viewer.interop_messaging_user_fbid), username: str(viewer.username), name: str(viewer.full_name) } : null,
  };
}

export function parseRequestsPage(data: Json, nowMs = Date.now()): { pending: IgThread[]; spamCount: number } | null {
  if (!has(data, "pendingMailbox") && !has(data, "spamMailbox")) return null;
  const pending = parseThreadConnection(obj(obj(data.pendingMailbox).threads_by_folder), nowMs).threads
    .map(thread => ({ ...thread, folder: "pending" as const }));
  return { pending, spamCount: parseThreadConnection(obj(obj(data.spamMailbox).threads_by_folder), nowMs).threads.length };
}

export function parseSearchUsers(data: Json): IgUser[] {
  return arr(obj(data.xdt_api__v1__fbsearch__topsearch_connection).users)
    .map(entry => user(obj(entry.user))).filter((u): u is IgUser => !!u);
}

// MARK: Thread logic

/** Messages from others newer than the viewer's read watermark (unread count). */
export function unreadMessages(thread: IgThread): IgMessage[] {
  if (thread.folder !== "inbox") return [];
  const watermark = thread.receipts[thread.viewerFbid];
  const newest = thread.messages.at(-1);
  if (!newest || newest.senderFbid === thread.viewerFbid) return [];
  if (watermark === undefined) return [];
  return thread.messages.filter(message => message.senderFbid !== thread.viewerFbid
    && message.content.kind !== "system" && message.timestampMs > watermark);
}

export function isThreadUnread(thread: IgThread): boolean {
  return thread.folder === "inbox" && (thread.markedUnread || unreadMessages(thread).length > 0);
}

/** The other side has read up to `timestampMs` (1:1 "Seen"). */
export function seenByOthers(thread: IgThread, timestampMs: number): boolean {
  const marks = thread.users.map(u => thread.receipts[u.fbid]).filter((mark): mark is number => mark !== undefined);
  if (!marks.length) return false;
  return thread.isGroup ? marks.some(mark => mark >= timestampMs) : marks.every(mark => mark >= timestampMs);
}

export function displayNameForFbid(thread: IgThread, fbid: string, fallback = ""): string {
  const found = thread.users.find(u => u.fbid === fbid);
  if (!found) return fallback;
  return thread.nicknames[found.id] || found.name || found.username || fallback;
}

export function threadTitle(thread: IgThread): string {
  if (thread.isGroup) {
    if (thread.rawTitle) return thread.rawTitle;
    const names = thread.users.slice(0, 3).map(u => (u.name || u.username).split(" ")[0] || u.username);
    const rest = thread.users.length - names.length;
    return names.join(", ") + (rest > 0 ? ` and ${rest} other${rest === 1 ? "" : "s"}` : "") || "Group chat";
  }
  const other = thread.users[0];
  return other ? thread.nicknames[other.id] || other.name || other.username || "Instagram user" : thread.rawTitle || "Instagram user";
}

/** Fold a fresh thread-query copy in: the server owns the refreshed range (unsends, reactions); older history is kept. */
export function mergeThreadDetail(old: IgThread | undefined, fresh: IgThread): IgThread {
  if (!old) return { ...fresh, detailLoaded: true };
  const merged: IgThread = { ...fresh, detailLoaded: true };
  if (!fresh.users.length) merged.users = old.users;
  if (!merged.viewerFbid) merged.viewerFbid = old.viewerFbid;
  if (!merged.legacyId) merged.legacyId = old.legacyId;
  // Detail may omit the folder tag: a request stays a request until accepted.
  if (old.folder !== "inbox" && fresh.folder === "inbox") merged.folder = old.folder;
  const oldest = fresh.messages[0];
  if (!old.detailLoaded) return merged;
  if (oldest) {
    const freshIds = new Set(fresh.messages.map(m => m.id));
    const older = old.messages.filter(m => m.timestampMs < oldest.timestampMs && !freshIds.has(m.id));
    merged.messages = [...older, ...fresh.messages];
    if (older.length) { merged.hasOlder = old.hasOlder; merged.cursor = old.cursor; }
  } else {
    merged.messages = old.messages;
    merged.hasOlder = old.hasOlder;
    merged.cursor = old.cursor;
  }
  return merged;
}

/** Fold an inbox-list copy in: list queries carry ≤5 newest messages with a reduced fragment. */
export function mergeThreadPreview(old: IgThread | undefined, fresh: IgThread): IgThread {
  if (!old) return { ...fresh, hasOlder: false, cursor: null, detailLoaded: false };
  const known = new Set(old.messages.map(m => m.id));
  const added = fresh.messages.filter(m => !known.has(m.id));
  return {
    ...fresh,
    users: fresh.users.length ? fresh.users : old.users,
    legacyId: fresh.legacyId || old.legacyId,
    viewerFbid: fresh.viewerFbid || old.viewerFbid,
    messages: added.length ? [...old.messages, ...added].sort(byTime) : old.messages,
    hasOlder: old.hasOlder, cursor: old.cursor, detailLoaded: old.detailLoaded,
  };
}

/** Prepend an older page (newest-first nodes from IGDMessageListOffMsysQuery). */
export function prependOlder(thread: IgThread, page: IgMessage[], cursor: string | null, hasOlder: boolean): IgThread {
  const known = new Set(thread.messages.map(m => m.id));
  return {
    ...thread,
    messages: [...page.filter(m => !known.has(m.id)), ...thread.messages].sort(byTime),
    cursor, hasOlder: hasOlder && !!cursor && page.length > 0,
  };
}

/** Client message ids, the web's IGDOfflineThreadingID: ms << 22 | 22 random bits, truncated to 63 bits. */
export function offlineThreadingId(nowMs = Date.now(), random = Math.floor(Math.random() * 2 ** 22)): string {
  const value = ((BigInt(Math.floor(nowMs)) << 22n) | BigInt(random & (2 ** 22 - 1))) & ((1n << 63n) - 1n);
  return value.toString();
}
