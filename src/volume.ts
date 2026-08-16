/**
 * Local in-app gain helpers. Gains are expressed in decibels where 0 dB is
 * neutral/default, negative values attenuate, and positive values boost.
 */

export const DEFAULT_LOCAL_GAIN_DB = 0;
export const DEFAULT_NOISE_SUPPRESSION_MODE: NoiseSuppressionMode = "off";
export const DEFAULT_REMOTE_USER_VOLUME_PERCENT = 100;
export const MIN_REMOTE_USER_VOLUME_PERCENT = 0;
export const MAX_REMOTE_USER_VOLUME_PERCENT = 200;
export const REMOTE_USER_VOLUME_FINE_STEP_PERCENT = 5;
export const REMOTE_USER_VOLUME_STEP_PERCENT = 10;

export type NoiseSuppressionMode = "off" | "simple";

export interface LocalAudioVolumes {
  micVolume: number;
  speakerVolume: number;
}

export type ParticipantVolumes = Record<string, number>;

export function normalizeRemoteUserVolumePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REMOTE_USER_VOLUME_PERCENT;
  const stepped = Math.round(value / REMOTE_USER_VOLUME_FINE_STEP_PERCENT) * REMOTE_USER_VOLUME_FINE_STEP_PERCENT;
  return Math.max(MIN_REMOTE_USER_VOLUME_PERCENT, Math.min(MAX_REMOTE_USER_VOLUME_PERCENT, stepped));
}

/** Normalize persisted per-participant volumes and omit neutral 100% entries. */
export function normalizeParticipantVolumes(value: unknown): ParticipantVolumes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const volumes: ParticipantVolumes = {};
  for (const [userId, volume] of Object.entries(value)) {
    if (!userId || typeof volume !== "number" || !Number.isFinite(volume)) continue;
    const normalized = normalizeRemoteUserVolumePercent(volume);
    if (normalized !== DEFAULT_REMOTE_USER_VOLUME_PERCENT) volumes[userId] = normalized;
  }
  return volumes;
}

export function parseNoiseSuppressionMode(value: string | undefined): NoiseSuppressionMode | null {
  switch (value?.trim().toLowerCase()) {
    case "off":
    case "none":
    case "0":
    case "false":
      return "off";
    case "simple":
    case "rnnoise":
    case "on":
    case "1":
    case "true":
      return "simple";
    default:
      return null;
  }
}

export function normalizeGainDb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOCAL_GAIN_DB;
  return value;
}

export function parseGainDb(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*dB)?$/i);
  if (!match) return null;
  const gain = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(gain)) return null;
  return normalizeGainDb(gain);
}

export function formatGainDb(gain: number): string {
  const normalized = normalizeGainDb(gain);
  if (Number.isInteger(normalized)) return String(normalized);
  return String(normalized).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatGainDbWithUnit(gain: number): string {
  return `${formatGainDb(gain)}dB`;
}

export function gainDbToLinear(gain: number): number {
  return 10 ** (normalizeGainDb(gain) / 20);
}
