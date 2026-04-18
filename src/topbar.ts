/**
 * Top bar renderer.
 */

import { formatChannelName } from "./discord";
import type { AppState } from "./state";
import { truncate } from "./strings";
import { theme } from "./theme";

function focusLabel(state: AppState): string {
  if (state.panelFocus === "sidebar") return "[servers]";
  return state.chatFocus === "history" ? "[history]" : "[prompt]";
}

export function renderTopbar(state: AppState, width: number): string {
  const title = "Record";
  const guild = state.sidebar.guilds.find((entry) => entry.id === state.sidebar.activeGuildId) ?? null;
  const channel = state.channelList.channels.find((entry) => entry.id === state.channelList.activeChannelId) ?? null;

  const descriptor = guild && channel
    ? `${guild.name} / ${formatChannelName(channel)}`
    : guild
      ? guild.name
      : state.auth.status === "authenticated"
        ? "Connected"
        : "Discord terminal client";

  const text = ` ${title} ${focusLabel(state)} — ${descriptor}`;
  const padded = truncate(text, width).padEnd(width, " ");
  return `${theme.topbarBg}${theme.text}${theme.bold}${padded}${theme.boldOff}${theme.reset}`;
}
