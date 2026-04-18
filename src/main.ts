/**
 * record — Discord terminal client bootstrap.
 */

import { submitCurrentBuffer, validateAndMaybeSave, type AppEffects } from "./actions";
import { configPath, loadConfig } from "./config";
import { cycleAutocomplete, dismissAutocomplete, updateAutocomplete } from "./autocomplete";
import { LOADING_FRAMES } from "./loading";
import {
  displayCursor,
  getInputLines,
  handleEditorKey,
  MAX_PROMPT_ROWS,
  PROMPT_PREFIX_WIDTH,
} from "./editor";
import { parseInput, PasteBuffer, type KeyEvent } from "./input";
import { resolveAction } from "./keybinds";
import { render } from "./render";
import { bootstrapReadOnlyClient, loadChannelMessages, loadGuildChannels } from "./session";
import {
  activateSelectedEntry,
  getSelectedSidebarEntry,
  moveSidebarSelection,
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
import { theme } from "./theme";
import { moveTimelineScroll } from "./timeline";
import { normalizeToken } from "./token";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("record needs an interactive TTY.");
  process.exit(1);
}

let initialToken: string | null = null;
let startupWarning: string | null = null;

try {
  const config = loadConfig();
  initialToken = config.token ? normalizeToken(config.token) : null;
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  if (err.code !== "ENOENT") {
    startupWarning = `Could not load config: ${err.message}`;
  }
}

const state = createInitialState(initialToken, configPath());
if (startupWarning) {
  setNotice(state, startupWarning, "warning");
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
    || state.channelList.loading
    || state.timeline.loading;
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
    setNotice(state, "Login first with /login <token>.", "warning");
    scheduleRender();
    return null;
  }
  return token;
}

function timelinePageSize(): number {
  const sidebarW = state.sidebar.open ? SIDEBAR_WIDTH : 0;
  const mainW = Math.max(1, state.cols - sidebarW);
  const maxInputWidth = Math.max(1, mainW - PROMPT_PREFIX_WIDTH);
  const input = getInputLines(
    state.editor.buffer,
    displayCursor(state.editor),
    maxInputWidth,
    Math.max(1, Math.min(MAX_PROMPT_ROWS, state.rows - 3)),
    state.editor.scroll,
  );
  const promptSeparatorRow = Math.max(3, state.rows - Math.max(1, input.lines.length));
  return Math.max(1, promptSeparatorRow - 3);
}

function scrollTimeline(delta: number): void {
  moveTimelineScroll(state.timeline, delta);
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

function toggleHistoryFocus(): void {
  if (state.panelFocus === "chat" && state.chatFocus === "history") {
    focusPrompt(state);
  } else {
    focusHistory(state);
  }

  syncPromptAutocomplete();
  scheduleRender();
}

function cyclePanelFocus(): void {
  cycleFocus(state);
  syncPromptAutocomplete();
  scheduleRender();
}

function handleGlobalAction(key: KeyEvent): boolean {
  const context = state.panelFocus === "sidebar" || state.chatFocus === "history"
    ? "navigation"
    : "prompt";
  const action = resolveAction(key, context);

  switch (action) {
    case "quit":
      cleanup();
      return true;
    case "sidebar_toggle":
      toggleSidebar();
      return true;
    case "focus_cycle":
      cyclePanelFocus();
      return true;
    case "focus_history":
      toggleHistoryFocus();
      return true;
    case "scroll_line_up":
      scrollTimeline(-1);
      return true;
    case "scroll_line_down":
      scrollTimeline(1);
      return true;
    case "scroll_half_up":
      scrollTimeline(-Math.max(1, Math.floor(timelinePageSize() / 2)));
      return true;
    case "scroll_half_down":
      scrollTimeline(Math.max(1, Math.floor(timelinePageSize() / 2)));
      return true;
    case "scroll_page_up":
      scrollTimeline(-timelinePageSize());
      return true;
    case "scroll_page_down":
      scrollTimeline(timelinePageSize());
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
  const action = resolveAction(key, "navigation");
  if (!action) return false;

  switch (action) {
    case "focus_prompt":
      focusPromptInsert(key.type === "char" && key.char === "a");
      return true;
    case "nav_up":
      moveTimelineScroll(state.timeline, -1);
      scheduleRender();
      return true;
    case "nav_down":
      moveTimelineScroll(state.timeline, 1);
      scheduleRender();
      return true;
    default:
      return false;
  }
}

function handlePromptFocused(key: KeyEvent): void {
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
    scheduleRender();
    return;
  }

  if (action === "scroll_bottom") {
    state.timeline.scrollOffset = state.timeline.maxScroll;
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
