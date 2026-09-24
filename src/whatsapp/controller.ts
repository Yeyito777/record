import { existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { WHATSAPP_GUILD_ID, instagramGuild, whatsappChannelId, whatsappGuild, whatsappJidFromChannelId, whatsappSidebarLayoutScope } from "../chatproviders";
import { clearChannelList, setActiveChannelEntry, setChannelList } from "../channels";
import { loadCachedSidebarChannelLayout, saveCachedSidebarChannelLayout } from "../datacache";
import { DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, type DiscordMessage, type DiscordMessageAttachment } from "../discord";
import { cachedAttachmentIsComplete, cachedAttachmentPath, pruneAttachmentCache, refreshCachedAttachment, type AttachmentOpenResult } from "../openable";
import {
  clearChannelNotifications,
  setChannelNotificationCount,
} from "../notifications";
import { applySidebarChannelLayoutForGuild, setSidebarCachedChannels, setSidebarGuilds, sidebarCachedGuilds, sidebarChannelLayoutForGuild } from "../sidebar";
import type { AppState } from "../state";
import { setNotice } from "../state";
import { clearTimeline, appendTimelineMessage, replaceTimelineMessage, setTimelineMessages } from "../timeline";
import { clearPrompt } from "../promptstate";
import {
  beginWhatsAppLoginUi,
  applyWhatsAppReactions,
  canonicalWhatsAppJid,
  MAX_WHATSAPP_MESSAGES_PER_CHAT,
  registerWhatsAppLidMapping,
  resetWhatsAppUiState,
  upsertWhatsAppChats,
  upsertWhatsAppContacts,
  upsertWhatsAppMessages,
  whatsAppAttachmentMessage,
  updateWhatsAppChats,
  whatsAppChannels,
  whatsAppDisplayName,
  whatsAppMessageToTimeline,
  whatsAppTimelineMessages,
} from "./integration";
import { isWhatsAppChatMuted, WHATSAPP_MUTE_FOREVER_END_MS } from "./mute";
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
  WhatsAppMessage,
  WhatsAppMessageKey,
  WhatsAppReactionEvent,
} from "./types";
import type { WhatsAppImageUpload } from "./worker-protocol";

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
    messageId?: string,
  ): Promise<import("./types").WhatsAppMessage>;
  sendImages(
    chatId: string,
    images: WhatsAppImageUpload[],
    caption: string,
    quoted?: import("./types").WhatsAppMessage,
    ephemeralExpirationSeconds?: number,
    messageIds?: string[],
  ): Promise<import("./types").WhatsAppMessage[]>;
  markRead(keys: import("./types").WhatsAppMessageKey[]): Promise<void>;
  sendReaction(key: WhatsAppMessageKey, emoji: string): Promise<WhatsAppReactionEvent>;
  fetchHistory(
    count: number,
    oldestKey: import("./types").WhatsAppMessageKey,
    oldestTimestampMs: number,
  ): Promise<string>;
  downloadMedia(
    message: import("./types").WhatsAppMessage,
    destinationPath: string,
    recoveryAnchor?: import("./types").WhatsAppMediaRecoveryAnchor,
  ): Promise<import("./worker-protocol").WhatsAppDownloadMediaResult>;
  setChatMuted(chatId: string, muted: boolean): Promise<import("./worker-protocol").WhatsAppSetChatMutedResult>;
  on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>): () => void;
}

export interface WhatsAppControllerOptions {
  backendFactory?: () => WhatsAppBackendHandle;
  authDirectory?: string;
  cacheFile?: string;
  cacheSaveDelayMs?: number;
  successModalDelayMs?: number;
  historyPageDelayMs?: number;
  historyRequestTimeoutMs?: number;
}

const DEFAULT_SUCCESS_MODAL_DELAY_MS = 900;
const DEFAULT_CACHE_SAVE_DELAY_MS = 250;
const DEFAULT_HISTORY_PAGE_DELAY_MS = 250;
const DEFAULT_HISTORY_REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_GAP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000;

interface PendingHistoryRequest {
  anchorId: string;
  requestId: string | null;
  receivedPages: Map<string, readonly import("./types").WhatsAppMessage[]>;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingReactionRequest {
  optimistic: WhatsAppReactionEvent;
  failed: boolean;
  settled: boolean;
  previous?: PendingReactionRequest;
  rollback: WhatsAppReactionEvent;
}

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "Unknown error");
  return sanitizeTerminalLabel(text).slice(0, 240);
}

function ensureWhatsAppRoot(state: AppState): void {
  setSidebarGuilds(state.sidebar, [
    { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
    whatsappGuild(),
    instagramGuild(),
    ...sidebarCachedGuilds(state.sidebar),
  ]);
}

export class WhatsAppController {
  private backend: WhatsAppBackendHandle;
  private readonly backendFactory: () => WhatsAppBackendHandle;
  private readonly authDirectory: string;
  private readonly cacheFile: string;
  private readonly cacheReady: Promise<void>;
  private readonly cacheSaveDelayMs: number;
  private readonly successModalDelayMs: number;
  private readonly historyPageDelayMs: number;
  private readonly historyRequestTimeoutMs: number;
  private readonly unsubscribers: Array<() => void> = [];
  private successModalTimer: ReturnType<typeof setTimeout> | null = null;
  private loginStartedWithSavedAuth = false;
  private backendResetGeneration = 0;
  private backendResetPromise: Promise<void> | null = null;
  private cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheWrites: Promise<void> = Promise.resolve();
  private cacheEnabled = true;
  private shuttingDown = false;
  private restoreScheduled = false;
  private historyRequestGeneration = 0;
  private readonly pendingHistoryByChatId = new Map<string, PendingHistoryRequest>();
  private muteRequestSequence = 0;
  private readonly muteRequestIdByChatId = new Map<string, number>();
  private loadedSidebarLayoutScope: string | null = null;
  // Local sends are not server history. Keep them independently of the visible
  // timeline so backfills, reactions and navigation cannot discard them.
  private readonly localMessages = new Map<string, DiscordMessage>();
  private readonly outgoing = new Map<string, {
    message: DiscordMessage;
    messageIds: string[];
    confirmedIds: Set<string>;
  }>();
  // Include removals so a late history snapshot cannot resurrect a reaction.
  private readonly liveReactions = new Map<string, WhatsAppReactionEvent>();
  private readonly reactionRequests = new Map<string, PendingReactionRequest>();

  constructor(
    private readonly state: AppState,
    private readonly scheduleRender: () => void,
    options: WhatsAppControllerOptions = {},
  ) {
    this.authDirectory = options.authDirectory ?? getRecordWhatsAppPaths().authDirectory;
    this.cacheFile = options.cacheFile ?? join(dirname(this.authDirectory), "cache.json");
    this.cacheSaveDelayMs = options.cacheSaveDelayMs ?? DEFAULT_CACHE_SAVE_DELAY_MS;
    this.successModalDelayMs = options.successModalDelayMs ?? DEFAULT_SUCCESS_MODAL_DELAY_MS;
    this.historyPageDelayMs = options.historyPageDelayMs ?? DEFAULT_HISTORY_PAGE_DELAY_MS;
    this.historyRequestTimeoutMs = options.historyRequestTimeoutMs ?? DEFAULT_HISTORY_REQUEST_TIMEOUT_MS;
    this.backendFactory = options.backendFactory ?? (() => createNodeWhatsAppBackendClient({ authDirectory: this.authDirectory }));
    this.backend = this.backendFactory();
    this.bindBackend();
    ensureWhatsAppRoot(this.state);
    this.cacheReady = this.loadCachedState();
  }

  get isConnected(): boolean {
    return this.backend.isConnected;
  }

  get hasStoredAuth(): boolean {
    return existsSync(join(this.authDirectory, "creds.json"));
  }

  restoreSavedSession(): void {
    if (!this.hasStoredAuth || this.backend.isConnected || this.restoreScheduled || this.shuttingDown || !this.cacheEnabled) return;
    this.restoreScheduled = true;
    void this.cacheReady.then(() => {
      this.restoreScheduled = false;
      if (!this.hasStoredAuth || this.backend.isConnected || this.shuttingDown || !this.cacheEnabled) return;
      this.loginStartedWithSavedAuth = true;
      void this.backend.startLogin().catch((error) => this.handleStartFailure(error, false));
    });
  }

  /** Open a persisted chat only after its disk cache has been hydrated. */
  async restoreCachedChannel(channelId: string): Promise<boolean> {
    await this.cacheReady;
    return this.openChannel(channelId);
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
    const backendReady = mustReset ? this.recreateBackend(true) : this.backendResetPromise;
    const ready = backendReady ? Promise.all([this.cacheReady, backendReady]) : this.cacheReady;
    void ready.then(start).catch((error) => this.handleStartFailure(error, true));
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
    this.clearLocalMessages();
    this.clearPendingHistoryRequests();
    this.state.whatsapp.loginRequestId += 1;
    this.state.whatsapp.loginModal = null;
    this.cacheEnabled = false;
    this.clearCacheSaveTimer();
    const resetGeneration = ++this.backendResetGeneration;
    const previous = this.backend;
    this.unbindBackend();
    const disconnect = previous.isConnected ? previous.logout() : previous.shutdown();
    const operation = Promise.allSettled([disconnect, this.cacheWrites]).then(async () => {
      if (resetGeneration !== this.backendResetGeneration) return;
      try {
        rmSync(this.authDirectory, { recursive: true, force: true });
        await removeWhatsAppCache(this.cacheFile);
      } catch (error) {
        setNotice(this.state, `Could not remove WhatsApp login: ${safeErrorMessage(error)}`, "warning", { statusLine: true, chat: false });
      }
      if (resetGeneration !== this.backendResetGeneration) return;
      this.clearLocalMessages();
      resetWhatsAppUiState(this.state.whatsapp);
      this.removeWhatsAppChannels();
      this.backend = this.backendFactory();
      this.bindBackend();
      this.cacheEnabled = true;
      setNotice(this.state, "WhatsApp disconnected.", "success", { statusLine: true, chat: false });
      this.scheduleRender();
    });
    this.backendResetPromise = operation;
    const finished = () => { if (this.backendResetPromise === operation) this.backendResetPromise = null; };
    void operation.then(finished, finished);
  }

  openRoot(): void {
    // Invalidate an in-flight Discord channel-list fetch before taking focus.
    this.state.channelList.requestId += 1;
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
      setNotice(this.state, "Connect with /login whatsapp to load WhatsApp chats.", "muted", { statusLine: true, chat: false });
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

    this.state.channelList.requestId += 1;
    this.state.timeline.requestId += 1;
    setSidebarCachedChannels(this.state.sidebar, WHATSAPP_GUILD_ID, channels);
    setChannelList(this.state.channelList, WHATSAPP_GUILD_ID, channels);
    setActiveChannelEntry(this.state.channelList, channel);
    this.state.sidebar.focusedGuildId = WHATSAPP_GUILD_ID;
    this.state.sidebar.activeGuildId = WHATSAPP_GUILD_ID;
    clearChannelNotifications(this.state.notifications, channelId);
    const chat = this.state.whatsapp.chatsById[jid];
    if (chat) {
      chat.unreadCount = 0;
      this.queueCacheSave();
    }
    this.refreshTimeline(channelId, false, false);
    setNotice(this.state, "", "muted");
    this.scheduleRender();

    const unreadKeys = (this.state.whatsapp.messagesByChatId[jid] ?? [])
      .filter((message) => !message.fromMe)
      .slice(-100)
      .map((message) => message.key);
    if (unreadKeys.length > 0 && this.backend.isConnected) {
      void this.backend.markRead(unreadKeys).catch(() => {});
    }
    this.requestOlderHistory(jid);
    return true;
  }

  loadOlderHistory(): void {
    const jid = this.activeWhatsAppJid();
    if (jid) this.requestOlderHistory(jid);
  }

  async reactToMessage(message: DiscordMessage, emoji: string): Promise<void> {
    if (!this.backend.isConnected || this.backendResetPromise || this.shuttingDown) {
      throw new Error("WhatsApp is not connected.");
    }
    const decoded = whatsappJidFromChannelId(message.channelId);
    if (!decoded || message.localStatus || typeof emoji !== "string") {
      throw new Error("Invalid WhatsApp reaction target.");
    }
    const jid = canonicalWhatsAppJid(this.state.whatsapp, decoded);
    const target = this.state.whatsapp.messagesByChatId[jid]?.find((candidate) => candidate.id === message.id);
    if (!target || !target.key.id || !target.key.chatId
      || (target.key.chatId.endsWith("@g.us") && !target.key.participantId && !target.key.fromMe)) {
      throw new Error("WhatsApp reaction target is unavailable.");
    }
    const key = JSON.stringify([jid, target.id, "self"]);
    // Snapshot only our reaction: other participants may react while this send
    // is pending. Rollback must not replace their updated reactions.
    const previous = target.reactions?.find((reaction) => reaction.fromMe);
    const optimistic: WhatsAppReactionEvent = {
      target: { ...target.key },
      reaction: {
        senderId: previous?.senderId ?? this.state.whatsapp.account?.id ?? "whatsapp:me",
        fromMe: true,
        emoji,
      },
    };
    const previousRequest = this.reactionRequests.get(key);
    const rollback: WhatsAppReactionEvent = {
      target: optimistic.target,
      reaction: previous ? { ...previous } : { ...optimistic.reaction, emoji: "" },
    };
    const followsPending = previousRequest?.optimistic === this.liveReactions.get(key);
    const request: PendingReactionRequest = {
      optimistic,
      failed: false,
      settled: false,
      previous: followsPending ? previousRequest : undefined,
      // If overlapping sends both fail, skip the failed optimistic predecessor
      // rather than resurrecting a reaction that was never sent.
      rollback,
    };
    this.reactionRequests.set(key, request);
    const generation = this.backendResetGeneration;
    const isCurrent = () => generation === this.backendResetGeneration && !this.shuttingDown
      && this.reactionRequests.get(key) === request
      && this.liveReactions.get(key) === optimistic;
    this.recordReactions([optimistic]);
    try {
      const event = await this.backend.sendReaction({ ...target.key }, emoji);
      if (!isCurrent()) return;
      this.recordReactions([event]);
    } catch (error) {
      request.failed = true;
      // A gateway echo (including a removal) or a newer local request owns the
      // state now; neither a late failure nor a late success may overwrite it.
      if (isCurrent()) {
        let restore = request;
        while (restore.previous?.failed) restore = restore.previous;
        const owner = restore.previous;
        this.recordReactions([owner?.optimistic ?? restore.rollback]);
        if (owner && !owner.settled) {
          this.reactionRequests.set(key, owner);
        }
      }
      throw error;
    } finally {
      request.settled = true;
      if (this.reactionRequests.get(key) === request) this.reactionRequests.delete(key);
    }
  }

  private recordReactions(events: WhatsAppReactionEvent[]): void {
    for (const event of events) {
      const key = JSON.stringify([canonicalWhatsAppJid(this.state.whatsapp, event.target.chatId),
        event.target.id, event.reaction.fromMe ? "self" : event.reaction.senderId]);
      this.liveReactions.set(key, event);
    }
    const changed = applyWhatsAppReactions(this.state.whatsapp, events);
    if (changed.length === 0) return;
    this.queueCacheSave();
    this.refreshActiveTimeline();
    this.scheduleRender();
  }

  sendMessage(content: string): boolean {
    let channelId = this.state.channelList.activeChannelId ?? this.state.timeline.channelId;
    const decodedJid = channelId ? whatsappJidFromChannelId(channelId) : null;
    const jid = decodedJid ? canonicalWhatsAppJid(this.state.whatsapp, decodedJid) : null;
    if (jid) channelId = whatsappChannelId(jid);
    if (!channelId || !jid) return false;
    if (!this.backend.isConnected || !this.cacheEnabled || this.backendResetPromise || this.shuttingDown) {
      const connection = this.backend.state;
      const message = !this.cacheEnabled || this.backendResetPromise || this.shuttingDown
        ? "WhatsApp is disconnecting; your draft was not sent."
        : connection.status === "reconnecting"
        ? `WhatsApp is reconnecting (attempt ${connection.attempt}); your draft was not sent.`
        : connection.status === "connecting" || connection.status === "loading-auth"
          ? "WhatsApp is still connecting; your draft was not sent."
          : "WhatsApp is not connected. Run /login whatsapp; your draft was not sent.";
      setNotice(this.state, message, "warning", { statusLine: true, chat: false });
      this.scheduleRender();
      return true;
    }
    const text = content;
    const generation = this.backendResetGeneration;
    const pendingImages = this.state.pendingImages.slice();
    // Baileys' legacy message ID format. Assign IDs before starting the RPC so
    // echoes can acknowledge exactly one send, including identical text sends.
    const messageIds = Array.from({ length: Math.max(1, pendingImages.length) },
      () => `3EB0${randomBytes(18).toString("hex").toUpperCase()}`);
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
      attachments: pendingImages.map((image, index) => ({
        id: `${localMessageId}:image:${index}`,
        filename: image.filename ?? `image-${index + 1}`,
        contentType: image.mediaType,
        size: image.sizeBytes,
        url: "",
      })),
      stickerNames: [],
      embedsCount: 0,
      localStatus: "pending" as const,
    };

    // Optimistic attachments have no WhatsApp message ID yet. Render the
    // original upload bytes instead of trying to download a temporary ID.
    for (const [index, attachment] of localMessage.attachments.entries()) {
      const image = pendingImages[index]!;
      this.state.localAttachmentImages[attachment.id] = { mediaType: image.mediaType, base64: image.base64 };
    }
    clearPrompt(this.state);
    const clearedEditor = this.state.editor.undo;
    this.state.pendingImages = [];
    this.state.replyTarget = null;
    setNotice(this.state, "", "muted");
    this.localMessages.set(localMessageId, localMessage);
    const outgoing = { message: localMessage, messageIds, confirmedIds: new Set<string>() };
    this.outgoing.set(localMessageId, outgoing);
    appendTimelineMessage(this.state.timeline, localMessage);
    this.state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.scheduleRender();

    const ephemeralExpirationSeconds = this.state.whatsapp.chatsById[jid]?.ephemeralExpirationSeconds;
    const send = pendingImages.length > 0
      ? this.backend.sendImages(jid, pendingImages, text, storedReply ?? undefined, ephemeralExpirationSeconds, messageIds)
      : this.backend.sendText(jid, text, storedReply ?? undefined, ephemeralExpirationSeconds, messageIds[0]).then((sent) => [sent]);
    void send.then((sentMessages) => {
      if (generation !== this.backendResetGeneration) return;
      if (sentMessages.length === 0) throw new Error("WhatsApp did not return the sent message.");
      upsertWhatsAppMessages(this.state.whatsapp, sentMessages, { preferExisting: true });
      this.localMessages.delete(localMessageId);
      this.outgoing.delete(localMessageId);
      for (const attachment of localMessage.attachments) delete this.state.localAttachmentImages[attachment.id];
      this.queueCacheSave();
      this.syncProviderState();
      this.refreshActiveTimeline();
    }).catch((error) => {
      if (generation !== this.backendResetGeneration) return;
      // An exact live echo is a successful send even if the RPC subsequently
      // fails (for example, the worker closes after emitting the echo).
      if (outgoing.confirmedIds.size === messageIds.length) return;
      const message = safeErrorMessage(error);
      const remaining = this.localMessages.get(localMessageId) ?? localMessage;
      this.localMessages.set(localMessageId, { ...remaining, localStatus: "failed", localError: message });
      const remainingImages = pendingImages.filter((_, index) => !outgoing.confirmedIds.has(messageIds[index]!));
      const remainingText = outgoing.confirmedIds.has(messageIds[0]!) ? "" : text;
      // Never replace a newer draft or insert an old chat's draft into another
      // conversation. The failed bubble retains the text/images either way.
      if (this.activeWhatsAppJid() === canonicalWhatsAppJid(this.state.whatsapp, jid)
        && this.state.editor.undo === clearedEditor
        && !this.state.editor.buffer && !this.state.pendingImages.length && !this.state.replyTarget) {
        this.state.replyTarget = outgoing.confirmedIds.has(messageIds[0]!) ? null : replyTarget;
        this.state.pendingImages = remainingImages;
        this.state.editor.buffer = remainingText;
        this.state.editor.cursor = remainingText.length;
      }
      this.refreshActiveTimeline();
      setNotice(this.state, `WhatsApp send failed: ${message}`, "warning", { statusLine: true, chat: false });
      this.scheduleRender();
    });
    return true;
  }

  toggleChatMute(channelId: string): boolean {
    const decodedJid = whatsappJidFromChannelId(channelId);
    const jid = decodedJid ? canonicalWhatsAppJid(this.state.whatsapp, decodedJid) : null;
    const chat = jid ? this.state.whatsapp.chatsById[jid] : undefined;
    if (!jid || !chat) return false;
    if (!this.backend.isConnected) {
      setNotice(this.state, "WhatsApp is not connected; the chat's mute setting was not changed.", "warning", { statusLine: true, chat: false });
      this.scheduleRender();
      return true;
    }

    const previousMutedUntilMs = chat.mutedUntilMs;
    const previousMuted = isWhatsAppChatMuted(previousMutedUntilMs);
    const nextMuted = !previousMuted;
    chat.mutedUntilMs = nextMuted ? WHATSAPP_MUTE_FOREVER_END_MS : null;
    if (nextMuted) clearChannelNotifications(this.state.notifications, whatsappChannelId(jid));
    this.queueCacheSave();
    setNotice(this.state, "", "muted");
    this.syncProviderState(true);
    const requestId = ++this.muteRequestSequence;
    this.muteRequestIdByChatId.set(jid, requestId);

    void this.backend.setChatMuted(jid, nextMuted).then((result) => {
      if (this.muteRequestIdByChatId.get(jid) !== requestId) return;
      this.muteRequestIdByChatId.delete(jid);
      const current = this.state.whatsapp.chatsById[jid];
      if (current) current.mutedUntilMs = result.mutedUntilMs;
      this.queueCacheSave();
      this.syncProviderState(true);
    }).catch((error) => {
      if (this.muteRequestIdByChatId.get(jid) !== requestId) return;
      this.muteRequestIdByChatId.delete(jid);
      const current = this.state.whatsapp.chatsById[jid];
      if (current) current.mutedUntilMs = previousMutedUntilMs;
      this.queueCacheSave();
      setNotice(
        this.state,
        `Failed to ${nextMuted ? "mute" : "unmute"} ${whatsAppDisplayName(this.state.whatsapp, jid)}: ${safeErrorMessage(error)}`,
        "error",
        { statusLine: true, chat: false },
      );
      this.syncProviderState(true);
    });
    return true;
  }

  async downloadAttachment(attachment: DiscordMessageAttachment): Promise<AttachmentOpenResult> {
    const path = cachedAttachmentPath(attachment);
    if (cachedAttachmentIsComplete(path, attachment.size)) {
      refreshCachedAttachment(path);
      return { ok: true, path, cached: true };
    }

    const messageId = attachment.id.startsWith("wa-media:")
      ? attachment.id.slice("wa-media:".length)
      : null;
    const source = whatsAppAttachmentMessage(attachment);
    const jid = source
      ? canonicalWhatsAppJid(this.state.whatsapp, source.chatId)
      : this.activeWhatsAppJid();
    const message = messageId && jid
      ? (this.state.whatsapp.messagesByChatId[jid] ?? []).find((candidate) => candidate.id === messageId) ?? source
      : null;
    if (!jid || !message || message.content.kind !== "media") {
      return { ok: false, error: "WhatsApp media message is unavailable." };
    }
    if (!this.backend.isConnected) {
      return { ok: false, retryWhenConnected: true, error: "WhatsApp must be connected to download this attachment." };
    }

    const backend = this.backend;
    const connection = backend.state;
    try {
      const messages = this.state.whatsapp.messagesByChatId[jid] ?? [];
      const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);
      const newerMessages = messageIndex >= 0
        ? messages.slice(messageIndex + 1)
        : messages.filter((candidate) => message.timestampMs !== null
          && candidate.timestampMs !== null && candidate.timestampMs > message.timestampMs);
      const newerAnchor = newerMessages.find((candidate) => (
        candidate.timestampMs !== null && candidate.timestampMs > 0
        && Boolean(candidate.key.id && candidate.key.chatId)
      ));
      const recoveryAnchor = newerAnchor?.timestampMs
        ? { key: newerAnchor.key, timestampMs: newerAnchor.timestampMs }
        : undefined;
      await backend.downloadMedia(message, path, recoveryAnchor);
      if (!cachedAttachmentIsComplete(path, attachment.size)) {
        rmSync(path, { force: true });
        return { ok: false, error: "WhatsApp returned an incomplete attachment." };
      }
      pruneAttachmentCache(path);
      return { ok: true, path, cached: false };
    } catch (error) {
      rmSync(path, { force: true });
      return {
        ok: false,
        error: safeErrorMessage(error),
        ...(backend !== this.backend || connection !== backend.state || !backend.isConnected
          ? { retryWhenConnected: true } : {}),
      };
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearPendingHistoryRequests();
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
        // On-demand history is a message backfill, not authoritative current
        // chat metadata. Old pages can contain an old last-message timestamp;
        // applying it would make the focused conversation suddenly move down.
        const chats = event.syncKind === "on-demand"
          ? event.chats.map(({ unreadCount: _unreadCount, lastMessageAtMs: _lastMessageAtMs, ...chat }) => chat)
          : event.chats;
        upsertWhatsAppChats(this.state.whatsapp, chats);
        upsertWhatsAppMessages(this.state.whatsapp, event.messages, { preferExisting: true });
        applyWhatsAppReactions(this.state.whatsapp, event.reactions ?? []);
        this.reapplyLiveReactions([...event.messages, ...(event.reactions ?? []).map(({ target }) => target)]);
        this.confirmOutgoingMessages(event.messages);
        this.reconcileProviderChannelIds();
        const completedHistoryRequest = event.syncKind === "on-demand"
          ? this.completeHistoryRequest(event.requestId, event.messages)
          : null;
        this.queueCacheSave();
        const activeJid = this.activeWhatsAppJid();
        if (activeJid) {
          const channelId = whatsappChannelId(activeJid);
          this.refreshTimeline(channelId, true,
            (this.state.whatsapp.messagesByChatId[activeJid]?.length ?? 0) < MAX_WHATSAPP_MESSAGES_PER_CHAT
            && (completedHistoryRequest?.chatId !== activeJid || completedHistoryRequest.anchorAdvanced));
        }
        this.syncProviderState(true);
        this.continueHistory(completedHistoryRequest);
      }),
      this.backend.on("contacts", (event) => {
        upsertWhatsAppContacts(this.state.whatsapp, event.contacts);
        this.queueCacheSave();
        this.syncProviderState();
      }),
      this.backend.on("chats", (event) => {
        if (event.kind === "update") updateWhatsAppChats(this.state.whatsapp, event.chats);
        else upsertWhatsAppChats(this.state.whatsapp, event.chats);
        this.queueCacheSave();
        this.syncProviderState(true);
      }),
      this.backend.on("messages", (event) => {
        const previouslyKnownIds = new Set(event.messages
          .filter((message) => {
            const chatId = canonicalWhatsAppJid(this.state.whatsapp, message.chatId);
            return (this.state.whatsapp.messagesByChatId[chatId] ?? [])
              .some((candidate) => candidate.id === message.id);
          })
          .map((message) => message.id));
        upsertWhatsAppMessages(this.state.whatsapp, event.messages, { preferExisting: event.kind === "upsert" });
        this.reapplyLiveReactions(event.messages);
        this.confirmOutgoingMessages(event.messages);
        // A message can reveal an LID→phone mapping after the corresponding
        // chats.update already created a temporary LID notification. Reconcile
        // before deciding whether the active chat should be cleared.
        this.reconcileProviderChannelIds();
        this.queueCacheSave();
        for (const message of event.messages) {
          const storedChatId = canonicalWhatsAppJid(this.state.whatsapp, message.chatId);
          const stored = (this.state.whatsapp.messagesByChatId[storedChatId] ?? [])
            .find((candidate) => candidate.id === message.id) ?? message;
          const mapped = whatsAppMessageToTimeline(this.state.whatsapp, stored);
          if (this.state.timeline.channelId === mapped.channelId) {
            // A visible message may already be outside the bounded provider
            // cache. Apply its update directly, without content-based echo
            // matching (only our outgoing IDs may acknowledge local sends).
            const previous = this.state.timeline.messages.find((candidate) => candidate.id === mapped.id);
            if (previous && stored.timestampMs === null) mapped.timestamp = previous.timestamp;
            if (previous && !stored.senderId && !stored.senderName) mapped.author = previous.author;
            replaceTimelineMessage(this.state.timeline, mapped.id, mapped);
            const isNewUpsert = event.kind === "upsert" && !previouslyKnownIds.has(message.id);
            if (isNewUpsert) this.state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
            if (!message.fromMe && isNewUpsert && event.upsertType === "notify") {
              const chat = this.state.whatsapp.chatsById[storedChatId];
              if (chat) chat.unreadCount = 0;
              clearChannelNotifications(this.state.notifications, mapped.channelId);
              void this.backend.markRead([message.key]).catch(() => {});
            }
          }
        }
        this.refreshActiveTimeline();
        this.syncProviderState();
      }),
      this.backend.on("reactions", (events) => {
        this.recordReactions(events);
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
    if (connection.status !== "connected") this.clearPendingHistoryRequests();
    if (connection.status === "connected") {
      this.state.whatsapp.account = connection.account
        ? {
            ...connection.account,
            ...(connection.account.name ? { name: sanitizeTerminalLabel(connection.account.name) } : {}),
          }
        : null;
      this.applyCachedSidebarChannelLayout();
      this.queueCacheSave();
      this.state.sidebar.loadingGuildId = null;
      const jid = this.activeWhatsAppJid();
      if (jid) this.requestOlderHistory(jid);
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

    if (!modal) {
      if (connection.status === "loading-auth" || connection.status === "connecting") {
        setNotice(this.state, "WhatsApp connecting…", "muted", { loading: true, statusLine: true, chat: false });
      } else if (connection.status === "reconnecting") {
        const delay = connection.delayMs > 0 ? ` in ${Math.ceil(connection.delayMs / 1_000)}s` : "";
        setNotice(this.state, `WhatsApp reconnecting${delay}…`, "muted", { loading: true, statusLine: true, chat: false });
      } else if (connection.status === "failed") {
        setNotice(this.state, `WhatsApp connection failed: ${safeErrorMessage(connection.error)}`, "error", { statusLine: true, chat: false });
      } else if (connection.status === "logged-out") {
        setNotice(this.state, "WhatsApp logged this linked device out. Run /logout whatsapp, then log in again.", "warning", { statusLine: true, chat: false });
      } else if (connection.status === "connection-replaced") {
        setNotice(this.state, "WhatsApp was opened by another client and this session was replaced.", "warning", { statusLine: true, chat: false });
      } else if (connection.status === "connected"
        && (this.state.notice.text.startsWith("WhatsApp connect")
          || this.state.notice.text.startsWith("WhatsApp reconnect"))) {
        setNotice(this.state, "", "muted");
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
    this.applyCachedSidebarChannelLayout();
    this.reconcileProviderChannelIds();
    const channels = whatsAppChannels(this.state.whatsapp);
    setSidebarCachedChannels(this.state.sidebar, WHATSAPP_GUILD_ID, channels);
    if (syncUnreadCounts) {
      const activeJid = this.activeWhatsAppJid();
      const visibleChannels = new Map(channels.map((channel) => [
        whatsappJidFromChannelId(channel.id),
        channel,
      ]));
      for (const chat of Object.values(this.state.whatsapp.chatsById)) {
        if (chat.unreadCount === undefined) continue;
        const channelId = whatsappChannelId(chat.id);
        const visibleChannel = visibleChannels.get(chat.id);
        if (!visibleChannel || visibleChannel.muted) {
          clearChannelNotifications(this.state.notifications, channelId);
          continue;
        }
        if (chat.id === activeJid) {
          chat.unreadCount = 0;
          clearChannelNotifications(this.state.notifications, channelId);
          continue;
        }
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

  private clearLocalMessages(): void {
    for (const message of this.localMessages.values()) {
      for (const attachment of message.attachments) delete this.state.localAttachmentImages[attachment.id];
    }
    this.localMessages.clear();
    this.outgoing.clear();
    this.liveReactions.clear();
  }

  private reapplyLiveReactions(targets: readonly Pick<WhatsAppMessageKey, "id" | "chatId">[]): void {
    const keys = new Set(targets.map((target) =>
      JSON.stringify([canonicalWhatsAppJid(this.state.whatsapp, target.chatId), target.id])));
    applyWhatsAppReactions(this.state.whatsapp, [...this.liveReactions.values()].filter(({ target }) =>
      keys.has(JSON.stringify([canonicalWhatsAppJid(this.state.whatsapp, target.chatId), target.id]))));
  }

  private confirmOutgoingMessages(messages: readonly WhatsAppMessage[]): void {
    for (const [localId, outgoing] of this.outgoing) {
      const jid = canonicalWhatsAppJid(this.state.whatsapp, whatsappJidFromChannelId(outgoing.message.channelId)!);
      for (const message of messages) {
        if (message.fromMe && outgoing.messageIds.includes(message.id)
          && canonicalWhatsAppJid(this.state.whatsapp, message.chatId) === jid) {
          outgoing.confirmedIds.add(message.id);
        }
      }
      if (!outgoing.confirmedIds.size) continue;
      const { message, messageIds, confirmedIds } = outgoing;
      if (confirmedIds.size === messageIds.length) {
        this.localMessages.delete(localId);
        this.outgoing.delete(localId);
      } else {
        this.localMessages.set(localId, {
          ...this.localMessages.get(localId)!,
          content: confirmedIds.has(messageIds[0]!) ? "" : message.content,
          reply: confirmedIds.has(messageIds[0]!) ? null : message.reply,
          attachments: message.attachments.filter((_, index) => !confirmedIds.has(messageIds[index]!)),
        });
      }
      for (const [index, attachment] of message.attachments.entries()) {
        if (confirmedIds.has(messageIds[index]!)) delete this.state.localAttachmentImages[attachment.id];
      }
    }
  }

  private refreshTimeline(channelId: string, preserveScroll = true, hasOlder = this.state.timeline.hasOlder): void {
    const sameTimeline = preserveScroll && this.state.timeline.channelId === channelId;
    // The visible history may be larger than the bounded provider cache. Keep
    // those messages (and their attachment source objects) until navigation.
    const byId = new Map((sameTimeline ? this.state.timeline.messages : [])
      .filter((message) => !message.localStatus)
      .map((message) => [message.id, message]));
    for (const message of whatsAppTimelineMessages(this.state.whatsapp, channelId)) byId.set(message.id, message);
    const messages = [...byId.values()];
    for (const local of this.localMessages.values()) {
      const jid = whatsappJidFromChannelId(local.channelId)!;
      const canonicalChannelId = whatsappChannelId(canonicalWhatsAppJid(this.state.whatsapp, jid));
      if (canonicalChannelId === channelId) messages.push({ ...local, channelId });
    }
    messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const systemMessages = this.state.timeline.systemMessages;
    setTimelineMessages(this.state.timeline, channelId, messages, { preserveScroll, hasOlder });
    if (sameTimeline) this.state.timeline.systemMessages = systemMessages;
    const jid = whatsappJidFromChannelId(channelId);
    this.state.timeline.loadingOlder = Boolean(jid && this.pendingHistoryByChatId.has(jid));
  }

  private refreshActiveTimeline(): void {
    const jid = this.activeWhatsAppJid();
    if (jid) this.refreshTimeline(whatsappChannelId(jid));
  }

  private continueHistory(completed: { chatId: string; anchorAdvanced: boolean } | null): void {
    if (!completed?.anchorAdvanced || this.activeWhatsAppJid() !== completed.chatId) return;
    const generation = this.historyRequestGeneration;
    setTimeout(() => {
      if (generation === this.historyRequestGeneration && this.activeWhatsAppJid() === completed.chatId) {
        this.requestOlderHistory(completed.chatId);
      }
    }, this.historyPageDelayMs);
  }

  private activeWhatsAppJid(): string | null {
    const channelId = this.state.timeline.channelId ?? this.state.channelList.activeChannelId;
    const jid = channelId ? whatsappJidFromChannelId(channelId) : null;
    return jid ? canonicalWhatsAppJid(this.state.whatsapp, jid) : null;
  }

  private applyCachedSidebarChannelLayout(): void {
    const accountId = this.state.whatsapp.account?.id;
    if (!accountId) return;
    const scope = whatsappSidebarLayoutScope(accountId, this.state.whatsapp.account?.phoneId);
    if (scope === this.loadedSidebarLayoutScope) return;
    this.loadedSidebarLayoutScope = scope;
    const layout = loadCachedSidebarChannelLayout(scope);
    applySidebarChannelLayoutForGuild(this.state.sidebar, WHATSAPP_GUILD_ID, layout?.[WHATSAPP_GUILD_ID]);
  }

  private requestOlderHistory(jid: string): void {
    if (!this.backend.isConnected) return;
    const messages = this.state.whatsapp.messagesByChatId[jid] ?? [];
    if (messages.length === 0 || messages.length >= MAX_WHATSAPP_MESSAGES_PER_CHAT) return;
    const oldest = this.historyAnchor(messages);
    if (!oldest?.key.id || !oldest.key.chatId || !oldest.timestampMs) return;
    if (this.pendingHistoryByChatId.has(jid)) return;
    if (this.state.timeline.channelId === whatsappChannelId(jid)) this.state.timeline.loadingOlder = true;
    const timeout = setTimeout(() => {
      const currentJid = canonicalWhatsAppJid(this.state.whatsapp, jid);
      if (this.pendingHistoryByChatId.get(currentJid) !== pending) return;
      this.pendingHistoryByChatId.delete(currentJid);
      if (this.state.timeline.channelId === whatsappChannelId(currentJid)) {
        this.state.timeline.loadingOlder = false;
        this.state.timeline.hasOlder = false;
        this.scheduleRender();
      }
    }, this.historyRequestTimeoutMs);
    const pending: PendingHistoryRequest = { anchorId: oldest.key.id, requestId: null, receivedPages: new Map(), timeout };
    this.pendingHistoryByChatId.set(jid, pending);
    this.scheduleRender();
    const count = Math.min(50, MAX_WHATSAPP_MESSAGES_PER_CHAT - messages.length);
    void this.backend.fetchHistory(count, oldest.key, oldest.timestampMs).then((requestId) => {
      if (this.pendingHistoryByChatId.get(canonicalWhatsAppJid(this.state.whatsapp, jid)) !== pending) return;
      pending.requestId = requestId;
      const earlyPage = pending.receivedPages.get(requestId);
      if (earlyPage) {
        const completed = this.completeHistoryRequest(requestId, earlyPage);
        this.refreshActiveTimeline();
        if (completed?.chatId === this.activeWhatsAppJid() && !completed.anchorAdvanced) {
          this.state.timeline.hasOlder = false;
        }
        this.continueHistory(completed);
        this.scheduleRender();
      }
      pending.receivedPages.clear();
    }).catch(() => {
      const currentJid = canonicalWhatsAppJid(this.state.whatsapp, jid);
      if (this.pendingHistoryByChatId.get(currentJid) !== pending) return;
      clearTimeout(timeout);
      this.pendingHistoryByChatId.delete(currentJid);
      if (this.state.timeline.channelId === whatsappChannelId(currentJid)) {
        this.state.timeline.loadingOlder = false;
        this.state.timeline.hasOlder = false;
        this.scheduleRender();
      }
    });
  }

  private completeHistoryRequest(
    requestId: string | undefined,
    messages: readonly import("./types").WhatsAppMessage[],
  ): { chatId: string; anchorAdvanced: boolean } | null {
    let match: [string, PendingHistoryRequest] | undefined;
    if (requestId) {
      match = [...this.pendingHistoryByChatId].find(([, pending]) => pending.requestId === requestId);
      if (!match) {
        // A history event can precede the fetchHistory RPC response, including
        // an empty terminal page. Only the eventual exact request ID may match.
        for (const pending of this.pendingHistoryByChatId.values()) {
          if (pending.requestId === null) pending.receivedPages.set(requestId, messages);
        }
        return null;
      }
    } else if (messages[0]) {
      const chatId = canonicalWhatsAppJid(this.state.whatsapp, messages[0].chatId);
      const pending = this.pendingHistoryByChatId.get(chatId);
      if (pending) match = [chatId, pending];
    }
    if (!match) return null;
    const [chatId, pending] = match;
    clearTimeout(pending.timeout);
    this.pendingHistoryByChatId.delete(chatId);
    const nextAnchorId = this.historyAnchor(this.state.whatsapp.messagesByChatId[chatId] ?? [])?.id;
    return { chatId, anchorAdvanced: Boolean(messages.length && nextAnchorId && nextAnchorId !== pending.anchorId) };
  }

  /**
   * Initial sync often contains one old preview plus a recent cluster. Fetching
   * before the absolute oldest preview cannot fill the large hole in between,
   * so page backward from the newer side of the largest significant gap.
   */
  private historyAnchor(messages: readonly import("./types").WhatsAppMessage[]): import("./types").WhatsAppMessage | null {
    const timestamped = messages.filter((message) => message.timestampMs != null);
    if (timestamped.length === 0) return null;
    let anchorIndex = 0;
    let largestGap = HISTORY_GAP_THRESHOLD_MS;
    for (let index = 1; index < timestamped.length; index++) {
      const gap = (timestamped[index].timestampMs ?? 0) - (timestamped[index - 1].timestampMs ?? 0);
      if (gap > largestGap) {
        largestGap = gap;
        anchorIndex = index;
      }
    }
    return timestamped[anchorIndex] ?? null;
  }

  private clearPendingHistoryRequests(): void {
    this.historyRequestGeneration += 1;
    for (const pending of this.pendingHistoryByChatId.values()) clearTimeout(pending.timeout);
    this.pendingHistoryByChatId.clear();
    if (this.activeWhatsAppJid()) this.state.timeline.loadingOlder = false;
  }

  private reconcileProviderChannelIds(): void {
    for (const [jid, pending] of this.pendingHistoryByChatId) {
      const canonical = canonicalWhatsAppJid(this.state.whatsapp, jid);
      if (canonical === jid) continue;
      this.pendingHistoryByChatId.delete(jid);
      if (this.pendingHistoryByChatId.has(canonical)) clearTimeout(pending.timeout);
      else this.pendingHistoryByChatId.set(canonical, pending);
    }
    let migratedSidebarPlacement = false;
    const placements = this.state.sidebar.channelPlacementsByGuildId[WHATSAPP_GUILD_ID] ?? {};
    for (const [oldChannelId, placement] of Object.entries(placements)) {
      const oldJid = whatsappJidFromChannelId(oldChannelId);
      if (!oldJid) continue;
      const canonicalChannelId = whatsappChannelId(canonicalWhatsAppJid(this.state.whatsapp, oldJid));
      if (canonicalChannelId === oldChannelId) continue;
      placements[canonicalChannelId] ??= { ...placement };
      delete placements[oldChannelId];
      migratedSidebarPlacement = true;
    }

    const selectedSidebarItem = this.state.sidebar.selectedItem;
    if (selectedSidebarItem?.type === "channel" && selectedSidebarItem.guildId === WHATSAPP_GUILD_ID) {
      const selectedJid = whatsappJidFromChannelId(selectedSidebarItem.id);
      if (selectedJid) {
        const canonicalChannelId = whatsappChannelId(canonicalWhatsAppJid(this.state.whatsapp, selectedJid));
        if (canonicalChannelId !== selectedSidebarItem.id) {
          this.state.sidebar.selectedItem = { ...selectedSidebarItem, id: canonicalChannelId };
        }
      }
    }

    for (const [oldChannelId, oldCount] of Object.entries(this.state.notifications.byChannelId)) {
      const oldJid = whatsappJidFromChannelId(oldChannelId);
      if (!oldJid) continue;
      const canonicalJid = canonicalWhatsAppJid(this.state.whatsapp, oldJid);
      const canonicalChannelId = whatsappChannelId(canonicalJid);
      if (canonicalChannelId === oldChannelId) continue;
      // Prefer the canonical reduced chat count. It understands whether a
      // temporary LID count was a new delta (and should be added) or merely an
      // alias snapshot (and should be deduplicated).
      const count = this.state.whatsapp.chatsById[canonicalJid]?.unreadCount
        ?? Math.max(oldCount, this.state.notifications.byChannelId[canonicalChannelId] ?? 0);
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
        this.refreshTimeline(canonicalChannelId, false, false);
      }
    }

    if (this.state.replyTarget) {
      const replyJid = whatsappJidFromChannelId(this.state.replyTarget.channelId);
      if (replyJid) {
        this.state.replyTarget.channelId = whatsappChannelId(canonicalWhatsAppJid(this.state.whatsapp, replyJid));
      }
    }

    if (migratedSidebarPlacement) this.persistSidebarChannelLayout();
  }

  private persistSidebarChannelLayout(): void {
    const account = this.state.whatsapp.account;
    if (!account?.id) return;
    const scope = whatsappSidebarLayoutScope(account.id, account.phoneId);
    try {
      saveCachedSidebarChannelLayout(scope, {
        [WHATSAPP_GUILD_ID]: sidebarChannelLayoutForGuild(this.state.sidebar, WHATSAPP_GUILD_ID),
      });
    } catch {
      // Provider sync must continue even if this local preference cannot be saved.
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
    this.clearLocalMessages();
    this.clearPendingHistoryRequests();
    const generation = ++this.backendResetGeneration;
    const previous = this.backend;
    this.unbindBackend();
    try {
      await previous.shutdown();
    } catch (error) {
      setNotice(this.state, `Could not stop the previous WhatsApp session cleanly: ${safeErrorMessage(error)}`, "warning", { statusLine: true, chat: false });
    }
    if (generation !== this.backendResetGeneration) return;
    if (removeAuth) {
      try {
        rmSync(this.authDirectory, { recursive: true, force: true });
      } catch (error) {
        setNotice(this.state, `Could not reset the WhatsApp login: ${safeErrorMessage(error)}`, "warning", { statusLine: true, chat: false });
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
    const generation = this.backendResetGeneration;
    try {
      const cached = await loadWhatsAppCache(this.cacheFile);
      if (!cached || !this.cacheEnabled || this.shuttingDown || generation !== this.backendResetGeneration) return;
      hydrateWhatsAppUiState(this.state.whatsapp, cached);
      this.syncProviderState(true);
    } catch (error) {
      setNotice(this.state, `Could not load the WhatsApp chat cache: ${safeErrorMessage(error)}`, "warning", { statusLine: true, chat: false });
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
      setNotice(this.state, `Could not save the WhatsApp chat cache: ${safeErrorMessage(error)}`, "warning", { statusLine: true, chat: false });
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
