import { DEFAULT_SPEAKING_IDLE_MS, DEFAULT_SPEAKING_STOP_THRESHOLD_DB, DEFAULT_SPEAKING_THRESHOLD_DB } from "./constants";

export function speakingThresholdDb(): number {
  return speakingStartThresholdDb();
}

export function speakingStartThresholdDb(): number {
  const raw = process.env.RECORD_VOICE_SPEAKING_START_THRESHOLD_DB ?? process.env.RECORD_VOICE_SPEAKING_THRESHOLD_DB;
  if (!raw) return DEFAULT_SPEAKING_THRESHOLD_DB;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SPEAKING_THRESHOLD_DB;
}

export function speakingStopThresholdDb(): number {
  const start = speakingStartThresholdDb();
  const raw = process.env.RECORD_VOICE_SPEAKING_STOP_THRESHOLD_DB;
  if (!raw) return Math.min(start, DEFAULT_SPEAKING_STOP_THRESHOLD_DB);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(start, parsed) : Math.min(start, DEFAULT_SPEAKING_STOP_THRESHOLD_DB);
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
