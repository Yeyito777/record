/**
 * Local in-app gain helpers. Gains are expressed in decibels where 0 dB is
 * neutral/default, negative values attenuate, and positive values boost.
 */

export const DEFAULT_LOCAL_GAIN_DB = 0;
export const DEFAULT_NOISE_SUPPRESSION_MODE: NoiseSuppressionMode = "off";

export type NoiseSuppressionMode = "off" | "simple";

export interface LocalAudioVolumes {
  micVolume: number;
  speakerVolume: number;
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
