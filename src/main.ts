/**
 * record — Discord terminal client bootstrap.
 */

import { submitCurrentBuffer, validateAndMaybeSave, type AppEffects } from "./actions";
import { flushDataCacheSync } from "./datacache";
import { configPath, loadConfig, loadSavedLogins } from "./config";
import { acceptAutocomplete, cycleAutocomplete, dismissAutocomplete, updateAutocomplete } from "./autocomplete";
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
  placeHistoryCursorAtVisibleBottom,
  scrollHistoryPageWithCursor,
  scrollHistoryViewportSticky,
  scrollHistoryWithCursor,
} from "./historycursor";
import { setChannelList } from "./channels";
import { imageExtension, readClipboardImage } from "./imageclipboard";
import { attachmentAtHistoryCursor, openableTargetAtHistoryCursor } from "./historyopenable";
import { parseInput, PasteBuffer, type KeyEvent } from "./input";
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
import { formatByteSize, summarizeInlineMessageParts } from "./messageparts";
import { channelNotificationCounts, guildNotificationCounts } from "./notifications";
import { render } from "./render";
import {
  ackCurrentChannelIfAtBottom,
  bootstrapReadOnlyClient,
  currentAppGatewaySessionId,
  disconnectAppGateway,
  disconnectMemberListGateway,
  deleteMessage,
  loadChannelMessages,
  loadGuildChannels,
  loadOlderChannelMessages,
  moveSelectedGuildOrder,
  persistSidebarFolders,
  syncMemberListForCurrentChannel,
  toggleSelectedGuildMute,
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
  scrollSidebarSelection,
  scrollSidebarSelectionLine,
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
  disableKittyKeyboard,
  enterAlt,
  enableBracketedPaste,
  enableKittyKeyboard,
  hideCursor,
  leaveAlt,
  resetCursorColor,
  setCursorColor,
  showCursor,
} from "./terminal";
import { dmAuthorColor, theme } from "./theme";
import { hasActiveTimelineCall, moveTimelineScroll, shouldLoadOlderMessages, startLoadingOlderMessages } from "./timeline";
import { acceptDiscordInvite, DiscordCaptchaRequiredError, discordInviteCodeFromUrl, DIRECT_MESSAGES_GUILD_ID, type DiscordInviteJoinResult, type DiscordMessage } from "./discord";
import { debugLog } from "./debuglog";
import { pruneTypingState } from "./typing";
import { normalizeToken } from "./token";
import { downloadAttachment, openTargetDetached, type AttachmentDownloadProgress } from "./openable";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("record needs an interactive TTY.");
  process.exit(1);
}

let initialToken: string | null = null;
let initialShowHiddenChannels = false;
let initialSavedLogins: Record<string, string> = {};
const startupWarnings: string[] = [];

try {
  const config = loadConfig();
  initialToken = config.token ? normalizeToken(config.token) : null;
  initialShowHiddenChannels = config.channels?.showHidden === true;
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

const state = createInitialState(initialToken, configPath(), initialSavedLogins, { showHiddenChannels: initialShowHiddenChannels });
if (startupWarnings.length > 0) {
  setNotice(state, startupWarnings.join("\n"), "warning");
}

const LOADING_INTERVAL_MS = 80;
const OPEN_NOTICE_MS = 1200;

let running = true;
let terminalReady = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let loadingTimer: ReturnType<typeof setInterval> | null = null;

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
    || state.memberList.loading
    || state.channelList.loading
    || state.timeline.loading
    || state.timeline.loadingOlder
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
  syncLoadingAnimation();
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render(state);
  }, 16);
}

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
  void bootstrapReadOnlyClient(state, token, { scheduleRender });
}

function isPromptTyping(): boolean {
  return state.panelFocus === "chat" && state.chatFocus === "prompt" && state.editor.mode === "insert";
}

function syncPromptAutocomplete(): void {
  if (isPromptTyping()) {
    updateAutocomplete(state);
  } else {
    state.autocomplete = null;
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
  const maxInputWidth = Math.max(1, mainW - PROMPT_PREFIX_WIDTH);
  const input = getInputLines(
    state.editor.buffer,
    displayCursor(state.editor),
    maxInputWidth,
    Math.max(1, Math.min(MAX_PROMPT_ROWS, state.rows - 3 - bottomStatusRows)),
    state.editor.scroll,
  );
  const promptSeparatorRow = Math.max(3, state.rows - Math.max(1, input.lines.length) - bottomStatusRows);
  return Math.max(1, promptSeparatorRow - 3);
}

function maybeLoadOlderHistory(): void {
  const token = state.auth.savedToken;
  const channelId = state.timeline.channelId;
  if (!token || !channelId || !shouldLoadOlderMessages(state.timeline)) return;

  startLoadingOlderMessages(state.timeline);
  scheduleRender();
  void loadOlderChannelMessages(state, token, channelId, timelineContentWidth(), { scheduleRender });
}

function scrollTimeline(delta: number): void {
  moveTimelineScroll(state.timeline, delta);
  if (delta <= 0) {
    maybeLoadOlderHistory();
  }
  ackCurrentChannelIfAtBottom(state);
  scheduleRender();
}

function sidebarVisibilityOptions(): { showHiddenChannels: boolean } {
  return { showHiddenChannels: state.showHiddenChannels };
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

function summarizeReplyMessage(message: DiscordMessage): string {
  if (message.call || message.type === 3) return "☎ Call";
  return summarizeInlineMessageParts(
    message.content,
    message.attachments,
    message.embeds ?? message.embedsCount,
    message.stickerNames,
  ).slice(0, 160);
}

function pasteImageFromClipboard(): void {
  const image = readClipboardImage();
  if (!image) return;

  const index = state.pendingImages.length + 1;
  const filename = `image-${index}.${imageExtension(image.mediaType)}`;
  state.pendingImages.push({ ...image, filename });
  setNotice(state, "", "muted");
  focusPrompt(state);
  scheduleRender();
}

function removeLastPendingImage(): boolean {
  if (state.editor.cursor !== 0 || state.pendingImages.length === 0) return false;
  state.pendingImages.pop();
  setNotice(state, "", "muted");
  scheduleRender();
  return true;
}

function cancelCurrentAction(): void {
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
  if (state.channelList.activeChannel?.guildId !== DIRECT_MESSAGES_GUILD_ID) return "";
  return message.author.id === state.auth.user?.id ? theme.accent : dmAuthorColor(message.author.id);
}

function selectedMessageCanBeEdited(message: DiscordMessage | null): message is DiscordMessage {
  if (!message) return false;
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
  resetEditor(state.editor, message.content, "insert");
  focusPrompt(state);
  syncPromptAutocomplete();
  scheduleRender();
}

function startReplyToSelectedHistoryMessage(mention = false): void {
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
      jumpToNotification(1);
      return true;
    case "paste_image":
      pasteImageFromClipboard();
      return true;
    case "reply_toggle":
      startReplyToSelectedHistoryMessage(false);
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
    state.navigationPendingKeys = "";
    state.sidebar.visualAnchor = null;
    state.sidebar.pendingDeleteItem = null;
    scheduleRender();
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
  if (!navigation.action) return navigation.handled;

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
      toggleSelectedGuildMute(state, { scheduleRender });
      return true;
    case "nav_move_guild_up":
      moveSelectedGuildOrder(state, { scheduleRender }, "up");
      return true;
    case "nav_move_guild_down":
      moveSelectedGuildOrder(state, { scheduleRender }, "down");
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
    case "nav_select": {
      const selectedBefore = getSelectedSidebarEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
      if (selectedBefore.kind === "folder" || selectedBefore.kind === "up") {
        activateSelectedEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions());
        scheduleRender();
        return true;
      }

      const token = tokenOrWarn();
      if (!token) return true;

      const entry = activateSelectedEntry(state.sidebar, state.channelList.channels, sidebarVisibilityOptions()) ?? selectedBefore;

      if (entry.kind === "guild") {
        if (state.sidebar.expandedGuildId === entry.guildId) {
          void loadGuildChannels(state, token, entry.guildId, { scheduleRender }, { openFirstChannel: false });
        } else {
          scheduleRender();
        }
        return true;
      }

      if (entry.kind === "channel") {
        ensureSidebarEntryGuildLoaded(entry.guildId);
        void loadChannelMessages(state, token, entry.id, { scheduleRender });
        return true;
      }

      scheduleRender();
      return true;
    }
    default:
      return false;
  }
}

function handleHistoryFocused(key: KeyEvent): boolean {
  if (state.editor.mode === "normal" && key.type === "char" && key.char === "d") {
    deleteSelectedHistoryMessage();
    return true;
  }

  const clearedPendingDelete = clearPendingMessageDelete();

  if (state.editor.mode === "normal" && key.type === "char" && (key.char === "r" || key.char === "R")) {
    startReplyToSelectedHistoryMessage(key.char === "R");
    return true;
  }

  if (state.editor.mode === "normal" && key.type === "char" && key.char === "e" && selectedMessageCanBeEdited(selectedHistoryMessage())) {
    startEditSelectedHistoryMessage();
    return true;
  }

  if (handleHistoryVimKey(state, key, timelinePageSize())) {
    if (state.chatFocus === "history") maybeLoadOlderHistory();
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
      scheduleRender();
      return true;
    case "nav_select": {
      const attachment = attachmentAtHistoryCursor(state);
      if (attachment) {
        setNotice(state, `Downloading ${attachment.filename}…`, "muted", { loading: true, chat: false });
        scheduleRender();
        void (async () => {
          const downloaded = await downloadAttachment(attachment, {
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
  if (key.type === "backspace" && removeLastPendingImage()) return;

  if (key.type === "tab" && state.autocomplete) {
    cycleAutocomplete(state, 1);
    scheduleRender();
    return;
  }

  if (key.type === "backtab" && state.autocomplete) {
    cycleAutocomplete(state, -1);
    scheduleRender();
    return;
  }

  if (key.type === "escape" && state.autocomplete) {
    acceptAutocomplete(state);
  }

  const previousBuffer = state.editor.buffer;
  const previousCursor = state.editor.cursor;
  const previousMode = state.editor.mode;
  const action = handleEditorKey(state.editor, key);

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
    ackCurrentChannelIfAtBottom(state);
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

function setupTerminal(): void {
  process.stdout.write(
    enterAlt
      + hideCursor
      + enableBracketedPaste
      + enableKittyKeyboard
      + (theme.cursorColor ? setCursorColor(theme.cursorColor) : ""),
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalReady = true;
}

function restoreTerminal(): void {
  if (!terminalReady) return;
  process.stdin.setRawMode(false);
  process.stdout.write(
    disableKittyKeyboard
      + disableBracketedPaste
      + showCursor
      + resetCursorColor
      + leaveAlt,
  );
  terminalReady = false;
}

function cleanup(): void {
  if (!running) return;
  running = false;
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  stopLoadingAnimation();
  disconnectMemberListGateway();
  disconnectAppGateway();
  flushDataCacheSync();
  restoreTerminal();
  process.exit(0);
}

const effects: AppEffects = {
  scheduleRender,
  quit: cleanup,
  applyThemeCursor,
  bootstrapSession,
};

async function main(): Promise<void> {
  setupTerminal();

  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    scheduleRender();
  });

  render(state);

  if (initialToken) {
    void validateAndMaybeSave(state, initialToken, false, "Validating saved token…", effects);
  }

  const pasteBuffer = new PasteBuffer(processInput);

  process.stdin.on("data", (data: Buffer) => {
    const ready = pasteBuffer.feed(data);
    if (ready !== null) processInput(ready);
  });
}

function processInput(input: string): void {
  if (!running) return;

  const events = parseInput(input);
  for (const event of events) {
    handleKey(event);
    if (!running) break;
  }
}

process.on("exit", restoreTerminal);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

main().catch((error) => {
  flushDataCacheSync();
  restoreTerminal();
  console.error(`Fatal: ${(error as Error).message}`);
  process.exit(1);
});
