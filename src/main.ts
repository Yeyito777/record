/**
 * record — Discord terminal client bootstrap.
 *
 * Current scope is intentionally tiny: token auth only.
 */

import { validateAndMaybeSave, submitCurrentBuffer, type AppEffects } from "./actions";
import { configPath, loadConfig } from "./config";
import { cycleAutocomplete, dismissAutocomplete, updateAutocomplete } from "./autocomplete";
import { handleEditorKey } from "./editor";
import { parseInput, PasteBuffer, type KeyEvent } from "./input";
import { resolveAction } from "./keybinds";
import { render } from "./render";
import { createInitialState, setNotice } from "./state";
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
import { normalizeToken } from "./token";
import { theme } from "./theme";

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

let running = true;
let terminalReady = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRender(): void {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render(state);
  }, 16);
}

function applyThemeCursor(): void {
  if (theme.cursorColor) process.stdout.write(setCursorColor(theme.cursorColor));
}

function handleKey(key: KeyEvent): void {
  const globalAction = resolveAction(key);
  if (globalAction === "sidebar_toggle") {
    state.sidebar.open = !state.sidebar.open;
    scheduleRender();
    return;
  }
  if (globalAction === "quit") {
    cleanup();
    return;
  }

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

  if (
    previousBuffer !== state.editor.buffer
    || previousCursor !== state.editor.cursor
    || previousMode !== state.editor.mode
  ) {
    updateAutocomplete(state);
  }

  scheduleRender();
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
  restoreTerminal();
  process.exit(0);
}

const effects: AppEffects = {
  scheduleRender,
  quit: cleanup,
  applyThemeCursor,
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
