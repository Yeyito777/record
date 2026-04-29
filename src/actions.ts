/**
 * High-level app actions.
 *
 * Keeps submission/auth/theme side effects out of main.ts so the entrypoint can
 * stay focused on terminal lifecycle + event wiring.
 */

import { clearConfig, saveConfig, saveSavedLogins } from "./config";
import { tryCommand } from "./commands";
import { fetchCurrentUserPresenceStatus, validateToken } from "./discord";
import { promptMentionUsers, resolvePromptMentionsForSend } from "./mentions";
import { clearReadOnlyClient, editCurrentMessage, hangUpCurrentCall, refreshReadOnlyClient, sendCurrentChannelMessage, setCurrentCallDeaf, setCurrentCallMute, startCurrentDirectMessageCall, type SessionEffects } from "./session";
import type { AppState } from "./state";
import { isCurrentAuthRequest, nextAuthRequestId, setLoadingNotice, setNotice } from "./state";
import { normalizeToken } from "./token";

export interface AppEffects extends SessionEffects {
  quit: () => void;
  applyThemeCursor: () => void;
  bootstrapSession: (token: string) => void;
}

function setAuthError(state: AppState, message: string): void {
  state.auth.status = "error";
  state.auth.user = null;
  state.auth.error = message;
  setNotice(state, message, "error");
}

function resetAuthState(state: AppState): void {
  state.auth.status = "idle";
  state.auth.user = null;
  state.auth.error = null;
  state.auth.savedToken = null;
  state.auth.lastValidatedAt = null;
}

function nextSavedLogins(state: AppState, username: string, token: string): Record<string, string> {
  const entries = Object.entries(state.auth.savedLogins).filter(([, savedToken]) => savedToken !== token);
  return { ...Object.fromEntries(entries), [username]: token };
}

export function resolveLoginCredential(state: AppState, credential: string): string {
  return state.auth.savedLogins[credential] ?? credential;
}

export async function validateAndMaybeSave(
  state: AppState,
  token: string,
  persist: boolean,
  loadingText: string,
  effects: AppEffects,
): Promise<void> {
  const requestId = nextAuthRequestId(state);
  const changingLogin = state.auth.savedToken !== null && state.auth.savedToken !== token;
  if (changingLogin) {
    clearReadOnlyClient(state);
  }

  state.auth.status = "loading";
  state.auth.user = null;
  state.auth.error = null;
  setLoadingNotice(state, loadingText);
  effects.scheduleRender();

  try {
    const [user, presenceStatus] = await Promise.all([
      validateToken(token),
      fetchCurrentUserPresenceStatus(token).catch(() => null),
    ]);
    if (!isCurrentAuthRequest(state, requestId)) return;

    state.auth.savedToken = token;

    let saveError: string | null = null;
    if (persist) {
      const savedLogins = nextSavedLogins(state, user.username, token);
      state.auth.savedLogins = savedLogins;

      const saveFailures: string[] = [];
      try {
        saveConfig({ token });
      } catch (error) {
        saveFailures.push(`config: ${(error as Error).message}`);
      }
      try {
        saveSavedLogins(savedLogins);
      } catch (error) {
        saveFailures.push(`saved logins: ${(error as Error).message}`);
      }
      saveError = saveFailures.length > 0 ? saveFailures.join("; ") : null;
    }

    state.auth.status = "authenticated";
    state.auth.user = user;
    state.auth.presenceStatus = presenceStatus;
    state.auth.error = null;
    state.auth.lastValidatedAt = Date.now();

    if (saveError) {
      setNotice(state, `Authenticated, but saving failed: ${saveError}`, "warning");
    } else {
      setNotice(state, "", "muted");
    }

    effects.scheduleRender();
    effects.bootstrapSession(token);
  } catch (error) {
    if (!isCurrentAuthRequest(state, requestId)) return;
    const message = error instanceof Error ? error.message : String(error);
    setAuthError(state, message);
    effects.scheduleRender();
  }
}

export function logout(state: AppState, effects: AppEffects): void {
  nextAuthRequestId(state);

  try {
    clearConfig();
  } catch (error) {
    setNotice(state, `Failed to clear config: ${(error as Error).message}`, "error");
    effects.scheduleRender();
    return;
  }

  resetAuthState(state);
  state.autocomplete = null;
  clearReadOnlyClient(state);
  setNotice(state, "Logged out.", "success");
  effects.scheduleRender();
}

function handleCommandSubmit(state: AppState, text: string, effects: AppEffects): boolean {
  const result = tryCommand(text, state);
  if (result === null) {
    if (text.startsWith("/")) {
      const name = text.split(/\s+/)[0];
      setNotice(state, `Unknown command: ${name}`, "error");
      effects.scheduleRender();
      return true;
    }
    return false;
  }

  switch (result.type) {
    case "handled":
      effects.scheduleRender();
      return true;
    case "quit":
      effects.quit();
      return true;
    case "login":
      void validateAndMaybeSave(
        state,
        normalizeToken(resolveLoginCredential(state, result.credential)),
        true,
        "Validating token with Discord…",
        effects,
      );
      return true;
    case "logout":
      logout(state, effects);
      return true;
    case "theme_changed":
      effects.applyThemeCursor();
      effects.scheduleRender();
      return true;
    case "refresh":
      refreshReadOnlyClient(state, effects);
      return true;
    case "call":
      startCurrentDirectMessageCall(state, effects);
      return true;
    case "hangup":
      hangUpCurrentCall(state, effects);
      return true;
    case "mute":
      setCurrentCallMute(state, effects, result.muted);
      return true;
    case "deafen":
      setCurrentCallDeaf(state, effects, result.deafened);
      return true;
  }
}

export function submitCurrentBuffer(state: AppState, effects: AppEffects): void {
  const rawText = state.editor.buffer;
  const text = rawText.trim();
  const hasImages = state.pendingImages.length > 0;
  state.autocomplete = null;

  if (state.editTarget) {
    editCurrentMessage(state, state.auth.savedToken, rawText, effects, { sendContent: resolvePromptMentionsForSend(state, rawText) });
    return;
  }

  if (!text && !hasImages) return;
  if (text && !hasImages && handleCommandSubmit(state, text, effects)) return;

  sendCurrentChannelMessage(state, state.auth.savedToken, text, effects, {
    sendContent: resolvePromptMentionsForSend(state, text),
    localMentionUsers: promptMentionUsers(state, text),
  });
}
