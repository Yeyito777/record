/**
 * Minimal VT screen model for renderer tests.
 *
 * Understands what Record's frames emit: CUP, EL, DECSTBM, SU/SD, LF at the
 * bottom margin, SGR (kept per cell as its effective colors and flags, as st
 * compares cells), DECSC/DECRC, and skips
 * private modes, cursor styles and OSC strings. Kitty graphics placements
 * (APC G a=p / a=d) are tracked like st does: anchored to their cell, moved by
 * region scrolls and dropped when their anchor row scrolls out. Like st, the
 * second cell of a wide character keeps its previous attributes, and a
 * placement remembers each cell under it, per line, the first time it is
 * drawn over it: if one changes later st draws it over the image (image
 * occlusion), see visiblePlacements() and occlusions().
 */

import { termWidth } from "./textwidth";

interface Cell {
  ch: string;
  sgr: string;
}

/** A Kitty placement as the terminal holds it (zero-based anchor cell). */
export interface VtPlacement {
  imageId: number;
  placementId: number;
  row: number;
  col: number;
  /** The placement's other controls, e.g. `c=2,r=1,C=1,z=1478`. */
  controls: string;
  /**
   * st's occlusion baseline: per line (its identity moves with scrolls, like
   * st's Line) and column, the cell st first drew the placement over.
   */
  baseline?: WeakMap<Cell[], Map<number, string>>;
}

const SGR_FLAGS: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 7: 32, 8: 64, 9: 128, 21: 8 };
const SGR_CLEARS: Record<number, number> = { 22: 1 | 2, 23: 4, 24: 8, 25: 16, 27: 32, 28: 64, 29: 128 };

/**
 * The attributes after an SGR, as "flags|fg|bg" ("" when all are default):
 * cells compare by what st stores (colors and flags), not by the escapes
 * that set them.
 */
function applySgr(current: string, params: string): string {
  let [flags, fg, bg] = current ? current.split("|") as [string, string, string] : ["0", "", ""];
  let bits = Number(flags);
  const codes = (params === "" ? "0" : params).split(/[;:]/).map(Number);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) {
      bits = 0;
      fg = "";
      bg = "";
    } else if (code in SGR_FLAGS) {
      bits |= SGR_FLAGS[code]!;
    } else if (code in SGR_CLEARS) {
      bits &= ~SGR_CLEARS[code]!;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      fg = String(code);
    } else if (code === 39) {
      fg = "";
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      bg = String(code);
    } else if (code === 49) {
      bg = "";
    } else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      const length = mode === 5 ? 2 : mode === 2 ? 4 : 1;
      const color = codes.slice(i + 1, i + 1 + length).join(";");
      if (code === 38) fg = color;
      else bg = color;
      i += length;
    }
  }
  return bits === 0 && fg === "" && bg === "" ? "" : `${bits}|${fg}|${bg}`;
}

export class VtScreen {
  readonly grid: Cell[][];
  private row = 0;
  private col = 0;
  private top = 0;
  private bottom: number;
  private sgr = "";
  private saved = { row: 0, col: 0, sgr: "" };
  private readonly placementsByKey = new Map<string, VtPlacement>();
  private anonymousPlacements = 0;

  constructor(public rows: number, public cols: number) {
    this.bottom = rows - 1;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  /**
   * A terminal resize as st does it on the alternate screen: rows stay
   * top-anchored and are cut or padded, placements on rows that remain are
   * kept (re-anchored, so they take a new occlusion baseline) and the rest
   * are dropped. Margins reset to the full screen.
   */
  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.grid.splice(rows);
    for (const line of this.grid) {
      line.splice(cols);
      while (line.length < cols) line.push(this.blankCell());
    }
    while (this.grid.length < rows) this.grid.push(this.blankRow());
    this.top = 0;
    this.bottom = rows - 1;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, cols - 1);
    for (const [key, placement] of this.placementsByKey) {
      if (placement.row >= rows) this.placementsByKey.delete(key);
      else placement.baseline = undefined;
    }
    // st draws the resized screen before the application repaints it.
    this.snapshotPlacements();
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
    this.movePlacements(-n);
  }

  private scrollDown(n: number): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, this.blankRow());
    }
    this.movePlacements(n);
  }

  private movePlacements(rows: number): void {
    for (const [key, placement] of this.placementsByKey) {
      if (placement.row < this.top || placement.row > this.bottom) continue;
      placement.row += rows;
      if (placement.row < this.top || placement.row > this.bottom) this.placementsByKey.delete(key);
    }
  }

  private graphics(body: string): void {
    const controls = new Map(body.split(";", 1)[0]!.split(",").map((field) => {
      const equals = field.indexOf("=");
      return [field.slice(0, equals), field.slice(equals + 1)] as const;
    }));
    const action = controls.get("a");
    const imageId = Number(controls.get("i") ?? 0);
    const placementId = Number(controls.get("p") ?? 0);
    if (action === "p") {
      const rest = [...controls].filter(([name]) => !["a", "i", "p", "q"].includes(name)).map(([name, value]) => `${name}=${value}`).join(",");
      const key = placementId ? `${imageId}:${placementId}` : `${imageId}:anon${++this.anonymousPlacements}`;
      const previous = this.placementsByKey.get(key);
      // st keeps a placement's baseline while its identity (ids, anchor, size,
      // crop) stays the same; selecting it (V=1) does not change it.
      const identity = (controls: string) => controls.split(",").filter((field) => field !== "V=1").join(",");
      const same = previous && previous.row === this.row && previous.col === this.col && identity(previous.controls) === identity(rest);
      this.placementsByKey.set(key, { imageId, placementId, row: this.row, col: this.col, controls: rest, baseline: same ? previous.baseline : undefined });
      return;
    }
    if (action !== "d") return;
    const what = controls.get("d") ?? "a";
    for (const [key, placement] of this.placementsByKey) {
      const remove = what === "a" || what === "A"
        || ((what === "i" || what === "I") && placement.imageId === imageId && (!placementId || placement.placementId === placementId))
        || (what === "z" && placement.controls.split(",").includes(`z=${controls.get("z")}`))
        || ((what === "r" || what === "R") && placement.imageId >= Number(controls.get("x")) && placement.imageId <= Number(controls.get("y")));
      if (remove) this.placementsByKey.delete(key);
    }
  }

  /** The cells a placement covers on screen, with the line each is on. */
  private cellsUnder(placement: VtPlacement): { line: Cell[]; row: number; col: number; value: string }[] {
    const field = (name: string, fallback: number) => {
      const match = new RegExp(`(?:^|,)${name}=(\\d+)`).exec(placement.controls);
      return match ? Number(match[1]) : fallback;
    };
    const columns = field("c", 1);
    const rows = field("r", 1);
    const cells: { line: Cell[]; row: number; col: number; value: string }[] = [];
    for (let row = placement.row; row < Math.min(this.rows, placement.row + rows); row++) {
      const line = this.grid[row]!;
      for (let col = placement.col; col < Math.min(this.cols, placement.col + columns); col++) {
        cells.push({ line, row, col, value: `${line[col]!.sgr}\u0000${line[col]!.ch}` });
      }
    }
    return cells;
  }

  private static selected(placement: VtPlacement): boolean {
    return placement.controls.split(",").includes("V=1");
  }

  /**
   * st draws the frame: each placement remembers the cells it is drawn over
   * the first time, per line. A selected placement never snapshots cells.
   */
  private snapshotPlacements(): void {
    for (const placement of this.placementsByKey.values()) {
      if (VtScreen.selected(placement)) continue;
      const baseline = placement.baseline ??= new WeakMap();
      for (const { line, col, value } of this.cellsUnder(placement)) {
        let cells = baseline.get(line);
        if (!cells) baseline.set(line, cells = new Map());
        if (!cells.has(col)) cells.set(col, value);
      }
    }
  }

  /** The first cell st would draw over the placement (it changed since first drawn), if any. */
  private changedCell(placement: VtPlacement): { row: number; col: number; before: string; after: string } | null {
    if (VtScreen.selected(placement)) return null;
    for (const { line, row, col, value } of this.cellsUnder(placement)) {
      const before = placement.baseline?.get(line)?.get(col);
      if (before !== undefined && before !== value) return { row, col, before: JSON.stringify(before), after: JSON.stringify(value) };
    }
    return null;
  }

  /** Current placements, sorted by image, placement and position. */
  placements(): VtPlacement[] {
    return [...this.placementsByKey.values()]
      .map(({ baseline: _baseline, ...placement }) => ({ ...placement }))
      .sort((a, b) => a.imageId - b.imageId || a.placementId - b.placementId || a.row - b.row || a.col - b.col);
  }

  /** Placements st draws whole: no cell under them changed since it was first drawn over. */
  visiblePlacements(): VtPlacement[] {
    const visible = [...this.placementsByKey.values()].filter((placement) => !this.changedCell(placement));
    return visible
      .map(({ baseline: _baseline, ...placement }) => ({ ...placement }))
      .sort((a, b) => a.imageId - b.imageId || a.placementId - b.placementId || a.row - b.row || a.col - b.col);
  }

  /** Placements st would partly hide, with their first changed cell. */
  occlusions(): { imageId: number; placementId: number; row: number; col: number; cell: { row: number; col: number; before: string; after: string } }[] {
    const result: ReturnType<VtScreen["occlusions"]> = [];
    for (const placement of this.placementsByKey.values()) {
      const cell = this.changedCell(placement);
      if (cell) result.push({ imageId: placement.imageId, placementId: placement.placementId, row: placement.row, col: placement.col, cell });
    }
    return result;
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
        this.sgr = applySgr(this.sgr, params);
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
          // APC/OSC: skip to ST (ESC \) or BEL; track Kitty graphics placements.
          const st = data.indexOf("\x1b\\", i + 2);
          const bel = next === "]" ? data.indexOf("\x07", i + 2) : -1;
          const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st + 2;
          if (end <= i) throw new Error("VtScreen: unterminated string");
          if (next === "_" && data[i + 2] === "G") this.graphics(data.slice(i + 3, st));
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
        // Like st, the dummy half of a wide character keeps its previous attributes.
        if (width === 2 && this.col + 1 < this.cols) this.grid[this.row]![this.col + 1] = { ch: "", sgr: this.grid[this.row]![this.col + 1]!.sgr };
      }
      this.col = Math.min(this.cols, this.col + width);
    }
    this.snapshotPlacements();
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
