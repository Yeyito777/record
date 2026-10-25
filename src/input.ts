/**
 * Terminal input parser.
 *
 * Lifted from the same general approach as Exocortex TUI, but trimmed down to
 * what record currently needs.
 */

import { StringDecoder } from "node:string_decoder";
import { nextGraphemeEnd } from "./editor-buffer";

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
    | "ctrl-o"
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

export interface MouseEvent {
  type: "mouse";
  /** 0=left, 1=middle, 2=right, 3=motion only, 64=wheel up, 65=wheel down. */
  button: number;
  /** 1-based terminal column. */
  col: number;
  /** 1-based terminal row. */
  row: number;
  action: "press" | "release" | "motion";
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

export type InputEvent = KeyEvent | MouseEvent;

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
  15: "ctrl-o",
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
  "111;5": "ctrl-o",
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
      case 111: return "ctrl-o";
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

/** Kitty keypad keys (numbers in the Unicode private-use area) sent without text. */
const KITTY_KEYPAD_CHARS: Record<number, string> = {
  57399: "0", 57400: "1", 57401: "2", 57402: "3", 57403: "4",
  57404: "5", 57405: "6", 57406: "7", 57407: "8", 57408: "9",
  57409: ".", 57410: "/", 57411: "*", 57412: "-", 57413: "+", 57415: "=", 57416: ",",
};
const KITTY_KEYPAD_KEYS: Record<number, KeyEvent["type"]> = {
  57417: "left", 57418: "right", 57419: "up", 57420: "down",
  57423: "home", 57424: "end", 57426: "delete",
};
const KITTY_KP_ENTER = 57414;

/** Kitty reports keys without a Unicode character (Shift, Caps Lock, F13…) in the private-use area. */
function isPrivateUseCodepoint(cp: number): boolean {
  return cp >= 0xE000 && cp <= 0xF8FF;
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

  const keyType = csiUKeyType(keyCode === KITTY_KP_ENTER ? 13 : keyCode, modifiers)
    ?? (modifiers === 1 ? KITTY_KEYPAD_KEYS[keyCode] : undefined);
  if (keyType) return { type: keyType, event };

  // With kitty keyboard protocol's all-keys + associated-text flags, printable
  // input (including releases) arrives as CSI u rather than raw UTF-8. Other
  // functional keys (modifiers, locks, F13+, media) are not text: their
  // private-use codes would type invisible characters (and Record draws
  // private-use characters as custom emoji).
  const plain = modifiers === 1 || modifiers === 2;
  const text = decodeCodepoints(fields[2])
    ?? (plain ? KITTY_KEYPAD_CHARS[keyCode] : undefined)
    ?? (plain && !isPrivateUseCodepoint(keyCode) ? String.fromCodePoint(keyCode) : null);
  if (text) return { type: "char", char: text, event };
  return null;
}

/**
 * Legacy CSI keys: ESC [ <number> ; <modifiers>[:<event>] <final>. The kitty
 * protocol reports repeats and releases of arrows, Home/End and ~ keys with
 * these parameters (a repeated Left is ESC [ 1;1:2 D). Only the modifier
 * combinations below are keys; others (Ctrl+Left, …) stay unmapped.
 */
function parseCsiKey(params: string, final: string): KeyEvent | null {
  const match = /^(\d*)(?:;(\d*)(?::(\d+))?)?$/.exec(params);
  if (!match) return null;
  const number = match[1] ? parseInt(match[1], 10) : 1;
  const modifiers = match[2] ? parseInt(match[2], 10) : 1;
  const event = match[3] === undefined ? undefined : KITTY_EVENT_TYPES[match[3]];
  if (match[3] !== undefined && !event) return null;
  const type = csiKeyType(number, modifiers, final);
  if (!type) return null;
  return event ? { type, event } : { type };
}

/** Function keys F17-F24: CSI NN;2~ (st maps Ctrl+4 through Ctrl+-). */
const SHIFTED_TILDE_KEYS: Partial<Record<number, KeyEvent["type"]>> = {
  15: "f17", 17: "f18", 18: "f19", 19: "f20", 20: "f21", 21: "f22", 23: "f23", 24: "f24",
};
const TILDE_KEYS: Partial<Record<number, KeyEvent["type"]>> = { 1: "home", 3: "delete", 4: "end" };
const LETTER_KEYS: Partial<Record<string, KeyEvent["type"]>> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab",
};
/** Function keys F14-F16: CSI 1;2Q/R/S (Shift+F1/F2/F3 — st maps Ctrl+1/2/3). */
const SHIFTED_LETTER_KEYS: Partial<Record<string, KeyEvent["type"]>> = { Q: "f14", R: "f15", S: "f16" };

function csiKeyType(number: number, modifiers: number, final: string): KeyEvent["type"] | null {
  if (final === "~") {
    if (modifiers === 1) return TILDE_KEYS[number] ?? null;
    if (modifiers === 2) return SHIFTED_TILDE_KEYS[number] ?? null;
    return null;
  }
  if (number !== 1) return null;
  if (modifiers === 1) return LETTER_KEYS[final] ?? null;
  if (modifiers === 2) return SHIFTED_LETTER_KEYS[final] ?? null;
  return null;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Strip modifier/motion bits from an SGR mouse button mask. */
const SGR_BUTTON_MASK = 0x43;

export class PasteBuffer {
  private buf = "";
  // A read can end inside a multibyte character (large pastes); decode across reads.
  private decoder = new StringDecoder("utf8");
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static TIMEOUT_MS = 2000;

  constructor(private readonly onFlush: (data: string) => void) {}

  feed(data: Buffer): string | null {
    this.buf += this.decoder.write(data);

    const startIdx = this.buf.indexOf(PASTE_START);
    if (startIdx === -1) return this.drain();
    if (this.buf.indexOf(PASTE_END, startIdx) !== -1) return this.drain();

    this.resetTimer();
    return null;
  }

  private drain(flushDecoder = false): string | null {
    if (flushDecoder) this.buf += this.decoder.end();
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
      const data = this.drain(true);
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
        // SGR mouse: ESC [ < Pb ; Px ; Py M (press/motion) or m (release).
        if (str[i + 2] === "<") {
          const pressEnd = str.indexOf("M", i + 3);
          const releaseEnd = str.indexOf("m", i + 3);
          let endPos = -1;
          let isRelease = false;
          if (pressEnd !== -1 && (releaseEnd === -1 || pressEnd < releaseEnd)) {
            endPos = pressEnd;
          } else if (releaseEnd !== -1) {
            endPos = releaseEnd;
            isRelease = true;
          }

          if (endPos !== -1) {
            const parts = str.slice(i + 3, endPos).split(";");
            if (parts.length === 3) {
              const cb = parseInt(parts[0] ?? "", 10);
              const col = parseInt(parts[1] ?? "", 10);
              const row = parseInt(parts[2] ?? "", 10);
              if (Number.isFinite(cb) && Number.isFinite(col) && Number.isFinite(row)) {
                const isMotion = Boolean(cb & 32);
                events.push({
                  type: "mouse",
                  button: cb & SGR_BUTTON_MASK,
                  col,
                  row,
                  action: isRelease ? "release" : isMotion ? "motion" : "press",
                  shift: Boolean(cb & 4),
                  meta: Boolean(cb & 8),
                  ctrl: Boolean(cb & 16),
                });
                i = endPos + 1;
                continue;
              }
            }
          }
        }

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

          // Standard CSI keys (arrows, Home/End, Delete, F14-F24), with
          // kitty repeat/release event types; unknown sequences are skipped.
          const csiEvent = parseCsiKey(params, final);
          if (csiEvent) events.push(csiEvent);
          i += seqLen;
          continue;
        }
      }

      events.push({ type: "escape" });
      i++;
      continue;
    }

    // Regular character. Consume the whole grapheme cluster so emoji and
    // composed characters arrive at the editor as one user-visible glyph
    // (r and f take a whole emoji, not half a surrogate pair).
    if (code >= 32) {
      const end = nextGraphemeEnd(str, i);
      events.push({ type: "char", char: str.slice(i, end) });
      i = end;
      continue;
    }

    events.push({ type: "unknown" });
    i++;
  }

  return events;
}
