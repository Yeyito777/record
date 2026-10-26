/**
 * st's video extension to Kitty graphics (st docs/video.md): `a=v` APCs that
 * open a video, carry H.264 access units, pause, query and close it. A video
 * is shown like any image, by placing its id (`a=p`).
 */

const APC = "\x1b_G";
const ST = "\x1b\\";
/** Base64 characters per APC, as st-play sends them. */
const CHUNK_CHARS = 16384;
/** Image id of the capability query (reply matching only; no image is made). */
export const VIDEO_QUERY_ID = 0x6ffffffd;

function textPayload(fields: Record<string, string | number>): string {
  return Buffer.from(Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ")).toString("base64");
}

function apc(controls: string, base64 = ""): string {
  if (!base64) return `${APC}${controls}${ST}`;
  if (base64.length <= CHUNK_CHARS) return `${APC}${controls};${base64}${ST}`;
  const parts: string[] = [];
  for (let offset = 0; offset < base64.length; offset += CHUNK_CHARS) {
    const last = offset + CHUNK_CHARS >= base64.length;
    const chunk = base64.slice(offset, offset + CHUNK_CHARS);
    parts.push(offset === 0 ? `${APC}${controls},m=1;${chunk}${ST}` : `${APC}m=${last ? 0 : 1};${chunk}${ST}`);
  }
  return parts.join("");
}

/** The capability query, then DA1: a terminal that answers DA1 but not the query has no video. */
export function videoCapabilityQuery(): string {
  return `${APC}a=v,i=${VIDEO_QUERY_ID},k=c${ST}\x1b[c`;
}

export interface VideoOpenOptions {
  /** Display size in pixels: placements size and crop in these units. */
  width: number;
  height: number;
  /** Milliseconds buffered before playing (st's default is 300). */
  prebufferMs?: number;
  paused?: boolean;
  /** 0..1; 0 opens it muted. */
  volume?: number;
}

/** Open (or replace) a silent H.264 video; errors only are answered (q=1). */
export function videoOpen(id: number, options: VideoOpenOptions): string {
  const fields: Record<string, string | number> = {
    video: "h264",
    width: Math.max(1, Math.min(4096, Math.round(options.width))),
    height: Math.max(1, Math.min(4096, Math.round(options.height))),
  };
  if (options.prebufferMs !== undefined) fields.prebuffer = Math.max(0, Math.min(10000, Math.round(options.prebufferMs)));
  if (options.paused) fields.pause = 1;
  if (options.volume !== undefined) fields.volume = Math.max(0, Math.min(1, options.volume));
  return apc(`a=v,i=${id},k=o,q=1`, textPayload(fields));
}

/** One H.264 access unit (Annex B), stamped in microseconds. Never answered. */
export function videoPacket(id: number, ptsUs: number, keyframe: boolean, data: Uint8Array): string {
  const payload = Buffer.allocUnsafe(10 + data.length);
  payload[0] = 0;
  payload[1] = keyframe ? 1 : 0;
  payload.writeBigInt64BE(BigInt(Math.round(ptsUs)), 2);
  payload.set(data, 10);
  return apc(`a=v,i=${id},k=d,q=2`, payload.toString("base64"));
}

export function videoSet(id: number, settings: { paused?: boolean; volume?: number }): string {
  const fields: Record<string, string | number> = {};
  if (settings.paused !== undefined) fields.pause = settings.paused ? 1 : 0;
  if (settings.volume !== undefined) fields.volume = Math.max(0, Math.min(1, settings.volume));
  return apc(`a=v,i=${id},k=s,q=1`, textPayload(fields));
}

/** A status query: its reply comes only after every byte before it was handled (an acknowledgement). */
export function videoQuery(id: number, seq: number): string {
  return apc(`a=v,i=${id},k=q`, textPayload({ seq }));
}

/** Close the video: playback stops and the decoder is freed. */
export function videoClose(id: number): string {
  return `${APC}a=d,d=I,i=${id},q=2${ST}`;
}

export interface VideoReply {
  id: number;
  ok: boolean;
  /** key=value fields after OK (seq, state, pos, shown, ...), or the error code. */
  fields: Record<string, string>;
  error?: string;
}

/** A reply to an `a=v` command (`ESC _ G i=<id>;OK ...` or `;CODE:...`), else null. */
export function parseVideoReply(sequence: string): VideoReply | null {
  const match = /^\x1b_Gi=(\d+);([^\x1b]*)\x1b\\$/.exec(sequence);
  if (!match) return null;
  const id = Number(match[1]);
  const body = match[2]!;
  if (body === "OK" || body.startsWith("OK ")) {
    const fields: Record<string, string> = {};
    for (const pair of body.slice(2).trim().split(/\s+/)) {
      const equals = pair.indexOf("=");
      if (equals > 0) fields[pair.slice(0, equals)] = pair.slice(equals + 1);
    }
    return { id, ok: true, fields };
  }
  return { id, ok: false, fields: {}, error: body.split(":")[0] ?? body };
}

/** A DA1 reply (`ESC [ ? ... c`): the terminal has answered everything sent before the DA1 request. */
export function isPrimaryDeviceAttributes(sequence: string): boolean {
  return /^\x1b\[\?[\d;]*c$/.test(sequence);
}
