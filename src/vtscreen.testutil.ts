/**
 * Minimal VT screen model for renderer tests.
 *
 * Understands what Record's frames emit: CUP, EL, DECSTBM, SU/SD, LF at the
 * bottom margin, SGR (kept per cell as raw text), DECSC/DECRC, and skips
 * private modes, cursor styles, APC graphics and OSC strings.
 */

import { termWidth } from "./textwidth";

interface Cell {
  ch: string;
  sgr: string;
}

export class VtScreen {
  readonly grid: Cell[][];
  private row = 0;
  private col = 0;
  private top = 0;
  private bottom: number;
  private sgr = "";
  private saved = { row: 0, col: 0, sgr: "" };

  constructor(readonly rows: number, readonly cols: number) {
    this.bottom = rows - 1;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  private blankCell(): Cell {
    return { ch: " ", sgr: this.sgr };
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.cols }, () => this.blankCell());
  }

  private scrollUp(n: number): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.top, 1);
      this.grid.splice(this.bottom, 0, this.blankRow());
    }
  }

  private scrollDown(n: number): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, this.blankRow());
    }
  }

  private csi(params: string, final: string): void {
    if (params.startsWith("?") || params.endsWith(" ") || params.startsWith(">") || params.startsWith("<")) return;
    const args = params === "" ? [] : params.split(";").map((value) => Number(value));
    const n = Math.max(1, args[0] || 1);
    switch (final) {
      case "H":
        this.row = Math.min(this.rows - 1, Math.max(0, (args[0] || 1) - 1));
        this.col = Math.min(this.cols - 1, Math.max(0, (args[1] || 1) - 1));
        return;
      case "K": {
        const mode = args[0] ?? 0;
        const from = mode === 0 ? this.col : 0;
        const to = mode === 1 ? this.col : this.cols - 1;
        for (let c = from; c <= to; c++) this.grid[this.row]![c] = this.blankCell();
        return;
      }
      case "r":
        this.top = args[0] ? args[0] - 1 : 0;
        this.bottom = args[1] ? args[1] - 1 : this.rows - 1;
        this.row = 0;
        this.col = 0;
        return;
      case "S":
        this.scrollUp(n);
        return;
      case "T":
        this.scrollDown(n);
        return;
      case "m":
        this.sgr = params === "" || params === "0" ? "" : this.sgr + `[${params}m`;
        return;
      default:
        throw new Error(`VtScreen: unsupported CSI ${JSON.stringify(params + final)}`);
    }
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        const next = data[i + 1];
        if (next === "[") {
          const match = /^\x1b\[([0-9;?<> ]*)([@-~])/.exec(data.slice(i, i + 64));
          if (!match) throw new Error(`VtScreen: bad CSI at ${JSON.stringify(data.slice(i, i + 16))}`);
          this.csi(match[1]!, match[2]!);
          i += match[0].length;
        } else if (next === "_" || next === "]") {
          // APC/OSC: skip to ST (ESC \) or BEL.
          const st = data.indexOf("\x1b\\", i + 2);
          const bel = next === "]" ? data.indexOf("\x07", i + 2) : -1;
          const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st + 2;
          if (end <= i) throw new Error("VtScreen: unterminated string");
          i = end;
        } else if (next === "7") {
          this.saved = { row: this.row, col: this.col, sgr: this.sgr };
          i += 2;
        } else if (next === "8") {
          ({ row: this.row, col: this.col, sgr: this.sgr } = this.saved);
          i += 2;
        } else {
          throw new Error(`VtScreen: unsupported escape ${JSON.stringify(data.slice(i, i + 4))}`);
        }
        continue;
      }
      if (ch === "\n") {
        if (this.row === this.bottom) this.scrollUp(1);
        else this.row = Math.min(this.rows - 1, this.row + 1);
        i++;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      const codePoint = data.codePointAt(i)!;
      const glyph = String.fromCodePoint(codePoint);
      i += glyph.length;
      const width = termWidth(glyph);
      if (width === 0) continue;
      if (this.col < this.cols) {
        this.grid[this.row]![this.col] = { ch: glyph, sgr: this.sgr };
        if (width === 2 && this.col + 1 < this.cols) this.grid[this.row]![this.col + 1] = { ch: "", sgr: this.sgr };
      }
      this.col = Math.min(this.cols, this.col + width);
    }
  }

  /** Visible text per row, trailing spaces trimmed. */
  text(): string[] {
    return this.grid.map((row) => row.map((cell) => cell.ch).join("").trimEnd());
  }

  /** Text plus attributes, for exact screen comparison. */
  snapshot(): string {
    return this.grid.map((row) => row.map((cell) => `${cell.sgr}${cell.ch}`).join("")).join("\n");
  }
}
