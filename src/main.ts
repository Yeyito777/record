/**
 * record — Discord terminal client bootstrap.
 */

import { submitCurrentBuffer, validateAndMaybeSave, type AppEffects } from "./actions";
import { AsyncWorkQueue } from "./asyncwork";
import { flushDataCacheSync } from "./datacache";
import { customEmojiImages, replaceCustomEmojiTokens } from "./customemoji";
import { configPath, loadConfig, loadSavedLogins, type ImageDisplayMode } from "./config";
import { DEFAULT_LOCAL_GAIN_DB, DEFAULT_NOISE_SUPPRESSION_MODE, REMOTE_USER_VOLUME_STEP_PERCENT, normalizeGainDb, normalizeParticipantVolumes, parseNoiseSuppressionMode, type NoiseSuppressionMode, type ParticipantVolumes } from "./volume";
import { acceptAutocomplete, cycleAutocomplete, dismissAutocomplete, tryPathComplete, updateAutocomplete } from "./autocomplete";
import { LOADING_FRAMES } from "./loading";
import {
  displayCursor,
  getInputLines,
  handleEditorKey,
  MAX_PROMPT_ROWS,
  PROMPT_PREFIX_WIDTH,
  resetEditor,
} from "./editor";
import {
  ensureHistoryCursorVisible,
  handleHistoryVimKey,
  jumpHistoryCursorToMessage,
  jumpHistoryCursorToReplyTarget,
  placeHistoryCursorAtVisibleBottom,
  replyTargetAtHistoryCursor,
  scrollHistoryPageWithCursor,
  scrollHistoryViewportSticky,
  scrollHistoryWithCursor,
} from "./historycursor";
import { handleHistorySelectionQuoteKey } from "./historyselection";
import { findTimelineChannel, setActiveChannelEntry, setChannelList } from "./channels";
import { imageExtension, readClipboardImage, type ClipboardImageAttachment } from "./imageclipboard";
import { inlineImageId, inlineImagePreviewPixelBounds, isImageAttachment, prepareInlineImage, prepareInlineImageBytes, shouldLoadInlineImage, visibleInlineImageSources, type InlineChatImageLoading, type InlineChatImageReady } from "./inlineimage";
import { handleImageModalKey } from "./imagemodal";
import { copyToClipboard } from "./editor-clipboard";
import { attachmentAtHistoryCursor, forwardedOriginAtHistoryCursor, inlineImageBodyAttachmentAtHistoryCursor, openableTargetAtHistoryCursor, threadChannelAtHistoryCursor } from "./historyopenable";
import { parseInput, PasteBuffer, type KeyEvent, type MouseEvent } from "./input";
import { handleMouseEvent } from "./mouse";
import { TerminalClipboardClient, TerminalControlBuffer } from "./terminalclipboard";
import { TerminalGraphicsClient } from "./terminalgraphics";
import { resolveAction, resolveNavigationAction } from "./keybinds";
import {
  jumpMemberListSelectionToEdge,
  jumpMemberListSelectionToVisibleEdge,
  jumpMemberListSelectionToVisibleMiddle,
  MEMBER_LIST_WIDTH,
  moveMemberListSelection,
  scrollMemberListSelection,
  scrollMemberListSelectionLine,
} from "./memberlist";
import { formatByteSize } from "./messageparts";
import { channelNotificationCounts, guildNotificationCounts, nextChannelNotification } from "./notifications";
import { cancelPromptReaction, handlePromptPrefixBackspace } from "./promptbackspace";
import { clearPrompt, restoreReactionDraft } from "./promptstate";
import { beginReactionComposer } from "./reactionprompt";
import { configuredQuickReaction, DEFAULT_QUICK_REACTION, handleQuickReactionKey, resetQuickReaction } from "./quickreactions";
import { invalidateFrame } from "./frame";
import { render } from "./render";
import {
  ackCurrentChannelIfAtBottom,
  adjustSelectedVoiceMemberVolume,
  adjustVoiceMemberVolume,
  bootstrapReadOnlyClient,
  canDeleteGuildChannel,
  canWatchVoiceMemberStream,
  currentAppGatewaySessionId,
  disconnectAppGateway,
  ensureCurrentServerCommands,
  disconnectMemberListGateway,
  deleteMessage,
  focusThreadChannel,
  loadChannelMessageLocation,
  loadChannelMessages,
  loadChannelMessagesAround,
  loadGuildChannels,
  loadLatestChannelMessages,
  loadNewerChannelMessages,
  loadOlderChannelMessages,
  moveSelectedGuildOrder,
  persistSidebarFolders,
  removeSessionChannel,
  removeSessionGuild,
  restoreCachedSessionPreview,
  sendCurrentChannelVoiceMessage,
  setTrackedVoiceMemberServerDeafened,
  setTrackedVoiceMemberServerMuted,
  startCurrentVoiceCall,
  syncCurrentServerCommandAutocomplete,
  syncMemberListForCurrentChannel,
  isWatchingVoiceMemberStream,
  toggleVoiceMemberMute,
  toggleSelectedGuildMute,
  toggleSelectedPrivateConversationPin,
  voiceMemberModerationContext,
  voiceMemberVolume,
  watchCurrentStream,
} from "./session";
import { renderStatusLine } from "./statusline";
import {
  activateSelectedEntry,
  getSelectedSidebarEntry,
  jumpSidebarSelectionToEdge,
  jumpSidebarSelectionToVisibleEdge,
  handleSidebarPromptKey,
  handleSidebarSearchBarKey,
  jumpSidebarSelectionToVisibleMiddle,
  jumpToSidebarSearchMatch,
  leaveSidebarFolder,
  moveSidebarSelection,
  moveSidebarSelectionOut,
  openSidebarCommandBar,
  openSidebarCreateFolderPrompt,
  openSidebarMoveItemsPrompt,
  openSidebarRenameFolderPrompt,
  openSidebarSearchBar,
  revealSidebarChannel,
  scrollSidebarSelection,
  scrollSidebarSelectionLine,
  setSidebarGuilds,
  sidebarChannelsForGuild,
  toggleSidebarVisualSelection,
  unwrapSelectedSidebarFolder,
  moveSidebarSelectionToNextAnyNotification,
  moveSidebarSelectionToNextCategory,
  moveSidebarSelectionToNextDirectMessage,
  moveSidebarSelectionToNextGuild,
  moveSidebarSelectionToPrevAnyNotification,
  moveSidebarSelectionToPrevCategory,
  moveSidebarSelectionToPrevDirectMessage,
  moveSidebarSelectionToPrevGuild,
  SIDEBAR_WIDTH,
} from "./sidebar";
import { createChannelActionModal, createServerActionModal, createVoiceMemberActionModal, handleServerActionModalKey, type ServerAction } from "./serveractions";
import {
  createInitialState,
  cycleFocus,
  focusHistory,
  focusPrompt,
  focusSidebar,
  setNotice,
} from "./state";
import {
  disableBracketedPaste,
  disableClipboardPasteEvents,
  disableKittyKeyboard,
  disableMouse,
  enterAlt,
  enableBracketedPaste,
  enableClipboardPasteEvents,
  enableKittyKeyboard,
  enableMouse,
  hideCursor,
  leaveAlt,
  resetCursorColor,
  queryClipboardPasteEvents,
  setStGraphicsCells,
  setCursorColor,
  showCursor,
} from "./terminal";
import { disposeInlineTerminalImages, handleInlineTerminalImageResponse, parseTerminalCellSize, queryTerminalCellSize } from "./terminalimage";
import { dmAuthorColor, theme } from "./theme";
import { clearTimeline, hasActiveTimelineCall, hasLoadingInlineTimelineImage, moveTimelineScroll, removeTimelineInlineImageState, renderTimelineLines, setTimelineInlineImageState, setTimelineRenderContext, setTimelineTerminalCellSize, shouldLoadNewerMessages, shouldLoadOlderMessages, startLoadingNewerMessages, startLoadingOlderMessages } from "./timeline";
import { acceptDiscordInvite, banGuildMember, createGuildInvite, deleteChannel, DiscordCaptchaRequiredError, disconnectGuildMemberFromVoice, discordInviteCodeFromUrl, DIRECT_MESSAGES_GUILD_ID, DIRECT_MESSAGES_GUILD_NAME, isForumChannel, isGuildVoiceChannel, isThreadChannel, kickGuildMember, leaveGuild, setGuildMemberServerDeafen, setGuildMemberServerMute, summarizeDiscordMessageReplyPreview, type DiscordInviteJoinResult, type DiscordMessage, type DiscordMessageAttachment } from "./discord";
import { isFixedTopLevelGuildId, isWhatsAppChannelId, whatsappGuild, WHATSAPP_GUILD_ID } from "./chatproviders";
import { debugLog } from "./debuglog";
import { formatTypingUsers, getTypingUsers, pruneTypingState } from "./typing";
import { normalizeToken } from "./token";
import {
  downloadAttachment,
  downloadableOpenableUrlFilename,
  downloadOpenableUrl,
  openTargetDetached,
  shouldDownloadTargetBeforeOpen,
  type AttachmentDownloadProgress,
} from "./openable";
import { createVoiceMessageController } from "./voice-message-controller";
import { WhatsAppController } from "./whatsapp/controller";
import { InstagramController } from "./instagram/controller";
import { isTimelineNearBottom } from "./timeline";
import { INSTAGRAM_GUILD_ID, instagramGuild, isInstagramChannelId, isExternalChannelId } from "./chatproviders";
import { handleLoginModalKey } from "./whatsapp/loginmodal";
import { applyTuiStartingState, availableStartingChannel, captureTuiStartingState, loadTuiStartingState, saveTuiStartingState } from "./startingstate";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("record needs an interactive TTY.");
  process.exit(1);
}

let initialToken: string | null = null;
let initialShowHiddenChannels = false;
let initialImageDisplayMode: ImageDisplayMode = "show";
let initialNoiseSuppression: NoiseSuppressionMode = DEFAULT_NOISE_SUPPRESSION_MODE;
let initialMicGainDb = DEFAULT_LOCAL_GAIN_DB;
let initialParticipantVolumes: ParticipantVolumes = {};
let initialSavedLogins: Record<string, string> = {};
let initialQuickReactionEmoji = DEFAULT_QUICK_REACTION;
const startupWarnings: string[] = [];

try {
  const config = loadConfig();
  initialToken = config.token ? normalizeToken(config.token) : null;
  initialShowHiddenChannels = config.channels?.showHidden === true;
  initialImageDisplayMode = config.images?.mode === "hide" ? "hide" : "show";
  initialNoiseSuppression = parseNoiseSuppressionMode(config.audio?.noiseSuppression) ?? DEFAULT_NOISE_SUPPRESSION_MODE;
  initialMicGainDb = normalizeGainDb(config.audio?.micGainDb ?? DEFAULT_LOCAL_GAIN_DB);
  initialParticipantVolumes = normalizeParticipantVolumes(config.audio?.participantVolumes);
  initialQuickReactionEmoji = configuredQuickReaction(config.quickReactionEmoji);
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  if (err.code !== "ENOENT") {
    startupWarnings.push(`Could not load config: ${err.message}`);
  }
}

try {
  initialSavedLogins = loadSavedLogins();
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  if (err.code !== "ENOENT") {
    startupWarnings.push(`Could not load saved logins: ${err.message}`);
  }
}

const savedStartingState = loadTuiStartingState();
const state = createInitialState(initialToken, configPath(), initialSavedLogins, { showHiddenChannels: initialShowHiddenChannels, imageDisplayMode: initialImageDisplayMode, noiseSuppression: initialNoiseSuppression, micGainDb: initialMicGainDb, participantVolumes: initialParticipantVolumes, quickReactionEmoji: initialQuickReactionEmoji });
let pendingStartingState = savedStartingState;
setSidebarGuilds(state.sidebar, [
  { id: DIRECT_MESSAGES_GUILD_ID, name: DIRECT_MESSAGES_GUILD_NAME, icon: null },
  whatsappGuild(),
  instagramGuild(),
]);
if (startupWarnings.length > 0) {
  setNotice(state, startupWarnings.join("\n"), "warning");
}

const LOADING_INTERVAL_MS = 80;
const INLINE_IMAGE_LOAD_CONCURRENCY = 2;
const OPEN_NOTICE_MS = 1200;
const COPIED_INVITE_NOTICE_MS = 1800;

let running = true;
let terminalReady = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let loadingTimer: ReturnType<typeof setInterval> | null = null;
let terminalGraphicsCells = false;
let terminalClipboardClient: TerminalClipboardClient | null = null;
let terminalControlBuffer: TerminalControlBuffer | null = null;
let terminalGraphicsClient: TerminalGraphicsClient | null = null;
let nextInlineImageRequestId = 0;
const inlineImageLoadQueue = new AsyncWorkQueue(INLINE_IMAGE_LOAD_CONCURRENCY);
const inlineImageModalRequests = new Map<string, number>();

function syncTerminalGraphicsCells(): void {
  const modal = state.whatsapp.loginModal;
  const enabled = Boolean(modal?.phase === "qr" && modal.qr);
  if (enabled === terminalGraphicsCells) return;
  terminalGraphicsCells = enabled;
  if (terminalReady && process.env.TERM?.startsWith("st")) {
    process.stdout.write(setStGraphicsCells(enabled));
  }
}

function stopLoadingAnimation(): void {
  if (!loadingTimer) return;
  clearInterval(loadingTimer);
  loadingTimer = null;
}

function hasActiveLoadingIndicator(): boolean {
  return state.notice.loading
    || state.auth.status === "loading"
    || state.sidebar.loading
    || Boolean(state.sidebar.loadingGuildId)
    || Object.values(state.sidebar.providerStatusByGuildId).some(status => status.loading)
    || state.memberList.loading
    || state.channelList.loading
    || state.timeline.loading
    || state.timeline.loadingOlder
    || state.timeline.loadingNewer
    || hasLoadingInlineTimelineImage(state.timeline)
    || Boolean(state.whatsapp.loginModal && state.whatsapp.loginModal.phase !== "qr" && state.whatsapp.loginModal.phase !== "error")
    || hasActiveTimelineCall(state.timeline)
    || Boolean(state.voiceCall)
    || Object.keys(state.typing.byChannelId).length > 0;
}

function syncLoadingAnimation(): void {
  if (!hasActiveLoadingIndicator()) {
    state.loadingFrameIndex = 0;
    stopLoadingAnimation();
    return;
  }

  if (loadingTimer) return;
  loadingTimer = setInterval(() => {
    if (!hasActiveLoadingIndicator()) {
      state.loadingFrameIndex = 0;
      stopLoadingAnimation();
      return;
    }

    state.loadingFrameIndex = (state.loadingFrameIndex + 1) % LOADING_FRAMES.length;
    pruneTypingState(state.typing);
    scheduleRender();
  }, LOADING_INTERVAL_MS);
}

function scheduleRender(): void {
  syncTerminalGraphicsCells();
  syncLoadingAnimation();
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render(state);
    autoShowVisibleInlineImages();
  }, 16);
}

let voiceMessageController: ReturnType<typeof createVoiceMessageController> | null = null;

function clearNoticeLater(text: string, delayMs: number): void {
  setTimeout(() => {
    if (!running || state.notice.text !== text) return;
    setNotice(state, "", "muted");
    scheduleRender();
  }, delayMs);
}

function showTransientNotice(text: string, delayMs = OPEN_NOTICE_MS): void {
  setNotice(state, text, "muted", { loading: true, chat: false });
  scheduleRender();
  clearNoticeLater(text, delayMs);
}

function formatAttachmentDownloadProgress(progress: AttachmentDownloadProgress): string {
  const received = formatByteSize(progress.receivedBytes) || "0 B";
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const percent = Math.max(0, Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100)));
    return `${percent}% (${received} / ${formatByteSize(progress.totalBytes)})`;
  }
  return received;
}

function showAttachmentDownloadProgress(filename: string, progress: AttachmentDownloadProgress): void {
  setNotice(state, `Downloading ${filename}… ${formatAttachmentDownloadProgress(progress)}`, "muted", { loading: true, chat: false });
  scheduleRender();
}

function currentInlineImageRequest(requestId: number): InlineChatImageLoading | null {
  return Object.values(state.timeline.inlineImages)
    .find((image): image is InlineChatImageLoading => image.phase === "loading" && image.requestId === requestId)
    ?? null;
}

function availableInlineImageId(attachmentId: string, preferred: number): number {
  const used = new Map(
    Object.values(state.timeline.inlineImages)
      .filter((image): image is InlineChatImageReady => image.phase === "ready")
      .map((image) => [image.imageId, image.attachmentId]),
  );
  let candidate = preferred;
  while (used.has(candidate) && used.get(candidate) !== attachmentId) {
    candidate = ((candidate + 1) & 0x7fffffff) || 0x40000000;
  }
  return candidate;
}

function setInlineImageError(attachment: InlineChatImageLoading, error: string): void {
  setTimelineInlineImageState(state.timeline, {
    phase: "error",
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    sourceUrl: attachment.sourceUrl,
    requestId: attachment.requestId,
    error,
  });
  scheduleRender();
}

function startInlineAttachmentImage(attachment: DiscordMessageAttachment): void {
  const existing = state.timeline.inlineImages[attachment.id];
  if (existing && existing.sourceUrl === attachment.url && existing.phase !== "waiting") return;
  if (existing) removeTimelineInlineImageState(state.timeline, attachment.id);

  state.inlineImageHiddenAttachmentIds.delete(attachment.id);
  const requestId = ++nextInlineImageRequestId;
  const channelId = state.timeline.channelId;
  setTimelineInlineImageState(state.timeline, {
    phase: "loading",
    attachmentId: attachment.id,
    filename: attachment.filename,
    sourceUrl: attachment.url,
    requestId,
  });
  scheduleRender();

  // A successful send removes temporary upload entries before a busy queue
  // necessarily starts this job. Retain the bytes with the queued request.
  const local = state.localAttachmentImages[attachment.id];
  void inlineImageLoadQueue.enqueue(async () => {
    try {
      const queued = currentInlineImageRequest(requestId);
      if (!running || state.timeline.channelId !== channelId || !queued) return;
      const previewBounds = inlineImagePreviewPixelBounds(
        state.timeline.terminalCellWidthPixels,
        state.timeline.terminalCellHeightPixels,
      );
      let prepared: Awaited<ReturnType<typeof prepareInlineImage>>;
      if (local) {
        prepared = await prepareInlineImageBytes(Buffer.from(local.base64, "base64"), previewBounds);
      } else {
        const downloaded = isWhatsAppChannelId(channelId)
          ? await whatsAppController.downloadAttachment(attachment)
          : await downloadAttachment(attachment);
        const current = currentInlineImageRequest(requestId);
        if (!running || state.timeline.channelId !== channelId || !current) return;
        if (!downloaded.ok || !downloaded.path) {
          if (downloaded.retryWhenConnected) {
            setTimelineInlineImageState(state.timeline, { ...current, phase: "waiting" });
            scheduleRender();
            return;
          }
          setInlineImageError(current, downloaded.error ?? "unknown download error");
          return;
        }
        prepared = await prepareInlineImage(downloaded.path, previewBounds);
      }

      const current = currentInlineImageRequest(requestId);
      if (!running || state.timeline.channelId !== channelId || !current) return;
      setTimelineInlineImageState(state.timeline, {
        phase: "ready",
        attachmentId: current.attachmentId,
        filename: current.filename,
        sourceUrl: current.sourceUrl,
        requestId,
        imageId: availableInlineImageId(
          current.attachmentId,
          inlineImageId({ id: current.attachmentId, url: current.sourceUrl }),
        ),
        ...prepared,
      });
      scheduleRender();
    } catch (error) {
      const current = currentInlineImageRequest(requestId);
      if (!running || state.timeline.channelId !== channelId || !current) return;
      const message = error instanceof Error ? error.message : String(error);
      debugLog("inline_image.prepare_failed", { attachmentId: current.attachmentId, filename: current.filename, error: message });
      setInlineImageError(current, message);
    }
  });
}

function toggleInlineAttachmentImage(attachment: DiscordMessageAttachment): boolean {
  if (!isImageAttachment(attachment)) return false;

  const existing = state.timeline.inlineImages[attachment.id];
  if (existing?.phase === "ready" || existing?.phase === "loading" || existing?.phase === "waiting") {
    removeTimelineInlineImageState(state.timeline, attachment.id);
    if (state.imageDisplayMode === "show") state.inlineImageHiddenAttachmentIds.add(attachment.id);
    scheduleRender();
    return true;
  }

  if (existing) removeTimelineInlineImageState(state.timeline, attachment.id);
  state.inlineImageHiddenAttachmentIds.delete(attachment.id);
  startInlineAttachmentImage(attachment);
  return true;
}

function openInlineImageModal(attachment: DiscordMessageAttachment): boolean {
  if (!isImageAttachment(attachment)) return false;
  const existing = state.timeline.inlineImages[attachment.id];
  if (existing?.phase !== "ready") return false;
  if (inlineImageModalRequests.has(attachment.id)) return true;

  const requestId = ++nextInlineImageRequestId;
  const channelId = state.timeline.channelId;
  const sourceUrl = attachment.url;
  inlineImageModalRequests.set(attachment.id, requestId);
  void inlineImageLoadQueue.enqueue(async () => {
    try {
      const before = state.timeline.inlineImages[attachment.id];
      if (!running
        || state.timeline.channelId !== channelId
        || inlineImageModalRequests.get(attachment.id) !== requestId
        || before?.phase !== "ready"
        || before.sourceUrl !== sourceUrl) return;

      const local = state.localAttachmentImages[attachment.id];
      let prepared: Awaited<ReturnType<typeof prepareInlineImage>>;
      if (local) {
        prepared = await prepareInlineImageBytes(Buffer.from(local.base64, "base64"), { preserveSourceResolution: true });
      } else {
        const downloaded = isWhatsAppChannelId(channelId)
          ? await whatsAppController.downloadAttachment(attachment)
          : await downloadAttachment(attachment);
        if (!downloaded.ok || !downloaded.path) throw new Error(downloaded.error ?? "unknown download error");
        prepared = await prepareInlineImage(downloaded.path, { preserveSourceResolution: true });
      }

      const current = state.timeline.inlineImages[attachment.id];
      if (!running
        || state.timeline.channelId !== channelId
        || inlineImageModalRequests.get(attachment.id) !== requestId
        || current?.phase !== "ready"
        || current.sourceUrl !== sourceUrl) return;
      const modalAttachmentId = `modal:${attachment.id}`;
      state.imageModal = {
        filename: attachment.filename,
        image: {
          phase: "ready",
          attachmentId: modalAttachmentId,
          filename: attachment.filename,
          sourceUrl,
          requestId,
          imageId: availableInlineImageId(
            modalAttachmentId,
            inlineImageId({ id: modalAttachmentId, url: sourceUrl }),
          ),
          ...prepared,
        },
      };
      scheduleRender();
    } catch (error) {
      debugLog("inline_image.modal_failed", {
        attachmentId: attachment.id,
        filename: attachment.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (inlineImageModalRequests.get(attachment.id) === requestId) {
        inlineImageModalRequests.delete(attachment.id);
      }
    }
  });
  return true;
}

function autoShowVisibleInlineImages(): void {
  if (!running) return;
  const viewportStart = state.timeline.scrollOffset;
  const attachments = visibleInlineImageSources(
    state.timeline.messages,
    state.historyMessageBounds,
    viewportStart,
    timelinePageSize(),
  );
  for (const attachment of attachments) {
    if (state.inlineImageHiddenAttachmentIds.has(attachment.id)) continue;
    const existing = state.timeline.inlineImages[attachment.id];
    if (!shouldLoadInlineImage(existing, attachment.url, state.imageDisplayMode === "show",
      !isWhatsAppChannelId(state.timeline.channelId) || whatsAppController.isConnected)) continue;
    startInlineAttachmentImage(attachment);
  }
}

function downloadAndOpenTarget(target: string): void {
  const filename = downloadableOpenableUrlFilename(target);
  setNotice(state, `Downloading ${filename}…`, "muted", { loading: true, chat: false });
  scheduleRender();

  void (async () => {
    const downloaded = await downloadOpenableUrl(target, {
      onProgress: (progress) => {
        if (!running) return;
        showAttachmentDownloadProgress(filename, progress);
      },
    });
    if (!running) return;
    if (!downloaded.ok || !downloaded.path) {
      setNotice(state, `Could not open ${filename}: ${downloaded.error ?? "unknown error"}`, "warning");
      scheduleRender();
      return;
    }

    const openNotice = downloaded.cached
      ? `Opening cached ${filename}…`
      : `Opening ${filename}…`;
    if (!openTargetDetached(downloaded.path)) {
      setNotice(state, `Could not open ${filename}: No opener configured for ${downloaded.path}.`, "warning");
      scheduleRender();
    } else {
      showTransientNotice(openNotice);
    }
  })();
}

function inviteJoinLabel(result: DiscordInviteJoinResult): string {
  if (result.guildName) return `“${result.guildName}”`;
  if (result.guildId) return `server ${result.guildId}`;
  return `invite ${result.code}`;
}

function showInviteNotice(text: string, tone: "muted" | "warning" = "muted", loading = false): void {
  setNotice(state, text, tone, { loading, statusLine: true, chat: false });
  scheduleRender();
}

function openInviteInBrowserForCaptcha(target: string, code: string): void {
  debugLog("invite.join.captcha_open_browser", { code });
  if (openTargetDetached(target)) {
    showInviteNotice(`Captcha required for invite ${code}; opening in browser…`, "warning");
  } else {
    showInviteNotice(`Captcha required for invite ${code}, but no browser opener is configured.`, "warning");
  }
}

function joinDiscordInviteTarget(target: string, code: string): void {
  const token = state.auth.savedToken;
  if (!token) {
    showInviteNotice("Login first with /login <token|username> to join Discord invites.", "warning");
    return;
  }

  const sessionId = currentAppGatewaySessionId(token);
  debugLog("invite.join.start", { code, hasSessionId: Boolean(sessionId) });
  showInviteNotice(`Joining Discord invite ${code}…`, "muted", true);
  void (async () => {
    try {
      const result = await acceptDiscordInvite(token, target, { sessionId });
      if (!running) return;
      debugLog("invite.join.success", {
        code: result.code,
        guildId: result.guildId,
        channelId: result.channelId,
      });
      showInviteNotice(`Joined ${inviteJoinLabel(result)}. Refreshing servers…`, "muted", true);
      bootstrapSession(token);
    } catch (error) {
      if (!running) return;
      const message = error instanceof Error ? error.message : String(error);
      debugLog("invite.join.error", { code, error: message });
      if (error instanceof DiscordCaptchaRequiredError) {
        openInviteInBrowserForCaptcha(target, code);
        return;
      }
      showInviteNotice(`Could not join Discord invite ${code}: ${message}`, "warning");
    }
  })();
}

function applyThemeCursor(): void {
  if (theme.cursorColor) process.stdout.write(setCursorColor(theme.cursorColor));
}

function bootstrapSession(token: string): void {
  void (async () => {
    // bootstrapReadOnlyClient applies account caches synchronously before its
    // first REST await. Restore and revalidate the visible channel in parallel
    // with the slower top-level guild/DM hydration.
    const bootstrap = bootstrapReadOnlyClient(state, token, { scheduleRender });
    await restorePendingStartingState(token, { deferUnavailableGuild: true });
    await bootstrap;
    // A cold cache has no guild metadata to validate the target against. Retry
    // once the authoritative guild list has arrived.
    await restorePendingStartingState(token);
  })().catch((error) => {
    debugLog("starting_state.restore_failed", { error: error instanceof Error ? error.message : String(error) });
  });
}

function isPromptTyping(): boolean {
  return state.panelFocus === "chat" && state.chatFocus === "prompt" && state.editor.mode === "insert";
}

function syncPromptAutocomplete(): void {
  if (isPromptTyping()) {
    updateAutocomplete(state);
    if (state.editor.buffer.trimStart().startsWith("/")) {
      ensureCurrentServerCommands(state, { scheduleRender });
      syncCurrentServerCommandAutocomplete(state, { scheduleRender });
    }
  } else {
    state.autocomplete = null;
    state.serverCommands.autocomplete = null;
  }
}

function focusPromptInsert(append = false): void {
  focusPrompt(state, append);
  syncPromptAutocomplete();
  scheduleRender();
}

function tokenOrWarn(): string | null {
  const token = state.auth.savedToken;
  if (!token) {
    setNotice(state, "Login first with /login <token|username>.", "warning");
    scheduleRender();
    return null;
  }
  return token;
}

function timelineContentWidth(): number {
  const sidebarW = state.sidebar.open ? SIDEBAR_WIDTH : 0;
  const memberListW = state.memberList.open ? MEMBER_LIST_WIDTH : 0;
  const mainW = Math.max(1, state.cols - sidebarW - memberListW);
  return Math.max(1, mainW - 2);
}

function timelinePageSize(): number {
  const sidebarW = state.sidebar.open ? SIDEBAR_WIDTH : 0;
  const memberListW = state.memberList.open ? MEMBER_LIST_WIDTH : 0;
  const mainW = Math.max(1, state.cols - sidebarW - memberListW);
  const statusHeight = renderStatusLine(state, mainW).height;
  const bottomStatusRows = statusHeight > 0 ? statusHeight + 1 : 0;
  const imageIndicatorRows = state.pendingImages.length > 0 ? 1 : 0;
  const maxInputWidth = Math.max(1, mainW - PROMPT_PREFIX_WIDTH);
  const input = getInputLines(
    state.editor.buffer,
    displayCursor(state.editor),
    maxInputWidth,
    Math.max(1, Math.min(MAX_PROMPT_ROWS, state.rows - 3 - bottomStatusRows - imageIndicatorRows)),
    state.editor.scroll,
  );
  const inputRowCount = Math.max(1, input.lines.length);
  const promptSeparatorRow = Math.max(3, state.rows - inputRowCount - bottomStatusRows - imageIndicatorRows);
  const activeTypingUsers = getTypingUsers(
    state.typing,
    state.channelList.activeChannelId ?? state.timeline.channelId,
    state.auth.user?.id ?? null,
  );
  const typingRowCount = formatTypingUsers(activeTypingUsers) ? 1 : 0;
  return Math.max(1, promptSeparatorRow - 3 - typingRowCount);
}

function maybeLoadOlderHistory(): void {
  if (isInstagramChannelId(state.timeline.channelId)) {
    if (shouldLoadOlderMessages(state.timeline)) instagramController.loadOlder();
    return;
  }
  const token = state.auth.savedToken;
  const channelId = state.timeline.channelId;
  if (isWhatsAppChannelId(channelId)) {
    if (shouldLoadOlderMessages(state.timeline)) whatsAppController.loadOlderHistory();
    return;
  }
  if (!token || !channelId || !shouldLoadOlderMessages(state.timeline)) return;

  startLoadingOlderMessages(state.timeline);
  scheduleRender();
  void loadOlderChannelMessages(state, token, channelId, timelineContentWidth(), { scheduleRender });
}

function maybeLoadNewerHistory(): void {
  if (isExternalChannelId(state.timeline.channelId)) return;
  const token = state.auth.savedToken;
  const channelId = state.timeline.channelId;
  if (!token || !channelId || !shouldLoadNewerMessages(state.timeline)) return;

  startLoadingNewerMessages(state.timeline);
  scheduleRender();
  void loadNewerChannelMessages(state, token, channelId, { scheduleRender });
}

function scrollTimeline(delta: number): void {
  moveTimelineScroll(state.timeline, delta);
  if (delta <= 0) {
    maybeLoadOlderHistory();
  } else {
    maybeLoadNewerHistory();
  }
  if (isInstagramChannelId(state.timeline.channelId)) {
    if (isTimelineNearBottom(state.timeline.scrollOffset, state.timeline.maxScroll)) instagramController.markActiveRead();
  }
  else ackCurrentChannelIfAtBottom(state);
  scheduleRender();
}

function sidebarVisibilityOptions(): { showHiddenChannels: boolean; currentUserId: string | null } {
  return {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  };
}

async function restorePendingStartingState(
  token: string | null,
  options: { deferUnavailableGuild?: boolean } = {},
): Promise<void> {
  const startingState = pendingStartingState;
  if (!startingState) return;

  const savedChannel = startingState.focusedChannel;
  if (savedChannel?.guildId === INSTAGRAM_GUILD_ID) {
    if (!instagramController.isConnected) return;
    pendingStartingState = null;
    const restored = await instagramController.restoreChannel(savedChannel.channelId).catch(() => false);
    applyTuiStartingState(state, restored ? startingState : { ...startingState, focusedChannel: null });
    scheduleRender();
    return;
  }
  if (savedChannel?.guildId === WHATSAPP_GUILD_ID) {
    pendingStartingState = null;
    const restored = await whatsAppController.restoreCachedChannel(savedChannel.channelId);
    applyTuiStartingState(state, restored ? startingState : { ...startingState, focusedChannel: null });
    scheduleRender();
    return;
  }

  const accountId = state.auth.user?.id;
  if (!token || !accountId) return;
  if (startingState.accountId && startingState.accountId !== accountId) {
    pendingStartingState = null;
    return;
  }

  const channelLocation = availableStartingChannel(startingState, accountId, state.sidebar.guilds);
  if (savedChannel && !channelLocation && options.deferUnavailableGuild) return;
  pendingStartingState = null;
  let restoredFocusedChannel = savedChannel === null;
  if (channelLocation) {
    const cachedChannel = state.channelList.guildId === channelLocation.guildId
      ? findTimelineChannel(state.channelList.channels, channelLocation.channelId)
      : null;
    // The first frame already contains this channel and its messages. Start
    // message hydration now instead of waiting for the channel-list REST call.
    const messageHydration = cachedChannel && !cachedChannel.hidden
      ? loadChannelMessages(state, token, cachedChannel.id, { scheduleRender })
      : null;
    await loadGuildChannels(
      state,
      token,
      channelLocation.guildId,
      { scheduleRender },
      { openFirstChannel: false, focusGuild: false },
    );
    const channel = findTimelineChannel(state.channelList.channels, channelLocation.channelId);
    if (channel && !channel.hidden) {
      if (messageHydration) await messageHydration;
      else await loadChannelMessages(state, token, channel.id, { scheduleRender });
      setActiveChannelEntry(state.channelList, channel);
      restoredFocusedChannel = true;
    }
  }

  if (savedChannel && !restoredFocusedChannel) {
    // Authentication has now disproved the optimistic cache preview. Invalidate
    // any in-flight message refresh before dropping inaccessible stale content.
    state.timeline.requestId += 1;
    clearTimeline(state.timeline);
    setActiveChannelEntry(state.channelList, null);
    if (state.sidebar.activeGuildId === savedChannel.guildId) state.sidebar.activeGuildId = null;
  }

  // Loading the active channel necessarily focuses its guild. Restore the
  // independently saved sidebar cursor only after that work has completed.
  applyTuiStartingState(
    state,
    restoredFocusedChannel ? startingState : { ...startingState, focusedChannel: null },
  );
  scheduleRender();
}

function scrollFocusedPanel(delta: number, visibleRows: number, mode: "cursor" | "page" = "cursor"): void {
  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    scrollSidebarSelection(state.sidebar, state.channelList.channels, delta < 0 ? 1 : -1, Math.abs(delta), state.rows, mode, sidebarVisibilityOptions());
    scheduleRender();
    return;
  }

  if (state.panelFocus === "memberlist" && state.memberList.open) {
    scrollMemberListSelection(state.memberList, delta < 0 ? 1 : -1, Math.abs(delta), state.rows, mode);
    scheduleRender();
    return;
  }

  if (state.chatFocus === "history") {
    const dir = delta < 0 ? 1 : -1;
    if (mode === "page") {
      scrollHistoryPageWithCursor(state, dir, Math.abs(delta), visibleRows);
    } else {
      scrollHistoryWithCursor(state, dir, Math.abs(delta), visibleRows);
    }
    if (delta <= 0) maybeLoadOlderHistory();
    if (delta > 0) maybeLoadNewerHistory();
    scheduleRender();
    return;
  }

  scrollTimeline(delta);
}

function scrollFocusedPanelLine(delta: number): void {
  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    scrollSidebarSelectionLine(state.sidebar, state.channelList.channels, delta < 0 ? 1 : -1, state.rows, sidebarVisibilityOptions());
    scheduleRender();
    return;
  }

  if (state.panelFocus === "memberlist" && state.memberList.open) {
    scrollMemberListSelectionLine(state.memberList, delta < 0 ? 1 : -1, state.rows);
    scheduleRender();
    return;
  }

  if (state.chatFocus === "history") {
    scrollHistoryViewportSticky(state, delta < 0 ? 1 : -1, timelinePageSize());
    if (delta <= 0) maybeLoadOlderHistory();
    if (delta > 0) maybeLoadNewerHistory();
    scheduleRender();
    return;
  }

  scrollTimeline(delta);
}

function jumpToNotification(direction: -1 | 1): void {
  if (!state.sidebar.open) state.sidebar.open = true;
  focusSidebar(state);
  const channelCounts = channelNotificationCounts(state.notifications);
  const guildCounts = guildNotificationCounts(state.notifications, state.channelList.channels);
  if (direction < 0) {
    moveSidebarSelectionToPrevAnyNotification(state.sidebar, state.channelList.channels, channelCounts, guildCounts, sidebarVisibilityOptions());
  } else {
    moveSidebarSelectionToNextAnyNotification(state.sidebar, state.channelList.channels, channelCounts, guildCounts, sidebarVisibilityOptions());
  }
  scheduleRender();
}

function editorHasPendingInput(): boolean {
  return Boolean(
    state.editor.pendingOperator
    || state.editor.pendingOperatorKey
    || state.editor.pendingTextObjectModifier
    || state.editor.pendingKeys
    || state.editor.count !== null
    || state.editor.pendingFind
    || state.editor.pendingReplace,
  );
}

function switchToNextNotification(): void {
  const target = nextChannelNotification(state.notifications, state.channelList.activeChannelId);
  if (!target) {
    scheduleRender();
    return;
  }

  const knownChannel = sidebarChannelsForGuild(
    state.sidebar,
    state.channelList.channels,
    target.guildId ?? "",
  ).find((channel) => channel.id === target.channelId)
    ?? Object.values(state.sidebar.cachedChannelsByGuildId)
      .flat()
      .find((channel) => channel.id === target.channelId)
    ?? null;
  const guildId = target.guildId ?? knownChannel?.guildId ?? null;
  if (!guildId) {
    scheduleRender();
    return;
  }

  if (guildId === INSTAGRAM_GUILD_ID) {
    revealSidebarChannel(state.sidebar, state.channelList.channels, guildId, target.channelId, sidebarVisibilityOptions());
    instagramController.openChannel(target.channelId);
    return;
  }
  if (guildId === WHATSAPP_GUILD_ID) {
    revealSidebarChannel(state.sidebar, state.channelList.channels, guildId, target.channelId, sidebarVisibilityOptions());
    whatsAppController.openChannel(target.channelId);
    return;
  }

  const token = tokenOrWarn();
  if (!token) return;

  void (async () => {
    let channels = sidebarChannelsForGuild(state.sidebar, state.channelList.channels, guildId);
    if (!channels.some((channel) => channel.id === target.channelId)) {
      await loadGuildChannels(state, token, guildId, effects, { openFirstChannel: false });
      channels = sidebarChannelsForGuild(state.sidebar, state.channelList.channels, guildId);
    }

    if (!channels.some((channel) => channel.id === target.channelId)) {
      scheduleRender();
      return;
    }

    setChannelList(state.channelList, guildId, channels);
    revealSidebarChannel(state.sidebar, state.channelList.channels, guildId, target.channelId, sidebarVisibilityOptions());
    await loadChannelMessages(state, token, target.channelId, effects);
  })();
}

function toggleSidebar(): void {
  state.sidebar.open = !state.sidebar.open;

  if (state.sidebar.open) {
    focusSidebar(state);
  } else {
    state.panelFocus = "chat";
  }

  syncPromptAutocomplete();
  scheduleRender();
}

function toggleMemberList(): void {
  state.memberList.open = !state.memberList.open;
  if (state.memberList.open) {
    syncMemberListForCurrentChannel(state, { scheduleRender });
  } else {
    if (state.panelFocus === "memberlist") {
      state.panelFocus = state.sidebar.open ? "sidebar" : "chat";
    }
  }
  scheduleRender();
}

function selectedHistoryMessage(): DiscordMessage | null {
  const row = state.historyCursor.row;
  const bound = state.historyMessageBounds.find((entry) => row >= entry.start && row < entry.end);
  if (!bound) return null;
  return state.timeline.messages.find((message) => message.id === bound.messageId) ?? null;
}

function exitPinnedMessages(): boolean {
  if (state.timeline.view !== "pinned") return false;
  const token = state.auth.savedToken;
  const channelId = state.timeline.channelId;
  if (token && channelId) {
    void loadChannelMessages(state, token, channelId, { scheduleRender });
  } else {
    scheduleRender();
  }
  return true;
}

function returnToPinnedMessageInChannelHistory(): boolean {
  if (state.timeline.view !== "pinned") return false;

  const message = selectedHistoryMessage();
  if (!message) {
    scheduleRender();
    return true;
  }

  const token = state.auth.savedToken;
  const channelId = state.timeline.channelId;
  if (!token || !channelId) {
    scheduleRender();
    return true;
  }

  if (state.notice.loading && state.notice.text === "Fetching pins...") {
    setNotice(state, "", "muted", { statusLine: false, chat: false });
  }

  void (async () => {
    const loaded = await loadChannelMessagesAround(state, token, channelId, message.id, effects);
    if (!running) return;
    if (loaded) {
      refreshHistorySnapshot();
      jumpHistoryCursorToMessage(state, message.id, timelinePageSize());
    }
    scheduleRender();
  })();
  return true;
}

function refreshHistorySnapshot(): void {
  const guildId = state.channelList.activeChannel?.guildId ?? null;
  const viewerId = guildId === INSTAGRAM_GUILD_ID ? state.instagram.account?.id
    : guildId === WHATSAPP_GUILD_ID ? state.whatsapp.account?.id : state.auth.user?.id;
  setTimelineRenderContext(
    state.timeline,
    viewerId ?? null,
    isFixedTopLevelGuildId(guildId),
    state.guildRolesByGuildId,
    state.memberRoleIdsByGuildId,
    state.memberRoleCacheVersion,
    state.channelList.activeChannel?.guildId ?? null,
  );

  const timelineNotice = state.timeline.messages.length === 0 && state.timeline.channelId === null
    ? state.notice
    : { ...state.notice, chat: false };
  const timeline = renderTimelineLines(state.timeline, timelineContentWidth(), timelinePageSize(), timelineNotice, state.loadingFrameIndex);
  state.historyLineAnchors = timeline.lineAnchors;
  state.historyLines = timeline.allLines;
  state.historyLineBackgrounds = timeline.lineBackgrounds;
  state.historyWrapContinuation = timeline.wrapContinuation;
  state.historyMessageBounds = timeline.messageBounds;
}

function jumpToReplyTargetAtHistoryCursor(): boolean {
  const target = replyTargetAtHistoryCursor(state);
  if (!target) return false;

  if (target.channelId !== state.timeline.channelId) {
    scheduleRender();
    return true;
  }

  if (jumpHistoryCursorToReplyTarget(state, timelinePageSize())) {
    scheduleRender();
    return true;
  }

  // WhatsApp history currently lives in the provider's local sync buffer. A
  // missing quoted message must never fall through to Discord's REST loader.
  if (isExternalChannelId(state.timeline.channelId)) {
    setNotice(state, "That quoted message is not in the loaded history.", "muted", { statusLine: false, chat: true });
    scheduleRender();
    return true;
  }

  const token = state.auth.savedToken;
  const channelId = state.timeline.channelId;
  if (!token || !channelId) {
    scheduleRender();
    return true;
  }

  void (async () => {
    const loaded = await loadChannelMessagesAround(state, token, channelId, target.messageId, effects);
    if (!running) return;
    if (loaded) {
      refreshHistorySnapshot();
      jumpHistoryCursorToMessage(state, target.messageId, timelinePageSize());
    }
    scheduleRender();
  })();
  return true;
}

function jumpToForwardedOriginAtHistoryCursor(): boolean {
  const target = forwardedOriginAtHistoryCursor(state);
  if (!target) return false;

  const token = tokenOrWarn();
  if (!token) return true;

  void (async () => {
    const loaded = await loadChannelMessageLocation(state, token, target, effects);
    if (!running) return;
    if (loaded) {
      refreshHistorySnapshot();
      jumpHistoryCursorToMessage(state, target.messageId, timelinePageSize());
    }
    scheduleRender();
  })();
  return true;
}

function focusThreadAtHistoryCursor(): boolean {
  const target = threadChannelAtHistoryCursor(state);
  if (!target) return false;

  const token = tokenOrWarn();
  if (!token) return true;
  void focusThreadChannel(state, token, target.channelId, effects, target.guildId);
  return true;
}

function jumpToChannelBottom(): void {
  const token = state.auth.savedToken;
  const channelId = state.timeline.channelId;

  state.historyCursorPendingVisibleBottom = true;
  state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;

  if (!state.timeline.hasNewer || !token || !channelId) {
    placeHistoryCursorAtVisibleBottom(state, timelinePageSize());
    ensureHistoryCursorVisible(state, timelinePageSize());
    scheduleRender();
    return;
  }

  void (async () => {
    const loaded = await loadLatestChannelMessages(state, token, channelId, effects);
    if (!running) return;
    if (loaded) {
      refreshHistorySnapshot();
      placeHistoryCursorAtVisibleBottom(state, timelinePageSize());
      ensureHistoryCursorVisible(state, timelinePageSize());
    }
    scheduleRender();
  })();
  scheduleRender();
}

function summarizeReplyMessage(message: DiscordMessage): string {
  if (message.call || message.type === 3) return "☎ Call";
  return summarizeDiscordMessageReplyPreview(message).slice(0, 160);
}

function attachClipboardImage(image: ClipboardImageAttachment): void {
  if (isInstagramChannelId(state.channelList.activeChannelId ?? state.timeline.channelId)) {
    setNotice(state, "Instagram uploads are not supported.", "warning");
    scheduleRender();
    return;
  }
  const index = state.pendingImages.length + 1;
  const filename = `image-${index}.${imageExtension(image.mediaType)}`;
  state.pendingImages.push({ ...image, filename });
  setNotice(state, "", "muted");
  focusPrompt(state);
  scheduleRender();
}

function pasteImageFromClipboard(): void {
  const image = readClipboardImage();
  if (image) attachClipboardImage(image);
}

function handlePromptBackspacePrefixAction(): boolean {
  const action = handlePromptPrefixBackspace(state);
  if (!action) return false;
  setNotice(state, "", "muted");
  scheduleRender();
  return true;
}

function cancelCurrentAction(): void {
  if (state.reactionComposer) {
    if (!restoreReactionDraft(state)) clearPrompt(state);
    scheduleRender();
    return;
  }
  if (state.reactionTarget && /^\/(?:un)?react(?:\s|$)/.test(state.editor.buffer)) {
    state.reactionComposer = false;
    state.reactionTarget = null;
    resetEditor(state.editor, "", "insert");
    state.autocomplete = null;
    scheduleRender();
    return;
  }
  if (clearPendingMessageDelete()) {
    scheduleRender();
    return;
  }

  if (state.pendingImages.length > 0) {
    state.pendingImages = [];
    scheduleRender();
    return;
  }

  if (state.replyTarget) {
    state.replyTarget = null;
    scheduleRender();
    return;
  }

  if (state.editTarget) {
    state.editTarget = null;
    scheduleRender();
    return;
  }

  if (state.autocomplete) {
    dismissAutocomplete(state);
    scheduleRender();
    return;
  }

  scheduleRender();
}

function replyGuildIdForMessage(message: DiscordMessage): string | null {
  const guildId = message.guildId ?? state.channelList.activeChannel?.guildId ?? null;
  return guildId === DIRECT_MESSAGES_GUILD_ID ? null : guildId;
}

function replyAuthorColor(message: DiscordMessage): string {
  const guildId = state.channelList.activeChannel?.guildId;
  if (!isFixedTopLevelGuildId(guildId)) return "";
  const viewerId = guildId === INSTAGRAM_GUILD_ID ? state.instagram.account?.id
    : guildId === WHATSAPP_GUILD_ID ? state.whatsapp.account?.id : state.auth.user?.id;
  return message.author.id === viewerId ? theme.accent : dmAuthorColor(message.author.id);
}

function selectedMessageCanBeEdited(message: DiscordMessage | null): message is DiscordMessage {
  if (!message) return false;
  if (isExternalChannelId(message.channelId)) return false;
  if (!state.auth.user || message.author.id !== state.auth.user.id) return false;
  if (message.localStatus === "pending" || message.id.startsWith("local:")) return false;
  return true;
}

function clearPendingMessageDelete(): boolean {
  if (!state.messageDeletePending) return false;
  state.messageDeletePending = null;
  return true;
}

function selectedMessageMatchesPendingDelete(message: DiscordMessage): boolean {
  return state.messageDeletePending?.channelId === message.channelId
    && state.messageDeletePending.messageId === message.id;
}

function deleteSelectedHistoryMessage(): void {
  if (state.panelFocus !== "chat" || state.chatFocus !== "history") {
    scheduleRender();
    return;
  }

  const message = selectedHistoryMessage();
  if (!message) {
    scheduleRender();
    return;
  }
  if (isExternalChannelId(message.channelId)) {
    state.messageDeletePending = null;
    setNotice(state, "Deleting external messages is not supported yet.", "warning", { statusLine: false, chat: true });
    scheduleRender();
    return;
  }

  if (!selectedMessageMatchesPendingDelete(message)) {
    state.messageDeletePending = { channelId: message.channelId, messageId: message.id };
    scheduleRender();
    return;
  }

  deleteMessage(state, state.auth.savedToken, message, effects);
}

function startEditSelectedHistoryMessage(): void {
  const message = selectedHistoryMessage();
  if (!selectedMessageCanBeEdited(message)) return;
  restoreReactionDraft(state);
  state.reactionComposer = false;

  state.editTarget = {
    messageId: message.id,
    channelId: message.channelId,
    authorDisplayName: message.author.displayName,
    authorColor: replyAuthorColor(message),
    summary: summarizeReplyMessage(message),
    originalContent: message.content,
    timestamp: message.timestamp,
  };
  state.replyTarget = null;
  state.messageDeletePending = null;
  state.pendingImages = [];
  setNotice(state, "", "muted");
  resetEditor(state.editor, replaceCustomEmojiTokens(message.content), "insert");
  focusPrompt(state);
  syncPromptAutocomplete();
  scheduleRender();
}

function startReplyToSelectedHistoryMessage(mention = true): void {
  if (state.panelFocus !== "chat" || state.chatFocus !== "history") {
    setNotice(state, "Focus history and select a message to reply.", "muted");
    scheduleRender();
    return;
  }

  const message = selectedHistoryMessage();
  if (!message) {
    setNotice(state, "Select a message to reply.", "muted");
    scheduleRender();
    return;
  }
  if (message.localStatus === "pending" || message.id.startsWith("local:")) {
    setNotice(state, "Wait until the message is sent before replying to it.", "warning");
    scheduleRender();
    return;
  }

  if (state.reactionComposer) {
    if (!restoreReactionDraft(state)) clearPrompt(state);
  }
  state.replyTarget = {
    messageId: message.id,
    channelId: message.channelId,
    guildId: replyGuildIdForMessage(message),
    authorId: message.author.id,
    authorDisplayName: message.author.displayName,
    authorColor: replyAuthorColor(message),
    summary: summarizeReplyMessage(message),
    mentionRoleIds: message.mentionRoleIds,
    mentionUsers: message.mentionUsers,
    timestamp: message.timestamp,
    mention: mention && message.author.id !== state.auth.user?.id,
  };
  state.messageDeletePending = null;
  setNotice(state, "", "muted");
  focusPrompt(state);
  syncPromptAutocomplete();
  scheduleRender();
}

function toggleHistoryFocus(): void {
  if (state.panelFocus === "chat" && state.chatFocus === "history") {
    focusPrompt(state);
    state.historyCursorPendingVisibleBottom = false;
  } else {
    focusHistory(state);
    placeHistoryCursorAtVisibleBottom(state, timelinePageSize());
    ensureHistoryCursorVisible(state, timelinePageSize());
    state.historyCursorPendingVisibleBottom = true;
  }

  syncPromptAutocomplete();
  scheduleRender();
}

function cyclePanelFocus(direction: 1 | -1): void {
  cycleFocus(state, direction);
  syncPromptAutocomplete();
  scheduleRender();
}

function handleGlobalAction(key: KeyEvent): boolean {
  const context = state.panelFocus === "sidebar" || state.panelFocus === "memberlist" || state.chatFocus === "history"
    ? "navigation"
    : "prompt";
  const action = resolveAction(key, context);
  const normalNotificationShortcut = action === "notification_next" && key.type === "char" && key.char === "t";
  if (normalNotificationShortcut && (
    state.editor.mode !== "normal"
    || editorHasPendingInput()
    || state.navigationPendingKeys.length > 0
    || (state.panelFocus === "sidebar" && state.sidebar.visualAnchor !== null)
  )) {
    return false;
  }
  if (action && action !== "cancel_action" && !action.startsWith("nav_") && action !== "focus_prompt") {
    state.navigationPendingKeys = "";
    clearPendingMessageDelete();
  }

  switch (action) {
    case "cancel_action":
      cancelCurrentAction();
      return true;
    case "quit":
      cleanup();
      return true;
    case "sidebar_toggle":
      toggleSidebar();
      return true;
    case "focus_cycle_next":
      cyclePanelFocus(1);
      return true;
    case "focus_cycle_prev":
      cyclePanelFocus(-1);
      return true;
    case "focus_history":
      toggleHistoryFocus();
      return true;
    case "member_list_toggle":
      toggleMemberList();
      return true;
    case "scroll_line_up":
      scrollFocusedPanelLine(-1);
      return true;
    case "scroll_line_down":
      scrollFocusedPanelLine(1);
      return true;
    case "scroll_half_up": {
      const amount = Math.floor(timelinePageSize() / 2);
      scrollFocusedPanel(-amount, timelinePageSize());
      return true;
    }
    case "scroll_half_down": {
      const amount = Math.floor(timelinePageSize() / 2);
      scrollFocusedPanel(amount, timelinePageSize());
      return true;
    }
    case "scroll_page_up":
      scrollFocusedPanel(-timelinePageSize(), timelinePageSize(), "page");
      return true;
    case "scroll_page_down":
      scrollFocusedPanel(timelinePageSize(), timelinePageSize(), "page");
      return true;
    case "notification_prev":
      jumpToNotification(-1);
      return true;
    case "notification_next":
      if (normalNotificationShortcut) switchToNextNotification();
      else jumpToNotification(1);
      return true;
    case "paste_image":
      pasteImageFromClipboard();
      return true;
    case "reply_toggle":
      startReplyToSelectedHistoryMessage();
      return true;
    case "sidebar_next":
    case "sidebar_prev": {
      if (isPromptTyping()) return false;
      if (!state.sidebar.open) state.sidebar.open = true;
      focusSidebar(state);
      moveSidebarSelection(state.sidebar, state.channelList.channels, action === "sidebar_next" ? 1 : -1, sidebarVisibilityOptions());
      syncPromptAutocomplete();
      scheduleRender();
      return true;
    }
    default:
      return false;
  }
}

function ensureSidebarEntryGuildLoaded(guildId: string): void {
  if (state.channelList.guildId === guildId && state.channelList.channels.length > 0) return;
  const channels = sidebarChannelsForGuild(state.sidebar, state.channelList.channels, guildId);
  if (channels.length > 0) setChannelList(state.channelList, guildId, channels);
}

function openSelectedServerActionModal(): boolean {
  const selected = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
  if (selected.guildId === INSTAGRAM_GUILD_ID && selected.kind !== "channel") return false;
  if (selected.kind !== "guild" && selected.kind !== "category" && selected.kind !== "channel" && selected.kind !== "voice-member") return false;
  if (selected.guildId === WHATSAPP_GUILD_ID && selected.kind !== "channel") return false;
  state.navigationPendingKeys = "";
  state.sidebar.visualAnchor = null;
  state.sidebar.pendingDeleteItem = null;
  if (selected.kind === "guild") {
    if (isFixedTopLevelGuildId(selected.guildId)) return false;
    const guild = state.sidebar.guilds.find((candidate) => candidate.id === selected.guildId);
    if (!guild) return false;
    state.sidebar.serverActionModal = createServerActionModal(guild.id, guild.name, Boolean(guild.muted));
  } else if (selected.kind === "voice-member") {
    if (!selected.channelId || !selected.userId) return false;
    const moderation = voiceMemberModerationContext(
      state,
      selected.guildId,
      selected.channelId,
      selected.userId,
    );
    state.sidebar.serverActionModal = createVoiceMemberActionModal({
      guildId: selected.guildId,
      channelId: selected.channelId,
      userId: selected.userId,
      displayName: selected.label,
      muted: selected.self ? Boolean(selected.selfMuted) : Boolean(selected.localMuted),
      volumePercent: selected.self ? null : voiceMemberVolume(state, selected.userId),
      streaming: canWatchVoiceMemberStream(state, selected.channelId, selected.userId),
      watching: isWatchingVoiceMemberStream(selected.channelId, selected.userId),
      ...moderation,
    });
  } else {
    const channel = sidebarChannelsForGuild(state.sidebar, state.channelList.channels, selected.guildId)
      .find((candidate) => candidate.id === selected.id);
    if (!channel) return false;
    state.sidebar.serverActionModal = createChannelActionModal(
      selected.kind,
      selected.guildId,
      selected.id,
      selected.label,
      Boolean(channel.muted),
      {
        canDelete: selected.kind === "channel" && canDeleteGuildChannel(state, selected.guildId, selected.id),
        isThread: isThreadChannel(channel),
      },
    );
  }
  scheduleRender();
  return true;
}

function toggleSelectedMute(): void {
  const selected = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
  if (selected.guildId === INSTAGRAM_GUILD_ID) {
    if (selected.kind !== "channel" || !instagramController.toggleChatMute(selected.id)) {
      setNotice(state, "Select an Instagram chat to mute or unmute it locally.", "muted", { statusLine: true, chat: false });
      scheduleRender();
    }
    return;
  }
  if (selected.guildId === WHATSAPP_GUILD_ID) {
    if (selected.kind !== "channel" || !whatsAppController.toggleChatMute(selected.id)) {
      setNotice(state, "Select a WhatsApp chat to mute or unmute it.", "muted", { statusLine: true, chat: false });
      scheduleRender();
    }
    return;
  }
  toggleSelectedGuildMute(state, { scheduleRender });
}

function serverActionErrorMessage(error: unknown, fallback: string): string {
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? `${fallback}: ${detail}` : fallback;
}

function runServerModalAction(action: ServerAction): void {
  const modal = state.sidebar.serverActionModal;
  if (!modal || modal.busy) return;
  if (modal.guildId === INSTAGRAM_GUILD_ID) {
    state.sidebar.serverActionModal = null;
    if (action === "toggle_mute" && modal.targetKind === "channel") instagramController.toggleChatMute(modal.targetId);
    scheduleRender();
    return;
  }

  if (action === "toggle_mute" && modal.targetKind === "voice_member") {
    state.sidebar.serverActionModal = null;
    toggleVoiceMemberMute(state, { scheduleRender }, modal.targetId);
    return;
  }

  if (action === "toggle_mute" && modal.guildId === WHATSAPP_GUILD_ID) {
    state.sidebar.serverActionModal = null;
    whatsAppController.toggleChatMute(modal.targetId);
    return;
  }

  if (action === "watch_stream" && modal.targetKind === "voice_member") {
    state.sidebar.serverActionModal = null;
    const streamKey = modal.guildId === DIRECT_MESSAGES_GUILD_ID
      ? `call:${modal.channelId}:${modal.targetId}`
      : `guild:${modal.guildId}:${modal.channelId}:${modal.targetId}`;
    watchCurrentStream(state, { scheduleRender }, streamKey);
    return;
  }

  const token = tokenOrWarn();
  if (!token) return;
  modal.busy = true;
  modal.error = null;
  scheduleRender();

  if (action === "copy_invite") {
    const cachedChannels = sidebarChannelsForGuild(state.sidebar, state.channelList.channels, modal.guildId);
    // A context menu that sits unchanged during the network request feels like
    // the Enter press was missed. Dismiss it immediately and move progress to
    // the status line until the URL is actually on the clipboard.
    state.sidebar.serverActionModal = null;
    setNotice(state, "Copying invite...", "muted", { loading: true, statusLine: true, chat: false });
    scheduleRender();
    void createGuildInvite(token, modal.guildId, cachedChannels).then((inviteUrl) => {
      copyToClipboard(inviteUrl);
      const notice = "Copied server url to clipboard!";
      setNotice(state, notice, "success", { statusLine: true, chat: false });
      clearNoticeLater(notice, COPIED_INVITE_NOTICE_MS);
      scheduleRender();
    }).catch((error) => {
      modal.busy = false;
      modal.error = serverActionErrorMessage(error, "Could not copy invite");
      setNotice(state, "", "muted", { statusLine: true, chat: false });
      if (!state.sidebar.serverActionModal && state.sidebar.guilds.some((guild) => guild.id === modal.guildId)) {
        state.sidebar.serverActionModal = modal;
      }
      scheduleRender();
    });
    return;
  }

  if (action === "toggle_mute") {
    state.sidebar.serverActionModal = null;
    toggleSelectedGuildMute(state, { scheduleRender });
    return;
  }

  const failModalAction = (error: unknown, fallback: string): void => {
    if (state.sidebar.serverActionModal !== modal) return;
    modal.busy = false;
    modal.error = serverActionErrorMessage(error, fallback);
    scheduleRender();
  };

  const finishModalAction = (): void => {
    if (state.sidebar.serverActionModal === modal) state.sidebar.serverActionModal = null;
    scheduleRender();
  };

  if (action === "delete_channel" && (modal.targetKind === "channel" || modal.targetKind === "thread")) {
    void deleteChannel(token, modal.targetId).then(() => {
      if (state.sidebar.serverActionModal === modal) state.sidebar.serverActionModal = null;
      removeSessionChannel(state, { scheduleRender }, modal.targetId, modal.guildId);
      scheduleRender();
    }).catch((error) => failModalAction(
      error,
      modal.targetKind === "thread" ? "Could Not Delete Thread" : "Could Not Delete Channel",
    ));
    return;
  }

  if (modal.targetKind === "voice_member" && modal.channelId) {
    if (action === "toggle_server_mute") {
      const muted = !modal.serverMuted;
      void setGuildMemberServerMute(token, modal.guildId, modal.targetId, muted).then(() => {
        setTrackedVoiceMemberServerMuted(state, modal.channelId!, modal.targetId, muted);
        finishModalAction();
      }).catch((error) => failModalAction(error, `Could Not ${muted ? "Server Mute" : "Server Unmute"}`));
      return;
    }

    if (action === "toggle_server_deafen") {
      const deafened = !modal.serverDeafened;
      void setGuildMemberServerDeafen(token, modal.guildId, modal.targetId, deafened).then(() => {
        setTrackedVoiceMemberServerDeafened(state, modal.channelId!, modal.targetId, deafened);
        finishModalAction();
      }).catch((error) => failModalAction(error, `Could Not Server ${deafened ? "Deafen" : "Undeafen"}`));
      return;
    }

    if (action === "kick_from_vc") {
      void disconnectGuildMemberFromVoice(token, modal.guildId, modal.targetId).then(() => {
        finishModalAction();
      }).catch((error) => failModalAction(error, "Could Not Kick From VC"));
      return;
    }

    if (action === "kick_from_server") {
      void kickGuildMember(token, modal.guildId, modal.targetId).then(() => {
        finishModalAction();
      }).catch((error) => failModalAction(error, "Could Not Kick From Server"));
      return;
    }

    if (action === "ban_from_server") {
      void banGuildMember(token, modal.guildId, modal.targetId).then(() => {
        finishModalAction();
      }).catch((error) => failModalAction(error, "Could Not Ban From Server"));
      return;
    }
  }

  void leaveGuild(token, modal.guildId).then(() => {
    if (state.sidebar.serverActionModal === modal) state.sidebar.serverActionModal = null;
    removeSessionGuild(state, modal.guildId);
    scheduleRender();
  }).catch((error) => {
    if (state.sidebar.serverActionModal !== modal) return;
    modal.busy = false;
    modal.error = serverActionErrorMessage(error, "Could not leave server");
    scheduleRender();
  });
}

function handleServerModalKey(key: KeyEvent): void {
  const modal = state.sidebar.serverActionModal;
  if (!modal) return;
  state.navigationPendingKeys = "";
  const result = handleServerActionModalKey(modal, key);
  if (result.type === "close") state.sidebar.serverActionModal = null;
  if (result.type === "adjust_volume" && modal.targetKind === "voice_member") {
    modal.volumePercent = adjustVoiceMemberVolume(state, { scheduleRender }, modal.targetId, result.deltaPercent);
  }
  if (result.type === "action") runServerModalAction(result.action);
  scheduleRender();
}

/** Activate the current sidebar row through the same path for Enter and clicks. */
function activateSidebarSelection(): void {
  const selectedBefore = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
  if (selectedBefore.guildId === INSTAGRAM_GUILD_ID) {
    if (selectedBefore.kind === "channel") instagramController.openChannel(selectedBefore.id);
    else {
      activateSelectedEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      if (state.sidebar.expandedGuildId === INSTAGRAM_GUILD_ID) instagramController.openRoot();
      scheduleRender();
    }
    return;
  }
  if (selectedBefore.kind === "folder" || selectedBefore.kind === "up") {
    activateSelectedEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
    scheduleRender();
    return;
  }

  if (selectedBefore.kind === "guild" && selectedBefore.guildId === WHATSAPP_GUILD_ID) {
    const entry = activateSelectedEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions()) ?? selectedBefore;
    if (state.sidebar.expandedGuildId === entry.guildId) whatsAppController.openRoot();
    else scheduleRender();
    return;
  }

  if (selectedBefore.kind === "channel" && selectedBefore.guildId === WHATSAPP_GUILD_ID) {
    whatsAppController.openChannel(selectedBefore.id);
    return;
  }

  const token = tokenOrWarn();
  if (!token) return;

  const entry = activateSelectedEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions()) ?? selectedBefore;

  if (entry.kind === "guild") {
    if (state.sidebar.expandedGuildId === entry.guildId) {
      void loadGuildChannels(state, token, entry.guildId, { scheduleRender }, { openFirstChannel: false });
    } else {
      scheduleRender();
    }
    return;
  }

  if (entry.kind === "channel") {
    ensureSidebarEntryGuildLoaded(entry.guildId);
    const channel = state.channelList.channels.find((candidate) => candidate.id === entry.id)
      ?? state.sidebar.cachedChannelsByGuildId[entry.guildId]?.find((candidate) => candidate.id === entry.id)
      ?? null;
    if (channel && isGuildVoiceChannel(channel)) {
      startCurrentVoiceCall(state, { scheduleRender }, { voiceChannel: channel });
      return;
    }
    if (isForumChannel(channel)) {
      scheduleRender();
      return;
    }
    void loadChannelMessages(state, token, entry.id, { scheduleRender });
    return;
  }

  scheduleRender();
}

function handleSidebarFocused(key: KeyEvent): boolean {
  if (state.sidebar.prompt) {
    state.navigationPendingKeys = "";
    handleSidebarPromptKey(state.sidebar, key, state.channelList.channels, sidebarVisibilityOptions());
    persistSidebarFolders(state);
    scheduleRender();
    return true;
  }

  if (state.sidebar.search?.barOpen) {
    state.navigationPendingKeys = "";
    handleSidebarSearchBarKey(state.sidebar, state.channelList.channels, key, sidebarVisibilityOptions());
    scheduleRender();
    return true;
  }

  if (key.type === "escape") {
    if (state.editor.mode === "normal") exitPinnedMessages();
    state.navigationPendingKeys = "";
    state.sidebar.visualAnchor = null;
    state.sidebar.pendingDeleteItem = null;
    scheduleRender();
    return true;
  }

  if (key.type === "char" && key.char === ";") {
    openSelectedServerActionModal();
    return true;
  }

  if (key.type === "backspace") {
    state.navigationPendingKeys = "";
    leaveSidebarFolder(state.sidebar);
    scheduleRender();
    return true;
  }

  const navigation = resolveNavigationAction(key, state.navigationPendingKeys);
  state.navigationPendingKeys = navigation.pendingKeys;
  if (!navigation.action && navigation.handled) return true;

  switch (navigation.action) {
    case "focus_prompt":
      focusPromptInsert(key.type === "char" && key.char === "a");
      return true;
    case "nav_up":
      moveSidebarSelection(state.sidebar, state.channelList.channels, -1, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_down":
      moveSidebarSelection(state.sidebar, state.channelList.channels, 1, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_top":
      jumpSidebarSelectionToEdge(state.sidebar, state.channelList.channels, state.rows, "top", sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_bottom":
      jumpSidebarSelectionToEdge(state.sidebar, state.channelList.channels, state.rows, "bottom", sidebarVisibilityOptions());
      scheduleRender();
      return true;
    default:
      break;
  }

  if (key.type === "char" && key.char) {
    if (key.char === "/" || key.char === "?") {
      openSidebarSearchBar(state.sidebar, state.channelList.channels, key.char === "/" ? "forward" : "backward", sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === ":") {
      openSidebarCommandBar(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === "n" && state.sidebar.search?.query) {
      jumpToSidebarSearchMatch(state.sidebar, state.channelList.channels, state.sidebar.search.direction, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === "v" || key.char === "V") {
      toggleSidebarVisualSelection(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === "f") {
      openSidebarCreateFolderPrompt(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === "F") {
      openSidebarMoveItemsPrompt(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === "<") {
      if (moveSidebarSelectionOut(state.sidebar, state.channelList.channels, sidebarVisibilityOptions())) persistSidebarFolders(state);
      scheduleRender();
      return true;
    }
    if (key.char === "h") {
      leaveSidebarFolder(state.sidebar);
      scheduleRender();
      return true;
    }
    if (key.char === "l") {
      const before = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      if (before.kind === "folder" || before.kind === "up") activateSelectedEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === "r") {
      openSidebarRenameFolderPrompt(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    }
    if (key.char === "x") {
      if (unwrapSelectedSidebarFolder(state.sidebar, state.channelList.channels, sidebarVisibilityOptions())) persistSidebarFolders(state);
      scheduleRender();
      return true;
    }
    if (key.char === "N" && state.sidebar.search?.query) {
      jumpToSidebarSearchMatch(
        state.sidebar,
        state.channelList.channels,
        state.sidebar.search.direction === "forward" ? "backward" : "forward",
        sidebarVisibilityOptions(),
      );
      scheduleRender();
      return true;
    }
  }

  const action = navigation.action;
  if (!action) return false;

  switch (action) {
    case "nav_prev_server":
      moveSidebarSelectionToPrevGuild(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_next_server":
      moveSidebarSelectionToNextGuild(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_prev_category":
      if (state.sidebar.expandedGuildId === DIRECT_MESSAGES_GUILD_ID) {
        moveSidebarSelectionToPrevDirectMessage(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      } else {
        moveSidebarSelectionToPrevCategory(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      }
      scheduleRender();
      return true;
    case "nav_next_category":
      if (state.sidebar.expandedGuildId === DIRECT_MESSAGES_GUILD_ID) {
        moveSidebarSelectionToNextDirectMessage(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      } else {
        moveSidebarSelectionToNextCategory(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      }
      scheduleRender();
      return true;
    case "nav_toggle_guild_mute":
      toggleSelectedMute();
      return true;
    case "nav_voice_volume_up":
      adjustSelectedVoiceMemberVolume(state, { scheduleRender }, REMOTE_USER_VOLUME_STEP_PERCENT);
      return true;
    case "nav_voice_volume_down":
      adjustSelectedVoiceMemberVolume(state, { scheduleRender }, -REMOTE_USER_VOLUME_STEP_PERCENT);
      return true;
    case "nav_move_guild_up":
      moveSelectedGuildOrder(state, { scheduleRender }, "up");
      return true;
    case "nav_move_guild_down":
      moveSelectedGuildOrder(state, { scheduleRender }, "down");
      return true;
    case "nav_toggle_conversation_pin":
      toggleSelectedPrivateConversationPin(state, { scheduleRender });
      return true;
    case "nav_visible_top":
      jumpSidebarSelectionToVisibleEdge(state.sidebar, state.channelList.channels, state.rows, "top", sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_visible_middle":
      jumpSidebarSelectionToVisibleMiddle(state.sidebar, state.channelList.channels, state.rows, sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_visible_bottom":
      jumpSidebarSelectionToVisibleEdge(state.sidebar, state.channelList.channels, state.rows, "bottom", sidebarVisibilityOptions());
      scheduleRender();
      return true;
    case "nav_open_text": {
      const selected = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      if (selected.kind !== "channel") {
        scheduleRender();
        return true;
      }

      ensureSidebarEntryGuildLoaded(selected.guildId);
      const channel = state.channelList.channels.find((candidate) => candidate.id === selected.id)
        ?? state.sidebar.cachedChannelsByGuildId[selected.guildId]?.find((candidate) => candidate.id === selected.id)
        ?? null;
      if (!channel) {
        scheduleRender();
        return true;
      }

      if (selected.guildId === INSTAGRAM_GUILD_ID) {
        instagramController.openChannel(channel.id);
        return true;
      }
      if (selected.guildId === WHATSAPP_GUILD_ID) {
        whatsAppController.openChannel(channel.id);
        return true;
      }

      if (isForumChannel(channel)) {
        // Forums are thread containers rather than message timelines. Their
        // active posts are selectable directly beneath this row.
        scheduleRender();
        return true;
      }

      const token = tokenOrWarn();
      if (!token) return true;

      void loadChannelMessages(state, token, channel.id, { scheduleRender });
      return true;
    }
    case "nav_select": {
      activateSidebarSelection();
      return true;
    }
    default:
      return false;
  }
}

function handleHistoryFocused(key: KeyEvent): boolean {
  if (state.editor.mode === "normal" && !editorHasPendingInput() && key.type === "char" && key.char === ":") {
    const message = selectedHistoryMessage();
    if (!message || message.localStatus || message.id.startsWith("local:")) {
      setNotice(state, "Select a sent message to react to.", "warning");
    } else {
      beginReactionComposer(state, message);
      syncPromptAutocomplete();
    }
    scheduleRender();
    return true;
  }

  if (key.type === "escape" && state.timeline.view === "pinned") {
    focusHistory(state);
    exitPinnedMessages();
    return true;
  }

  if (state.editor.mode === "normal" && key.type === "char" && key.char === "d") {
    deleteSelectedHistoryMessage();
    return true;
  }

  const clearedPendingDelete = clearPendingMessageDelete();

  if (handleHistorySelectionQuoteKey(state, key)) {
    syncPromptAutocomplete();
    scheduleRender();
    return true;
  }

  if (state.editor.mode === "normal" && key.type === "char" && (key.char === "r" || key.char === "R")) {
    startReplyToSelectedHistoryMessage(key.char === "r");
    return true;
  }

  if (state.editor.mode === "normal" && key.type === "char" && key.char === "e" && selectedMessageCanBeEdited(selectedHistoryMessage())) {
    startEditSelectedHistoryMessage();
    return true;
  }

  if (state.editor.mode === "normal" && key.type === "char" && key.char === "G") {
    jumpToChannelBottom();
    return true;
  }

  if (handleHistoryVimKey(state, key, timelinePageSize())) {
    if (state.chatFocus === "history") {
      maybeLoadOlderHistory();
      maybeLoadNewerHistory();
    }
    scheduleRender();
    return true;
  }

  const action = resolveAction(key, "navigation");
  if (!action) {
    if (clearedPendingDelete) {
      scheduleRender();
      return true;
    }
    return false;
  }

  switch (action) {
    case "focus_prompt":
      focusPromptInsert(key.type === "char" && key.char === "a");
      return true;
    case "nav_up":
      scrollHistoryWithCursor(state, 1, 1, timelinePageSize());
      maybeLoadOlderHistory();
      scheduleRender();
      return true;
    case "nav_down":
      scrollHistoryWithCursor(state, -1, 1, timelinePageSize());
      maybeLoadNewerHistory();
      scheduleRender();
      return true;
    case "nav_select": {
      const imageBodyAttachment = inlineImageBodyAttachmentAtHistoryCursor(state);
      if (imageBodyAttachment && openInlineImageModal(imageBodyAttachment)) return true;

      const attachment = attachmentAtHistoryCursor(state);
      if (attachment && toggleInlineAttachmentImage(attachment)) return true;

      if (returnToPinnedMessageInChannelHistory()) return true;
      if (focusThreadAtHistoryCursor()) return true;
      if (jumpToReplyTargetAtHistoryCursor()) return true;
      if (jumpToForwardedOriginAtHistoryCursor()) return true;

      if (attachment) {
        setNotice(state, `Downloading ${attachment.filename}…`, "muted", { loading: true, chat: false });
        scheduleRender();
        void (async () => {
          const downloaded = isWhatsAppChannelId(state.timeline.channelId)
            ? await whatsAppController.downloadAttachment(attachment)
            : await downloadAttachment(attachment, {
              onProgress: (progress) => {
                if (!running) return;
                showAttachmentDownloadProgress(attachment.filename, progress);
              },
            });
          if (!running) return;
          if (!downloaded.ok || !downloaded.path) {
            setNotice(state, `Could not open ${attachment.filename}: ${downloaded.error ?? "unknown error"}`, "warning");
            scheduleRender();
            return;
          }
          const openNotice = downloaded.cached
            ? `Opening cached ${attachment.filename}…`
            : `Opening ${attachment.filename}…`;
          if (!openTargetDetached(downloaded.path)) {
            setNotice(state, `Could not open ${attachment.filename}: No opener configured for ${downloaded.path}.`, "warning");
            scheduleRender();
          } else {
            showTransientNotice(openNotice);
          }
        })();
        return true;
      }

      const target = openableTargetAtHistoryCursor(state);
      if (!target) return true;
      const inviteCode = discordInviteCodeFromUrl(target);
      if (inviteCode) {
        joinDiscordInviteTarget(target, inviteCode);
        return true;
      }
      if (shouldDownloadTargetBeforeOpen(target)) {
        downloadAndOpenTarget(target);
        return true;
      }
      if (!openTargetDetached(target)) {
        setNotice(state, `No opener configured for ${target}.`, "warning");
        scheduleRender();
      } else {
        showTransientNotice(`Opening ${target}…`);
      }
      return true;
    }
    default:
      return false;
  }
}

function handleMemberListFocused(key: KeyEvent): boolean {
  const navigation = resolveNavigationAction(key, state.navigationPendingKeys);
  state.navigationPendingKeys = navigation.pendingKeys;
  const action = navigation.action;
  if (!action) return navigation.handled;

  switch (action) {
    case "focus_prompt":
      focusPromptInsert(key.type === "char" && key.char === "a");
      return true;
    case "nav_up":
      state.memberList.selectedIndex = Math.max(0, state.memberList.selectedIndex - 1);
      scheduleRender();
      return true;
    case "nav_down":
      state.memberList.selectedIndex = Math.min(
        Math.max(0, state.memberList.members.length - 1),
        state.memberList.selectedIndex + 1,
      );
      scheduleRender();
      return true;
    case "nav_top":
      jumpMemberListSelectionToEdge(state.memberList, state.rows, "top");
      scheduleRender();
      return true;
    case "nav_bottom":
      jumpMemberListSelectionToEdge(state.memberList, state.rows, "bottom");
      scheduleRender();
      return true;
    case "nav_visible_top":
      jumpMemberListSelectionToVisibleEdge(state.memberList, state.rows, "top");
      scheduleRender();
      return true;
    case "nav_visible_middle":
      jumpMemberListSelectionToVisibleMiddle(state.memberList, state.rows);
      scheduleRender();
      return true;
    case "nav_visible_bottom":
      jumpMemberListSelectionToVisibleEdge(state.memberList, state.rows, "bottom");
      scheduleRender();
      return true;
    default:
      return false;
  }
}

function handlePromptFocused(key: KeyEvent): void {
  if (key.type === "backspace" && handlePromptBackspacePrefixAction()) return;

  if (key.type === "tab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, 1);
    } else {
      tryPathComplete(state);
    }
    scheduleRender();
    return;
  }

  if (key.type === "backtab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, -1);
    }
    scheduleRender();
    return;
  }

  if (key.type === "escape" && state.autocomplete) {
    acceptAutocomplete(state);
  }

  const previousBuffer = state.editor.buffer;
  const previousCursor = state.editor.cursor;
  const previousMode = state.editor.mode;
  const editorKey = key.type === "paste" && key.text
    ? { ...key, text: replaceCustomEmojiTokens(key.text) }
    : key;
  const action = handleEditorKey(state.editor, editorKey);

  if (action === "submit") {
    submitCurrentBuffer(state, effects);
    return;
  }

  if (action === "quit") {
    cleanup();
    return;
  }

  if (action === "scroll_top") {
    state.timeline.scrollOffset = 0;
    maybeLoadOlderHistory();
    scheduleRender();
    return;
  }

  if (action === "scroll_bottom") {
    state.timeline.scrollOffset = state.timeline.maxScroll;
    if (isInstagramChannelId(state.timeline.channelId)) instagramController.markActiveRead();
    else ackCurrentChannelIfAtBottom(state);
    scheduleRender();
    return;
  }

  if (
    previousBuffer !== state.editor.buffer
    || previousCursor !== state.editor.cursor
    || previousMode !== state.editor.mode
  ) {
    syncPromptAutocomplete();
  }

  scheduleRender();
}

function handleKey(key: KeyEvent): void {
  if (key.type === "ctrl-c") {
    cleanup();
    return;
  }

  if (key.event === "release") return;
  if (handleQuickReactionKey(state, key, effects)) return;

  if (state.imageModal) {
    const result = handleImageModalKey(key);
    if (result.type === "close") state.imageModal = null;
    scheduleRender();
    return;
  }

  if (state.whatsapp.loginModal) {
    const result = handleLoginModalKey(state.whatsapp.loginModal, key);
    if (result.type === "cancel") whatsAppController.cancelLogin();
    else scheduleRender();
    return;
  }

  if (voiceMessageController?.handleKey(key)) return;

  if (state.sidebar.serverActionModal) {
    handleServerModalKey(key);
    return;
  }

  if (state.panelFocus === "chat" && key.type === "escape" && state.editor.mode === "normal"
    && cancelPromptReaction(state)) {
    scheduleRender();
    return;
  }

  if (state.panelFocus === "sidebar" && state.sidebar.open && state.sidebar.prompt) {
    handleSidebarFocused(key);
    return;
  }

  if (state.panelFocus === "sidebar" && state.sidebar.open && state.sidebar.search?.barOpen) {
    handleSidebarFocused(key);
    return;
  }

  if (state.panelFocus === "sidebar" && state.sidebar.open && key.type === "escape") {
    handleSidebarFocused(key);
    return;
  }

  if (handleGlobalAction(key)) return;

  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    handleSidebarFocused(key);
    return;
  }

  if (state.panelFocus === "memberlist" && state.memberList.open) {
    handleMemberListFocused(key);
    return;
  }

  if (state.chatFocus === "history") {
    handleHistoryFocused(key);
    return;
  }

  handlePromptFocused(key);
}

function handleMouse(event: MouseEvent): void {
  resetQuickReaction(state);
  if (state.imageModal || voiceMessageController?.isRecording() || state.voiceMessagePrompt) return;

  const previousFocus = state.panelFocus;
  const previousIndex = state.sidebar.selectedIndex;
  const previousScrollOffset = state.sidebar.scrollOffset;
  const result = handleMouseEvent(event, state);
  if (state.panelFocus !== previousFocus) syncPromptAutocomplete();

  if (result.type === "activate_sidebar") {
    activateSidebarSelection();
    return;
  }

  if (result.type === "scroll_chat") {
    scrollTimeline(result.delta);
    return;
  }

  // All non-motion events can affect the viewport. Avoid redraws for the high
  // volume stream of no-op motion reports generated by all-motion tracking.
  if (event.action !== "motion"
      || state.panelFocus !== previousFocus
      || state.sidebar.selectedIndex !== previousIndex
      || state.sidebar.scrollOffset !== previousScrollOffset) {
    scheduleRender();
  }
}

function setupTerminal(): void {
  process.stdout.write(
    enterAlt
      + hideCursor
      + queryTerminalCellSize()
      + enableBracketedPaste
      + queryClipboardPasteEvents
      + enableClipboardPasteEvents
      + enableKittyKeyboard
      + enableMouse
      + (theme.cursorColor ? setCursorColor(theme.cursorColor) : ""),
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalReady = true;
}

function restoreTerminal(): void {
  if (!terminalReady) return;
  process.stdin.setRawMode(false);
  disposeInlineTerminalImages(state);
  process.stdout.write(
    (terminalGraphicsClient?.isSupported() ? customEmojiImages.cleanupSequence() : "")
      + (terminalGraphicsCells ? setStGraphicsCells(false) : "")
      + disableMouse
      + disableKittyKeyboard
      + disableClipboardPasteEvents
      + disableBracketedPaste
      + showCursor
      + resetCursorColor
      + leaveAlt,
  );
  terminalGraphicsCells = false;
  terminalReady = false;
}

function cleanup(): void {
  if (!running) return;
  running = false;
  persistStartingStateOnce();
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  stopLoadingAnimation();
  voiceMessageController?.cleanup();
  terminalControlBuffer?.dispose();
  terminalControlBuffer = null;
  terminalClipboardClient?.dispose();
  terminalClipboardClient = null;
  terminalGraphicsClient?.dispose();
  disconnectMemberListGateway();
  disconnectAppGateway();
  flushDataCacheSync();
  restoreTerminal();
  const forceExit = setTimeout(() => process.exit(0), 1_000);
  void Promise.allSettled([whatsAppController.shutdown(), instagramController.shutdown()]).finally(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

function loginWhatsApp(): void {
  whatsAppController.login();
}

function logoutWhatsApp(): void {
  whatsAppController.logout();
}

const effects: AppEffects = {
  scheduleRender,
  quit: cleanup,
  applyThemeCursor,
  bootstrapSession,
  loginWhatsApp,
  loginInstagram: (tabId) => { void instagramController.login(tabId); },
  logoutInstagram: () => { void instagramController.logout(); },
  sendInstagramMessage: (content) => instagramController.sendMessage(content),
  refreshInstagram: () => { void instagramController.refresh(); },
  logoutWhatsApp,
  sendWhatsAppMessage: (content) => whatsAppController.sendMessage(content),
  reactWhatsAppMessage: (message, emoji) => whatsAppController.reactToMessage(message, emoji),
};

voiceMessageController = createVoiceMessageController(state, scheduleRender, {
  sendVoiceMessage: (clip) => sendCurrentChannelVoiceMessage(state, state.auth.savedToken, clip, effects),
});

const whatsAppController = new WhatsAppController(state, scheduleRender);
const instagramController = new InstagramController(state, scheduleRender);
if (savedStartingState) applyTuiStartingState(state, savedStartingState);
if (initialToken) restoreCachedSessionPreview(state, savedStartingState);
if (savedStartingState?.focusedChannel?.guildId === WHATSAPP_GUILD_ID) {
  void restorePendingStartingState(null).catch((error) => {
    debugLog("starting_state.restore_failed", { error: error instanceof Error ? error.message : String(error) });
  });
}

async function main(): Promise<void> {
  setupTerminal();

  const pasteBuffer = new PasteBuffer(processInput);
  terminalClipboardClient = new TerminalClipboardClient({
    write: (sequence) => process.stdout.write(sequence),
    onImage: attachClipboardImage,
    onText: (text) => handleKey({ type: "paste", text }),
    onError: (message) => debugLog("terminal.clipboard.error", { message }),
  });
  customEmojiImages.configure({
    onUpdate: () => {
      if (!running) return;
      scheduleRender();
    },
  });
  terminalGraphicsClient = new TerminalGraphicsClient({
    write: (sequence) => process.stdout.write(sequence),
    onSupportChanged: (supported) => {
      customEmojiImages.setEnabled(supported);
      invalidateFrame(state);
      scheduleRender();
    },
  });
  terminalControlBuffer = new TerminalControlBuffer(
    (data) => {
      const ready = pasteBuffer.feed(Buffer.from(data));
      if (ready !== null) processInput(ready);
    },
    (sequence) => {
      const cellSize = parseTerminalCellSize(sequence);
      if (cellSize) {
        if (setTimelineTerminalCellSize(state.timeline, cellSize.width, cellSize.height)) scheduleRender();
        return;
      }
      // Inline-image eviction replies are a narrow subset of Kitty graphics
      // controls. Route them before the custom-emoji capability client, which
      // intentionally consumes every remaining Kitty graphics response.
      if (handleInlineTerminalImageResponse(state, sequence)) {
        scheduleRender();
        return;
      }
      if (terminalGraphicsClient?.handleControlSequence(sequence)) return;
      terminalClipboardClient?.handleControlSequence(sequence);
    },
  );
  process.stdin.on("data", (data: Buffer) => terminalControlBuffer?.feed(data));
  terminalGraphicsClient.query();

  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    invalidateFrame(state);
    if (terminalReady) process.stdout.write(queryTerminalCellSize());
    scheduleRender();
  });

  if (initialToken) {
    // Enter the authenticating state before the first frame so startup never
    // briefly renders the logged-out instructions for a saved login.
    void validateAndMaybeSave(state, initialToken, false, "Validating saved token…", effects);
  }

  render(state);

  whatsAppController.restoreSavedSession();
  void instagramController.autoConnect().then(() => restorePendingStartingState(state.auth.savedToken));
}

function processInput(input: string): void {
  if (!running) return;

  const events = parseInput(input);
  for (const event of events) {
    if (event.type === "mouse") handleMouse(event);
    else handleKey(event);
    if (!running) break;
  }
}

let startingStatePersisted = false;

function persistStartingStateOnce(): void {
  if (startingStatePersisted) return;
  try {
    saveTuiStartingState(captureTuiStartingState(state, pendingStartingState?.accountId ?? null));
    startingStatePersisted = true;
  } catch (error) {
    debugLog("starting_state.save_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

process.on("exit", () => {
  persistStartingStateOnce();
  restoreTerminal();
});
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGHUP", cleanup);

main().catch(async (error) => {
  disconnectMemberListGateway();
  disconnectAppGateway();
  await whatsAppController.shutdown().catch(() => {});
  await instagramController.shutdown().catch(() => {});
  flushDataCacheSync();
  restoreTerminal();
  console.error(`Fatal: ${(error as Error).message}`);
  process.exit(1);
});
