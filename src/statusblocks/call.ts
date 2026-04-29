/**
 * Voice call status block — persistent in-call HUD.
 */

import type { AppState, VoiceCallStatus } from "../state";
import type { StatusBlock } from "../statusline";
import { theme } from "../theme";
import { termWidth, truncate } from "../textwidth";

const MAX_CALL_NAME_WIDTH = 28;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const two = (value: number) => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

function callPlainText(call: VoiceCallStatus, now = Date.now()): string {
  const name = truncate(call.displayName || "call", MAX_CALL_NAME_WIDTH);
  const elapsed = formatElapsed(now - call.startedAt);
  const mic = call.selfMute ? "🔇 muted" : "🎙 on";
  const speaker = call.selfDeaf ? "🔇 off" : "🔈 on";
  return `  ▎ ☎ ${name} ${elapsed}  ${mic}  ${speaker}`;
}

export function callBlock(state: AppState): StatusBlock | null {
  const call = state.voiceCall;
  if (!call || call.state === "ended" || call.state === "error") return null;

  const text = callPlainText(call);
  return {
    id: "call",
    priority: 9,
    width: termWidth(text),
    height: 1,
    rows: [
      `${theme.accent}${text}${theme.reset}`,
    ],
  };
}
