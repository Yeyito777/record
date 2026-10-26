import { INSTAGRAM_GUILD_ID, instagramChannelId, instagramGuild, instagramThreadIdFromChannelId, whatsappGuild } from "../chatproviders";
import { clearChannelList, setActiveChannelEntry, setChannelList } from "../channels";
import { loadCachedSidebarChannelLayout } from "../datacache";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, type DiscordMessage, type DiscordMessageAttachment } from "../discord";
import { clearChannelNotifications, setChannelNotificationCount } from "../notifications";
import { downloadAttachment as downloadGenericAttachment, type AttachmentDownloadOptions, type AttachmentOpenResult } from "../openable";
import { clearPrompt } from "../promptstate";
import { applySidebarChannelLayoutForGuild, setSidebarCachedChannels, setSidebarGuilds, sidebarCachedGuilds } from "../sidebar";
import { setNotice, type AppState } from "../state";
import { appendTimelineMessage, clearTimeline, isTimelineNearBottom, setTimelineMessages } from "../timeline";
import { sanitizeTerminalLabel } from "../whatsapp/sanitize";
import { dirname } from "node:path";
import { importInstagramSession, instagramAuthPath, loadInstagramSession, parseInstagramCookies, removeInstagramSession, saveInstagramSession, type InstagramLogin, type InstagramSession } from "./auth";
import { loadInstagramCache, saveInstagramCache, type InstagramCacheSnapshot } from "./cache";
import { sweepInstagramTemps } from "./files";
import { InstagramApiError, InstagramClient } from "./client";
import {
  createInstagramUiState, INSTAGRAM_DRAFT_PREFIX, INSTAGRAM_REEL_ATTACHMENT_PREFIX, instagramChannels, instagramThreadForChannel,
  instagramTimelineMessages, instagramUnreadCount, isDraftThreadId, type InstagramOutgoing,
} from "./integration";
import {
  contentSummary, displayNameForFbid, foldReactionNotices, isSystemContent, mergeThreadDetail, mergeThreadPreview, offlineThreadingId, prependOlder,
  type IgInboxPage, type IgThread, type IgUser,
} from "./model";
import { isInstagramThreadMuted, loadInstagramMutes, saveInstagramMutes } from "./mute";
import type { InstagramTransportOptions } from "./transport";

export interface InstagramControllerOptions {
  clientFactory?: (session: InstagramSession, options: InstagramTransportOptions) => InstagramClient;
  loadSession?: typeof loadInstagramSession;
  importSession?: typeof importInstagramSession;
  saveSession?: typeof saveInstagramSession;
  removeSession?: typeof removeInstagramSession;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  inboxPageDelayMs?: number;
  /** Polls between message-request checks (a few minutes). */
  requestPollEvery?: number;
  loadMutes?: typeof loadInstagramMutes;
  saveMutes?: typeof saveInstagramMutes;
  loadCache?: typeof loadInstagramCache;
  /** `null` disables the disk cache (tests). */
  saveCache?: typeof saveInstagramCache | null;
  cacheSaveDelayMs?: number;
  downloadAttachment?: typeof downloadGenericAttachment;
}

const MAX_INBOX_PAGES = 12;

let defaultControllerOptions: InstagramControllerOptions = {};
let tempsSwept = false;

/** Demo mode: a fake client and session behind the controller (src/demo/instagram.ts). */
export function setDefaultInstagramControllerOptions(options: InstagramControllerOptions): void {
  defaultControllerOptions = options;
}

export class InstagramController {
  private client: InstagramClient | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private historyRequests = new Set<string>();
  private seen = new Map<string, string>();
  private authWrites: Promise<void> = Promise.resolve();
  private retryAttempt = 0;
  private retrying = false;
  private lastErrorNotice: string | null = null;
  private mailboxId = "";
  private sequenceId = "";
  private inboxCursor: string | null = null;
  private inboxCursors = new Set<string>();
  private pagingGeneration: number | null = null;
  private muteWrites: Promise<void> = Promise.resolve();
  private muteSequence = 0;
  private mutePersistenceAvailable = true;
  private sendQueues = new Map<string, Promise<void>>();
  private reactionRequests = new Set<string>();
  private pollCount = 0;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheWrites: Promise<void> = Promise.resolve();
  private loadedCacheFor: string | null = null;

  private options: InstagramControllerOptions;

  constructor(private state: AppState, private render: () => void, options: InstagramControllerOptions = {}) {
    this.options = { ...defaultControllerOptions, ...options };
  }

  get isConnected(): boolean { return this.state.instagram.connection.status === "connected"; }
  get readOnly(): boolean { return this.client?.readOnly ?? false; }

  async autoConnect(): Promise<void> {
    if (this.state.instagram.connection.status === "connecting") return;
    const generation = ++this.generation;
    this.stopTimer();
    this.state.instagram.connection = { status: "connecting" };
    this.updateStatus();
    if (!tempsSwept) {
      tempsSwept = true;
      // Temp files of writes a kill or crash interrupted (session, cache, mutes).
      try { sweepInstagramTemps(dirname(instagramAuthPath())); } catch { /* best effort */ }
    }
    try {
      const session = await (this.options.loadSession || loadInstagramSession)();
      if (generation !== this.generation) return;
      if (session) {
        // Show the last session's chats at once; the inbox read below resyncs them.
        this.hydrateFromCache(session.cookies.ds_user_id ?? "");
        await this.connect(session, generation);
      } else {
        this.state.instagram.connection = { status: "idle" };
        this.updateStatus();
      }
    } catch (error) { if (generation === this.generation) this.failure(error); }
  }

  async login(login: InstagramLogin): Promise<void> {
    // Bad pasted input must not interrupt a working connection or overwrite auth.
    let pastedSession: InstagramSession | undefined;
    if (login.source === "cookies") {
      try { pastedSession = parseInstagramCookies(login.credential); }
      catch (error) { this.notice((error as Error).message, true); return; }
    }
    const generation = ++this.generation;
    this.stopTimer();
    this.client = null;
    this.refreshing = false;
    this.historyRequests.clear();
    this.seen.clear();
    this.retryAttempt = 0;
    this.resetInboxPaging();
    this.state.instagram.connection = { status: "connecting" };
    this.updateStatus();
    this.notice(login.source === "browser" ? "Importing Instagram session from vimbrowser…" : "Connecting to Instagram…", false, true);
    try {
      const session = login.source === "browser"
        ? await (this.options.importSession || importInstagramSession)(login.tabId)
        : pastedSession!;
      if (generation !== this.generation) return;
      // Keep the explicitly supplied session even if the first inbox request times
      // out. A temporary network failure must not lose the user's login.
      // Serialize storage mutations so logout cannot race a late credential save.
      this.authWrites = this.authWrites.catch(() => {}).then(async () => {
        if (generation === this.generation) await (this.options.saveSession || saveInstagramSession)(session);
      });
      await this.authWrites;
      if (generation !== this.generation) return;
      await this.connect(session, generation);
      if (generation === this.generation) this.notice("Instagram connected.");
    } catch (error) { if (generation === this.generation) this.failure(error); }
  }

  private createClient(session: InstagramSession, generation: number): InstagramClient {
    const options: InstagramTransportOptions = {
      // Instagram rotates cookies on successful responses: keep the saved login current.
      onSessionRotated: rotated => {
        if (generation !== this.generation) return;
        // Written even if Record quits first (shutdown waits for it); a later
        // login or logout queues behind it, so it never overwrites theirs.
        this.authWrites = this.authWrites.catch(() => {}).then(() =>
          (this.options.saveSession || saveInstagramSession)(rotated).catch(() => {}));
      },
    };
    return (this.options.clientFactory || ((s, o) => new InstagramClient(s, o)))(session, options);
  }

  private async connect(session: InstagramSession, generation: number): Promise<void> {
    const client = this.createClient(session, generation);
    this.state.instagram.connection = { status: "connecting" };
    this.updateStatus();
    const inbox = await client.inbox();
    await this.muteWrites;
    if (generation !== this.generation) return;
    const viewerId = inbox.viewer?.id || session.cookies.ds_user_id || "";
    if (this.state.instagram.account?.id !== viewerId) {
      this.clearProvider(false);
      this.loadMutes(viewerId);
      this.hydrateFromCache(viewerId);
    } else if (this.loadedCacheFor !== viewerId) {
      this.hydrateFromCache(viewerId);
    }
    this.client = client;
    const previous = this.state.instagram.account;
    this.state.instagram.account = {
      id: viewerId, fbid: inbox.viewer?.fbid || previous?.fbid || "",
      username: sanitizeTerminalLabel(inbox.viewer?.username || previous?.username || ""),
      name: sanitizeTerminalLabel(inbox.viewer?.name || previous?.name || inbox.viewer?.username || "Me"),
    };
    this.state.instagram.connection = { status: "connected" };
    this.state.instagram.fromCache = false;
    this.retryAttempt = 0;
    this.clearErrorNotice();
    this.mailboxId = inbox.mailboxId;
    this.sequenceId = inbox.sequenceId;
    this.acceptInbox(inbox, true);
    this.inboxCursor = inbox.hasNextPage ? inbox.cursor : null;
    this.inboxCursors.clear();
    const layout = loadCachedSidebarChannelLayout(`instagram:${viewerId}`);
    if (layout?.[INSTAGRAM_GUILD_ID]) applySidebarChannelLayoutForGuild(this.state.sidebar, INSTAGRAM_GUILD_ID, layout[INSTAGRAM_GUILD_ID]!);
    this.render();
    // Page the sidebar independently; never block initial chat access on a large inbox.
    void this.loadInboxPages(client, generation);
    void this.loadRequests(client, generation);
    const active = instagramThreadIdFromChannelId(this.state.timeline.channelId || "");
    if (active && !isDraftThreadId(active)) void this.fetchThread(active, false);
    this.schedulePoll();
  }

  private loadMutes(accountId: string): void {
    this.mutePersistenceAvailable = true;
    try {
      this.state.instagram.muteOverridesByThreadId = (this.options.loadMutes || loadInstagramMutes)(accountId);
    } catch {
      this.mutePersistenceAvailable = false;
      this.notice("Could not load Instagram's local mute settings; changes will apply only for this session.", true);
    }
  }

  private hydrateFromCache(accountId: string): void {
    if (!/^\d+$/.test(accountId) || this.loadedCacheFor === accountId) return;
    this.loadedCacheFor = accountId;
    let snapshot: InstagramCacheSnapshot | null = null;
    try { snapshot = (this.options.loadCache || loadInstagramCache)(accountId); } catch { snapshot = null; }
    if (!snapshot) return;
    if (this.state.instagram.account && this.state.instagram.account.id !== accountId) return;
    if (!this.state.instagram.account) {
      this.loadMutes(accountId);
      this.state.instagram.account = snapshot.account ?? { id: accountId, fbid: "", username: "", name: "Me" };
    }
    for (const thread of snapshot.threads) {
      if (!this.state.instagram.threadsById[thread.id]) this.storeThread(thread);
    }
    this.state.instagram.requestIds = snapshot.requestIds.filter(id => this.state.instagram.threadsById[id]);
    const known = new Set(this.state.instagram.outgoing.map(send => send.localId));
    this.state.instagram.outgoing.push(...snapshot.outgoing.filter(send => !known.has(send.localId))
      .map(send => send.status === "pending" ? { ...send, status: "unconfirmed" as const } : send));
    if (!this.mailboxId) this.mailboxId = snapshot.mailboxId;
    if (!this.sequenceId) this.sequenceId = snapshot.sequenceId;
    this.state.instagram.fromCache = true;
    const layout = loadCachedSidebarChannelLayout(`instagram:${accountId}`);
    if (layout?.[INSTAGRAM_GUILD_ID]) applySidebarChannelLayoutForGuild(this.state.sidebar, INSTAGRAM_GUILD_ID, layout[INSTAGRAM_GUILD_ID]!);
    this.syncSidebar();
    this.refreshTimeline();
  }

  private resetInboxPaging(): void {
    this.inboxCursor = null;
    this.inboxCursors.clear();
    this.pagingGeneration = null;
  }

  private async loadInboxPages(client: InstagramClient, generation: number): Promise<void> {
    if (generation !== this.generation || !this.isConnected
      || this.pagingGeneration === generation || !this.inboxCursor || !this.mailboxId) return;
    this.pagingGeneration = generation;
    try {
      while (this.inboxCursor && generation === this.generation && this.inboxCursors.size < MAX_INBOX_PAGES) {
        const cursor = this.inboxCursor;
        if (this.inboxCursors.has(cursor)) { this.inboxCursor = null; break; }
        // Keep startup pagination gentle on Instagram's private API.
        await new Promise(resolve => setTimeout(resolve, this.options.inboxPageDelayMs ?? 750));
        if (generation !== this.generation || !this.isConnected) return;
        const page = await client.inboxPage(this.mailboxId, cursor);
        if (generation !== this.generation || !this.isConnected) return;
        // Advance only after success. A transient failure must resume this page,
        // not silently abandon older conversations after refreshing page one.
        this.inboxCursors.add(cursor);
        this.inboxCursor = page.hasNextPage ? page.cursor : null;
        if (!this.historyRequests.size) this.retryAttempt = 0;
        this.clearErrorNotice();
        this.acceptInbox(page, false);
      }
    } catch (error) { if (generation === this.generation) this.failure(error); }
    finally {
      if (this.pagingGeneration === generation) this.pagingGeneration = null;
    }
  }

  private async loadRequests(client: InstagramClient, generation: number): Promise<void> {
    try {
      const requests = await client.requests();
      if (generation !== this.generation) return;
      for (const thread of requests.pending) {
        this.storeThread(mergeThreadPreview(this.state.instagram.threadsById[thread.id], thread));
      }
      this.state.instagram.requestIds = requests.pending.map(thread => thread.id);
      this.state.instagram.hiddenRequestCount = requests.spamCount;
      this.syncSidebar();
      this.queueCacheSave();
    } catch {
      // Requests are secondary: the inbox keeps working without them.
    }
  }

  private acceptInbox(page: IgInboxPage, head: boolean): void {
    const threads = this.state.instagram.threadsById;
    for (const thread of page.threads) {
      this.storeThread(mergeThreadPreview(threads[thread.id], thread));
      if (thread.folder === "inbox") this.state.instagram.requestIds = this.state.instagram.requestIds.filter(id => id !== thread.id);
      this.reconcileOutgoing(thread.id);
    }
    if (head && page.threads.length) {
      // Threads that left the inbox head window but were never paged remain from cache; nothing is invented.
      for (const [id, user] of Object.entries(this.state.instagram.draftUsers)) {
        const real = page.threads.find(thread => !thread.isGroup && thread.users.length === 1 && thread.users[0]!.id === user.id);
        if (real) this.adoptDraft(id, real.id);
      }
    }
    this.syncSidebar();
    this.refreshTimeline();
    this.queueCacheSave();
  }

  private syncSidebar(): void {
    setSidebarGuilds(this.state.sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      whatsappGuild(), instagramGuild(), ...sidebarCachedGuilds(this.state.sidebar),
    ]);
    const channels = instagramChannels(this.state.instagram);
    setSidebarCachedChannels(this.state.sidebar, INSTAGRAM_GUILD_ID, channels);
    for (const thread of Object.values(this.state.instagram.threadsById)) {
      const id = instagramChannelId(thread.id);
      const visible = id === this.state.timeline.channelId
        && isTimelineNearBottom(this.state.timeline.scrollOffset, this.state.timeline.maxScroll);
      setChannelNotificationCount(this.state.notifications, id, INSTAGRAM_GUILD_ID,
        visible ? 0 : instagramUnreadCount(this.state.instagram, thread));
    }
    if (this.state.channelList.guildId === INSTAGRAM_GUILD_ID) {
      const activeId = this.state.channelList.activeChannelId;
      setChannelList(this.state.channelList, INSTAGRAM_GUILD_ID, channels);
      setActiveChannelEntry(this.state.channelList, channels.find(channel => channel.id === activeId) || null);
    }
    this.updateStatus();
  }

  async refresh(): Promise<void> {
    if (this.refreshing || this.state.instagram.connection.status === "connecting") return;
    if (!this.client) {
      await this.autoConnect();
      if (this.state.instagram.connection.status === "idle") this.notice("Connect with /login instagram to load Instagram chats.", false, true);
      return;
    }
    const generation = this.generation;
    const client = this.client;
    this.refreshing = true;
    this.stopTimer();
    try {
      const inbox = await client.inbox();
      if (generation !== this.generation) return;
      this.state.instagram.connection = { status: "connected" };
      this.clearErrorNotice();
      if (inbox.mailboxId) this.mailboxId = inbox.mailboxId;
      if (inbox.sequenceId) this.sequenceId = inbox.sequenceId;
      this.acceptInbox(inbox, true);
      if (this.pollCount++ % (this.options.requestPollEvery ?? 10) === 0) void this.loadRequests(client, generation);
      const id = instagramThreadIdFromChannelId(this.state.timeline.channelId || "");
      if (id && !isDraftThreadId(id)) await this.fetchThread(id, false);
      if (generation !== this.generation) return;
      if (this.isConnected) {
        // A successful head request alone is not recovery from a failing
        // history/page request: preserve its exponential backoff.
        if (!this.inboxCursor && !this.historyRequests.size) this.retryAttempt = 0;
        void this.loadInboxPages(client, generation);
      }
    } catch (error) { if (generation === this.generation) this.failure(error); }
    finally {
      if (generation === this.generation) {
        this.refreshing = false;
        if (!this.retrying) this.schedulePoll();
      }
    }
  }

  openRoot(): void {
    this.state.channelList.requestId++;
    this.state.sidebar.focusedGuildId = INSTAGRAM_GUILD_ID;
    this.syncSidebar();
    if (this.state.instagram.connection.status === "idle") {
      this.notice("Connect with /login instagram to load Instagram chats.", false, true);
      // A session may have been imported by another instance since startup.
      void this.autoConnect();
    } else if (this.state.instagram.connection.status === "error") {
      this.notice(this.state.instagram.connection.error || "Instagram is offline. Try /refresh.", true, true);
    }
  }

  /** Record-only preference: never calls Instagram or requires a live connection. */
  toggleChatMute(channelId: string): boolean {
    const id = instagramThreadIdFromChannelId(channelId);
    const thread = id ? this.state.instagram.threadsById[id] : null;
    const accountId = this.state.instagram.account?.id;
    if (!id || !thread || !accountId) return false;
    const overrides = this.state.instagram.muteOverridesByThreadId;
    const muted = !isInstagramThreadMuted(overrides, { thread_id: thread.id, muted: thread.muted });
    overrides[id] = muted;
    // Publish to sidebar, active channel and unread counts before any disk I/O.
    this.syncSidebar();
    this.notice(muted ? "Chat muted locally in Record." : "Chat unmuted locally in Record.");
    if (!this.mutePersistenceAvailable) {
      this.notice("Local mute changed for this session. Saved mute settings could not be loaded and were left untouched.", true);
      return true;
    }

    const snapshot = { ...overrides };
    const sequence = ++this.muteSequence;
    const generation = this.generation;
    // Serialize snapshots so rapid mute/unmute clicks cannot save out of order.
    this.muteWrites = this.muteWrites.catch(() => {}).then(() =>
      (this.options.saveMutes || saveInstagramMutes)(accountId, snapshot)
    ).catch(() => {
      if (generation !== this.generation || sequence !== this.muteSequence
        || this.state.instagram.account?.id !== accountId) return;
      this.notice("Local mute changed for this session, but could not be saved for next launch.", true);
    });
    return true;
  }

  openChannel(channelId: string): boolean {
    const id = instagramThreadIdFromChannelId(channelId);
    const channels = instagramChannels(this.state.instagram);
    const channel = channels.find(channel => channel.id === channelId);
    const thread = instagramThreadForChannel(this.state.instagram, channelId);
    if (!id || !channel || !thread) return false;
    this.state.channelList.requestId++;
    this.state.timeline.requestId++;
    setChannelList(this.state.channelList, INSTAGRAM_GUILD_ID, channels);
    setActiveChannelEntry(this.state.channelList, channel);
    this.state.sidebar.focusedGuildId = INSTAGRAM_GUILD_ID;
    this.state.sidebar.activeGuildId = INSTAGRAM_GUILD_ID;
    clearChannelNotifications(this.state.notifications, channelId);
    setTimelineMessages(this.state.timeline, channelId, instagramTimelineMessages(this.state.instagram, channelId), {
      hasOlder: thread.hasOlder || !thread.detailLoaded,
    });
    this.state.timeline.emptyText = isDraftThreadId(id) ? "New chat — your first message creates it." : null;
    this.render();
    if (!isDraftThreadId(id)) void this.fetchThread(id, false);
    if (thread.folder === "pending") {
      this.notice("Message request: they won't see you've read it. Accept with /accept to reply.", false);
    }
    return true;
  }

  async restoreChannel(channelId: string): Promise<boolean> {
    const id = instagramThreadIdFromChannelId(channelId);
    if (!id || isDraftThreadId(id)) return false;
    if (!this.state.instagram.threadsById[id]) {
      if (!this.client || !this.isConnected) return false;
      const generation = this.generation;
      try {
        const thread = await this.client.thread(id, this.sequenceId);
        if (generation !== this.generation) return false;
        this.storeThread(mergeThreadDetail(undefined, thread));
        this.syncSidebar();
      } catch (error) {
        if (generation === this.generation) this.failure(error);
        return false;
      }
    }
    return this.openChannel(channelId);
  }

  loadOlder(): boolean {
    const id = instagramThreadIdFromChannelId(this.state.timeline.channelId || "");
    if (!id || isDraftThreadId(id)) return false;
    void this.fetchThread(id, true);
    return true;
  }

  private async fetchThread(id: string, older: boolean): Promise<void> {
    if (!this.client || !this.isConnected || this.historyRequests.has(id)) return;
    const stored = this.state.instagram.threadsById[id];
    if (older && stored?.detailLoaded && (!stored.hasOlder || !stored.cursor)) {
      this.state.timeline.loadingOlder = false;
      this.state.timeline.hasOlder = false;
      return;
    }
    // A thread only known from an inbox preview loads its full newest page first.
    const page = older && stored?.detailLoaded ? "older" : "detail";
    const generation = this.generation;
    const client = this.client;
    this.historyRequests.add(id);
    if (older) this.state.timeline.loadingOlder = true;
    try {
      if (page === "older") {
        const result = await client.olderMessages(id, stored!.cursor!);
        if (generation !== this.generation) return;
        const current = this.state.instagram.threadsById[id];
        if (current) this.storeThread(prependOlder(current, result.messages, result.cursor, result.hasOlder));
      } else {
        const fresh = await client.thread(id, this.sequenceId);
        if (generation !== this.generation) return;
        this.learnViewer(fresh);
        const current = this.state.instagram.threadsById[id];
        const merged = mergeThreadDetail(current, fresh);
        if (this.state.instagram.requestIds.includes(id)) merged.folder = "pending";
        this.storeThread(merged);
        this.reconcileOutgoing(id);
      }
      this.syncSidebar();
      this.queueCacheSave();
      if (this.state.timeline.channelId === instagramChannelId(id)) {
        this.refreshTimeline();
        this.markActiveRead();
      }
    } catch (error) { if (generation === this.generation) this.failure(error); }
    finally {
      if (generation === this.generation) {
        this.historyRequests.delete(id);
        if (this.state.timeline.channelId === instagramChannelId(id)) this.state.timeline.loadingOlder = false;
        this.render();
      }
    }
  }

  /** Every thread lands here: Instagram's reaction notices never become messages. */
  private storeThread(thread: IgThread): void {
    this.state.instagram.threadsById[thread.id] = foldReactionNotices(thread, this.state.instagram.threadsById[thread.id]);
  }

  /** The thread query's viewer carries username/name; the inbox's doesn't. */
  private learnViewer(thread: IgThread): void {
    const account = this.state.instagram.account;
    if (!account) return;
    if (!account.fbid) account.fbid = thread.viewerFbid;
    if (!account.username && thread.viewerUsername) account.username = sanitizeTerminalLabel(thread.viewerUsername);
    if ((!account.name || account.name === "Me") && thread.viewerName) account.name = sanitizeTerminalLabel(thread.viewerName);
  }

  private refreshTimeline(): void {
    const channelId = this.state.timeline.channelId;
    const id = instagramThreadIdFromChannelId(channelId || "");
    if (!id || !channelId) return;
    const thread = instagramThreadForChannel(this.state.instagram, channelId);
    const systemMessages = this.state.timeline.systemMessages;
    const maxScroll = this.state.timeline.maxScroll;
    const atBottom = isTimelineNearBottom(this.state.timeline.scrollOffset, maxScroll);
    setTimelineMessages(this.state.timeline, channelId, instagramTimelineMessages(this.state.instagram, channelId), {
      preserveScroll: !atBottom, hasOlder: Boolean(thread && (thread.hasOlder || !thread.detailLoaded)),
    });
    // render.ts remaps the viewport using stable line anchors. Preserve the old
    // extent until that render; a zero maxScroll falsely looks pinned to bottom.
    this.state.timeline.maxScroll = maxScroll;
    this.state.timeline.systemMessages = systemMessages;
    this.state.timeline.loadingOlder = this.historyRequests.has(id) && this.state.timeline.loadingOlder;
    this.render();
  }

  /**
   * Read receipt for the newest message from someone else, only while the chat
   * is open at the bottom. Never for message requests or in read-only mode.
   */
  markActiveRead(): void {
    if (!isTimelineNearBottom(this.state.timeline.scrollOffset, this.state.timeline.maxScroll)) return;
    const id = instagramThreadIdFromChannelId(this.state.timeline.channelId || "");
    const thread = id ? this.state.instagram.threadsById[id] : null;
    if (!id || !thread || !this.client || !this.isConnected || thread.folder !== "inbox") return;
    const viewer = thread.viewerFbid || this.state.instagram.account?.fbid || "";
    const newest = [...thread.messages].reverse().find(message => message.content.kind !== "system");
    if (!newest || newest.senderFbid === viewer || this.seen.get(id) === newest.id) return;
    if ((thread.receipts[viewer] ?? 0) >= newest.timestampMs && !thread.markedUnread) return;
    clearChannelNotifications(this.state.notifications, instagramChannelId(id));
    if (this.client.readOnly) return;
    const generation = this.generation;
    this.seen.set(id, newest.id);
    void this.client.markRead(id, thread.legacyId, newest.id).then(watermark => {
      if (generation !== this.generation) return;
      const current = this.state.instagram.threadsById[id];
      if (!current) return;
      current.markedUnread = false;
      current.receipts = { ...current.receipts, [viewer]: Math.max(current.receipts[viewer] ?? 0, watermark ?? newest.timestampMs) };
      clearChannelNotifications(this.state.notifications, instagramChannelId(id));
      this.queueCacheSave();
      this.render();
    }).catch(() => { /* never retried in a loop: the next new message tries again */ });
  }

  // MARK: Sending

  sendMessage(content: string): boolean {
    const channelId = this.state.channelList.activeChannelId || this.state.timeline.channelId || "";
    const id = instagramThreadIdFromChannelId(channelId);
    if (!id) return false;
    const thread = instagramThreadForChannel(this.state.instagram, channelId);
    if (this.state.pendingImages.length) { this.notice("Instagram uploads are not supported yet; your draft was kept.", true); return true; }
    if (!this.isConnected || !this.client) { this.notice("Instagram is not connected. Run /login instagram; your draft was kept.", true); return true; }
    if (!thread) return false;
    if (thread.folder === "pending") { this.notice("This is a message request. Accept it with /accept before replying; your draft was kept.", true); return true; }
    if (!thread.canSend) { this.notice("You can't reply to this Instagram conversation; your draft was kept.", true); return true; }
    if (!content.trim()) return true;
    const reply = this.state.replyTarget?.channelId === channelId ? this.state.replyTarget : null;
    const quoted = reply ? thread.messages.find(message => message.id === reply.messageId) : undefined;
    const send: InstagramOutgoing = {
      localId: `local:ig:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      threadId: id, text: content, otid: offlineThreadingId(), createdAt: Date.now(), status: "pending",
      reply: reply ? {
        id: reply.messageId, senderFbid: quoted?.senderFbid ?? "",
        senderName: reply.authorDisplayName ?? (quoted ? displayNameForFbid(thread, quoted.senderFbid, quoted.senderName) : ""),
        summary: quoted ? contentSummary(quoted.content) : reply.summary,
      } : null,
    };
    // Capture and clear in this event: the next draft is independent, even if identical.
    this.state.instagram.outgoing.push(send);
    clearPrompt(this.state);
    this.state.replyTarget = null;
    setNotice(this.state, "", "muted");
    const local = instagramTimelineMessages(this.state.instagram, channelId).find(message => message.id === send.localId);
    if (local && this.state.timeline.channelId === channelId) appendTimelineMessage(this.state.timeline, local);
    this.state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.queueCacheSave();
    this.render();
    this.enqueueSend(send);
    return true;
  }

  /** Sends run one at a time per chat, in order. A failure holds the later ones (never out of order). */
  private enqueueSend(send: InstagramOutgoing): void {
    const generation = this.generation;
    const previous = this.sendQueues.get(send.threadId) ?? Promise.resolve();
    const run = previous.then(() => this.performSend(send, generation));
    this.sendQueues.set(send.threadId, run);
    void run.finally(() => { if (this.sendQueues.get(send.threadId) === run) this.sendQueues.delete(send.threadId); });
  }

  private async performSend(send: InstagramOutgoing, generation: number): Promise<void> {
    const current = this.state.instagram.outgoing.find(entry => entry.localId === send.localId);
    if (!current || current.status !== "pending" || generation !== this.generation || !this.client) return;
    const queue = this.state.instagram.outgoing;
    const earlierFailed = queue.slice(0, queue.indexOf(current)).some(entry => entry.threadId === send.threadId && entry.status !== "pending");
    if (earlierFailed) return this.settleSend(send, "failed", "Not sent: an earlier message didn't go through.");
    const draft = isDraftThreadId(send.threadId) ? this.state.instagram.draftUsers[send.threadId] : undefined;
    try {
      const receipt = await this.client.sendText(send.text, draft ? { recipientIds: [draft.id] } : { threadId: send.threadId },
        { ...(send.reply?.id ? { replyTo: send.reply.id } : {}), otid: send.otid });
      if (generation !== this.generation) return;
      this.state.instagram.outgoing = this.state.instagram.outgoing.filter(entry => entry.localId !== send.localId);
      const threadId = draft ? null : send.threadId;
      const thread = threadId ? this.state.instagram.threadsById[threadId] : undefined;
      if (thread) {
        const viewer = thread.viewerFbid || this.state.instagram.account?.fbid || "";
        if (!thread.messages.some(message => message.id === receipt.messageId)) {
          thread.messages = [...thread.messages, {
            id: receipt.messageId, senderFbid: viewer, senderName: this.state.instagram.account?.name ?? "",
            timestampMs: receipt.timestampMs, offlineThreadingId: send.otid, content: { kind: "text", text: send.text },
            reactions: [], ...(send.reply ? { replyTo: send.reply } : {}),
          }];
        }
        thread.lastActivityMs = Math.max(thread.lastActivityMs, receipt.timestampMs);
        thread.receipts = { ...thread.receipts, [viewer]: Math.max(thread.receipts[viewer] ?? 0, receipt.timestampMs) };
      }
      this.syncSidebar();
      this.refreshTimeline();
      this.queueCacheSave();
      // The first message created the chat: find it and move over.
      if (draft) void this.refresh();
    } catch (error) {
      if (generation !== this.generation) return;
      const uncertain = error instanceof InstagramApiError && (error.kind === "uncertain" || error.kind === "transient" || error.kind === "invalid");
      const message = error instanceof Error ? sanitizeTerminalLabel(error.message).slice(0, 200) : "Instagram send failed.";
      this.settleSend(send, uncertain ? "unconfirmed" : "failed", message);
      // Only a definite refusal returns the text to an empty prompt in the same chat.
      if (!uncertain && !this.state.editor.buffer && !this.state.replyTarget
        && this.state.timeline.channelId === instagramChannelId(send.threadId)) {
        this.state.editor.buffer = send.text;
        this.state.editor.cursor = send.text.length;
      }
      this.notice(uncertain
        ? "Instagram may not have received your message. Check the chat (/refresh) before resending; it won't be resent automatically."
        : `Instagram message not sent: ${message}`, true);
    }
  }

  private settleSend(send: InstagramOutgoing, status: "failed" | "unconfirmed", error: string): void {
    const entry = this.state.instagram.outgoing.find(candidate => candidate.localId === send.localId);
    if (!entry) return;
    entry.status = status;
    entry.error = error;
    this.refreshTimeline();
    this.queueCacheSave();
    this.render();
  }

  /** A refreshed thread carrying an outgoing message's client id means it landed. */
  private reconcileOutgoing(threadId: string): void {
    const thread = this.state.instagram.threadsById[threadId];
    if (!thread) return;
    const landed = new Set(thread.messages.map(message => message.offlineThreadingId).filter(Boolean));
    const before = this.state.instagram.outgoing.length;
    this.state.instagram.outgoing = this.state.instagram.outgoing.filter(send =>
      send.threadId !== threadId || send.status === "pending" || !landed.has(send.otid));
    if (this.state.instagram.outgoing.length !== before) this.queueCacheSave();
  }

  /** Discard a failed/unconfirmed local message (history `d`). */
  discardLocalMessage(messageId: string): boolean {
    const entry = this.state.instagram.outgoing.find(send => send.localId === messageId);
    if (!entry || entry.status === "pending") return false;
    this.state.instagram.outgoing = this.state.instagram.outgoing.filter(send => send.localId !== messageId);
    this.refreshTimeline();
    this.queueCacheSave();
    this.notice("Unsent Instagram message discarded.");
    return true;
  }

  // MARK: Reactions

  /**
   * Instagram keeps one reaction per person per message: a new emoji replaces
   * yours. Optimistic, rolled back if Instagram (or read-only mode) refuses.
   */
  async reactToMessage(message: DiscordMessage, emoji: string, remove: boolean): Promise<void> {
    const id = instagramThreadIdFromChannelId(message.channelId);
    const thread = id ? this.state.instagram.threadsById[id] : undefined;
    if (!id || !thread || isDraftThreadId(id)) throw new Error("Instagram reaction target is unavailable.");
    if (!this.client || !this.isConnected) throw new Error("Instagram is not connected.");
    const target = thread.messages.find(candidate => candidate.id === message.id);
    if (!target || isSystemContent(target.content)) throw new Error("This Instagram item can't be reacted to.");
    const key = `${id}/${message.id}`;
    if (this.reactionRequests.has(key)) throw new Error("A reaction is already being sent for this message.");
    const viewer = thread.viewerFbid || this.state.instagram.account?.fbid || "";
    const before = target.reactions;
    const mine = before.find(reaction => reaction.senderFbid === viewer);
    if (remove && !mine) throw new Error("You haven't reacted to this message.");
    if (remove && emoji && mine && mine.emoji !== emoji) throw new Error("You haven't reacted with that emoji.");
    target.reactions = remove ? before.filter(reaction => reaction.senderFbid !== viewer)
      : [...before.filter(reaction => reaction.senderFbid !== viewer), { emoji, senderFbid: viewer }];
    this.reactionRequests.add(key);
    this.refreshTimeline();
    const generation = this.generation;
    try {
      await this.client.react(id, message.id, remove ? mine!.emoji : emoji, remove);
      if (generation === this.generation) this.queueCacheSave();
    } catch (error) {
      if (generation === this.generation) {
        const current = this.state.instagram.threadsById[id]?.messages.find(candidate => candidate.id === message.id);
        if (current) current.reactions = before;
        this.refreshTimeline();
      }
      throw error;
    } finally {
      this.reactionRequests.delete(key);
    }
  }

  // MARK: Requests and new chats

  async acceptActiveRequest(): Promise<void> {
    const id = instagramThreadIdFromChannelId(this.state.timeline.channelId || this.state.channelList.activeChannelId || "");
    const thread = id ? this.state.instagram.threadsById[id] : undefined;
    if (!id || !thread || thread.folder !== "pending") { this.notice("Open a message request to accept it.", true); return; }
    if (!this.client || !this.isConnected) { this.notice("Instagram is not connected.", true); return; }
    const generation = this.generation;
    try {
      await this.client.acceptRequest(id);
      if (generation !== this.generation) return;
      thread.folder = "inbox";
      this.state.instagram.requestIds = this.state.instagram.requestIds.filter(candidate => candidate !== id);
      this.syncSidebar();
      this.refreshTimeline();
      this.queueCacheSave();
      this.notice("Message request accepted.");
    } catch (error) {
      if (generation === this.generation) this.notice(`Could not accept: ${error instanceof Error ? sanitizeTerminalLabel(error.message) : "Instagram refused."}`, true);
    }
  }

  /** `/dm <username>`: open the existing 1:1 chat, or a new one created by the first message. */
  async startDirectMessage(username: string): Promise<void> {
    const wanted = username.replace(/^@/, "").trim().toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(wanted)) { this.notice("Usage: /dm <instagram username>", true); return; }
    const existing = Object.values(this.state.instagram.threadsById).find(thread =>
      !thread.isGroup && thread.folder === "inbox" && thread.users.length === 1 && thread.users[0]!.username.toLowerCase() === wanted);
    if (existing) { this.openChannel(instagramChannelId(existing.id)); return; }
    if (!this.client || !this.isConnected) { this.notice("Instagram is not connected.", true); return; }
    const generation = this.generation;
    this.notice(`Looking up @${wanted}…`);
    let users: IgUser[];
    try { users = await this.client.searchUsers(wanted); } catch (error) {
      if (generation === this.generation) this.notice(`Search failed: ${error instanceof Error ? sanitizeTerminalLabel(error.message) : ""}`, true);
      return;
    }
    if (generation !== this.generation) return;
    const user = users.find(candidate => candidate.username.toLowerCase() === wanted);
    if (!user) {
      const names = users.slice(0, 5).map(candidate => `@${sanitizeTerminalLabel(candidate.username)}`).join(", ");
      this.notice(names ? `No account named @${wanted}. Did you mean ${names}?` : `No Instagram account named @${wanted}.`, true);
      return;
    }
    const thread = Object.values(this.state.instagram.threadsById).find(candidate =>
      !candidate.isGroup && candidate.users.length === 1 && candidate.users[0]!.id === user.id);
    if (thread) { this.openChannel(instagramChannelId(thread.id)); return; }
    const draftId = `${INSTAGRAM_DRAFT_PREFIX}${user.id}`;
    this.state.instagram.draftUsers[draftId] = { ...user, username: sanitizeTerminalLabel(user.username), name: sanitizeTerminalLabel(user.name) };
    this.syncSidebar();
    this.openChannel(instagramChannelId(draftId));
    this.notice(`New chat with @${sanitizeTerminalLabel(user.username)}: your first message creates it.`);
  }

  /** The first send created the real thread: move pending/failed sends and the view to it. */
  private adoptDraft(draftId: string, threadId: string): void {
    delete this.state.instagram.draftUsers[draftId];
    for (const send of this.state.instagram.outgoing) if (send.threadId === draftId) send.threadId = threadId;
    if (this.state.timeline.channelId === instagramChannelId(draftId) || this.state.channelList.activeChannelId === instagramChannelId(draftId)) {
      this.syncSidebar();
      this.openChannel(instagramChannelId(threadId));
    }
  }

  // MARK: Attachments

  /** Shared reels resolve to their one video on open; everything else is a signed CDN URL. */
  async downloadAttachment(attachment: DiscordMessageAttachment, options: AttachmentDownloadOptions = {}): Promise<AttachmentOpenResult> {
    const download = this.options.downloadAttachment ?? downloadGenericAttachment;
    if (!attachment.id.startsWith(INSTAGRAM_REEL_ATTACHMENT_PREFIX)) return download(attachment, options);
    const code = attachment.id.slice(INSTAGRAM_REEL_ATTACHMENT_PREFIX.length);
    if (!this.client || !this.isConnected) return { ok: false, retryWhenConnected: true, error: "Instagram must be connected to load this reel." };
    try {
      const reel = await this.client.reel(code);
      return download({ ...attachment, url: reel.videoUrl, cacheKey: attachment.cacheKey ?? `ig-reel:${code}` }, options);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? sanitizeTerminalLabel(error.message) : "Could not load the reel." };
    }
  }

  // MARK: Lifecycle

  async logout(): Promise<void> {
    void this.shutdown();
    this.clearProvider();
    this.loadedCacheFor = null;
    this.authWrites = this.authWrites.catch(() => {}).then(() => (this.options.removeSession || removeInstagramSession)());
    try { await Promise.all([this.authWrites, this.muteWrites]); this.notice("Instagram disconnected from Record (browser session unchanged)."); }
    catch { this.notice("Could not remove saved Instagram auth.", true); }
  }

  async shutdown(): Promise<void> {
    await this.flushCacheSave();
    this.generation++;
    this.stopTimer();
    this.client = null;
    this.refreshing = false;
    this.historyRequests.clear();
    this.seen.clear();
    this.sendQueues.clear();
    this.retryAttempt = 0;
    this.resetInboxPaging();
    // A rotated-cookie save still writing would leave its temp file (and lose the rotation).
    await Promise.all([this.muteWrites, this.cacheWrites, this.authWrites.catch(() => {})]);
  }

  private clearProvider(updateStatus = true): void {
    if (this.cacheTimer) { clearTimeout(this.cacheTimer); this.cacheTimer = null; }
    for (const channel of instagramChannels(this.state.instagram)) clearChannelNotifications(this.state.notifications, channel.id);
    if (this.state.channelList.guildId === INSTAGRAM_GUILD_ID) clearChannelList(this.state.channelList);
    if (instagramThreadIdFromChannelId(this.state.timeline.channelId || "")) clearTimeline(this.state.timeline);
    Object.assign(this.state.instagram, createInstagramUiState());
    this.mailboxId = "";
    this.sequenceId = "";
    setSidebarCachedChannels(this.state.sidebar, INSTAGRAM_GUILD_ID, []);
    applySidebarChannelLayoutForGuild(this.state.sidebar, INSTAGRAM_GUILD_ID, {});
    if (updateStatus) this.updateStatus();
  }

  private snapshot(): InstagramCacheSnapshot | null {
    const account = this.state.instagram.account;
    if (!account || !/^\d+$/.test(account.id)) return null;
    return {
      version: 1, accountId: account.id, account: { ...account }, mailboxId: this.mailboxId, sequenceId: this.sequenceId,
      threads: Object.values(this.state.instagram.threadsById), requestIds: [...this.state.instagram.requestIds],
      outgoing: this.state.instagram.outgoing.map(send => ({ ...send })),
    };
  }

  private queueCacheSave(): void {
    if (this.options.saveCache === null) return;
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => { this.cacheTimer = null; this.writeCache(); }, this.options.cacheSaveDelayMs ?? 1_500);
    this.cacheTimer.unref?.();
  }

  private writeCache(): void {
    const snapshot = this.snapshot();
    if (!snapshot || this.options.saveCache === null) return;
    const save = this.options.saveCache ?? saveInstagramCache;
    this.cacheWrites = this.cacheWrites.catch(() => {}).then(() => save(snapshot)).catch(() => {});
  }

  private async flushCacheSave(): Promise<void> {
    if (!this.cacheTimer) return;
    clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    this.writeCache();
    await this.cacheWrites;
  }

  private updateStatus(): void {
    const connection = this.state.instagram.connection;
    const status = connection.status === "connecting" ? { text: this.state.instagram.fromCache ? "Syncing Instagram…" : "Connecting Instagram…", loading: true }
      : connection.status === "idle" ? { text: "Use /login instagram" }
      : connection.status === "error" ? { text: this.retrying ? "Retrying Instagram…" : "Offline · /refresh", loading: this.retrying }
      : null;
    if (status) this.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID] = status;
    else delete this.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID];
    this.render();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retrying = false;
  }
  private schedulePoll(): void {
    this.stopTimer();
    if (this.isConnected && this.client) {
      this.timer = setTimeout(() => { void this.refresh(); }, this.options.pollIntervalMs ?? 30_000);
      this.timer.unref?.();
    }
  }
  private notice(message: string, warning = false, connection = false): void {
    setNotice(this.state, message, warning ? "warning" : "muted", {
      statusLine: true, chat: false,
      ...(connection ? { connectionGuildId: INSTAGRAM_GUILD_ID } : {}),
    });
    this.render();
  }
  private clearErrorNotice(): void {
    if (this.lastErrorNotice && this.state.notice.text === this.lastErrorNotice) {
      setNotice(this.state, "", "muted");
    }
    this.lastErrorNotice = null;
  }
  private failure(error: unknown, suffix = ""): void {
    const message = error instanceof Error ? sanitizeTerminalLabel(error.message).slice(0, 240) : "Instagram request failed.";
    if (error instanceof InstagramApiError && error.kind === "read_only") { this.notice(message, true); return; }
    if (error instanceof InstagramApiError || this.state.instagram.connection.status === "connecting") {
      this.state.instagram.connection = { status: "error", error: message };
      this.stopTimer();
      // Only transient API failures are retried. Auth challenges and rate
      // limits require user action; never hammer them in the background.
      if (error instanceof InstagramApiError && !error.fatal) {
        const generation = this.generation;
        const delay = Math.min(60_000, (this.options.retryDelayMs ?? 5_000) * 2 ** Math.min(this.retryAttempt++, 4));
        this.retrying = true;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.retrying = false;
          if (generation === this.generation) void this.refresh();
        }, delay);
        this.timer.unref?.();
      }
    }
    this.updateStatus();
    this.lastErrorNotice = message + suffix;
    this.notice(this.lastErrorNotice, true, this.state.instagram.connection.status === "error");
  }
}
