/**
 * The bridge's log: one line per event on stderr (Moon's keeper sends it to
 * /var/log/moon-social/SERVICE.log). Fields are ids, counts, states and
 * durations: never message text, names, tokens, cookies or URLs with
 * credentials in them. Callers keep to that; `safe` trims what slips in.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function safe(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}

export function formatLine(level: string, service: string, event: string, fields: LogFields = {}, now = new Date()): string {
  const parts = [now.toISOString(), level, service, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === "string" ? safe(value) : String(value);
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.join(" ");
}

export function createLogger(service: string, write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Logger {
  return {
    info: (event, fields) => write(formatLine("info", service, event, fields)),
    warn: (event, fields) => write(formatLine("warn", service, event, fields)),
    error: (event, fields) => write(formatLine("error", service, event, fields)),
  };
}

/** An error's message for the log: one line, short. */
export function errorText(error: unknown): string {
  return safe(error instanceof Error ? error.message : String(error));
}
