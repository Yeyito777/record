/**
 * record — Discord terminal client bootstrap.
 */

// Must stay the first import: demo mode redirects config paths and the network.
import "./demo/bootstrap";
import { submitCurrentBuffer, validateAndMaybeSave, type AppEffects } from "./actions";
import { AsyncWorkQueue } from "./asyncwork";
import { killTrackedChildProcesses, trackedChildProcessCount } from "./childprocesses";
import { flushDataCacheSync } from "./datacache";
import { customEmojiImages, replaceCustomEmojiTokens } from "./customemoji";
import { configPath, loadConfig, loadSavedLogins, saveConfig, type ImageDisplayMode } from "./config";
import { DEFAULT_LOCAL_GAIN_DB, DEFAULT_NOISE_SUPPRESSION_MODE, REMOTE_USER_VOLUME_STEP_PERCENT, normalizeGainDb, normalizeParticipantVolumes, parseNoiseSuppressionMode, type NoiseSuppressionMode, type ParticipantVolumes } from "./volume";
import { acceptAutocomplete, cycleAutocomplete, dismissAutocomplete, handleAutocompleteArrow, tryPathComplete, updateAutocomplete } from "./autocomplete";
import { LOADING_FRAMES } from "./loading";
import {
  displayCursor,
  getInputLines,
  handleEditorKey,
  promptRowLimit,
  PROMPT_PREFIX_WIDTH,
  replaceEditorText,
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
import { imageExtension, readClipboardImages, type ClipboardImageAttachment } from "./imageclipboard";
import { inlineImageId, inlineImagePreviewPixelBounds, isImageAttachment, prepareInlineImage, prepareInlineImageBytes, shouldLoadInlineImage, visibleInlineImageSources, type InlineChatImageLoading, type InlineChatImageReady } from "./inlineimage";
import { InlineImageCache, inlineImageCacheKey } from "./inlineimagecache";
import { handleImageModalKey, openImageModalState, upgradeImageModal } from "./imagemodal";
import { copyToClipboard } from "./editor-clipboard";
import { attachmentAtHistoryCursor, embedVideoAtHistoryCursor, forwardedOriginAtHistoryCursor, inlineImageBodyAttachmentAtHistoryCursor, openableTargetAtHistoryCursor, threadChannelAtHistoryCursor } from "./historyopenable";
import { isEmbedSourceId, type EmbedVideoTarget } from "./embeds";
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
import { SYNCHRONIZED_UPDATES_QUERY, invalidateFrame, parseSynchronizedUpdatesReport } from "./frame";
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
import { disposeInlineTerminalImages, handleInlineTerminalImageResponse, parseTerminalCellSize, queryTerminalCellSize, terminalImageNotFoundId } from "./terminalimage";
import { sidebarIconTerminalOwner, sidebarIcons } from "./sidebaricons";
import { dmAuthorColor, theme } from "./theme";
import { clearTimeline, hasActiveTimelineCall, hasLoadingInlineTimelineImage, moveTimelineScroll, removeTimelineInlineImageState, renderTimelineLines, setTimelineInlineImageState, setTimelineImageDetails, setTimelineRenderContext, setTimelineTerminalCellSize, shouldLoadNewerMessages, shouldLoadOlderMessages, startLoadingNewerMessages, startLoadingOlderMessages } from "./timeline";
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
  type AttachmentDownloadOptions,
  type AttachmentDownloadProgress,
} from "./openable";
import { createVoiceMessageController } from "./voice-message-controller";
import { WhatsAppController } from "./whatsapp/controller";
import { InstagramController } from "./instagram/controller";
import { isTimelineNearBottom } from "./timeline";
import { INSTAGRAM_GUILD_ID, instagramGuild, isInstagramChannelId, isExternalChannelId } from "./chatproviders";
import { handleLoginModalKey } from "./whatsapp/loginmodal";
import { applyTuiStartingState, availableStartingChannel, captureTuiStartingState, loadTuiStartingState, saveTuiStartingState } from "./startingstate";
import {
  SMOOTH_SCROLL_OFF,
  SMOOTH_SCROLL_ON,
  SMOOTH_SCROLL_QUERY,
  SmoothScroller,
  markRelayout,
  markScrollIntent,
  parseSmoothScrollReport,
  setSmoothScroller,
  smoothScrollerFor,
} from "./smoothscroll";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("record needs an interactive TTY.");
  process.exit(1);
}

let initialToken: string | null = null;
let initialShowHiddenChannels = false;
let initialImageDisplayMode: ImageDisplayMode = "show";
let initialImageDetails = false;
let initialNoiseSuppression: NoiseSuppressionMode = DEFAULT_NOISE_SUPPRESSION_MODE;
let initialMicGainDb = DEFAULT_LOCAL_GAIN_DB;
let initialParticipantVolumes: ParticipantVolumes = {};
let initialSavedLogins: Record<string, string> = {};
let initialQuickReactionEmoji = DEFAULT_QUICK_REACTION;
let initialScrollRegions = true;
const startupWarnings: string[] = [];

try {
  const config = loadConfig();
  initialToken = config.token ? normalizeToken(config.token) : null;
  initialShowHiddenChannels = config.channels?.showHidden === true;
  initialImageDisplayMode = config.images?.mode === "hide" ? "hide" : "show";
  initialImageDetails = config.images?.details === true;
  initialNoiseSuppression = parseNoiseSuppressionMode(config.audio?.noiseSuppression) ?? DEFAULT_NOISE_SUPPRESSION_MODE;
  initialMicGainDb = normalizeGainDb(config.audio?.micGainDb ?? DEFAULT_LOCAL_GAIN_DB);
  initialParticipantVolumes = normalizeParticipantVolumes(config.audio?.participantVolumes);
  initialQuickReactionEmoji = configuredQuickReaction(config.quickReactionEmoji);
  initialScrollRegions = config.scrollRegions !== false;
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
const state = createInitialState(initialToken, configPath(), initialSavedLogins, { showHiddenChannels: initialShowHiddenChannels, imageDisplayMode: initialImageDisplayMode, imageDetails: initialImageDetails, noiseSuppression: initialNoiseSuppression, micGainDb: initialMicGainDb, participantVolumes: initialParticipantVolumes, quickReactionEmoji: initialQuickReactionEmoji, scrollRegions: initialScrollRegions });
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
// Viewer work has its own bounded lane, ahead of background thumbnail queues.
const inlineImageModalLoadQueue = new AsyncWorkQueue(1);
const inlineImageCache = new InlineImageCache();

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
    || typingIndicatorVisible();
}

/**
 * Typing dots animate in the open chat's typing row and beside sidebar rows.
 * Typing in other chats with the sidebar closed draws nothing, so it must not
 * keep the 80 ms frame timer running (expired entries are pruned on render).
 */
function typingIndicatorVisible(): boolean {
  const byChannelId = state.typing.byChannelId;
  if (Object.keys(byChannelId).length === 0) return false;
  if (state.sidebar.open) return true;
  const channelId = state.timeline.channelId ?? state.channelList.activeChannelId;
  return Boolean(channelId && byChannelId[channelId]?.length);
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
    renderFrame();
  }, 16);
}

function renderFrame(): void {
  render(state);
  autoShowVisibleInlineImages();
  scheduleSmoothScrollFrame();
}

function renderImmediately(): void {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  renderFrame();
}

/** RECORD_SMOOTH_SCROLL=off: never ask for st's mode 2032 (testing). */
const smoothScrollAllowed = process.env.RECORD_SMOOTH_SCROLL !== "off";
let smoothScrollTimer: ReturnType<typeof setTimeout> | null = null;
let smoothScrollWasBusy = false;

/**
 * While a smooth scroll moves, lay out each row it is about to cross: st
 * draws every frame of the glide itself, so Record wakes only when the next
 * row is due (no polling) and sends one small region-scroll frame per row.
 */
function scheduleSmoothScrollFrame(): void {
  const smooth = smoothScrollerFor(state);
  // Every frame may have changed the glide (a new input): plan the wake anew.
  if (smoothScrollTimer) {
    clearTimeout(smoothScrollTimer);
    smoothScrollTimer = null;
  }
  if (!smooth) return;
  if (!smooth.busy()) {
    // At rest again: one more frame crops images back to the pane.
    if (smoothScrollWasBusy) {
      smoothScrollWasBusy = false;
      renderImmediately();
    }
    return;
  }
  smoothScrollWasBusy = true;
  smoothScrollTimer = setTimeout(() => {
    smoothScrollTimer = null;
    if (!running || smoothScrollerFor(state) !== smooth) return;
    if (smooth.needsLayout()) {
      renderImmediately();
      return;
    }
    scheduleSmoothScrollFrame();
  }, Math.max(1, smooth.nextWakeMs()));
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
  const previewBounds = inlineImagePreviewPixelBounds(
    state.timeline.terminalCellWidthPixels,
    state.timeline.terminalCellHeightPixels,
  );
  const cacheKey = inlineImageCacheKey(attachment, previewBounds);
  const cached = inlineImageCache.get(cacheKey);
  if (cached) {
    setTimelineInlineImageState(state.timeline, {
      phase: "ready",
      attachmentId: attachment.id,
      filename: attachment.filename,
      sourceUrl: attachment.url,
      requestId,
      imageId: availableInlineImageId(attachment.id, inlineImageId(attachment)),
      ...cached,
    });
    scheduleRender();
    return;
  }
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
      // Another queued occurrence may have prepared this source already.
      let prepared = inlineImageCache.get(cacheKey);
      if (!prepared && local) {
        prepared = await prepareInlineImageBytes(Buffer.from(local.base64, "base64"), previewBounds);
      } else if (!prepared) {
        const downloaded = isWhatsAppChannelId(channelId)
          ? await whatsAppController.downloadAttachment(attachment)
          : isInstagramChannelId(channelId)
            ? await instagramController.downloadAttachment(attachment)
            : await downloadAttachment(attachment);
        const current = currentInlineImageRequest(requestId);
        if (!downloaded.ok || !downloaded.path) {
          if (!running || state.timeline.channelId !== channelId || !current) return;
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

      // Finish warming the cache even if the user left while this job ran.
      // Only the current request may publish UI state below.
      inlineImageCache.set(cacheKey, prepared);
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
  const requestId = ++nextInlineImageRequestId;
  const channelId = state.timeline.channelId;
  const sourceUrl = attachment.url;
  // Reuse resident preview pixels immediately, at the final viewer size, without
  // waiting behind background thumbnail downloads/conversions.
  const modal = openImageModalState(attachment, existing);
  state.imageModal = modal;
  scheduleRender();
  const isCurrent = () => running && state.imageModal === modal
    && state.timeline.channelId === channelId
    && state.timeline.inlineImages[attachment.id]?.sourceUrl === sourceUrl;
  void upgradeImageModal(modal, () => inlineImageModalLoadQueue.enqueue(async () => {
    if (!isCurrent()) return existing;
    const local = state.localAttachmentImages[attachment.id];
    let prepared: Awaited<ReturnType<typeof prepareInlineImage>>;
    if (local) {
      prepared = await prepareInlineImageBytes(Buffer.from(local.base64, "base64"), { preserveSourceResolution: true });
    } else {
      const downloaded = isWhatsAppChannelId(channelId)
        ? await whatsAppController.downloadAttachment(attachment)
        : isInstagramChannelId(channelId)
          ? await instagramController.downloadAttachment(attachment)
          : await downloadAttachment(attachment);
      if (!downloaded.ok || !downloaded.path) throw new Error(downloaded.error ?? "unknown download error");
      prepared = await prepareInlineImage(downloaded.path, { preserveSourceResolution: true });
    }

    const modalAttachmentId = `modal:${attachment.id}`;
    return {
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
    };
  }), isCurrent).catch((error) => {
    debugLog("inline_image.modal_failed", {
      attachmentId: attachment.id,
      filename: attachment.filename,
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => { if (isCurrent()) scheduleRender(); });
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
  // Embed pictures stay text where the terminal cannot draw images.
  const embedPictures = terminalGraphicsClient?.isSupported() !== false;
  for (const attachment of attachments) {
    if (state.inlineImageHiddenAttachmentIds.has(attachment.id)) continue;
    if (!embedPictures && isEmbedSourceId(attachment.id)) continue;
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
    promptRowLimit(state.rows - 3 - bottomStatusRows - imageIndicatorRows),
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
  const before = state.timeline.scrollOffset;
  moveTimelineScroll(state.timeline, delta);
  if (state.timeline.scrollOffset !== before) markScrollIntent(state);
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
  const focusedGuildId = state.panelFocus === "sidebar" && state.sidebar.open
    ? getSelectedSidebarEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions()).guildId
    : state.sidebar.activeGuildId;
  const target = nextChannelNotification(
    state.notifications,
    state.channelList.activeChannelId,
    focusedGuildId || state.sidebar.activeGuildId,
  );
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

/** Ctrl+O: show or hide the name rows above inline images; a sticky preference. */
function toggleImageDetails(): void {
  // A re-layout (handleKey marked it): the view keeps its anchor and snaps.
  const show = !state.timeline.showImageDetails;
  setTimelineImageDetails(state.timeline, show);
  try {
    saveConfig({ images: { details: show } });
  } catch (error) {
    debugLog("images.details_save_failed", { error: error instanceof Error ? error.message : String(error) });
  }
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
  markScrollIntent(state);
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
  // A copied file keeps its own name; pasted image data gets a numbered one.
  const filename = image.filename ?? `image-${index}.${imageExtension(image.mediaType)}`;
  state.pendingImages.push({ ...image, filename });
  setNotice(state, "", "muted");
  focusPrompt(state);
  scheduleRender();
}

function pasteImageFromClipboard(): void {
  const images = readClipboardImages((message) => {
    setNotice(state, message, "warning");
    scheduleRender();
  });
  for (const image of images) attachClipboardImage(image);
}

function showClipboardImageError(message: string): void {
  setNotice(state, message, "warning");
  scheduleRender();
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
  if (isInstagramChannelId(message.channelId) && message.localStatus && message.localStatus !== "pending") {
    // A failed/unconfirmed send is only local: discard it (never resent automatically).
    state.messageDeletePending = null;
    instagramController.discardLocalMessage(message.id);
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
  // The replaced draft stays one `u` away.
  replaceEditorText(state.editor, replaceCustomEmojiTokens(message.content));
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
    case "toggle_image_details":
      toggleImageDetails();
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

function downloadAndOpenAttachment(attachment: DiscordMessageAttachment): void {
  setNotice(state, `Downloading ${attachment.filename}…`, "muted", { loading: true, chat: false });
  scheduleRender();
  void (async () => {
    const progress: AttachmentDownloadOptions = {
      onProgress: (progress) => {
        if (!running) return;
        showAttachmentDownloadProgress(attachment.filename, progress);
      },
    };
    const downloaded = isWhatsAppChannelId(state.timeline.channelId)
      ? await whatsAppController.downloadAttachment(attachment)
      : isInstagramChannelId(state.timeline.channelId)
        // Shared reels resolve to their one video here, never Instagram's reel feed.
        ? await instagramController.downloadAttachment(attachment, progress)
        : await downloadAttachment(attachment, progress);
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
}

/**
 * Open a link or configured path from history with the configured openers.
 * A Discord invite joins only from the keyboard (`joinInvites`); a click
 * just says how, so a stray click never joins a server.
 */
function openHistoryLink(target: string, joinInvites: boolean): void {
  const inviteCode = discordInviteCodeFromUrl(target);
  if (inviteCode) {
    if (joinInvites) joinDiscordInviteTarget(target, inviteCode);
    else showTransientNotice(`Press Enter on the invite to join ${inviteCode}.`);
    return;
  }
  if (shouldDownloadTargetBeforeOpen(target)) {
    downloadAndOpenTarget(target);
    return;
  }
  if (!openTargetDetached(target)) {
    setNotice(state, `No opener configured for ${target}.`, "warning");
    scheduleRender();
  } else {
    showTransientNotice(`Opening ${target}…`);
  }
}

/** A video embed plays like a video attachment (a media file) or opens its page (YouTube, Tenor). */
function openEmbedVideo(target: EmbedVideoTarget): void {
  if (target.kind === "file") downloadAndOpenAttachment(target.attachment);
  else openHistoryLink(target.url, false);
}

/** A click in history: open the image, attachment or link under the cursor. Returns whether one was there. */
function openHistoryTargetAtCursor(): boolean {
  const video = embedVideoAtHistoryCursor(state);
  if (video) {
    openEmbedVideo(video);
    return true;
  }
  const imageBodyAttachment = inlineImageBodyAttachmentAtHistoryCursor(state);
  if (imageBodyAttachment) {
    openInlineImageModal(imageBodyAttachment);
    return true;
  }
  const attachment = attachmentAtHistoryCursor(state);
  if (attachment) {
    if (!toggleInlineAttachmentImage(attachment)) downloadAndOpenAttachment(attachment);
    return true;
  }
  const target = openableTargetAtHistoryCursor(state);
  if (!target) return false;
  openHistoryLink(target, false);
  return true;
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
      const video = embedVideoAtHistoryCursor(state);
      if (video) {
        openEmbedVideo(video);
        return true;
      }
      const imageBodyAttachment = inlineImageBodyAttachmentAtHistoryCursor(state);
      if (imageBodyAttachment && openInlineImageModal(imageBodyAttachment)) return true;

      const attachment = attachmentAtHistoryCursor(state);
      if (attachment && toggleInlineAttachmentImage(attachment)) return true;

      if (returnToPinnedMessageInChannelHistory()) return true;
      if (focusThreadAtHistoryCursor()) return true;
      if (jumpToReplyTargetAtHistoryCursor()) return true;
      if (jumpToForwardedOriginAtHistoryCursor()) return true;

      if (attachment) {
        downloadAndOpenAttachment(attachment);
        return true;
      }

      const target = openableTargetAtHistoryCursor(state);
      if (target) openHistoryLink(target, true);
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

  // Tab cycles autocomplete or completes a path; otherwise the editor inserts
  // a four-space soft tab in insert mode.
  if (key.type === "tab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, 1);
      scheduleRender();
      return;
    }
    if (tryPathComplete(state)) {
      scheduleRender();
      return;
    }
  }

  if (key.type === "backtab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, -1);
    }
    scheduleRender();
    return;
  }

  if (handleAutocompleteArrow(state, key)) {
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
    markScrollIntent(state);
    state.timeline.scrollOffset = 0;
    maybeLoadOlderHistory();
    scheduleRender();
    return;
  }

  if (action === "scroll_bottom") {
    markScrollIntent(state);
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
  // Whatever this key re-lays out (a send, a toggle) snaps; scroll keys mark
  // their own intent, which still glides.
  markRelayout(state);
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
  if (event.action !== "motion") markRelayout(state);
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

  if (result.type === "focus_prompt") {
    if (state.panelFocus !== "chat" || state.chatFocus !== "prompt" || state.editor.mode !== "insert") {
      focusPromptInsert(false);
    }
    return;
  }

  if (result.type === "history_press") {
    if (state.chatFocus !== "history" || state.panelFocus !== "chat") focusHistory(state);
    const position = { ...state.historyCursor, row: result.row, col: result.col };
    state.historyCursor = position;
    state.historyVisualAnchor = { ...position };
    state.editor.mode = "visual";
    syncPromptAutocomplete();
    scheduleRender();
    return;
  }

  if (result.type === "history_drag") {
    if (state.chatFocus === "history" && state.editor.mode === "visual") {
      state.historyCursor = { ...state.historyCursor, row: result.row, col: result.col };
      ensureHistoryCursorVisible(state, timelinePageSize());
      scheduleRender();
    }
    return;
  }

  if (result.type === "history_click") {
    // A click (no drag) is no selection: back to normal mode on the clicked character.
    state.editor.mode = "normal";
    state.historyCursor = { ...state.historyCursor, row: result.row, col: result.col };
    openHistoryTargetAtCursor();
    scheduleRender();
    return;
  }

  if (result.type === "history_release") {
    if (state.chatFocus === "history" && state.editor.mode === "visual") {
      if (result.position) state.historyCursor = { ...state.historyCursor, ...result.position };
      // A press and release on the same character without a drag selects nothing.
      if (state.historyCursor.row === state.historyVisualAnchor.row
        && state.historyCursor.col === state.historyVisualAnchor.col) state.editor.mode = "normal";
      // Otherwise the selection stays, for y (or Esc), like keyboard visual mode.
    }
    scheduleRender();
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
      // Region scrolls beside the side panels need synchronized updates
      // (mode 2026) confirmed; app-driven smooth scrolling (st mode 2032)
      // needs region scrolls. RECORD_SMOOTH_SCROLL=off skips the latter
      // (testing the plain region scrolls in st).
      + (state.scrollRegions ? SYNCHRONIZED_UPDATES_QUERY : "")
      + (state.scrollRegions && smoothScrollAllowed ? SMOOTH_SCROLL_QUERY : "")
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
  terminalReady = false;
  // Once the terminal window is closed (SIGHUP) the tty is gone and these
  // throw EIO; that must not abort the rest of shutdown.
  bestEffort("terminal.raw_mode", () => process.stdin.setRawMode(false));
  bestEffort("terminal.images", () => disposeInlineTerminalImages(state));
  bestEffort("terminal.sidebar_icons", () => disposeInlineTerminalImages(sidebarIconTerminalOwner));
  bestEffort("terminal.restore", () => process.stdout.write(
    (smoothScrollerFor(state) ? SMOOTH_SCROLL_OFF : "")
      + (terminalGraphicsClient?.isSupported() ? customEmojiImages.cleanupSequence() : "")
      + (terminalGraphicsCells ? setStGraphicsCells(false) : "")
      + disableMouse
      + disableKittyKeyboard
      + disableClipboardPasteEvents
      + disableBracketedPaste
      + showCursor
      + resetCursorColor
      + leaveAlt,
  ));
  terminalGraphicsCells = false;
}

/** Run one shutdown step; a failing step is logged and the next one still runs. */
function bestEffort(step: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    debugLog("shutdown.step_failed", { step, error: error instanceof Error ? error.message : String(error) });
  }
}

function settleShutdown(step: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    return run().catch((error) => {
      debugLog("shutdown.step_failed", { step, error: error instanceof Error ? error.message : String(error) });
    });
  } catch (error) {
    debugLog("shutdown.step_failed", { step, error: error instanceof Error ? error.message : String(error) });
    return Promise.resolve();
  }
}

function cleanup(reason: string = "quit"): void {
  if (!running) return;
  running = false;
  debugLog("shutdown.start", { reason });
  bestEffort("starting_state", persistStartingStateOnce);
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  if (smoothScrollTimer) {
    clearTimeout(smoothScrollTimer);
    smoothScrollTimer = null;
  }
  bestEffort("loading_animation", stopLoadingAnimation);
  bestEffort("voice_message", () => voiceMessageController?.cleanup());
  bestEffort("terminal.control_buffer", () => terminalControlBuffer?.dispose());
  terminalControlBuffer = null;
  bestEffort("terminal.clipboard", () => terminalClipboardClient?.dispose());
  terminalClipboardClient = null;
  bestEffort("terminal.graphics", () => terminalGraphicsClient?.dispose());
  bestEffort("member_list_gateway", disconnectMemberListGateway);
  bestEffort("app_gateway", disconnectAppGateway);
  bestEffort("data_cache", flushDataCacheSync);
  restoreTerminal();
  // Allow WhatsApp's bounded send drain and final durable cache flush to finish.
  const forceExit = setTimeout(() => process.exit(0), 5_000);
  void Promise.allSettled([
    settleShutdown("whatsapp", () => whatsAppController.shutdown()),
    settleShutdown("instagram", () => instagramController.shutdown()),
  ]).finally(() => {
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
  quit: () => cleanup("quit"),
  applyThemeCursor,
  bootstrapSession,
  loginWhatsApp,
  loginInstagram: (login) => { void instagramController.login(login); },
  logoutInstagram: () => { void instagramController.logout(); },
  sendInstagramMessage: (content) => instagramController.sendMessage(content),
  refreshInstagram: () => { void instagramController.refresh(); },
  logoutWhatsApp,
  sendWhatsAppMessage: (content) => whatsAppController.sendMessage(content),
  reactWhatsAppMessage: (message, emoji) => whatsAppController.reactToMessage(message, emoji),
  reactInstagramMessage: (message, emoji, remove) => instagramController.reactToMessage(message, emoji, remove),
  acceptInstagramRequest: () => { void instagramController.acceptActiveRequest(); },
  startInstagramDirectMessage: (username) => { void instagramController.startDirectMessage(username); },
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
    onImageError: showClipboardImageError,
  });
  customEmojiImages.configure({
    onUpdate: () => {
      if (!running) return;
      scheduleRender();
    },
  });
  sidebarIcons.configure({
    onUpdate: () => {
      if (!running) return;
      scheduleRender();
    },
    // WhatsApp chat pictures need one profile-picture query per shown chat.
    resolvers: { whatsapp: (source) => whatsAppController.profilePictureUrl(source.ref ?? "") },
  });
  terminalGraphicsClient = new TerminalGraphicsClient({
    write: (sequence) => process.stdout.write(sequence),
    onSupportChanged: (supported) => {
      customEmojiImages.setEnabled(supported);
      sidebarIcons.setEnabled(supported);
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
      const synchronized = parseSynchronizedUpdatesReport(sequence);
      if (synchronized !== null) {
        if (synchronized && state.scrollRegions && !state.synchronizedUpdates) {
          state.synchronizedUpdates = true;
          invalidateFrame(state);
          scheduleRender();
        }
        return;
      }
      const smoothSupported = parseSmoothScrollReport(sequence);
      if (smoothSupported !== null) {
        if (smoothSupported && state.scrollRegions && smoothScrollAllowed && !smoothScrollerFor(state)) {
          process.stdout.write(SMOOTH_SCROLL_ON);
          setSmoothScroller(state, new SmoothScroller());
          invalidateFrame(state);
          renderImmediately();
        }
        return;
      }
      const cellSize = parseTerminalCellSize(sequence);
      if (cellSize) {
        if (setTimelineTerminalCellSize(state.timeline, cellSize.width, cellSize.height)) scheduleRender();
        return;
      }
      // Inline-image eviction replies are a narrow subset of Kitty graphics
      // controls. Route them before the custom-emoji capability client, which
      // intentionally consumes every remaining Kitty graphics response.
      const rejectedImageId = terminalImageNotFoundId(sequence);
      if (rejectedImageId !== null && sidebarIcons.noteTerminalRejection(rejectedImageId)) {
        handleInlineTerminalImageResponse(sidebarIconTerminalOwner, sequence);
        scheduleRender();
        return;
      }
      if (handleInlineTerminalImageResponse(state, sequence)) {
        scheduleRender();
        return;
      }
      if (terminalGraphicsClient?.handleControlSequence(sequence)) return;
      terminalClipboardClient?.handleControlSequence(sequence);
    },
  );
  process.stdin.on("data", (data: Buffer) => terminalControlBuffer?.feed(data));
  // Closing the terminal window makes the tty read fail with EIO (often before
  // SIGHUP arrives). Unhandled, that error crashed Record past its shutdown.
  process.stdin.on("error", (error) => {
    debugLog("terminal.stdin_error", { error: error.message });
    cleanup("terminal_closed");
  });
  process.stdin.on("end", () => cleanup("terminal_closed"));
  process.stdout.on("error", (error) => {
    debugLog("terminal.stdout_error", { error: error.message });
    cleanup("terminal_closed");
  });
  terminalGraphicsClient.query();

  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    invalidateFrame(state);
    // st drops the glide's offset, rectangles and kept lines on resize.
    smoothScrollerFor(state)?.terminalReset();
    markRelayout(state);
    if (terminalReady) process.stdout.write(queryTerminalCellSize());
    scheduleRender();
  });

  if (initialToken) {
    // Enter the authenticating state before the first frame so startup never
    // briefly renders the logged-out instructions for a saved login.
    void validateAndMaybeSave(state, initialToken, false, "Validating saved token…", effects);
  }

  renderFrame();

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

// Every way out ends here, including a second signal during the shutdown
// drain and crashes: never leave the terminal raw or helper processes running.
process.on("exit", (code) => {
  debugLog("shutdown.exit", { code, childrenRunning: trackedChildProcessCount() });
  bestEffort("starting_state", persistStartingStateOnce);
  restoreTerminal();
  bestEffort("data_cache", flushDataCacheSync);
  killTrackedChildProcesses("SIGTERM");
});
process.on("SIGINT", () => cleanup("SIGINT"));
process.on("SIGTERM", () => cleanup("SIGTERM"));
process.on("SIGHUP", () => cleanup("SIGHUP"));
process.on("uncaughtException", (error) => {
  debugLog("process.uncaught_exception", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  running = false;
  restoreTerminal();
  bestEffort("fatal.report", () => console.error(`Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exit(1);
});
// A background task that forgot a .catch must not take the whole client down.
process.on("unhandledRejection", (reason) => {
  debugLog("process.unhandled_rejection", { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});

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
