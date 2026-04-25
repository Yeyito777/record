/**
 * Opt-in runtime debug logging.
 */

import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import { configDir } from "./config";

const enabled = process.env.RECORD_DEBUG !== "0" && process.env.RECORD_DEBUG !== "false";
const logPath = process.env.RECORD_DEBUG_LOG || join(configDir(), "debug.log");

export function debugLog(event: string, fields: Record<string, unknown> = {}): void {
  if (!enabled) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...(redact(fields) as Record<string, unknown>) })}\n`, { mode: 0o600 });
  } catch {
    // Debug logging must never affect the UI/client.
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|authorization|password/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redact(entry);
    }
  }
  return result;
}

export function debugLogPath(): string {
  return logPath;
}
