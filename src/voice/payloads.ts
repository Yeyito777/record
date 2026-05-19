import { DAVE_PROTOCOL_VERSION } from "@snazzah/davey";

import { VOICE_FLAGS } from "./constants";
import type { VoiceGatewayJoinData, VoiceGatewayOutboundStream, VoiceStateRequest } from "./types";

const DEFAULT_VIDEO_STREAMS: VoiceGatewayOutboundStream[] = [
  { type: "screen", rid: "100", quality: 100, active: true, maxFramerate: 30 },
];

export function buildVoiceIdentifyPayload(data: VoiceGatewayJoinData, maxDaveProtocolVersion = DAVE_PROTOCOL_VERSION): unknown {
  const video = Boolean(data.video);
  const payload: Record<string, unknown> = {
    server_id: data.guildId,
    channel_id: data.channelId,
    user_id: data.userId,
    session_id: data.sessionId,
    token: data.token,
    video,
    max_dave_protocol_version: maxDaveProtocolVersion,
  };
  if (video) payload.streams = DEFAULT_VIDEO_STREAMS.map(voiceGatewayOutboundStreamPayload);
  return {
    op: 0,
    d: payload,
  };
}

export function voiceGatewayOutboundStreamPayload(stream: VoiceGatewayOutboundStream): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: stream.type,
    rid: stream.rid,
    quality: stream.quality,
  };
  if (stream.active !== undefined) payload.active = stream.active;
  if (stream.maxBitrate !== undefined) payload.max_bitrate = stream.maxBitrate;
  if (stream.maxFramerate !== undefined) payload.max_framerate = stream.maxFramerate;
  if (stream.maxResolution) payload.max_resolution = stream.maxResolution;
  if (stream.ssrc !== undefined) payload.ssrc = stream.ssrc;
  if (stream.rtxSsrc !== undefined) payload.rtx_ssrc = stream.rtxSsrc;
  return payload;
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
