/**
 * Top bar renderer.
 */

import { formatChannelName, isThreadChannel } from "./discord";
import type { AppState } from "./state";
import { padRight } from "./textwidth";
import { theme } from "./theme";

function focusLabel(state: AppState): string {
  if (state.panelFocus === "sidebar") return "[servers]";
  if (state.panelFocus === "memberlist") return "[members]";
  return state.chatFocus === "history" ? "[history]" : "[prompt]";
}

export function renderTopbar(state: AppState, width: number): string {
  const title = "Record";
  const guild = state.sidebar.guilds.find((entry) => entry.id === state.sidebar.activeGuildId) ?? null;
  const channel = state.channelList.activeChannel;

  const parentChannel = isThreadChannel(channel)
    ? state.channelList.channels.find((entry) => entry.id === channel?.parentId) ?? null
    : null;
  const descriptor = guild && channel
    ? parentChannel
      ? `${guild.name} / ${formatChannelName(parentChannel)} / ${formatChannelName(channel)}`
      : `${guild.name} / ${formatChannelName(channel)}`
    : guild
      ? guild.name
      : state.auth.status === "authenticated"
        ? "Connected"
        : state.whatsapp.connection.status === "connected"
          ? "WhatsApp connected"
          : "Discord and WhatsApp terminal client";

  const text = ` ${title} ${focusLabel(state)} — ${descriptor}`;
  const padded = padRight(text, width);
  return `${theme.topbarBg}${theme.text}${theme.bold}${padded}${theme.boldOff}${theme.reset}`;
}
