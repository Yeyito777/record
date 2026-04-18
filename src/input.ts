/**
 * Terminal input parser.
 *
 * Lifted from the same general approach as Exocortex TUI, but trimmed down to
 * what record currently needs.
 */

export interface KeyEvent {
  type:
    | "char"
    | "enter"
    | "tab"
    | "backtab"
    | "backspace"
    | "delete"
    | "left"
    | "right"
    | "home"
    | "end"
    | "up"
    | "down"
    | "ctrl-c"
    | "ctrl-m"
    | "ctrl-s"
    | "escape"
    | "paste"
    | "unknown";
  char?: string;
  text?: string;
}

export type InputEvent = KeyEvent;

const CSI_U_MAP: Record<string, KeyEvent["type"]> = {
  "13": "enter",
  "9": "tab",
  "9;2": "backtab",
  "127": "backspace",
  "27": "escape",
  "99;5": "ctrl-c",
  "109;5": "ctrl-m",
  "115;5": "ctrl-s",
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export class PasteBuffer {
  private buf = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static TIMEOUT_MS = 2000;

  constructor(private readonly onFlush: (data: string) => void) {}

  feed(data: Buffer): string | null {
    this.buf += data.toString("utf8");

    const startIdx = this.buf.indexOf(PASTE_START);
    if (startIdx === -1) return this.drain();
    if (this.buf.indexOf(PASTE_END, startIdx) !== -1) return this.drain();

    this.resetTimer();
    return null;
  }

  private drain(): string | null {
    if (!this.buf) return null;
    const out = this.buf;
    this.buf = "";
    this.clearTimer();
    return out;
  }

  private resetTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      const data = this.drain();
      if (data) this.onFlush(data);
    }, PasteBuffer.TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export function parseInput(data: Buffer | string): InputEvent[] {
  const str = typeof data === "string" ? data : data.toString("utf8");
  const events: InputEvent[] = [];
  let i = 0;

  while (i < str.length) {
    if (str.startsWith(PASTE_START, i)) {
      i += PASTE_START.length;
      const endIdx = str.indexOf(PASTE_END, i);
      if (endIdx === -1) {
        events.push({ type: "paste", text: str.slice(i) });
        break;
      }
      events.push({ type: "paste", text: str.slice(i, endIdx) });
      i = endIdx + PASTE_END.length;
      continue;
    }

    const code = str.charCodeAt(i);
    const ch = str[i];

    if (code === 9) {
      events.push({ type: "tab" });
      i++;
      continue;
    }
    if (code === 3) {
      events.push({ type: "ctrl-c" });
      i++;
      continue;
    }
    if (code === 19) {
      events.push({ type: "ctrl-s" });
      i++;
      continue;
    }
    if (code === 13) {
      events.push({ type: "enter" });
      i++;
      continue;
    }
    if (code === 127 || code === 8) {
      events.push({ type: "backspace" });
      i++;
      continue;
    }

    if (code === 27) {
      if (i + 1 >= str.length) {
        events.push({ type: "escape" });
        i++;
        continue;
      }

      if (str[i + 1] === "[") {
        let j = i + 2;
        while (j < str.length && (str.charCodeAt(j) < 0x40 || str.charCodeAt(j) > 0x7e)) j++;
        if (j < str.length) {
          const params = str.slice(i + 2, j);
          const final = str[j];
          const seqLen = j - i + 1;

          if (final === "u") {
            const mapped = CSI_U_MAP[params];
            if (mapped) events.push({ type: mapped });
            i += seqLen;
            continue;
          }

          if (params === "" && final === "A") {
            events.push({ type: "up" });
            i += seqLen;
            continue;
          }
          if (params === "" && final === "B") {
            events.push({ type: "down" });
            i += seqLen;
            continue;
          }
          if (params === "" && final === "C") {
            events.push({ type: "right" });
            i += seqLen;
            continue;
          }
          if (params === "" && final === "D") {
            events.push({ type: "left" });
            i += seqLen;
            continue;
          }
          if (params === "" && final === "H") {
            events.push({ type: "home" });
            i += seqLen;
            continue;
          }
          if (params === "" && final === "F") {
            events.push({ type: "end" });
            i += seqLen;
            continue;
          }
          if (params === "" && final === "Z") {
            events.push({ type: "backtab" });
            i += seqLen;
            continue;
          }
          if (params === "1" && final === "~") {
            events.push({ type: "home" });
            i += seqLen;
            continue;
          }
          if (params === "3" && final === "~") {
            events.push({ type: "delete" });
            i += seqLen;
            continue;
          }
          if (params === "4" && final === "~") {
            events.push({ type: "end" });
            i += seqLen;
            continue;
          }

          i += seqLen;
          continue;
        }
      }

      events.push({ type: "escape" });
      i++;
      continue;
    }

    if (code >= 32) {
      events.push({ type: "char", char: ch });
      i++;
      continue;
    }

    events.push({ type: "unknown" });
    i++;
  }

  return events;
}
