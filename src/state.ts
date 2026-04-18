/**
 * Application state for record.
 */

import type { AutocompleteState } from "./autocomplete";
import type { DiscordIdentity } from "./discord";
import { createEditorState, type EditorState } from "./editor";
import { normalizeToken } from "./token";
import type { NoticeTone } from "./theme";

export type AuthStatus = "idle" | "loading" | "authenticated" | "error";

export interface Notice {
  tone: NoticeTone;
  text: string;
}

export interface AuthState {
  status: AuthStatus;
  user: DiscordIdentity | null;
  error: string | null;
  savedToken: string | null;
  lastValidatedAt: number | null;
  activeRequestId: number;
}

export interface AppState {
  cols: number;
  rows: number;
  editor: EditorState;
  autocomplete: AutocompleteState | null;
  auth: AuthState;
  notice: Notice;
  configPath: string;
}

export function createInitialState(initialToken: string | null, path: string): AppState {
  const savedToken = initialToken ? normalizeToken(initialToken) : null;
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    editor: createEditorState("", "insert"),
    autocomplete: null,
    auth: {
      status: "idle",
      user: null,
      error: null,
      savedToken,
      lastValidatedAt: null,
      activeRequestId: 0,
    },
    notice: { tone: "muted", text: "" },
    configPath: path,
  };
}

export function setNotice(state: AppState, text: string, tone: NoticeTone = "muted"): void {
  state.notice = { text, tone };
}

export function nextAuthRequestId(state: AppState): number {
  state.auth.activeRequestId += 1;
  return state.auth.activeRequestId;
}

export function isCurrentAuthRequest(state: AppState, requestId: number): boolean {
  return state.auth.activeRequestId === requestId;
}
