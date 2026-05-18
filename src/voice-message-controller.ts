import type { KeyEvent } from "./input";
import type { AppState } from "./state";
import { setNotice } from "./state";
import {
  VoiceMessageRecorder,
  VOICE_MESSAGE_SPINNER_FRAMES,
  type VoiceMessageClip,
} from "./voice-message";

const VOICE_MESSAGE_SPINNER_INTERVAL_MS = 80;
const VOICE_MESSAGE_MIN_RECORDING_MS = 500;
const VOICE_MESSAGE_REPEAT_INITIAL_GRACE_MS = 1000;
const VOICE_MESSAGE_REPEAT_IDLE_TIMEOUT_MS = 250;

interface VoiceMessageRecorderLike {
  stop(): Promise<VoiceMessageClip>;
  abort(): void;
}

export interface VoiceMessageController {
  handleKey(key: KeyEvent): boolean;
  isRecording(): boolean;
  cleanup(): void;
}

interface VoiceMessageControllerDeps {
  startRecorder?: () => VoiceMessageRecorderLike;
  sendVoiceMessage: (clip: VoiceMessageClip) => void;
  now?: () => number;
}

interface VoiceMessageSession {
  recorder: VoiceMessageRecorderLike | null;
  animationTimer: ReturnType<typeof setInterval> | null;
  recordingStartedAt: number;
  lastSpaceRepeatAt: number;
  sending: boolean;
}

export function createVoiceMessageController(
  state: AppState,
  scheduleRender: () => void,
  deps: VoiceMessageControllerDeps,
): VoiceMessageController {
  const startRecorder = deps.startRecorder ?? (() => VoiceMessageRecorder.start());
  const now = deps.now ?? (() => Date.now());
  const session: VoiceMessageSession = {
    recorder: null,
    animationTimer: null,
    recordingStartedAt: 0,
    lastSpaceRepeatAt: 0,
    sending: false,
  };

  function promptIsFocusedNormalMode(): boolean {
    return state.panelFocus === "chat"
      && state.chatFocus === "prompt"
      && state.editor.mode === "normal"
      && !state.autocomplete
      && !state.editTarget;
  }

  function stopAnimation(): void {
    if (!session.animationTimer) return;
    clearInterval(session.animationTimer);
    session.animationTimer = null;
  }

  function resetPrompt(): void {
    state.voiceMessagePrompt = null;
    session.recordingStartedAt = 0;
    session.lastSpaceRepeatAt = 0;
    session.sending = false;
    stopAnimation();
  }

  function showVoiceMessageError(prefix: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    resetPrompt();
    setNotice(state, `${prefix}: ${message}`, "warning", { statusLine: false, chat: true });
    scheduleRender();
  }

  function maybeStopRecordingFromIdle(): void {
    if (!session.recorder || state.voiceMessagePrompt?.phase !== "recording") return;
    const currentTime = now();
    if (currentTime - session.recordingStartedAt < VOICE_MESSAGE_REPEAT_INITIAL_GRACE_MS) return;
    if (currentTime - session.lastSpaceRepeatAt < VOICE_MESSAGE_REPEAT_IDLE_TIMEOUT_MS) return;
    void stopRecordingAndSend();
  }

  function startAnimation(): void {
    if (session.animationTimer) return;
    session.animationTimer = setInterval(() => {
      if (!state.voiceMessagePrompt) {
        stopAnimation();
        return;
      }
      state.voiceMessagePrompt.frameIndex = (state.voiceMessagePrompt.frameIndex + 1) % VOICE_MESSAGE_SPINNER_FRAMES.length;
      maybeStopRecordingFromIdle();
      scheduleRender();
    }, VOICE_MESSAGE_SPINNER_INTERVAL_MS);
  }

  function startRecording(): void {
    if (session.recorder || session.sending || state.voiceMessagePrompt) return;
    if (!state.auth.savedToken) {
      setNotice(state, "Login first with /login <token|username> before recording a voice message.", "warning", { statusLine: false, chat: true });
      scheduleRender();
      return;
    }
    if (!(state.channelList.activeChannelId ?? state.timeline.channelId)) {
      setNotice(state, "Open a channel before recording a voice message.", "warning", { statusLine: false, chat: true });
      scheduleRender();
      return;
    }
    if (state.editor.buffer.trim().length > 0) {
      setNotice(state, "Clear the prompt before recording a voice message.", "warning", { statusLine: false, chat: true });
      scheduleRender();
      return;
    }
    if (state.pendingImages.length > 0) {
      setNotice(state, "Send or cancel pending images before recording a voice message.", "warning", { statusLine: false, chat: true });
      scheduleRender();
      return;
    }

    try {
      session.recorder = startRecorder();
    } catch (error) {
      showVoiceMessageError("Voice capture failed", error);
      return;
    }

    session.recordingStartedAt = now();
    session.lastSpaceRepeatAt = session.recordingStartedAt;
    state.autocomplete = null;
    state.voiceMessagePrompt = { phase: "recording", frameIndex: 0 };
    startAnimation();
    scheduleRender();
  }

  async function stopRecordingAndSend(): Promise<void> {
    const recorder = session.recorder;
    if (!recorder) return;
    session.recorder = null;

    const durationMs = now() - session.recordingStartedAt;
    state.voiceMessagePrompt = { phase: "sending", frameIndex: state.voiceMessagePrompt?.frameIndex ?? 0 };
    session.sending = true;
    startAnimation();
    scheduleRender();

    let clip: VoiceMessageClip;
    try {
      clip = await recorder.stop();
    } catch (error) {
      showVoiceMessageError("Voice capture failed", error);
      return;
    }

    if (durationMs < VOICE_MESSAGE_MIN_RECORDING_MS) {
      resetPrompt();
      scheduleRender();
      return;
    }

    try {
      deps.sendVoiceMessage(clip);
      resetPrompt();
      scheduleRender();
    } catch (error) {
      showVoiceMessageError("Voice message failed", error);
    }
  }

  function handleKey(key: KeyEvent): boolean {
    if (session.recorder) {
      if (key.type === "char" && key.char === " ") {
        if (key.event === "release") {
          void stopRecordingAndSend();
          return true;
        }
        session.lastSpaceRepeatAt = now();
        return true;
      }

      // Any other key ends the recording without also acting as a command.
      void stopRecordingAndSend();
      return true;
    }

    if (session.sending) return true;

    if (!promptIsFocusedNormalMode()) return false;
    if (key.type !== "char" || key.char !== " ") return false;
    if (key.event === "release") return true;

    startRecording();
    return true;
  }

  function cleanup(): void {
    if (session.recorder) {
      session.recorder.abort();
      session.recorder = null;
    }
    resetPrompt();
  }

  return {
    handleKey,
    isRecording: () => !!session.recorder,
    cleanup,
  };
}
