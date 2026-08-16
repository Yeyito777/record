/** Mouse routing for Record's server sidebar, modeled after Exocortex TUI. */

import type { MouseEvent } from "./input";
import {
  focusSidebarAtMouse,
  scrollSidebarAtMouse,
  sidebarHitTest,
  SIDEBAR_WIDTH,
  type SidebarVisibilityOptions,
} from "./sidebar";
import { focusSidebar, type AppState } from "./state";
import { mouseCursorHand, mouseCursorPointer } from "./terminal";

export type MouseResult = { type: "handled" } | { type: "activate_sidebar" };

type CursorWriter = (sequence: string) => void;

function sidebarVisibilityOptions(state: AppState): SidebarVisibilityOptions {
  return {
    showHiddenChannels: state.showHiddenChannels,
    currentUserId: state.auth.user?.id ?? null,
  };
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
    : "pointer";
  if (shape === state.mouseCursor) return;
  state.mouseCursor = shape;
  writeCursor(shape === "hand" ? mouseCursorHand : mouseCursorPointer);
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

  // Wheel events use the same one-row sidebar viewport movement as Exocortex.
  if (inSidebar && (ev.button === 64 || ev.button === 65)) {
    if (ev.action === "press") {
      scrollSidebarAtMouse(
        state.sidebar,
        state.channelList.channels,
        ev.button === 64 ? -1 : 1,
        state.rows,
        options,
      );
    }
    return { type: "handled" };
  }

  if (inSidebar && ev.button === 0 && ev.action === "press") {
    const entry = focusSidebarAtMouse(state.sidebar, state.channelList.channels, ev.row, state.rows, options);
    return entry ? { type: "activate_sidebar" } : { type: "handled" };
  }

  return { type: "handled" };
}
