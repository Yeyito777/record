/**
 * Remove terminal control protocols from provider-controlled text before it is
 * interpolated into Record's ANSI frame. This handles complete and malformed
 * ECMA-48 CSI/string-control sequences, not merely color (SGR) escapes.
 */
export function sanitizeTerminalText(value: string, options: { multiline?: boolean } = {}): string {
  const multiline = options.multiline ?? false;
  let result = "";

  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);

    if (code === 0x1b) {
      index = skipEscapeSequence(value, index);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(value, index + 1);
      continue;
    }
    if (code === 0x9d) {
      index = skipStringControl(value, index + 1, true);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipStringControl(value, index + 1, false);
      continue;
    }

    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      if (multiline && code === 0x0a) result += "\n";
      else if (code === 0x09 || (!multiline && (code === 0x0a || code === 0x0d))) result += " ";
      index += 1;
      continue;
    }

    result += value[index];
    index += 1;
  }

  return result;
}

/** One-line identity/sidebar text with bidi overrides removed to avoid spoofing. */
export function sanitizeTerminalLabel(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function skipEscapeSequence(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  if (Number.isNaN(next)) return value.length;
  if (next === 0x5b) return skipCsi(value, start + 2); // ESC [
  if (next === 0x5d) return skipStringControl(value, start + 2, true); // ESC ]
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipStringControl(value, start + 2, false); // DCS, SOS, PM, APC
  }

  // Ordinary two-byte ESC controls may contain intermediate bytes before a
  // final byte. Consume the entire control so no designation fragment leaks.
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index++);
    if (code >= 0x30 && code <= 0x7e) break;
  }
  return index;
}

function skipCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index++);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length;
}

function skipStringControl(value: string, start: number, bellTerminates: boolean): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (bellTerminates && code === 0x07) return index + 1;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return value.length;
}
