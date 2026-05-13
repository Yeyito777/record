/**
 * Local in-app volume helpers.
 */

export const DEFAULT_LOCAL_VOLUME_PERCENT = 100;
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

export function clampVolumePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOCAL_VOLUME_PERCENT;
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

export function parseVolumePercent(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = value.trim().match(/^([+-]?\d+)%?$/);
  if (!match) return null;
  return clampVolumePercent(Number.parseInt(match[1] ?? "", 10));
}

export function volumePercentToLinear(volume: number): number {
  return clampVolumePercent(volume) / 100;
}

export function volumePercentToFilterValue(volume: number): string {
  const linear = volumePercentToLinear(volume);
  if (Number.isInteger(linear)) return String(linear);
  return linear.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
