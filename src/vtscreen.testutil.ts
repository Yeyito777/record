/**
 * Minimal VT screen model for renderer tests.
 *
 * Understands what Record's frames emit: CUP, EL, DECSTBM, SU/SD, LF at the
 * bottom margin, SGR (kept per cell as raw text), DECSC/DECRC, and skips
 * private modes, cursor styles and OSC strings. Kitty graphics placements
 * (APC G a=p / a=d) are tracked like st does: anchored to their cell, moved by
 * region scrolls and dropped when their anchor row scrolls out. Like st, the
 * second cell of a wide character keeps its previous attributes, and a
 * placement remembers the cells under it when it is first shown: if they
 * change later it is hidden (st's image occlusion), see visiblePlacements().
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
  /** The cells under it when first shown (st's occlusion baseline). */
  baseline?: string;
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
      // st keeps a placement's baseline while its identity (ids, cell, size) stays the same.
      const same = previous && previous.row === this.row && previous.col === this.col && previous.controls === rest;
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

  private cellsUnder(placement: VtPlacement): string {
    const field = (name: string, fallback: number) => {
      const match = new RegExp(`(?:^|,)${name}=(\\d+)`).exec(placement.controls);
      return match ? Number(match[1]) : fallback;
    };
    const columns = field("c", 1);
    const rows = field("r", 1);
    let cells = "";
    for (let row = placement.row; row < Math.min(this.rows, placement.row + rows); row++) {
      for (let col = placement.col; col < Math.min(this.cols, placement.col + columns); col++) {
        const cell = this.grid[row]![col]!;
        cells += `${cell.sgr}\u0000${cell.ch}\u0001`;
      }
    }
    return cells;
  }

  /** Placements first shown now remember the cells under them (st's occlusion baseline). */
  private snapshotPlacements(): void {
    for (const placement of this.placementsByKey.values()) placement.baseline ??= this.cellsUnder(placement);
  }

  /** Current placements, sorted by image, placement and position. */
  placements(): VtPlacement[] {
    return [...this.placementsByKey.values()]
      .map(({ baseline: _baseline, ...placement }) => ({ ...placement }))
      .sort((a, b) => a.imageId - b.imageId || a.placementId - b.placementId || a.row - b.row || a.col - b.col);
  }

  /** Placements st would draw: the cells under them are still the ones they were first shown over. */
  visiblePlacements(): VtPlacement[] {
    const visible = [...this.placementsByKey.values()].filter((placement) => placement.baseline === this.cellsUnder(placement));
    return visible
      .map(({ baseline: _baseline, ...placement }) => ({ ...placement }))
      .sort((a, b) => a.imageId - b.imageId || a.placementId - b.placementId || a.row - b.row || a.col - b.col);
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
