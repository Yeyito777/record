import { VOICE_GATEWAY_ABNORMAL_CLOSE_CODE, VOICE_GATEWAY_CALL_TERMINATED_CODE, VOICE_GATEWAY_DISCONNECTED_CODE, VOICE_GATEWAY_INVALID_SESSION_CODE, VOICE_GATEWAY_NORMAL_CLOSE_CODE } from "./constants";
import { VoiceGatewayCloseError } from "./types";

export function isRecoverableVoiceGatewayClose(error: Error): error is VoiceGatewayCloseError {
  return error instanceof VoiceGatewayCloseError
    && (
      error.code === VOICE_GATEWAY_INVALID_SESSION_CODE
      || error.code === VOICE_GATEWAY_NORMAL_CLOSE_CODE
      || error.code === VOICE_GATEWAY_ABNORMAL_CLOSE_CODE
      || error.code === VOICE_GATEWAY_DISCONNECTED_CODE
      || /connection closed normally/i.test(error.closeReason)
      || /session is no longer valid/i.test(error.closeReason)
      || /^disconnected\.?$/i.test(error.closeReason)
      || /connection ended/i.test(error.closeReason)
      || /abnormal/i.test(error.closeReason)
    );
}

export function isTerminalVoiceGatewayClose(error: Error): error is VoiceGatewayCloseError {
  return error instanceof VoiceGatewayCloseError
    && (error.code === VOICE_GATEWAY_CALL_TERMINATED_CODE || /call terminated/i.test(error.closeReason));
}

export function voiceGatewayCloseError(event: CloseEvent): VoiceGatewayCloseError {
  const reason = event.code === 4017
    ? "DAVE/E2EE protocol required"
    : event.reason || (event.code === VOICE_GATEWAY_INVALID_SESSION_CODE
      ? "Session is no longer valid."
      : event.code === VOICE_GATEWAY_NORMAL_CLOSE_CODE
        ? "Connection closed normally."
        : event.code === VOICE_GATEWAY_ABNORMAL_CLOSE_CODE
          ? "Connection ended."
          : "unknown reason");
  return new VoiceGatewayCloseError(event.code, reason);
}

export function asError(error: unknown, prefix: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix} ${message}`.trim());
}
