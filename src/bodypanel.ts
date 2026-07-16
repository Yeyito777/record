/**
 * Placeholder body content when no channel timeline is available.
 */

import type { AppState } from "./state";
import { truncate } from "./textwidth";
import { theme } from "./theme";

export function renderBodyLines(state: AppState, width: number): string[] {
  const discordConnected = state.auth.status === "authenticated";
  const whatsappConnected = state.whatsapp.connection.status === "connected";
  if (!discordConnected && !whatsappConnected) {
    return [
      `${theme.text}${truncate("Login with /login <token|username> to load your Discord servers.", width)}${theme.reset}`,
      `${theme.text}${truncate("Link WhatsApp with /login whatsapp.", width)}${theme.reset}`,
      `${theme.muted}${truncate("Use Ctrl+S or Ctrl+M to toggle the servers sidebar.", width)}${theme.reset}`,
    ];
  }

  if (!state.channelList.activeChannelId) {
    return [`${theme.muted}${truncate("Select a channel to start reading.", width)}${theme.reset}`];
  }

  return [];
}
