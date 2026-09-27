import { INSTAGRAM_GUILD_ID, WHATSAPP_GUILD_ID, isInstagramChannelId, isWhatsAppChannelId } from "../chatproviders";
import { loadingLabel } from "../loading";
import type { AppState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth } from "../textwidth";

/** Provider status persists independently of transient notices cleared by sends. */
function providerStatusBlock(
  state: AppState,
  guildId: string,
  name: string,
  active: boolean,
): StatusBlock | null {
  if (!active && state.channelList.guildId !== guildId
    && state.sidebar.focusedGuildId !== guildId && state.sidebar.expandedGuildId !== guildId) return null;
  if (guildId === WHATSAPP_GUILD_ID && state.whatsapp.loginModal) return null;
  const notice = state.notice;
  // Detailed connection feedback already occupies a notice block (or the chat).
  // Keep the persistent status as a fallback once that notice is cleared.
  if (notice.connectionGuildId === guildId && notice.text.trim()
    && (notice.chat !== false || (notice.statusLine !== false && !(state.voiceCall && notice.loading)))) return null;
  const provider = state.sidebar.providerStatusByGuildId[guildId];
  // History loading is already rendered inside the timeline.
  const text = provider?.text;
  if (!text) return null;
  const loading = provider.loading;
  const namedText = text.includes(name) ? text : `${name}: ${text}`;
  const label = `  ${loading ? loadingLabel(namedText, state.loadingFrameIndex) : namedText}`;
  const warning = !loading && (guildId === INSTAGRAM_GUILD_ID
    ? state.instagram.connection.status === "error"
    : ["failed", "logged-out", "connection-replaced"].includes(state.whatsapp.connection.status));
  return {
    id: `${name.toLowerCase()}-status`,
    priority: 9,
    width: termWidth(label),
    height: 1,
    rows: [`${warning ? theme.warning : theme.muted}${label}${theme.reset}`],
  };
}

export function whatsappStatusBlock(state: AppState): StatusBlock | null {
  return providerStatusBlock(state, WHATSAPP_GUILD_ID, "WhatsApp", isWhatsAppChannelId(state.timeline.channelId));
}

export function instagramStatusBlock(state: AppState): StatusBlock | null {
  return providerStatusBlock(state, INSTAGRAM_GUILD_ID, "Instagram", isInstagramChannelId(state.timeline.channelId));
}
