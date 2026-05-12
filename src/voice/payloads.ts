import { DAVE_PROTOCOL_VERSION } from "@snazzah/davey";

import { VOICE_FLAGS } from "./constants";
import type { VoiceGatewayJoinData, VoiceStateRequest } from "./types";

export function buildVoiceIdentifyPayload(data: VoiceGatewayJoinData, maxDaveProtocolVersion = DAVE_PROTOCOL_VERSION): unknown {
  return {
    op: 0,
    d: {
      server_id: data.guildId,
      channel_id: data.channelId,
      user_id: data.userId,
      session_id: data.sessionId,
      token: data.token,
      video: false,
      max_dave_protocol_version: maxDaveProtocolVersion,
    },
  };
}

export function buildVoiceStatePayload(request: VoiceStateRequest): unknown {
  if (!request.channelId) {
    return {
      op: 4,
      d: {
        guild_id: null,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
        self_video: false,
        flags: VOICE_FLAGS,
      },
    };
  }

  const data: Record<string, unknown> = {
    guild_id: request.guildId,
    channel_id: request.channelId,
    self_mute: request.selfMute,
    self_deaf: request.selfDeaf,
    self_video: request.selfVideo,
    flags: VOICE_FLAGS,
  };
  if (!request.guildId) {
    const preferredRegions = request.preferredRegions?.length ? request.preferredRegions : ["automatic"];
    data.preferred_regions = preferredRegions;
    data.preferred_region = preferredRegions[0];
  }
  return {
    op: 4,
    d: data,
  };
}
