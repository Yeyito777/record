/** Mouse routing for Record's server sidebar, modeled after Exocortex TUI. */

import type { MouseEvent } from "./input";
import {
  focusSidebarAtMouse,
  scrollSidebarAtMouse,
  sidebarHitTest,
  SIDEBAR_WIDTH,
  type SidebarVisibilityOptions,
} from "./sidebar";
import { clampHistoryCol, stripAnsi } from "./historycursor";
import { focusSidebar, type AppState } from "./state";
import { mouseCursorHand, mouseCursorPointer, mouseCursorText } from "./terminal";
import { nextWidthClusterEnd, termWidth } from "./textwidth";

export type MouseResult =
  | { type: "handled" }
  | { type: "activate_sidebar" }
  | { type: "scroll_chat"; delta: number }
  | { type: "focus_prompt" }
  | { type: "focus_history"; row: number; col: number };

type CursorWriter = (sequence: string) => void;

const CHAT_SCROLL_LINES = 3;

function sidebarVisibilityOptions(state: AppState): SidebarVisibilityOptions {
  return {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  };
}

type ChatArea = "prompt" | "history" | null;

/** Which text area of the chat column (as last drawn) a screen cell is in. */
function chatAreaAt(state: AppState, col: number, row: number): ChatArea {
  const layout = state.chatMouseLayout;
  if (!layout || col < layout.firstCol || col > layout.lastCol) return null;
  if (row >= layout.firstInputRow && row < layout.firstInputRow + layout.inputRows) return "prompt";
  if (row >= layout.bodyTop && row < layout.bodyTop + layout.bodyRows) return "history";
  return null;
}

/** The history line and column under a screen cell, or null past the content. */
function historyPositionAt(state: AppState, col: number, row: number): { row: number; col: number } | null {
  const layout = state.chatMouseLayout;
  if (!layout) return null;
  const line = state.timeline.scrollOffset + (row - layout.bodyTop);
  if (line < 0 || line >= state.historyLines.length) return null;
  const plain = stripAnsi(state.historyLines[line] ?? "");
  const target = col - (layout.firstCol + 1);
  let offset = 0;
  let width = 0;
  while (offset < plain.length) {
    const end = nextWidthClusterEnd(plain, offset);
    const size = termWidth(plain.slice(offset, end));
    if (width + size > target) break;
    width += size;
    offset = end;
  }
  return { row: line, col: clampHistoryCol(offset, state.historyLines, line) };
}

function updateMouseCursor(ev: MouseEvent, state: AppState, writeCursor: CursorWriter): void {
  const inSidebar = state.sidebar.open && ev.col >= 1 && ev.col <= SIDEBAR_WIDTH;
  const shape = inSidebar && sidebarHitTest(
    state.sidebar,
    state.channelList.channels,
    ev.row,
    state.rows,
    sidebarVisibilityOptions(state),
  )
    ? "hand"
    : !inSidebar && chatAreaAt(state, ev.col, ev.row) ? "text" : "pointer";
  if (shape === state.mouseCursor) return;
  state.mouseCursor = shape;
  writeCursor(shape === "hand" ? mouseCursorHand : shape === "text" ? mouseCursorText : mouseCursorPointer);
}

/**
 * Apply focus-follow-mouse, hover selection, click activation, and wheel scrolling.
 * Activation is returned to main.ts because opening a channel can require network
 * and provider-specific side effects.
 */
export function handleMouseEvent(
  ev: MouseEvent,
  state: AppState,
  writeCursor: CursorWriter = (sequence) => process.stdout.write(sequence),
): MouseResult {
  updateMouseCursor(ev, state, writeCursor);

  // Do not click through full-screen or sidebar-anchored modal overlays.
  if (state.whatsapp.loginModal || state.sidebar.serverActionModal) return { type: "handled" };

  const inSidebar = state.sidebar.open && ev.col >= 1 && ev.col <= SIDEBAR_WIDTH;

  // Match Exocortex: entering the sidebar focuses it; leaving returns panel focus
  // to chat without forcing insert mode or changing prompt/history focus.
  if (inSidebar && state.panelFocus !== "sidebar") {
    focusSidebar(state);
  } else if (!inSidebar && state.panelFocus === "sidebar") {
    state.panelFocus = "chat";
  }

  const options = sidebarVisibilityOptions(state);

  // Hover changes the keyboard target but does not activate/load it.
  if (inSidebar && ev.action === "motion") {
    focusSidebarAtMouse(state.sidebar, state.channelList.channels, ev.row, state.rows, options);
    return { type: "handled" };
  }

  // Wheel events use the same sidebar/chat split as Exocortex. The timeline
  // stores its viewport as a top-relative offset, so wheel-up is negative.
  if (ev.button === 64 || ev.button === 65) {
    if (ev.action !== "press") return { type: "handled" };

    if (inSidebar) {
      scrollSidebarAtMouse(
        state.sidebar,
        state.channelList.channels,
        ev.button === 64 ? -1 : 1,
        state.rows,
        options,
      );
      return { type: "handled" };
    }

    return {
      type: "scroll_chat",
      delta: ev.button === 64 ? -CHAT_SCROLL_LINES : CHAT_SCROLL_LINES,
    };
  }

  if (inSidebar && ev.button === 0 && ev.action === "press") {
    const entry = focusSidebarAtMouse(state.sidebar, state.channelList.channels, ev.row, state.rows, options);
    return entry ? { type: "activate_sidebar" } : { type: "handled" };
  }

  // A click in the prompt focuses it; a click in history focuses history with
  // the cursor on the clicked character (like Exocortex).
  if (!inSidebar && ev.button === 0 && ev.action === "press") {
    const area = chatAreaAt(state, ev.col, ev.row);
    if (area === "prompt") return { type: "focus_prompt" };
    if (area === "history") {
      const position = historyPositionAt(state, ev.col, ev.row);
      if (position) return { type: "focus_history", ...position };
    }
  }

  return { type: "handled" };
}
