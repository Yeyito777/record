import { INSTAGRAM_GUILD_ID, instagramChannelId, instagramGuild, instagramThreadIdFromChannelId, whatsappGuild } from "../chatproviders";
import { clearChannelList, setActiveChannelEntry, setChannelList } from "../channels";
import { loadCachedSidebarChannelLayout } from "../datacache";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME } from "../discord";
import { clearChannelNotifications, setChannelNotificationCount } from "../notifications";
import { clearPrompt } from "../promptstate";
import { applySidebarChannelLayoutForGuild, setSidebarCachedChannels, setSidebarGuilds, sidebarCachedGuilds } from "../sidebar";
import { setNotice, type AppState } from "../state";
import { clearTimeline, isTimelineNearBottom, setTimelineMessages } from "../timeline";
import { sanitizeTerminalLabel } from "../whatsapp/sanitize";
import { importInstagramSession, loadInstagramSession, removeInstagramSession, saveInstagramSession, type InstagramSession } from "./auth";
import { InstagramApiError, InstagramClient, type InstagramInbox } from "./client";
import { createInstagramUiState, instagramChannels, instagramTimelineMessages, mergeInstagramThread } from "./integration";

export interface InstagramControllerOptions {
  clientFactory?: (session: InstagramSession) => InstagramClient;
  loadSession?: typeof loadInstagramSession;
  importSession?: typeof importInstagramSession;
  saveSession?: typeof saveInstagramSession;
  removeSession?: typeof removeInstagramSession;
  pollIntervalMs?: number;
}

export class InstagramController {
  private client: InstagramClient | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private sending = false;
  private historyRequests = new Set<string>();
  private seen = new Map<string, string>();
  private authWrites: Promise<void> = Promise.resolve();

  constructor(private state: AppState, private render: () => void, private options: InstagramControllerOptions = {}) {}

  get isConnected(): boolean { return this.state.instagram.connection.status === "connected"; }

  async autoConnect(): Promise<void> {
    const generation = ++this.generation;
    try {
      const session = await (this.options.loadSession || loadInstagramSession)();
      if (session && generation === this.generation) await this.connect(session, generation);
    } catch (error) { if (generation === this.generation) this.failure(error); }
  }

  async login(tabId?: string): Promise<void> {
    const generation = ++this.generation;
    this.stopTimer();
    this.client = null;
    this.refreshing = false;
    this.sending = false;
    this.historyRequests.clear();
    this.seen.clear();
    this.state.instagram.connection = { status: "connecting" };
    this.notice("Importing Instagram session from vimbrowser…");
    try {
      const session = await (this.options.importSession || importInstagramSession)(tabId);
      if (generation !== this.generation) return;
      await this.connect(session, generation);
      if (generation !== this.generation || !this.isConnected) return;
      // Serialize storage mutations so logout cannot race a late credential save.
      this.authWrites = this.authWrites.catch(() => {}).then(async () => {
        if (generation === this.generation) await (this.options.saveSession || saveInstagramSession)(session);
      });
      await this.authWrites;
      if (generation === this.generation) this.notice("Instagram connected.");
    } catch (error) { if (generation === this.generation) this.failure(error); }
  }

  private async connect(session: InstagramSession, generation: number): Promise<void> {
    const client = (this.options.clientFactory || (s => new InstagramClient(s)))(session);
    this.state.instagram.connection = { status: "connecting" };
    const inbox = await client.inbox();
    if (generation !== this.generation) return;
    if (this.state.instagram.account?.id !== String(inbox.viewer.pk)) this.clearProvider();
    this.client = client;
    this.state.instagram.account = {
      id: String(inbox.viewer.pk), username: sanitizeTerminalLabel(inbox.viewer.username || ""),
      name: sanitizeTerminalLabel(inbox.viewer.full_name || inbox.viewer.username || "Me"),
    };
    this.state.instagram.connection = { status: "connected" };
    this.acceptInbox(inbox);
    const layout = loadCachedSidebarChannelLayout(`instagram:${this.state.instagram.account.id}`);
    if (layout?.[INSTAGRAM_GUILD_ID]) applySidebarChannelLayoutForGuild(this.state.sidebar, INSTAGRAM_GUILD_ID, layout[INSTAGRAM_GUILD_ID]!);
    this.render();
    // Page the sidebar independently; never block initial chat access on a large inbox.
    void this.loadInboxPages(client, inbox, generation);
    this.schedulePoll();
  }

  private async loadInboxPages(client: InstagramClient, inbox: InstagramInbox, generation: number): Promise<void> {
    const cursors = new Set<string>();
    try {
      while (inbox.inbox.has_older && inbox.inbox.oldest_cursor && generation === this.generation) {
        const cursor = inbox.inbox.oldest_cursor;
        if (cursors.has(cursor)) break;
        cursors.add(cursor);
        // Keep startup pagination gentle on Instagram's private API.
        await new Promise(resolve => setTimeout(resolve, 750));
        if (generation !== this.generation || !this.isConnected) return;
        inbox = await client.inbox(cursor);
        if (generation !== this.generation) return;
        this.acceptInbox(inbox);
      }
    } catch (error) { if (generation === this.generation) this.failure(error); }
  }

  private acceptInbox(inbox: InstagramInbox): void {
    for (const thread of inbox.inbox.threads) mergeInstagramThread(this.state.instagram, thread);
    this.syncSidebar();
    this.refreshTimeline();
  }

  private syncSidebar(): void {
    setSidebarGuilds(this.state.sidebar, [
      { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
      whatsappGuild(), instagramGuild(), ...sidebarCachedGuilds(this.state.sidebar),
    ]);
    const channels = instagramChannels(this.state.instagram);
    setSidebarCachedChannels(this.state.sidebar, INSTAGRAM_GUILD_ID, channels);
    for (const thread of Object.values(this.state.instagram.threadsById)) {
      const id = instagramChannelId(thread.thread_id);
      const readAt = Number(thread.last_seen_at?.[this.state.instagram.account?.id || ""]?.timestamp || 0);
      const unread = thread.marked_as_unread || thread.items.some(item =>
        String(item.user_id) !== this.state.instagram.account?.id && Number(item.timestamp) > readAt);
      const visible = id === this.state.timeline.channelId
        && isTimelineNearBottom(this.state.timeline.scrollOffset, this.state.timeline.maxScroll);
      setChannelNotificationCount(this.state.notifications, id, INSTAGRAM_GUILD_ID,
        visible || thread.muted ? 0 : unread ? 1 : 0);
    }
    if (this.state.channelList.guildId === INSTAGRAM_GUILD_ID) {
      const activeId = this.state.channelList.activeChannelId;
      setChannelList(this.state.channelList, INSTAGRAM_GUILD_ID, channels);
      setActiveChannelEntry(this.state.channelList, channels.find(channel => channel.id === activeId) || null);
    }
    this.render();
  }

  async refresh(): Promise<void> {
    if (!this.client || this.refreshing || this.state.instagram.connection.status === "connecting") return;
    const generation = this.generation;
    const client = this.client;
    this.refreshing = true;
    this.stopTimer();
    try {
      const inbox = await client.inbox();
      if (generation !== this.generation) return;
      this.state.instagram.connection = { status: "connected" };
      this.acceptInbox(inbox);
      const id = instagramThreadIdFromChannelId(this.state.timeline.channelId || "");
      if (id) await this.fetchThread(id, false);
    } catch (error) { if (generation === this.generation) this.failure(error); }
    finally {
      if (generation === this.generation) {
        this.refreshing = false;
        this.schedulePoll();
      }
    }
  }

  openChannel(channelId: string): boolean {
    const id = instagramThreadIdFromChannelId(channelId);
    const channel = instagramChannels(this.state.instagram).find(channel => channel.id === channelId);
    if (!id || !channel) return false;
    this.state.channelList.requestId++;
    this.state.timeline.requestId++;
    setChannelList(this.state.channelList, INSTAGRAM_GUILD_ID, instagramChannels(this.state.instagram));
    setActiveChannelEntry(this.state.channelList, channel);
    this.state.sidebar.focusedGuildId = INSTAGRAM_GUILD_ID;
    this.state.sidebar.activeGuildId = INSTAGRAM_GUILD_ID;
    clearChannelNotifications(this.state.notifications, channelId);
    setTimelineMessages(this.state.timeline, channelId, instagramTimelineMessages(this.state.instagram, channelId), {
      hasOlder: this.state.instagram.threadsById[id]?.has_older,
    });
    this.render();
    void this.fetchThread(id, false);
    return true;
  }

  async restoreChannel(channelId: string): Promise<boolean> {
    const id = instagramThreadIdFromChannelId(channelId);
    if (!id || !this.client || !this.isConnected) return false;
    if (!this.state.instagram.threadsById[id]) {
      const generation = this.generation;
      try {
        const thread = await this.client.thread(id);
        if (generation !== this.generation) return false;
        mergeInstagramThread(this.state.instagram, thread);
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
    if (!id) return false;
    void this.fetchThread(id, true);
    return true;
  }

  private async fetchThread(id: string, older: boolean): Promise<void> {
    if (!this.client || !this.isConnected || this.historyRequests.has(id)) return;
    const stored = this.state.instagram.threadsById[id];
    if (older && (!stored?.has_older || !stored.oldest_cursor)) {
      this.state.timeline.loadingOlder = false;
      return;
    }
    const generation = this.generation;
    this.historyRequests.add(id);
    if (older) this.state.timeline.loadingOlder = true;
    try {
      const thread = await this.client.thread(id, older ? stored?.oldest_cursor : undefined);
      if (generation !== this.generation) return;
      const advanced = thread.oldest_cursor !== stored?.oldest_cursor;
      mergeInstagramThread(this.state.instagram, thread, older);
      if (older && !advanced) this.state.instagram.threadsById[id]!.has_older = false;
      this.syncSidebar();
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

  private refreshTimeline(): void {
    const channelId = this.state.timeline.channelId;
    const id = instagramThreadIdFromChannelId(channelId || "");
    if (!id || !channelId) return;
    const systemMessages = this.state.timeline.systemMessages;
    const maxScroll = this.state.timeline.maxScroll;
    const atBottom = isTimelineNearBottom(this.state.timeline.scrollOffset, maxScroll);
    setTimelineMessages(this.state.timeline, channelId, instagramTimelineMessages(this.state.instagram, channelId), {
      preserveScroll: !atBottom, hasOlder: this.state.instagram.threadsById[id]?.has_older,
    });
    // render.ts remaps the viewport using stable line anchors. Preserve the old
    // extent until that render; a zero maxScroll falsely looks pinned to bottom.
    this.state.timeline.maxScroll = maxScroll;
    this.state.timeline.systemMessages = systemMessages;
    this.state.timeline.loadingOlder = this.historyRequests.has(id);
    this.render();
  }

  markActiveRead(): void {
    if (!isTimelineNearBottom(this.state.timeline.scrollOffset, this.state.timeline.maxScroll)) return;
    const id = instagramThreadIdFromChannelId(this.state.timeline.channelId || "");
    const thread = id ? this.state.instagram.threadsById[id] : null;
    const item = thread?.items.at(-1);
    if (!id || !item || !this.client || !this.isConnected || this.seen.get(id) === item.item_id) return;
    const generation = this.generation;
    this.seen.set(id, item.item_id);
    void this.client.markSeen(id, item.item_id).then(() => {
      if (generation !== this.generation || !this.state.instagram.account || !thread) return;
      thread.marked_as_unread = false;
      thread.last_seen_at = { ...thread.last_seen_at, [this.state.instagram.account.id]: { timestamp: item.timestamp, item_id: item.item_id } };
      clearChannelNotifications(this.state.notifications, instagramChannelId(id));
      this.render();
    }).catch(() => { if (generation === this.generation) this.seen.delete(id); });
  }

  sendMessage(content: string): boolean {
    const channelId = this.state.channelList.activeChannelId || this.state.timeline.channelId || "";
    const id = instagramThreadIdFromChannelId(channelId);
    if (!id) return false;
    if (this.state.pendingImages.length) { this.notice("Instagram uploads are not supported yet; your draft was kept.", true); return true; }
    if (!this.isConnected || !this.client) { this.notice("Instagram is not connected. Run /login instagram; your draft was kept.", true); return true; }
    if (this.sending) { this.notice("An Instagram message is still sending; your draft was kept.", true); return true; }
    if (!content.trim()) return true;
    const generation = this.generation;
    const draft = this.state.editor.buffer;
    const reply = this.state.replyTarget?.channelId === channelId ? this.state.replyTarget : null;
    this.sending = true;
    this.notice("Sending Instagram message…");
    void this.client.sendText(id, content, reply?.messageId).then(item => {
      if (generation !== this.generation) return;
      const thread = this.state.instagram.threadsById[id];
      if (thread) {
        if (reply) item.replied_to_message = thread.items.find(item => item.item_id === reply.messageId);
        mergeInstagramThread(this.state.instagram, { ...thread, items: [item], last_activity_at: item.timestamp });
      }
      if (this.state.editor.buffer === draft && this.state.channelList.activeChannelId === channelId) {
        clearPrompt(this.state);
        if (this.state.replyTarget === reply) this.state.replyTarget = null;
      }
      this.syncSidebar();
      this.refreshTimeline();
      this.notice("Instagram message sent.");
    }).catch(error => {
      if (generation === this.generation) this.failure(error, " Draft kept; refresh before retrying if delivery is uncertain.");
    }).finally(() => { if (generation === this.generation) { this.sending = false; this.render(); } });
    return true;
  }

  async logout(): Promise<void> {
    void this.shutdown();
    this.clearProvider();
    this.authWrites = this.authWrites.catch(() => {}).then(() => (this.options.removeSession || removeInstagramSession)());
    try { await this.authWrites; this.notice("Instagram disconnected from Record (browser session unchanged)."); }
    catch { this.notice("Could not remove saved Instagram auth.", true); }
  }

  async shutdown(): Promise<void> {
    this.generation++;
    this.stopTimer();
    this.client = null;
    this.refreshing = false;
    this.sending = false;
    this.historyRequests.clear();
    this.seen.clear();
  }

  private clearProvider(): void {
    for (const channel of instagramChannels(this.state.instagram)) clearChannelNotifications(this.state.notifications, channel.id);
    if (this.state.channelList.guildId === INSTAGRAM_GUILD_ID) clearChannelList(this.state.channelList);
    if (instagramThreadIdFromChannelId(this.state.timeline.channelId || "")) clearTimeline(this.state.timeline);
    Object.assign(this.state.instagram, createInstagramUiState());
    setSidebarCachedChannels(this.state.sidebar, INSTAGRAM_GUILD_ID, []);
    applySidebarChannelLayoutForGuild(this.state.sidebar, INSTAGRAM_GUILD_ID, {});
    this.render();
  }

  private stopTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedulePoll(): void {
    this.stopTimer();
    if (this.isConnected && this.client) {
      this.timer = setTimeout(() => { void this.refresh(); }, this.options.pollIntervalMs ?? 30_000);
      this.timer.unref?.();
    }
  }
  private notice(message: string, warning = false): void {
    setNotice(this.state, message, warning ? "warning" : "muted", { statusLine: true, chat: false });
    this.render();
  }
  private failure(error: unknown, suffix = ""): void {
    const message = error instanceof Error ? sanitizeTerminalLabel(error.message).slice(0, 240) : "Instagram request failed.";
    if (error instanceof InstagramApiError && error.fatal || this.state.instagram.connection.status === "connecting") {
      this.state.instagram.connection = { status: "error", error: message };
      this.stopTimer();
    }
    this.notice(message + suffix, true);
  }
}
