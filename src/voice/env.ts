import { DEFAULT_SPEAKING_IDLE_MS, DEFAULT_SPEAKING_THRESHOLD_DB } from "./constants";

export function speakingThresholdDb(): number {
  const raw = process.env.RECORD_VOICE_SPEAKING_THRESHOLD_DB;
  if (!raw) return DEFAULT_SPEAKING_THRESHOLD_DB;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SPEAKING_THRESHOLD_DB;
}

export function speakingIdleMs(): number {
  const raw = process.env.RECORD_VOICE_SPEAKING_IDLE_MS;
  if (!raw) return DEFAULT_SPEAKING_IDLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SPEAKING_IDLE_MS;
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

export function linearToDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}
