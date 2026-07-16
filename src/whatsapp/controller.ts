import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { WHATSAPP_GUILD_ID, whatsappChannelId, whatsappGuild, whatsappJidFromChannelId } from "../chatproviders";
import { clearChannelList, setActiveChannelEntry, setChannelList } from "../channels";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME } from "../discord";
import {
  clearChannelNotifications,
  recordChannelNotification,
  setChannelNotificationCount,
} from "../notifications";
import { setSidebarCachedChannels, setSidebarGuilds, sidebarCachedGuilds } from "../sidebar";
import type { AppState } from "../state";
import { setNotice } from "../state";
import { clearTimeline, appendTimelineMessage, setTimelineMessages } from "../timeline";
import { markTimelineMessageFailed, replaceTimelineMessage } from "../timeline";
import { clearPrompt } from "../promptstate";
import {
  beginWhatsAppLoginUi,
  canonicalWhatsAppJid,
  registerWhatsAppLidMapping,
  resetWhatsAppUiState,
  upsertWhatsAppChats,
  upsertWhatsAppContacts,
  upsertWhatsAppMessages,
  whatsAppChannels,
  whatsAppMessageToTimeline,
  whatsAppTimelineMessages,
} from "./integration";
import { setLoginModalPhase } from "./loginmodal";
import { getRecordWhatsAppPaths } from "./paths";
import { sanitizeTerminalLabel } from "./sanitize";
import { createNodeWhatsAppBackendClient } from "./nodeclient";
import {
  hydrateWhatsAppUiState,
  loadWhatsAppCache,
  removeWhatsAppCache,
  saveWhatsAppCache,
  snapshotWhatsAppUiState,
} from "./cache";
import type {
  WhatsAppBackendEventListener,
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppLoginResult,
} from "./types";

export interface WhatsAppBackendHandle {
  readonly state: WhatsAppConnectionState;
  readonly isConnected: boolean;
  startLogin(): Promise<WhatsAppLoginResult>;
  cancelLogin(): boolean;
  logout(): Promise<void>;
  shutdown(): Promise<void>;
  sendText(
    chatId: string,
    text: string,
    quoted?: import("./types").WhatsAppMessage,
    ephemeralExpirationSeconds?: number,
  ): Promise<import("./types").WhatsAppMessage>;
  markRead(keys: import("./types").WhatsAppMessageKey[]): Promise<void>;
  on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>): () => void;
}

export interface WhatsAppControllerOptions {
  backendFactory?: () => WhatsAppBackendHandle;
  authDirectory?: string;
  cacheFile?: string;
  cacheSaveDelayMs?: number;
  successModalDelayMs?: number;
}

const DEFAULT_SUCCESS_MODAL_DELAY_MS = 900;
const DEFAULT_CACHE_SAVE_DELAY_MS = 250;

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "Unknown error");
  return sanitizeTerminalLabel(text).slice(0, 240);
}

function ensureWhatsAppRoot(state: AppState): void {
  setSidebarGuilds(state.sidebar, [
    { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
    whatsappGuild(),
    ...sidebarCachedGuilds(state.sidebar),
  ]);
}

export class WhatsAppController {
  private backend: WhatsAppBackendHandle;
  private readonly backendFactory: () => WhatsAppBackendHandle;
  private readonly authDirectory: string;
  private readonly cacheFile: string;
  private readonly cacheSaveDelayMs: number;
  private readonly successModalDelayMs: number;
  private readonly unsubscribers: Array<() => void> = [];
  private successModalTimer: ReturnType<typeof setTimeout> | null = null;
  private loginStartedWithSavedAuth = false;
  private backendResetGeneration = 0;
  private backendResetPromise: Promise<void> | null = null;
  private cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheWrites: Promise<void> = Promise.resolve();
  private cacheEnabled = true;

  constructor(
    private readonly state: AppState,
    private readonly scheduleRender: () => void,
    options: WhatsAppControllerOptions = {},
  ) {
    this.authDirectory = options.authDirectory ?? getRecordWhatsAppPaths().authDirectory;
    this.cacheFile = options.cacheFile ?? join(dirname(this.authDirectory), "cache.json");
    this.cacheSaveDelayMs = options.cacheSaveDelayMs ?? DEFAULT_CACHE_SAVE_DELAY_MS;
    this.successModalDelayMs = options.successModalDelayMs ?? DEFAULT_SUCCESS_MODAL_DELAY_MS;
    this.backendFactory = options.backendFactory ?? (() => createNodeWhatsAppBackendClient({ authDirectory: this.authDirectory }));
    this.backend = this.backendFactory();
    this.bindBackend();
    ensureWhatsAppRoot(this.state);
    void this.loadCachedState();
  }

  get isConnected(): boolean {
    return this.backend.isConnected;
  }

  get hasStoredAuth(): boolean {
    return existsSync(join(this.authDirectory, "creds.json"));
  }

  restoreSavedSession(): void {
    if (!this.hasStoredAuth || this.backend.isConnected) return;
    this.loginStartedWithSavedAuth = true;
    void this.backend.startLogin().catch((error) => this.handleStartFailure(error, false));
  }

  login(): void {
    clearPrompt(this.state);
    const mustReset = this.backend.state.status === "logged-out"
      || this.backend.state.status === "connection-replaced"
      || this.backend.state.status === "stopped";

    const requestId = beginWhatsAppLoginUi(this.state.whatsapp);
    this.loginStartedWithSavedAuth = mustReset ? false : this.hasStoredAuth;
    this.scheduleRender();
    const start = () => {
      if (requestId !== this.state.whatsapp.loginRequestId) return;
      void this.backend.startLogin().then((result) => {
        if (requestId !== this.state.whatsapp.loginRequestId) return;
        this.handleLoginResult(result);
      }).catch((error) => {
        if (requestId !== this.state.whatsapp.loginRequestId) return;
        this.handleStartFailure(error, true);
      });
    };
    const ready = mustReset ? this.recreateBackend(true) : this.backendResetPromise;
    if (ready) void ready.then(start).catch((error) => this.handleStartFailure(error, true));
    else start();
  }

  cancelLogin(): void {
    this.state.whatsapp.loginRequestId += 1;
    this.backend.cancelLogin();
    this.state.whatsapp.loginModal = null;
    if (!this.loginStartedWithSavedAuth && !this.backend.isConnected) {
      void this.recreateBackend(true).finally(() => this.scheduleRender());
      return;
    }
    this.scheduleRender();
  }

  logout(): void {
    this.state.whatsapp.loginRequestId += 1;
    this.state.whatsapp.loginModal = null;
    this.cacheEnabled = false;
    this.clearCacheSaveTimer();
    const resetGeneration = ++this.backendResetGeneration;
    const previous = this.backend;
    this.unbindBackend();
    const disconnect = previous.isConnected ? previous.logout() : previous.shutdown();
    void Promise.allSettled([disconnect, this.cacheWrites]).then(async () => {
      if (resetGeneration !== this.backendResetGeneration) return;
      try {
        rmSync(this.authDirectory, { recursive: true, force: true });
        await removeWhatsAppCache(this.cacheFile);
      } catch (error) {
        setNotice(this.state, `Could not remove WhatsApp login: ${safeErrorMessage(error)}`, "warning", { statusLine: false, chat: true });
      }
      resetWhatsAppUiState(this.state.whatsapp);
      this.removeWhatsAppChannels();
      this.backend = this.backendFactory();
      this.bindBackend();
      this.cacheEnabled = true;
      setNotice(this.state, "WhatsApp disconnected.", "success", { statusLine: false, chat: true });
      this.scheduleRender();
    });
  }

  openRoot(): void {
    ensureWhatsAppRoot(this.state);
    const channels = whatsAppChannels(this.state.whatsapp);
    setSidebarCachedChannels(this.state.sidebar, WHATSAPP_GUILD_ID, channels);
    setChannelList(this.state.channelList, WHATSAPP_GUILD_ID, channels);
    this.state.sidebar.focusedGuildId = WHATSAPP_GUILD_ID;
    this.state.sidebar.loadingGuildId = this.backend.state.status === "connecting"
      || this.backend.state.status === "loading-auth"
      || this.backend.state.status === "reconnecting"
      ? WHATSAPP_GUILD_ID
      : null;
    if (!this.backend.isConnected && channels.length === 0) {
      setNotice(this.state, "Connect with /login whatsapp to load WhatsApp chats.", "muted", { statusLine: false, chat: true });
    }
    this.scheduleRender();
  }

  openChannel(channelId: string): boolean {
    const decodedJid = whatsappJidFromChannelId(channelId);
    if (!decodedJid) return false;
    const jid = canonicalWhatsAppJid(this.state.whatsapp, decodedJid);
    channelId = whatsappChannelId(jid);
    const channels = whatsAppChannels(this.state.whatsapp);
    const channel = channels.find((candidate) => candidate.id === channelId);
    if (!channel) return false;

    setSidebarCachedChannels(this.state.sidebar, WHATSAPP_GUILD_ID, channels);
    setChannelList(this.state.channelList, WHATSAPP_GUILD_ID, channels);
    setActiveChannelEntry(this.state.channelList, channel);
    this.state.sidebar.focusedGuildId = WHATSAPP_GUILD_ID;
    this.state.sidebar.activeGuildId = WHATSAPP_GUILD_ID;
    clearChannelNotifications(this.state.notifications, channelId);
    const messages = whatsAppTimelineMessages(this.state.whatsapp, channelId);
    setTimelineMessages(this.state.timeline, channelId, messages, { hasOlder: false });
    setNotice(this.state, "", "muted");
    this.scheduleRender();

    const newest = this.state.whatsapp.messagesByChatId[jid]?.at(-1);
    if (newest && this.backend.isConnected) {
      void this.backend.markRead([newest.key]).catch(() => {});
    }
    return true;
  }

  sendText(content: string): boolean {
    let channelId = this.state.channelList.activeChannelId ?? this.state.timeline.channelId;
    const decodedJid = channelId ? whatsappJidFromChannelId(channelId) : null;
    const jid = decodedJid ? canonicalWhatsAppJid(this.state.whatsapp, decodedJid) : null;
    if (jid) channelId = whatsappChannelId(jid);
    if (!channelId || !jid) return false;
    if (!this.backend.isConnected) {
      setNotice(this.state, "WhatsApp is not connected. Run /login whatsapp.", "warning", { statusLine: false, chat: true });
      this.scheduleRender();
      return true;
    }
    if (this.state.pendingImages.length > 0) {
      setNotice(this.state, "WhatsApp image sending is not wired yet; remove the pending image or use text for now.", "warning", { statusLine: false, chat: true });
      this.scheduleRender();
      return true;
    }

    const text = content;
    const localMessageId = `local:wa:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const replyTarget = this.state.replyTarget?.channelId === channelId ? this.state.replyTarget : null;
    const storedReply = replyTarget
      ? (this.state.whatsapp.messagesByChatId[jid] ?? []).find((message) => message.id === replyTarget.messageId) ?? null
      : null;
    const localMessage = {
      id: localMessageId,
      channelId,
      guildId: WHATSAPP_GUILD_ID,
      type: 0,
      content: text,
      mentionEveryone: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      mentionUsers: [],
      timestamp: Date.now(),
      editedTimestamp: null,
      author: {
        id: this.state.whatsapp.account?.id ?? "whatsapp:me",
        username: this.state.whatsapp.account?.name ?? "Me",
        displayName: this.state.whatsapp.account?.name ?? "Me",
        bot: false,
      },
      reply: replyTarget ? {
        messageId: replyTarget.messageId,
        channelId,
        authorId: replyTarget.authorId,
        authorDisplayName: replyTarget.authorDisplayName,
        timestamp: replyTarget.timestamp,
        summary: replyTarget.summary,
      } : null,
      call: null,
      attachments: [],
      stickerNames: [],
      embedsCount: 0,
      localStatus: "pending" as const,
    };

    clearPrompt(this.state);
    this.state.replyTarget = null;
    setNotice(this.state, "", "muted");
    appendTimelineMessage(this.state.timeline, localMessage);
    this.state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.scheduleRender();

    const ephemeralExpirationSeconds = this.state.whatsapp.chatsById[jid]?.ephemeralExpirationSeconds;
    void this.backend.sendText(jid, text, storedReply ?? undefined, ephemeralExpirationSeconds).then((sent) => {
      upsertWhatsAppMessages(this.state.whatsapp, [sent]);
      const mapped = whatsAppMessageToTimeline(this.state.whatsapp, sent);
      replaceTimelineMessage(this.state.timeline, localMessageId, mapped);
      this.queueCacheSave();
      this.syncProviderState();
    }).catch((error) => {
      const message = safeErrorMessage(error);
      markTimelineMessageFailed(this.state.timeline, localMessageId, message);
      this.state.replyTarget = replyTarget;
      this.state.editor.buffer = text;
      this.state.editor.cursor = text.length;
      setNotice(this.state, `WhatsApp send failed: ${message}`, "warning", { statusLine: false, chat: true });
      this.scheduleRender();
    });
    return true;
  }

  async shutdown(): Promise<void> {
    this.clearSuccessModalTimer();
    this.backendResetGeneration += 1;
    this.unbindBackend();
    await this.flushCacheSave();
    await this.backend.shutdown();
  }

  private bindBackend(): void {
    this.unsubscribers.push(
      this.backend.on("state", (event) => this.handleConnectionState(event)),
      this.backend.on("qr", ({ qr }) => {
        this.state.whatsapp.receivedQr = true;
        if (this.state.whatsapp.loginModal) {
          this.state.whatsapp.loginModal = setLoginModalPhase(this.state.whatsapp.loginModal, "qr", { qr, message: null });
        }
        this.scheduleRender();
      }),
      this.backend.on("history", (event) => {
        upsertWhatsAppContacts(this.state.whatsapp, event.contacts);
        upsertWhatsAppChats(this.state.whatsapp, event.chats);
        upsertWhatsAppMessages(this.state.whatsapp, event.messages);
        this.queueCacheSave();
        this.syncProviderState(true);
      }),
      this.backend.on("contacts", (event) => {
        upsertWhatsAppContacts(this.state.whatsapp, event.contacts);
        this.queueCacheSave();
        this.syncProviderState();
      }),
      this.backend.on("chats", (event) => {
        upsertWhatsAppChats(this.state.whatsapp, event.chats);
        this.queueCacheSave();
        this.syncProviderState(true);
      }),
      this.backend.on("messages", (event) => {
        upsertWhatsAppMessages(this.state.whatsapp, event.messages);
        this.queueCacheSave();
        for (const message of event.messages) {
          const storedChatId = canonicalWhatsAppJid(this.state.whatsapp, message.chatId);
          const stored = (this.state.whatsapp.messagesByChatId[storedChatId] ?? [])
            .find((candidate) => candidate.id === message.id) ?? message;
          const mapped = whatsAppMessageToTimeline(this.state.whatsapp, stored);
          if (this.state.timeline.channelId === mapped.channelId) {
            appendTimelineMessage(this.state.timeline, mapped);
            if (event.kind === "upsert") this.state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
          } else if (!message.fromMe && event.kind === "upsert" && event.upsertType === "notify") {
            recordChannelNotification(this.state.notifications, mapped.channelId, WHATSAPP_GUILD_ID);
          }
        }
        this.syncProviderState();
      }),
      this.backend.on("lid-mapping", ({ lid, phoneId }) => {
        registerWhatsAppLidMapping(this.state.whatsapp, lid, phoneId);
        this.queueCacheSave();
        this.syncProviderState();
      }),
      this.backend.on("error", (event) => {
        if (!event.recoverable && this.state.whatsapp.loginModal) {
          this.state.whatsapp.loginModal = setLoginModalPhase(this.state.whatsapp.loginModal, "error", {
            qr: null,
            message: safeErrorMessage(event.error),
          });
          this.scheduleRender();
        }
      }),
    );
  }

  private unbindBackend(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
  }

  private handleConnectionState(connection: WhatsAppConnectionState): void {
    this.state.whatsapp.connection = connection;
    if (connection.status === "connected") {
      this.state.whatsapp.account = connection.account
        ? {
            ...connection.account,
            ...(connection.account.name ? { name: sanitizeTerminalLabel(connection.account.name) } : {}),
          }
        : null;
      this.queueCacheSave();
      this.state.sidebar.loadingGuildId = null;
    }

    const modal = this.state.whatsapp.loginModal;
    if (modal) {
      if (connection.status === "loading-auth") {
        this.state.whatsapp.loginModal = setLoginModalPhase(modal, "starting", { qr: null, message: null });
      } else if (connection.status === "connecting") {
        const phase = this.state.whatsapp.receivedQr ? "linking" : "connecting";
        this.state.whatsapp.loginModal = setLoginModalPhase(modal, phase, { qr: null, message: null });
      } else if (connection.status === "reconnecting") {
        this.state.whatsapp.loginModal = setLoginModalPhase(modal, this.state.whatsapp.receivedQr ? "linking" : "connecting", {
          qr: null,
          message: connection.delayMs > 0 ? `Retrying in ${Math.ceil(connection.delayMs / 1000)} seconds…` : null,
        });
      } else if (connection.status === "connected") {
        this.state.whatsapp.loginModal = setLoginModalPhase(modal, "success", { qr: null, message: null });
        this.clearSuccessModalTimer();
        this.successModalTimer = setTimeout(() => {
          this.successModalTimer = null;
          if (this.state.whatsapp.loginModal?.phase === "success") {
            this.state.whatsapp.loginModal = null;
            this.scheduleRender();
          }
        }, this.successModalDelayMs);
      } else if (connection.status === "logged-out" || connection.status === "connection-replaced") {
        this.state.whatsapp.loginModal = setLoginModalPhase(modal, "error", {
          qr: null,
          message: connection.status === "logged-out"
            ? "WhatsApp logged this linked device out. Run /logout whatsapp, then try again."
            : "This linked-device session was replaced. Run /logout whatsapp, then try again.",
        });
      } else if (connection.status === "failed") {
        this.state.whatsapp.loginModal = setLoginModalPhase(modal, "error", { qr: null, message: safeErrorMessage(connection.error) });
      }
    }

    this.scheduleRender();
  }

  private handleLoginResult(result: WhatsAppLoginResult): void {
    if (result.status === "failed" && this.state.whatsapp.loginModal) {
      this.state.whatsapp.loginModal = setLoginModalPhase(this.state.whatsapp.loginModal, "error", {
        qr: null,
        message: safeErrorMessage(result.error),
      });
    }
    this.scheduleRender();
  }

  private handleStartFailure(error: unknown, showModal: boolean): void {
    if (showModal && this.state.whatsapp.loginModal) {
      this.state.whatsapp.loginModal = setLoginModalPhase(this.state.whatsapp.loginModal, "error", {
        qr: null,
        message: safeErrorMessage(error),
      });
    }
    this.scheduleRender();
  }

  private syncProviderState(syncUnreadCounts = false): void {
    ensureWhatsAppRoot(this.state);
    this.reconcileProviderChannelIds();
    const channels = whatsAppChannels(this.state.whatsapp);
    setSidebarCachedChannels(this.state.sidebar, WHATSAPP_GUILD_ID, channels);
    if (syncUnreadCounts) {
      for (const chat of Object.values(this.state.whatsapp.chatsById)) {
        if (chat.unreadCount === undefined) continue;
        const channelId = whatsappChannelId(chat.id);
        setChannelNotificationCount(
          this.state.notifications,
          channelId,
          WHATSAPP_GUILD_ID,
          chat.unreadCount,
        );
      }
    }
    if (this.state.channelList.guildId === WHATSAPP_GUILD_ID) {
      const activeId = this.state.channelList.activeChannelId;
      setChannelList(this.state.channelList, WHATSAPP_GUILD_ID, channels);
      if (activeId) {
        setActiveChannelEntry(this.state.channelList, channels.find((channel) => channel.id === activeId) ?? null);
      }
    }
    this.scheduleRender();
  }

  private reconcileProviderChannelIds(): void {
    for (const [oldChannelId, oldCount] of Object.entries(this.state.notifications.byChannelId)) {
      const oldJid = whatsappJidFromChannelId(oldChannelId);
      if (!oldJid) continue;
      const canonicalJid = canonicalWhatsAppJid(this.state.whatsapp, oldJid);
      const canonicalChannelId = whatsappChannelId(canonicalJid);
      if (canonicalChannelId === oldChannelId) continue;
      const count = oldCount + (this.state.notifications.byChannelId[canonicalChannelId] ?? 0);
      delete this.state.notifications.byChannelId[oldChannelId];
      delete this.state.notifications.channelGuildIds[oldChannelId];
      setChannelNotificationCount(
        this.state.notifications,
        canonicalChannelId,
        WHATSAPP_GUILD_ID,
        count,
      );
    }

    const activeChannelId = this.state.channelList.activeChannelId;
    const activeJid = activeChannelId ? whatsappJidFromChannelId(activeChannelId) : null;
    if (activeJid) {
      const canonicalChannelId = whatsappChannelId(canonicalWhatsAppJid(this.state.whatsapp, activeJid));
      if (canonicalChannelId !== activeChannelId) {
        this.state.channelList.activeChannelId = canonicalChannelId;
      }
    }

    const timelineJid = this.state.timeline.channelId
      ? whatsappJidFromChannelId(this.state.timeline.channelId)
      : null;
    if (timelineJid) {
      const canonicalJid = canonicalWhatsAppJid(this.state.whatsapp, timelineJid);
      const canonicalChannelId = whatsappChannelId(canonicalJid);
      if (canonicalChannelId !== this.state.timeline.channelId) {
        setTimelineMessages(
          this.state.timeline,
          canonicalChannelId,
          whatsAppTimelineMessages(this.state.whatsapp, canonicalChannelId),
          { hasOlder: false },
        );
      }
    }

    if (this.state.replyTarget) {
      const replyJid = whatsappJidFromChannelId(this.state.replyTarget.channelId);
      if (replyJid) {
        this.state.replyTarget.channelId = whatsappChannelId(canonicalWhatsAppJid(this.state.whatsapp, replyJid));
      }
    }
  }

  private removeWhatsAppChannels(): void {
    setSidebarCachedChannels(this.state.sidebar, WHATSAPP_GUILD_ID, []);
    if (this.state.channelList.guildId === WHATSAPP_GUILD_ID) {
      clearChannelList(this.state.channelList);
      clearTimeline(this.state.timeline);
      this.state.sidebar.activeGuildId = null;
    }
    for (const [channelId, guildId] of Object.entries(this.state.notifications.channelGuildIds)) {
      if (guildId === WHATSAPP_GUILD_ID) {
        clearChannelNotifications(this.state.notifications, channelId);
        delete this.state.notifications.channelGuildIds[channelId];
      }
    }
  }

  private recreateBackend(removeAuth: boolean): Promise<void> {
    const operation = this.performBackendRecreation(removeAuth);
    this.backendResetPromise = operation;
    void operation.then(
      () => { if (this.backendResetPromise === operation) this.backendResetPromise = null; },
      () => { if (this.backendResetPromise === operation) this.backendResetPromise = null; },
    );
    return operation;
  }

  private async performBackendRecreation(removeAuth: boolean): Promise<void> {
    const generation = ++this.backendResetGeneration;
    const previous = this.backend;
    this.unbindBackend();
    try {
      await previous.shutdown();
    } catch (error) {
      setNotice(this.state, `Could not stop the previous WhatsApp session cleanly: ${safeErrorMessage(error)}`, "warning", { statusLine: false, chat: true });
    }
    if (generation !== this.backendResetGeneration) return;
    if (removeAuth) {
      try {
        rmSync(this.authDirectory, { recursive: true, force: true });
      } catch (error) {
        setNotice(this.state, `Could not reset the WhatsApp login: ${safeErrorMessage(error)}`, "warning", { statusLine: false, chat: true });
      }
    }
    if (generation !== this.backendResetGeneration) return;
    this.backend = this.backendFactory();
    this.bindBackend();
    this.state.whatsapp.connection = { status: "idle" };
  }

  private clearSuccessModalTimer(): void {
    if (!this.successModalTimer) return;
    clearTimeout(this.successModalTimer);
    this.successModalTimer = null;
  }

  private async loadCachedState(): Promise<void> {
    try {
      const cached = await loadWhatsAppCache(this.cacheFile);
      if (!cached || !this.cacheEnabled) return;
      hydrateWhatsAppUiState(this.state.whatsapp, cached);
      this.syncProviderState(true);
    } catch (error) {
      setNotice(this.state, `Could not load the WhatsApp chat cache: ${safeErrorMessage(error)}`, "warning", { statusLine: false, chat: true });
      this.scheduleRender();
    }
  }

  private queueCacheSave(): void {
    if (!this.cacheEnabled) return;
    this.clearCacheSaveTimer();
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null;
      this.enqueueCacheWrite();
    }, this.cacheSaveDelayMs);
  }

  private enqueueCacheWrite(): void {
    if (!this.cacheEnabled) return;
    const snapshot = snapshotWhatsAppUiState(this.state.whatsapp);
    this.cacheWrites = this.cacheWrites.then(
      () => saveWhatsAppCache(this.cacheFile, snapshot),
      () => saveWhatsAppCache(this.cacheFile, snapshot),
    ).catch((error) => {
      if (!this.cacheEnabled) return;
      setNotice(this.state, `Could not save the WhatsApp chat cache: ${safeErrorMessage(error)}`, "warning", { statusLine: false, chat: true });
      this.scheduleRender();
    });
  }

  private async flushCacheSave(): Promise<void> {
    if (this.cacheSaveTimer) {
      this.clearCacheSaveTimer();
      this.enqueueCacheWrite();
    }
    await this.cacheWrites;
  }

  private clearCacheSaveTimer(): void {
    if (!this.cacheSaveTimer) return;
    clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = null;
  }
}
