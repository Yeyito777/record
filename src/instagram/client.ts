import type { InstagramSession } from "./auth";
import { INSTAGRAM_DOCS } from "./docids";
import {
  igMediaUrl, offlineThreadingId, parseInboxPage, parseMessage, parseRequestsPage, parseSearchUsers, parseThread,
  type IgInboxPage, type IgMessage, type IgThread, type IgUser,
} from "./model";
import { InstagramApiError, InstagramTransport, type InstagramTransportOptions } from "./transport";

export { InstagramApiError } from "./transport";

/** The three gatekeeper providers every IGD thread-list query takes (the web's values). */
const IGD_PROVIDERS = {
  __relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider: false,
  __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
  __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5,
  __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: true,
};

export interface InstagramSendReceipt { messageId: string; timestampMs: number }

/** A shared reel's single video (never a reel feed). */
export interface InstagramReelMedia { videoUrl: string; previewUrl: string | null; author: string; caption: string }

const numeric = (value: string) => /^\d{1,40}$/.test(value);

/** Instagram Direct over IGD GraphQL (`/api/graphql`); Quiet docs/API.md §7. */
export class InstagramClient {
  readonly transport: InstagramTransport;
  /** `device_id_for_iris_subscription`: a random lowercase UUID per client. */
  private readonly deviceId = crypto.randomUUID().toLowerCase();

  constructor(session: InstagramSession, options: InstagramTransportOptions | typeof fetch = {}) {
    const resolved = typeof options === "function" ? { fetcher: options } : options;
    this.transport = new InstagramTransport({ cookies: { ...session.cookies } }, resolved);
  }

  get readOnly(): boolean { return this.transport.readOnly; }

  /** First inbox page (15 threads, newest ≤5 messages each) + mailbox ids. */
  async inbox(): Promise<IgInboxPage> {
    const data = await this.transport.graphql(INSTAGRAM_DOCS.inbox, { device_id_for_iris_subscription: this.deviceId, ...IGD_PROVIDERS });
    const page = parseInboxPage(data);
    if (!page) throw new InstagramApiError("Instagram inbox format is unsupported.", false, "invalid");
    return page;
  }

  async inboxPage(mailboxId: string, cursor: string): Promise<IgInboxPage> {
    const data = await this.transport.graphql(INSTAGRAM_DOCS.inboxPage, {
      count: 15, cursor, folder: "INBOX", id: mailboxId, newer_than_timestamp_ms: null, ...IGD_PROVIDERS,
    });
    const page = parseInboxPage(data);
    if (!page) throw new InstagramApiError("Instagram inbox format is unsupported.", false, "invalid");
    return page;
  }

  /** A thread's newest 20 messages with full content. Reading doesn't send a receipt. */
  async thread(id: string, sequenceId: string): Promise<IgThread> {
    if (!numeric(id)) throw new Error("Invalid Instagram thread ID.");
    const data = await this.transport.graphql(INSTAGRAM_DOCS.thread, {
      thread_fbid: id, min_uq_seq_id: sequenceId || "0",
      __relay_internal__pv__IGDEnableOffMsysChatThemesQErelayprovider: false,
      __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20,
    }, `/direct/t/${id}/`);
    const thread = parseThread(data?.get_slide_thread_nullable?.as_ig_direct_thread ?? {});
    if (!thread) throw new InstagramApiError("Instagram couldn't open this chat.", false, "invalid");
    return thread;
  }

  /** 20 messages older than `cursor`. */
  async olderMessages(id: string, cursor: string): Promise<{ messages: IgMessage[]; cursor: string | null; hasOlder: boolean }> {
    if (!numeric(id)) throw new Error("Invalid Instagram thread ID.");
    const data = await this.transport.graphql(INSTAGRAM_DOCS.olderMessages, {
      id, after: cursor, before: null, first: 20, last: null, newer_than_message_id: null, older_than_message_id: null,
      __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20,
    }, `/direct/t/${id}/`);
    const thread = data?.fetch__SlideThread?.as_ig_direct_thread;
    if (!thread) throw new InstagramApiError("Instagram history format is unsupported.", false, "invalid");
    const connection = thread.slide_messages ?? {};
    const messages = (Array.isArray(connection.edges) ? connection.edges : [])
      .map((edge: any) => parseMessage(edge?.node ?? {})).filter((m: IgMessage | null): m is IgMessage => !!m);
    const next = typeof connection.page_info?.end_cursor === "string" ? connection.page_info.end_cursor : null;
    return { messages, cursor: next, hasOlder: Boolean(connection.page_info?.has_next_page) && !!next && messages.length > 0 };
  }

  /** Message requests (pending folder; hidden/spam are only counted). Reading accepts nothing. */
  async requests(nowMs = Date.now()): Promise<{ pending: IgThread[]; spamCount: number }> {
    const data = await this.transport.graphql(INSTAGRAM_DOCS.requests, {
      device_id_for_iris_subscription: this.deviceId,
      __relay_internal__pv__IGD30DayAgoTimestampMsrelayprovider: nowMs - 30 * 86_400_000, ...IGD_PROVIDERS,
    }, "/direct/requests/");
    const page = parseRequestsPage(data);
    if (!page) throw new InstagramApiError("Instagram requests format is unsupported.", false, "invalid");
    return page;
  }

  /** People search (Polaris top search; users only), for /dm. */
  async searchUsers(query: string): Promise<IgUser[]> {
    const data = await this.transport.graphql(INSTAGRAM_DOCS.search, {
      data: { context: "blended", include_reel: "true", query, rank_token: "", search_session_id: crypto.randomUUID(), search_surface: "web_top_search" },
      hasQuery: true,
    }, "/");
    return parseSearchUsers(data);
  }

  /**
   * Send text. `threadId` for an existing chat, else `recipientIds` starts one.
   * Success requires a real message id; anything else is failed or uncertain,
   * and the caller never resubmits automatically (same otid on a manual retry).
   */
  async sendText(text: string, target: { threadId: string } | { recipientIds: string[] }, options: { replyTo?: string; otid?: string } = {}): Promise<InstagramSendReceipt> {
    const threadId = "threadId" in target ? target.threadId : null;
    if (threadId !== null && !numeric(threadId)) throw new Error("Invalid Instagram thread ID.");
    const data = await this.transport.graphql(INSTAGRAM_DOCS.sendText, {
      ig_thread_igid: threadId, recipient_igids: "recipientIds" in target ? target.recipientIds : null,
      text: { sensitive_string_value: text }, offline_threading_id: options.otid ?? offlineThreadingId(),
      reply_to_message_id: options.replyTo ?? null, replied_to_item_id: null, replied_to_client_context: null,
      mentions: [], mentioned_user_ids: [], commands: null, forwarded_from_thread_id: null,
      is_forwarded_from_own_message: null, send_attribution: null, sampled: null,
    }, threadId ? `/direct/t/${threadId}/` : "/direct/new/");
    const ack = data?.[INSTAGRAM_DOCS.sendText.root];
    const messageId = typeof ack?.message_id === "string" ? ack.message_id : "";
    if (!messageId) throw new InstagramApiError("Instagram did not confirm sending. Refresh before retrying to avoid duplicates.", false, "uncertain");
    return { messageId, timestampMs: Number(ack.timestamp_ms) || Date.now() };
  }

  /** Add (`created`) or remove (`deleted`) the viewer's emoji reaction. */
  async react(threadId: string, messageId: string, emoji: string, remove: boolean): Promise<void> {
    if (!numeric(threadId)) throw new Error("Invalid Instagram thread ID.");
    await this.transport.graphql(INSTAGRAM_DOCS.react, {
      input: { emoji, item_id: "", message_id: messageId, reaction_status: remove ? "deleted" : "created", thread_id: threadId },
    }, `/direct/t/${threadId}/`);
  }

  /** Read receipt up to `messageId` (takes the 39-digit legacy thread id). */
  async markRead(threadId: string, legacyThreadId: string, messageId: string): Promise<number | null> {
    if (!numeric(threadId) || !numeric(legacyThreadId)) return null;
    const data = await this.transport.graphql(INSTAGRAM_DOCS.markRead, {
      data: { item_id: "", message_id: messageId }, metadata: { ig_thread_igid: legacyThreadId },
    }, `/direct/t/${threadId}/`);
    const watermark = Number(data?.[INSTAGRAM_DOCS.markRead.root]?.watermark_timestamp_ms);
    return Number.isFinite(watermark) && watermark > 0 ? watermark : null;
  }

  /** Accept a message request (moves it to the inbox). */
  async acceptRequest(threadId: string): Promise<void> {
    if (!numeric(threadId)) throw new Error("Invalid Instagram thread ID.");
    await this.transport.graphql(INSTAGRAM_DOCS.acceptRequest, {
      thread_fbid: threadId, offline_threading_id: offlineThreadingId(),
    }, "/direct/requests/");
  }

  /** One shared reel's video by shortcode (`media/<pk>/info/`): a single item, never a feed. */
  async reel(code: string): Promise<InstagramReelMedia> {
    const pk = shortcodeToPk(code);
    if (!pk) throw new InstagramApiError("This reel link isn't valid.", false, "invalid");
    const json = await this.transport.rest(`media/${pk}/info/`, `/reel/${code}/`);
    const item = Array.isArray(json?.items) ? json.items[0] : null;
    const videoUrl = igMediaUrl(item?.video_versions?.[0]?.url);
    if (!videoUrl) throw new InstagramApiError("This reel can't be played here (it may be private or gone).", false, "invalid");
    return {
      videoUrl, previewUrl: igMediaUrl(item?.image_versions2?.candidates?.[0]?.url),
      author: typeof item?.user?.username === "string" ? item.user.username : "",
      caption: typeof item?.caption?.text === "string" ? item.caption.text : "",
    };
  }
}

/** Shortcode → media pk: base64url digits; only the first 11 characters encode the pk. */
export function shortcodeToPk(code: string): string | null {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return null;
  let value = 0n;
  for (const char of code.slice(0, 11)) value = value * 64n + BigInt(alphabet.indexOf(char));
  return value > 0n && value < (1n << 64n) ? value.toString() : null;
}
