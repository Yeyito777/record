import type { AppState } from "../state";

export interface VoiceMemberWatchActionState {
  canWatch: boolean;
  watching: boolean;
}

/** Keep an already-open voice-member action menu in sync with stream events. */
export function syncVoiceMemberWatchAction(
  state: AppState,
  channelId: string,
  userId: string,
  watch: VoiceMemberWatchActionState,
): void {
  const modal = state.sidebar.serverActionModal;
  if (modal?.targetKind !== "voice_member" || modal.channelId !== channelId || modal.targetId !== userId) return;
  const actionIndex = modal.actions.indexOf("watch_stream");
  if (watch.canWatch && actionIndex < 0) {
    const volumeIndex = modal.actions.indexOf("adjust_volume");
    const insertIndex = volumeIndex >= 0 ? volumeIndex + 1 : Math.min(1, modal.actions.length);
    modal.actions.splice(insertIndex, 0, "watch_stream");
  } else if (!watch.canWatch && actionIndex >= 0) {
    modal.actions.splice(actionIndex, 1);
    if (modal.selection === "watch_stream") {
      modal.selection = modal.actions[Math.min(actionIndex, modal.actions.length - 1)] ?? "toggle_mute";
    }
  }
  modal.watchingStream = watch.canWatch && watch.watching;
}
