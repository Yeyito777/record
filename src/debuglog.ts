/**
 * Runtime debug logging to $XDG_CONFIG_HOME/record/debug.log.
 *
 * On unless RECORD_DEBUG=0/false. RECORD_DEBUG=verbose also records the
 * high-frequency call/voice events in VERBOSE_EVENTS. RECORD_DEBUG_LOG moves
 * the file. Lines are buffered and written in batches (never one write per
 * event on the UI thread), the buffer is flushed synchronously on exit, and
 * the file rotates to debug.log.1 at RECORD_DEBUG_LOG_MAX_BYTES (default
 * 16 MiB), so the log never exceeds roughly twice that on disk.
 */

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "fs";
import { dirname, join } from "path";

import { configDir } from "./config";

/** Events fired per voice packet batch, speaking flip or gateway voice state. */
const VERBOSE_EVENTS = new Set([
  "call.participants.voice_state_ignored",
  "call.widget.update",
  "call.widget.speaking",
  "voice.playback.stats",
  "voice.capture.speaking",
  "voice.gateway.webrtc_video_stats",
  "stream.media.video_stats",
]);

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const FLUSH_DELAY_MS = 250;
const FLUSH_BYTES = 64 * 1024;

interface DebugLogOptions {
  enabled: boolean;
  verbose: boolean;
  path: string;
  maxBytes: number;
}

let options: DebugLogOptions = optionsFromEnv(process.env);
let pending: string[] = [];
let pendingBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let fd: number | null = null;
let fileBytes = 0;
let exitHookInstalled = false;

function optionsFromEnv(env: NodeJS.ProcessEnv): DebugLogOptions {
  const mode = (env.RECORD_DEBUG ?? "").trim().toLowerCase();
  const maxBytes = Number(env.RECORD_DEBUG_LOG_MAX_BYTES);
  return {
    enabled: mode !== "0" && mode !== "false",
    verbose: mode === "verbose" || mode === "2",
    path: env.RECORD_DEBUG_LOG || join(configDir(), "debug.log"),
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
  };
}

export function debugLog(event: string, fields: Record<string, unknown> = {}): void {
  if (!options.enabled) return;
  if (!options.verbose && VERBOSE_EVENTS.has(event)) return;
  try {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...(redact(fields) as Record<string, unknown>) })}\n`;
    pending.push(line);
    pendingBytes += line.length;
  } catch {
    // Debug logging must never affect the UI/client.
    return;
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", flushDebugLog);
  }
  if (pendingBytes >= FLUSH_BYTES) {
    flushDebugLog();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushDebugLog, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }
}

/** Write buffered lines now. Safe to call at any time, including from exit hooks. */
export function flushDebugLog(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;
  const chunk = pending.join("");
  pending = [];
  pendingBytes = 0;
  try {
    if (fd === null) openLog();
    if (fileBytes > 0 && fileBytes + chunk.length > options.maxBytes) rotate();
    const bytes = Buffer.from(chunk);
    writeSync(fd!, bytes);
    fileBytes += bytes.length;
  } catch {
    // Debug logging must never affect the UI/client.
    closeLog();
  }
}

function openLog(): void {
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  fd = openSync(options.path, "a", 0o600);
  fileBytes = fstatSync(fd).size;
}

function rotate(): void {
  closeLog();
  renameSync(options.path, `${options.path}.1`);
  openLog();
}

function closeLog(): void {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
  fd = null;
  fileBytes = 0;
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
  return options.path;
}

/** Tests only: flush, close, and re-read options (from env unless overridden). */
export function resetDebugLogForTest(overrides: Partial<DebugLogOptions> = {}, env: NodeJS.ProcessEnv = process.env): void {
  flushDebugLog();
  closeLog();
  options = { ...optionsFromEnv(env), ...overrides };
}
