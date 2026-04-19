/**
 * Application state for record.
 */

import type { AutocompleteState } from "./autocomplete";
import { createChannelListState, type ChannelListState } from "./channels";
import type { DiscordIdentity } from "./discord";
import { createEditorState, enterInsertMode, leaveInsertMode, type EditorState } from "./editor";
import { createSidebarState, type SidebarState } from "./sidebar";
import { createTimelineState, type TimelineState } from "./timeline";
import { normalizeToken } from "./token";
import type { NoticeTone } from "./theme";

export type AuthStatus = "idle" | "loading" | "authenticated" | "error";
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
export type PanelFocus = "sidebar" | "chat";
export type ChatFocus = "prompt" | "history";

export interface Notice {
  tone: NoticeTone;
  text: string;
  loading: boolean;
}

export interface AuthState {
  status: AuthStatus;
  user: DiscordIdentity | null;
  presenceStatus: PresenceStatus | null;
  error: string | null;
  savedToken: string | null;
  lastValidatedAt: number | null;
  activeRequestId: number;
}

export interface AppState {
  cols: number;
  rows: number;
  panelFocus: PanelFocus;
  chatFocus: ChatFocus;
  editor: EditorState;
  autocomplete: AutocompleteState | null;
  sidebar: SidebarState;
  channelList: ChannelListState;
  timeline: TimelineState;
  auth: AuthState;
  notice: Notice;
  loadingFrameIndex: number;
  configPath: string;
}

export function createInitialState(initialToken: string | null, path: string): AppState {
  const savedToken = initialToken ? normalizeToken(initialToken) : null;
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    panelFocus: "chat",
    chatFocus: "prompt",
    editor: createEditorState("", "insert"),
    autocomplete: null,
    sidebar: createSidebarState(),
    channelList: createChannelListState(),
    timeline: createTimelineState(),
    auth: {
      status: "idle",
      user: null,
      presenceStatus: null,
      error: null,
      savedToken,
      lastValidatedAt: null,
      activeRequestId: 0,
    },
    notice: { tone: "muted", text: "", loading: false },
    loadingFrameIndex: 0,
    configPath: path,
  };
}

export function setNotice(
  state: AppState,
  text: string,
  tone: NoticeTone = "muted",
  options: { loading?: boolean } = {},
): void {
  state.notice = { text, tone, loading: options.loading ?? false };
}

export function setLoadingNotice(state: AppState, text: string): void {
  setNotice(state, text, "muted", { loading: true });
}

export function nextAuthRequestId(state: AppState): number {
  state.auth.activeRequestId += 1;
  return state.auth.activeRequestId;
}

export function isCurrentAuthRequest(state: AppState, requestId: number): boolean {
  return state.auth.activeRequestId === requestId;
}

export function focusPrompt(state: AppState, append = false): void {
  state.panelFocus = "chat";
  state.chatFocus = "prompt";
  const targetCursor = append ? state.editor.cursor + 1 : state.editor.cursor;
  enterInsertMode(state.editor, targetCursor);
}

export function focusHistory(state: AppState): void {
  state.panelFocus = "chat";
  state.chatFocus = "history";
  leaveInsertMode(state.editor);
}

export function focusSidebar(state: AppState): void {
  state.panelFocus = "sidebar";
  leaveInsertMode(state.editor);
}

export function cycleFocus(state: AppState): void {
  if (!state.sidebar.open) {
    state.panelFocus = "chat";
    return;
  }

  if (state.panelFocus === "sidebar") {
    state.panelFocus = "chat";
  } else {
    focusSidebar(state);
  }
}
