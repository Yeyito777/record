/**
 * Voice call status block — persistent in-call HUD.
 */

import { loadingLabel } from "../loading";
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

function callParts(call: VoiceCallStatus, now = Date.now()): { name: string; elapsed: string; mic: string; speaker: string } {
  return {
    name: truncate(call.displayName || "call", MAX_CALL_NAME_WIDTH),
    elapsed: formatElapsed(now - call.startedAt),
    mic: call.selfMute ? "🔇 muted" : "🎙 on",
    speaker: call.selfDeaf ? "🔇 off" : "🔈 on",
  };
}

function readyCallText(call: VoiceCallStatus, now = Date.now()): string {
  const { name, elapsed, mic, speaker } = callParts(call, now);
  return ` ☎ ${name} ${elapsed}  ${mic}  ${speaker}`;
}

function pendingCallText(call: VoiceCallStatus, frameIndex: number, now = Date.now()): string {
  const { name, elapsed, mic, speaker } = callParts(call, now);
  const action = call.state === "connecting" ? "Connecting…" : "Calling…";
  return ` ☎ ${name} ${elapsed}  ${loadingLabel(action, frameIndex)}  ${mic}  ${speaker}`;
}

function stableCallWidth(call: VoiceCallStatus, frameIndex: number, now = Date.now()): number {
  return Math.max(
    termWidth(readyCallText(call, now)),
    termWidth(pendingCallText({ ...call, state: "signaling" }, frameIndex, now)),
    termWidth(pendingCallText({ ...call, state: "connecting" }, frameIndex, now)),
  );
}

export function callBlock(state: AppState): StatusBlock | null {
  const call = state.voiceCall;
  if (!call || call.state === "ended" || call.state === "error") return null;

  const now = Date.now();
  const ready = call.state === "ready";
  const text = ready ? readyCallText(call, now) : pendingCallText(call, state.loadingFrameIndex, now);
  return {
    id: "call",
    priority: 98,
    width: stableCallWidth(call, state.loadingFrameIndex, now),
    height: 1,
    rows: [
      `${ready ? theme.accent : theme.muted}${text}${theme.reset}`,
    ],
  };
}
