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
    | "ctrl-q"
    | "ctrl-r"
    | "ctrl-s"
    | "ctrl-semicolon"
    | "ctrl-left-bracket"
    | "ctrl-right-bracket"
    | "ctrl-u"
    | "ctrl-v"
    | "ctrl-y"
    | "f14"
    | "f15"
    | "f16"
    | "f17"
    | "f18"
    | "f19"
    | "f20"
    | "f21"
    | "f22"
    | "f23"
    | "f24"
    | "escape"
    | "paste"
    | "unknown";
  char?: string;
  /** Kitty keyboard protocol event type when reported by the terminal. */
  event?: "press" | "repeat" | "release";
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
  17: "ctrl-q",
  18: "ctrl-r",
  19: "ctrl-s",
  21: "ctrl-u",
  22: "ctrl-v",
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
  "113;5": "ctrl-q",
  "114;5": "ctrl-r",
  "115;5": "ctrl-s",
  "59;5": "ctrl-semicolon",
  "91;5": "ctrl-left-bracket",
  "93;5": "ctrl-right-bracket",
  "117;5": "ctrl-u",
  "118;5": "ctrl-v",
  "121;5": "ctrl-y",
};

const KITTY_EVENT_TYPES: Record<string, NonNullable<KeyEvent["event"]>> = {
  "1": "press",
  "2": "repeat",
  "3": "release",
};

function decodeCodepoints(textField: string | undefined): string | null {
  if (!textField) return null;
  const chars: string[] = [];
  for (const part of textField.split(":")) {
    const cp = parseInt(part, 10);
    if (!Number.isFinite(cp)) return null;
    try {
      chars.push(String.fromCodePoint(cp));
    } catch {
      return null;
    }
  }
  return chars.join("");
}

function csiUKeyType(keyCode: number, modifiers: number): KeyEvent["type"] | null {
  if (keyCode === 13 && modifiers === 1) return "enter";
  if (keyCode === 13 && modifiers === 2) return "shift-enter";
  if (keyCode === 9 && modifiers === 1) return "tab";
  if (keyCode === 9 && modifiers === 2) return "backtab";
  if ((keyCode === 127 || keyCode === 8) && (modifiers === 1 || modifiers === 2)) return "backspace";
  if (keyCode === 27 && modifiers === 1) return "escape";
  if (modifiers === 5) {
    switch (keyCode) {
      case 98: return "ctrl-b";
      case 99: return "ctrl-c";
      case 100: return "ctrl-d";
      case 101: return "ctrl-e";
      case 102: return "ctrl-f";
      case 106: return "ctrl-j";
      case 107: return "ctrl-k";
      case 108: return "ctrl-l";
      case 109: return "ctrl-m";
      case 110: return "ctrl-n";
      case 113: return "ctrl-q";
      case 114: return "ctrl-r";
      case 115: return "ctrl-s";
      case 117: return "ctrl-u";
      case 118: return "ctrl-v";
      case 121: return "ctrl-y";
      case 59: return "ctrl-semicolon";
      case 91: return "ctrl-left-bracket";
      case 93: return "ctrl-right-bracket";
    }
  }
  return null;
}

function parseCsiU(params: string): KeyEvent | null {
  const legacyType = CSI_U_MAP[params];
  if (legacyType) return { type: legacyType };

  const fields = params.split(";");
  const keyCode = parseInt((fields[0] ?? "").split(":")[0] ?? "", 10);
  if (!Number.isFinite(keyCode)) return null;

  const modifierParts = (fields[1] ?? "1").split(":");
  const modifiers = parseInt(modifierParts[0] || "1", 10);
  if (!Number.isFinite(modifiers)) return null;
  const event = KITTY_EVENT_TYPES[modifierParts[1] ?? "1"] ?? "press";

  const keyType = csiUKeyType(keyCode, modifiers);
  if (keyType) return { type: keyType, event };

  // With kitty keyboard protocol's all-keys + associated-text flags, printable
  // input (including releases) arrives as CSI u rather than raw UTF-8.
  const text = decodeCodepoints(fields[2])
    ?? (modifiers === 1 || modifiers === 2 ? String.fromCodePoint(keyCode) : null);
  if (text) return { type: "char", char: text, event };
  return null;
}

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
            const parsed = parseCsiU(params);
            if (parsed) events.push(parsed);
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

          // Function keys F14-F16: CSI 1;2Q/R/S (Shift+F1/F2/F3 — st maps Ctrl+1/2/3)
          if (params === "1;2" && final === "Q") {
            events.push({ type: "f14" });
            i += seqLen;
            continue;
          }
          if (params === "1;2" && final === "R") {
            events.push({ type: "f15" });
            i += seqLen;
            continue;
          }
          if (params === "1;2" && final === "S") {
            events.push({ type: "f16" });
            i += seqLen;
            continue;
          }

          // Function keys F17-F24: CSI NN;2~ (st maps Ctrl+4 through Ctrl+-)
          if (params === "15;2" && final === "~") {
            events.push({ type: "f17" });
            i += seqLen;
            continue;
          }
          if (params === "17;2" && final === "~") {
            events.push({ type: "f18" });
            i += seqLen;
            continue;
          }
          if (params === "18;2" && final === "~") {
            events.push({ type: "f19" });
            i += seqLen;
            continue;
          }
          if (params === "19;2" && final === "~") {
            events.push({ type: "f20" });
            i += seqLen;
            continue;
          }
          if (params === "20;2" && final === "~") {
            events.push({ type: "f21" });
            i += seqLen;
            continue;
          }
          if (params === "21;2" && final === "~") {
            events.push({ type: "f22" });
            i += seqLen;
            continue;
          }
          if (params === "23;2" && final === "~") {
            events.push({ type: "f23" });
            i += seqLen;
            continue;
          }
          if (params === "24;2" && final === "~") {
            events.push({ type: "f24" });
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
