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
    | "shift-enter"
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
    | "ctrl-b"
    | "ctrl-c"
    | "ctrl-d"
    | "ctrl-e"
    | "ctrl-f"
    | "ctrl-j"
    | "ctrl-k"
    | "ctrl-l"
    | "ctrl-m"
    | "ctrl-n"
    | "ctrl-r"
    | "ctrl-s"
    | "ctrl-semicolon"
    | "ctrl-left-bracket"
    | "ctrl-right-bracket"
    | "ctrl-u"
    | "ctrl-y"
    | "escape"
    | "paste"
    | "unknown";
  char?: string;
  text?: string;
}

export type InputEvent = KeyEvent;

const CONTROL_BYTE_MAP: Partial<Record<number, KeyEvent["type"]>> = {
  2: "ctrl-b",
  3: "ctrl-c",
  4: "ctrl-d",
  5: "ctrl-e",
  6: "ctrl-f",
  9: "tab",
  10: "ctrl-j",
  11: "ctrl-k",
  12: "ctrl-l",
  13: "enter",
  14: "ctrl-n",
  18: "ctrl-r",
  19: "ctrl-s",
  21: "ctrl-u",
  25: "ctrl-y",
  29: "ctrl-right-bracket",
  127: "backspace",
};

const CSI_U_MAP: Record<string, KeyEvent["type"]> = {
  "13": "enter",
  "13;2": "shift-enter",
  "9": "tab",
  "9;2": "backtab",
  "127": "backspace",
  "27": "escape",
  "98;5": "ctrl-b",
  "99;5": "ctrl-c",
  "100;5": "ctrl-d",
  "101;5": "ctrl-e",
  "102;5": "ctrl-f",
  "106;5": "ctrl-j",
  "107;5": "ctrl-k",
  "108;5": "ctrl-l",
  "109;5": "ctrl-m",
  "110;5": "ctrl-n",
  "114;5": "ctrl-r",
  "115;5": "ctrl-s",
  "59;5": "ctrl-semicolon",
  "91;5": "ctrl-left-bracket",
  "93;5": "ctrl-right-bracket",
  "117;5": "ctrl-u",
  "121;5": "ctrl-y",
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

    const controlType = CONTROL_BYTE_MAP[code] ?? (code === 8 ? "backspace" : undefined);
    if (controlType) {
      events.push({ type: controlType });
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
