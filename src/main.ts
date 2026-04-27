/**
 * record — Discord terminal client bootstrap.
 */

import { submitCurrentBuffer, validateAndMaybeSave, type AppEffects } from "./actions";
import { configPath, loadConfig, loadSavedLogins } from "./config";
import { cycleAutocomplete, dismissAutocomplete, updateAutocomplete } from "./autocomplete";
import { LOADING_FRAMES } from "./loading";
import {
  displayCursor,
  getInputLines,
  handleEditorKey,
  MAX_PROMPT_ROWS,
  PROMPT_PREFIX_WIDTH,
} from "./editor";
import {
  ensureHistoryCursorVisible,
  handleHistoryVimKey,
  placeHistoryCursorAtVisibleBottom,
  scrollHistoryViewportSticky,
  scrollHistoryWithCursor,
} from "./historycursor";
import { imageExtension, readClipboardImage } from "./imageclipboard";
import { parseInput, PasteBuffer, type KeyEvent } from "./input";
import { resolveAction } from "./keybinds";
import { MEMBER_LIST_WIDTH, moveMemberListSelection } from "./memberlist";
import { channelNotificationCounts, guildNotificationCounts } from "./notifications";
import { render } from "./render";
import {
  ackCurrentChannelIfAtBottom,
  bootstrapReadOnlyClient,
  disconnectAppGateway,
  disconnectMemberListGateway,
  loadChannelMessages,
  loadGuildChannels,
  loadOlderChannelMessages,
  moveSelectedGuildOrder,
  syncMemberListForCurrentChannel,
  toggleSelectedGuildMute,
} from "./session";
import { renderStatusLine } from "./statusline";
import {
  activateSelectedEntry,
  getSelectedSidebarEntry,
  moveSidebarSelection,
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
import { DIRECT_MESSAGES_GUILD_ID, type DiscordMessage } from "./discord";
import { pruneTypingState } from "./typing";
import { normalizeToken } from "./token";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("record needs an interactive TTY.");
  process.exit(1);
}

let initialToken: string | null = null;
let initialSavedLogins: Record<string, string> = {};
const startupWarnings: string[] = [];

try {
  const config = loadConfig();
  initialToken = config.token ? normalizeToken(config.token) : null;
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

const state = createInitialState(initialToken, configPath(), initialSavedLogins);
if (startupWarnings.length > 0) {
  setNotice(state, startupWarnings.join("\n"), "warning");
}

const LOADING_INTERVAL_MS = 80;

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

function scrollFocusedPanel(delta: number, visibleRows: number): void {
  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    moveSidebarSelection(state.sidebar, state.channelList.channels, delta);
    scheduleRender();
    return;
  }

  if (state.panelFocus === "memberlist" && state.memberList.open) {
    moveMemberListSelection(state.memberList, delta);
    scheduleRender();
    return;
  }

  if (state.chatFocus === "history") {
    scrollHistoryWithCursor(state, delta < 0 ? 1 : -1, Math.abs(delta), visibleRows);
    if (delta <= 0) maybeLoadOlderHistory();
    scheduleRender();
    return;
  }

  scrollTimeline(delta);
}

function scrollFocusedPanelLine(delta: number): void {
  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    moveSidebarSelection(state.sidebar, state.channelList.channels, delta);
    scheduleRender();
    return;
  }

  if (state.panelFocus === "memberlist" && state.memberList.open) {
    moveMemberListSelection(state.memberList, delta);
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
    moveSidebarSelectionToPrevAnyNotification(state.sidebar, state.channelList.channels, channelCounts, guildCounts);
  } else {
    moveSidebarSelectionToNextAnyNotification(state.sidebar, state.channelList.channels, channelCounts, guildCounts);
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
  const content = message.content.replace(/\s+/g, " ").trim();
  if (content) return content.slice(0, 160);
  if (message.attachments.length > 0) return `[attachments] ${message.attachments.map((attachment) => attachment.filename).join(", ")}`.slice(0, 160);
  if (message.stickerNames.length > 0) return `[stickers] ${message.stickerNames.join(", ")}`.slice(0, 160);
  if (message.embedsCount > 0) return `[embeds] ${message.embedsCount}`;
  if (message.call || message.type === 3) return "☎ Call";
  return "(empty message)";
}

function pasteImageFromClipboard(): void {
  const image = readClipboardImage();
  if (!image) {
    setNotice(state, "No image found in clipboard.", "warning");
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

function removeLastPendingImage(): boolean {
  if (state.editor.cursor !== 0 || state.pendingImages.length === 0) return false;
  state.pendingImages.pop();
  setNotice(state, "", "muted");
  scheduleRender();
  return true;
}

function cancelCurrentAction(): void {
  if (state.pendingImages.length > 0) {
    state.pendingImages = [];
    setNotice(state, "Image attachments cleared.", "muted");
    scheduleRender();
    return;
  }

  if (state.replyTarget) {
    state.replyTarget = null;
    setNotice(state, "Reply cancelled.", "muted");
    scheduleRender();
    return;
  }

  if (state.autocomplete) {
    dismissAutocomplete(state);
    scheduleRender();
    return;
  }

  setNotice(state, "No active action to cancel.", "muted");
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
    timestamp: message.timestamp,
    mention: mention && message.author.id !== state.auth.user?.id,
  };
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
      scrollFocusedPanel(-timelinePageSize(), timelinePageSize());
      return true;
    case "scroll_page_down":
      scrollFocusedPanel(timelinePageSize(), timelinePageSize());
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
      moveSidebarSelection(state.sidebar, state.channelList.channels, action === "sidebar_next" ? 1 : -1);
      syncPromptAutocomplete();
      scheduleRender();
      return true;
    }
    default:
      return false;
  }
}

function handleSidebarFocused(key: KeyEvent): boolean {
  const action = resolveAction(key, "navigation");
  if (!action) return false;

  switch (action) {
    case "focus_prompt":
      focusPromptInsert(key.type === "char" && key.char === "a");
      return true;
    case "nav_up":
      moveSidebarSelection(state.sidebar, state.channelList.channels, -1);
      scheduleRender();
      return true;
    case "nav_down":
      moveSidebarSelection(state.sidebar, state.channelList.channels, 1);
      scheduleRender();
      return true;
    case "nav_prev_server":
      moveSidebarSelectionToPrevGuild(state.sidebar, state.channelList.channels);
      scheduleRender();
      return true;
    case "nav_next_server":
      moveSidebarSelectionToNextGuild(state.sidebar, state.channelList.channels);
      scheduleRender();
      return true;
    case "nav_prev_category":
      if (state.sidebar.expandedGuildId === DIRECT_MESSAGES_GUILD_ID) {
        moveSidebarSelectionToPrevDirectMessage(state.sidebar, state.channelList.channels);
      } else {
        moveSidebarSelectionToPrevCategory(state.sidebar, state.channelList.channels);
      }
      scheduleRender();
      return true;
    case "nav_next_category":
      if (state.sidebar.expandedGuildId === DIRECT_MESSAGES_GUILD_ID) {
        moveSidebarSelectionToNextDirectMessage(state.sidebar, state.channelList.channels);
      } else {
        moveSidebarSelectionToNextCategory(state.sidebar, state.channelList.channels);
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
    case "nav_select": {
      const token = tokenOrWarn();
      if (!token) return true;

      const selectedBefore = getSelectedSidebarEntry(state.sidebar, state.channelList.channels);
      const entry = activateSelectedEntry(state.sidebar, state.channelList.channels) ?? selectedBefore;

      if (entry.kind === "guild") {
        if (state.sidebar.expandedGuildId === entry.guildId) {
          void loadGuildChannels(state, token, entry.guildId, { scheduleRender }, { openFirstChannel: false });
        } else {
          scheduleRender();
        }
        return true;
      }

      if (entry.kind === "channel") {
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
  if (state.editor.mode === "normal" && key.type === "char" && (key.char === "r" || key.char === "R")) {
    startReplyToSelectedHistoryMessage(key.char === "R");
    return true;
  }

  if (handleHistoryVimKey(state, key, timelinePageSize())) {
    if (state.chatFocus === "history") maybeLoadOlderHistory();
    scheduleRender();
    return true;
  }

  const action = resolveAction(key, "navigation");
  if (!action) return false;

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
    default:
      return false;
  }
}

function handleMemberListFocused(key: KeyEvent): boolean {
  const action = resolveAction(key, "navigation");
  if (!action) return false;

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
    dismissAutocomplete(state);
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
  restoreTerminal();
  console.error(`Fatal: ${(error as Error).message}`);
  process.exit(1);
});
