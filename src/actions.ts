/**
 * High-level app actions.
 *
 * Keeps submission/auth/theme side effects out of main.ts so the entrypoint can
 * stay focused on terminal lifecycle + event wiring.
 */

import { clearConfig, saveConfig, saveSavedLogins } from "./config";
import { tryCommand } from "./commands";
import { fetchCurrentUserStatusSettings, setCurrentUserSettingsProtoCustomStatus, setCurrentUserSettingsProtoStatus, validateToken } from "./discord";
import { expandMacros } from "./macros";
import { promptMentionUsers, resolvePromptMentionsForSend } from "./mentions";
import { clearReadOnlyClient, createCurrentChannelThread, editCurrentMessage, executeCurrentServerCommand, hangUpCurrentCall, loadCurrentChannelPinnedMessages, refreshReadOnlyClient, sendCurrentChannelMessage, setCurrentCallDeaf, setCurrentCallMute, setCurrentUserCustomStatus, setCurrentUserPresenceStatus, setLocalMicVolume, setLocalNoiseSuppression, setLocalSpeakerVolume, startCurrentVoiceCall, toggleCurrentStream, uploadCurrentChannelFile, watchCurrentStream, type SessionEffects } from "./session";
import { tryServerCommand } from "./servercommands";
import type { AppState } from "./state";
import { isCurrentAuthRequest, nextAuthRequestId, setLoadingNotice, setNotice } from "./state";
import { normalizeToken } from "./token";
import { isWhatsAppChannelId } from "./chatproviders";
import { pushTimelineSystemMessage } from "./timeline";

export interface AppEffects extends SessionEffects {
  quit: () => void;
  applyThemeCursor: () => void;
  bootstrapSession: (token: string) => void;
  loginWhatsApp: () => void;
  logoutWhatsApp: () => void;
  sendWhatsAppMessage: (content: string) => boolean;
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
  state.auth.presenceStatus = null;
  state.auth.customStatus = null;
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
  state.auth.presenceStatus = null;
  state.auth.customStatus = null;
  state.auth.error = null;
  setLoadingNotice(state, loadingText);
  effects.scheduleRender();

  try {
    const [user, statusSettings] = await Promise.all([
      validateToken(token),
      fetchCurrentUserStatusSettings(token).catch(() => null),
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
    state.auth.presenceStatus = statusSettings?.presenceStatus ?? null;
    state.auth.customStatus = statusSettings?.customStatus ?? null;
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
    if (state.auth.cachedSidebarPreviewAccountId) clearReadOnlyClient(state);
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
  if (result === null) return false;

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
    case "login_whatsapp":
      effects.loginWhatsApp();
      return true;
    case "logout":
      logout(state, effects);
      return true;
    case "logout_whatsapp":
      effects.logoutWhatsApp();
      return true;
    case "theme_changed":
      effects.applyThemeCursor();
      effects.scheduleRender();
      return true;
    case "refresh":
      refreshReadOnlyClient(state, effects);
      return true;
    case "pinned":
      void loadCurrentChannelPinnedMessages(state, state.auth.savedToken, effects);
      return true;
    case "create_thread":
      createCurrentChannelThread(state, state.auth.savedToken, result.name, effects);
      return true;
    case "upload":
      uploadCurrentChannelFile(state, state.auth.savedToken, result.path, effects);
      return true;
    case "call":
      startCurrentVoiceCall(state, effects);
      return true;
    case "stream":
      toggleCurrentStream(state, effects);
      return true;
    case "watch":
      watchCurrentStream(state, effects, result.target);
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
    case "mic_volume":
      setLocalMicVolume(state, effects, result.volume);
      return true;
    case "speaker_volume":
      setLocalSpeakerVolume(state, effects, result.volume);
      return true;
    case "noise_suppression":
      setLocalNoiseSuppression(state, effects, result.mode);
      return true;
    case "status":
      setCurrentUserPresenceStatus(state, effects, result.status, (token, status) => setCurrentUserSettingsProtoStatus(token, status));
      return true;
    case "status_quote":
      setCurrentUserCustomStatus(state, effects, result.text, (token, text) => setCurrentUserSettingsProtoCustomStatus(token, text));
      return true;
  }
}

function handleServerCommandSubmit(state: AppState, text: string, effects: AppEffects): boolean {
  const result = tryServerCommand(text, state);
  if (result === null) return false;
  if (result.type === "error") {
    pushTimelineSystemMessage(state.timeline, result.message);
    setNotice(state, result.message, "warning", { statusLine: false, chat: true });
    effects.scheduleRender();
    return true;
  }
  executeCurrentServerCommand(state, state.auth.savedToken, result.request, result.sourceText, effects);
  return true;
}

export function submitCurrentBuffer(state: AppState, effects: AppEffects): void {
  const rawText = state.editor.buffer;
  const text = rawText.trim();
  const hasImages = state.pendingImages.length > 0;
  state.autocomplete = null;

  if (state.editTarget) {
    const expandedRawText = expandMacros(rawText);
    editCurrentMessage(state, state.auth.savedToken, expandedRawText, effects, {
      sendContent: resolvePromptMentionsForSend(state, expandedRawText),
    });
    return;
  }

  if (!text && !hasImages) return;

  const expandedText = expandMacros(text);
  if (text && expandedText === text) {
    // The advertised /@app namespace is always an app command. Legacy /app
    // input remains accepted, but local commands keep priority there so an app
    // with a colliding name can never shadow Record's own controls.
    if (!hasImages && !text.startsWith("/@") && handleCommandSubmit(state, text, effects)) return;
    if (handleServerCommandSubmit(state, text, effects)) return;
    if (!hasImages && handleCommandSubmit(state, text, effects)) return;
  }

  const activeChannelId = state.channelList.activeChannelId ?? state.timeline.channelId;
  if (isWhatsAppChannelId(activeChannelId) && effects.sendWhatsAppMessage(expandedText)) return;

  sendCurrentChannelMessage(state, state.auth.savedToken, expandedText, effects, {
    sendContent: resolvePromptMentionsForSend(state, expandedText),
    localMentionUsers: promptMentionUsers(state, expandedText),
  });
}
