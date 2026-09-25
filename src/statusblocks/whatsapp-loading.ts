import { WHATSAPP_GUILD_ID, isWhatsAppChannelId } from "../chatproviders";
import { loadingLabel } from "../loading";
import type { AppState } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth } from "../textwidth";

/** Loading belongs to provider state, not the transient notice cleared by sends. */
export function whatsappLoadingBlock(state: AppState): StatusBlock | null {
  const active = isWhatsAppChannelId(state.timeline.channelId);
  if (!active && state.channelList.guildId !== WHATSAPP_GUILD_ID) return null;
  const provider = state.sidebar.providerStatusByGuildId[WHATSAPP_GUILD_ID];
  const text = provider?.loading ? provider.text
    : active && (state.timeline.loading || state.timeline.loadingOlder) ? "Loading WhatsApp history…" : null;
  if (!text) return null;
  const label = `  ${loadingLabel(text, state.loadingFrameIndex)}`;
  return { id: "whatsapp-loading", priority: 9, width: termWidth(label), height: 1, rows: [`${theme.muted}${label}${theme.reset}`] };
}
