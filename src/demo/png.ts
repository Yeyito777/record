/**
 * Tiny deterministic PNG painter for demo mode: server icons, avatars, custom
 * emoji and inline image attachments are all drawn locally, never downloaded.
 */

import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA canvas with just enough drawing primitives for recognisable test art. */
export class Canvas {
  readonly pixels: Uint8Array;

  constructor(readonly width: number, readonly height: number) {
    this.pixels = new Uint8Array(width * height * 4);
  }

  set(x: number, y: number, [r, g, b]: Rgb, alpha = 255): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    if (alpha >= 255) {
      this.pixels[i] = r;
      this.pixels[i + 1] = g;
      this.pixels[i + 2] = b;
      this.pixels[i + 3] = 255;
      return;
    }
    const a = alpha / 255;
    this.pixels[i] = Math.round(r * a + this.pixels[i]! * (1 - a));
    this.pixels[i + 1] = Math.round(g * a + this.pixels[i + 1]! * (1 - a));
    this.pixels[i + 2] = Math.round(b * a + this.pixels[i + 2]! * (1 - a));
    this.pixels[i + 3] = Math.max(this.pixels[i + 3]!, alpha);
  }

  /** Diagonal two-colour gradient across the whole canvas. */
  gradient(from: Rgb, to: Rgb): void {
    const span = Math.max(1, this.width + this.height - 2);
    const pixels = this.pixels;
    for (let y = 0; y < this.height; y += 1) {
      let i = y * this.width * 4;
      for (let x = 0; x < this.width; x += 1, i += 4) {
        const t = (x + y) / span;
        pixels[i] = from[0] + (to[0] - from[0]) * t;
        pixels[i + 1] = from[1] + (to[1] - from[1]) * t;
        pixels[i + 2] = from[2] + (to[2] - from[2]) * t;
        pixels[i + 3] = 255;
      }
    }
  }

  fillRect(x0: number, y0: number, w: number, h: number, color: Rgb, alpha = 255): void {
    const x1 = Math.min(this.width, Math.round(x0 + w));
    const y1 = Math.min(this.height, Math.round(y0 + h));
    for (let y = Math.max(0, Math.round(y0)); y < y1; y += 1) {
      for (let x = Math.max(0, Math.round(x0)); x < x1; x += 1) this.set(x, y, color, alpha);
    }
  }

  fillCircle(cx: number, cy: number, radius: number, color: Rgb, alpha = 255): void {
    const r2 = radius * radius;
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.height - 1, Math.ceil(cy + radius)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.width - 1, Math.ceil(cx + radius)); x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, color, alpha);
      }
    }
  }

  /** Clear everything outside a centred circle (round avatars). */
  maskCircle(): void {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const r2 = Math.min(cx, cy) ** 2;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r2) this.pixels[(y * this.width + x) * 4 + 3] = 0;
      }
    }
  }

  /** Draw text with the built-in 5x7 font; `scale` is pixels per font dot. */
  text(text: string, x0: number, y0: number, scale: number, color: Rgb): void {
    let x = x0;
    for (const char of text.toUpperCase()) {
      const glyph = FONT[char] ?? FONT["?"]!;
      for (let row = 0; row < 7; row += 1) {
        const bits = glyph[row]!;
        for (let col = 0; col < 5; col += 1) {
          if (bits[col] === "#") this.fillRect(x + col * scale, y0 + row * scale, scale, scale, color);
        }
      }
      x += 6 * scale;
    }
  }

  /** Centre `text` horizontally and vertically, scaled to fit `maxWidthFraction`. */
  centeredText(text: string, color: Rgb, maxWidthFraction = 0.7, maxHeightFraction = 0.5): void {
    const columns = Math.max(1, text.length * 6 - 1);
    const scale = Math.max(1, Math.floor(Math.min(
      (this.width * maxWidthFraction) / columns,
      (this.height * maxHeightFraction) / 7,
    )));
    const w = columns * scale;
    const h = 7 * scale;
    this.text(text, Math.round((this.width - w) / 2), Math.round((this.height - h) / 2), scale, color);
  }

  encode(): Buffer {
    const stride = this.width * 4;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (stride + 1)] = 0;
      Buffer.from(this.pixels.buffer, this.pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 1 })),
      chunk("IEND", new Uint8Array(0)),
    ]);
  }
}

export function hexColor(hex: number): Rgb {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function lighten([r, g, b]: Rgb, amount: number): Rgb {
  return [r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount].map(Math.round) as unknown as Rgb;
}

function darken([r, g, b]: Rgb, amount: number): Rgb {
  return [r * (1 - amount), g * (1 - amount), b * (1 - amount)].map(Math.round) as unknown as Rgb;
}

/** Rounded-square server icon with up to three initials. */
export function renderIcon(label: string, color: Rgb, size = 128, round = false): Buffer {
  const canvas = new Canvas(size, size);
  canvas.gradient(lighten(color, 0.15), darken(color, 0.25));
  canvas.fillCircle(size * 0.8, size * 0.18, size * 0.22, lighten(color, 0.45), 90);
  canvas.centeredText(label.slice(0, 3), [255, 255, 255], 0.72, 0.42);
  if (round) {
    canvas.maskCircle();
  } else {
    // Rounded corners, like Discord's server pills.
    const r = size * 0.22;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const cx = x < r ? r : x >= size - r ? size - r : x + 0.5;
        const cy = y < r ? r : y >= size - r ? size - r : y + 0.5;
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r * r) canvas.pixels[(y * size + x) * 4 + 3] = 0;
      }
    }
  }
  return canvas.encode();
}

/** Inline "photo": gradient, a few shapes, and its own size printed on it. */
export function renderPicture(width: number, height: number, from: Rgb, to: Rgb, seed: number): Buffer {
  const canvas = new Canvas(width, height);
  canvas.gradient(from, to);
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const short = Math.min(width, height);
  for (let i = 0; i < 6; i += 1) {
    const shade = next() > 0.5 ? lighten(to, 0.5) : darken(from, 0.3);
    if (next() > 0.4) {
      canvas.fillCircle(next() * width, next() * height, short * (0.08 + next() * 0.25), shade, 150);
    } else {
      canvas.fillRect(next() * width * 0.8, next() * height * 0.8, width * (0.1 + next() * 0.3), height * (0.08 + next() * 0.2), shade, 140);
    }
  }
  // A thin frame makes the image edges obvious against the terminal.
  canvas.fillRect(0, 0, width, Math.max(1, short / 100), [255, 255, 255], 200);
  canvas.fillRect(0, height - Math.max(1, short / 100), width, Math.max(1, short / 100), [255, 255, 255], 200);
  canvas.fillRect(0, 0, Math.max(1, short / 100), height, [255, 255, 255], 200);
  canvas.fillRect(width - Math.max(1, short / 100), 0, Math.max(1, short / 100), height, [255, 255, 255], 200);
  canvas.centeredText(`${width}x${height}`, [255, 255, 255], 0.8, 0.3);
  return canvas.encode();
}

/* 5x7 bitmap font: digits, letters and a little punctuation. */
const FONT: Record<string, string[]> = {
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
  D: ["###  ", "#  # ", "#   #", "#   #", "#   #", "#  # ", "###  "],
  E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  G: [" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ####"],
  H: ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  I: [" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  J: ["  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "],
  K: ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"],
  N: ["#   #", "#   #", "##  #", "# # #", "#  ##", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  Q: [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  R: ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "#   #", "# # #", "# # #", "# # #", " # # "],
  X: ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  Y: ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
  "?": [" ### ", "#   #", "    #", "   # ", "  #  ", "     ", "  #  "],
  "!": ["  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "     ", "  #  "],
  "#": [" # # ", " # # ", "#####", " # # ", "#####", " # # ", " # # "],
  "+": ["     ", "  #  ", "  #  ", "#####", "  #  ", "  #  ", "     "],
  "-": ["     ", "     ", "     ", "#####", "     ", "     ", "     "],
  ".": ["     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "],
  ":": ["     ", " ##  ", " ##  ", "     ", " ##  ", " ##  ", "     "],
};
