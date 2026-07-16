/**
 * Pure terminal QR rendering for WhatsApp's raw login payload.
 *
 * A terminal cell is roughly twice as tall as it is wide.  Rendering two QR
 * pixels per cell with Unicode half blocks therefore keeps modules square while
 * retaining the QR standard's four-module quiet zone.
 */

import QRCode from "qrcode";

export const QR_QUIET_ZONE_MODULES = 4;

const QR_COLORS = "\x1b[30;107m";
const ANSI_RESET = "\x1b[0m";

export interface UnicodeQrSize {
  /** Width of the encoded QR symbol, excluding the quiet zone. */
  moduleCount: number;
  /** Integer number of terminal QR pixels used for each source module. */
  scale: number;
  /** Terminal columns, including the quiet zone. */
  width: number;
  /** Terminal rows, including the quiet zone. */
  height: number;
  /** Quiet-zone width in source modules. */
  quietZone: number;
}

export interface UnicodeQrRender extends UnicodeQrSize {
  /** ANSI-styled rows. Every row has exactly `width` visible columns. */
  lines: string[];
}

interface QrMatrix {
  size: number;
  get(row: number, col: number): number;
}

function qrMatrix(value: string): QrMatrix {
  // Keep the library default-compatible M correction level explicit so output
  // remains stable if qrcode changes a renderer default in a future release.
  return QRCode.create(value, { errorCorrectionLevel: "M" }).modules;
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function renderedSide(moduleCount: number, scale: number): number {
  return (moduleCount + (QR_QUIET_ZONE_MODULES * 2)) * scale;
}

function sizeFor(moduleCount: number, scale: number): UnicodeQrSize {
  const pixelSide = renderedSide(moduleCount, scale);
  return {
    moduleCount,
    scale,
    width: pixelSide,
    height: Math.ceil(pixelSide / 2),
    quietZone: QR_QUIET_ZONE_MODULES,
  };
}

/** Return the minimum terminal area needed to render a complete QR at scale 1. */
export function measureUnicodeQr(value: string): UnicodeQrSize {
  return sizeFor(qrMatrix(value).size, 1);
}

function isDark(matrix: QrMatrix, pixelRow: number, pixelCol: number, scale: number): boolean {
  const quietPixels = QR_QUIET_ZONE_MODULES * scale;
  const matrixPixels = matrix.size * scale;
  const matrixRow = pixelRow - quietPixels;
  const matrixCol = pixelCol - quietPixels;

  if (matrixRow < 0 || matrixCol < 0 || matrixRow >= matrixPixels || matrixCol >= matrixPixels) {
    return false;
  }

  return matrix.get(Math.floor(matrixRow / scale), Math.floor(matrixCol / scale)) === 1;
}

function halfBlock(topDark: boolean, bottomDark: boolean): string {
  if (topDark && bottomDark) return "█";
  if (topDark) return "▀";
  if (bottomDark) return "▄";
  return " ";
}

/**
 * Render a raw QR value into the largest complete integer scale that fits.
 *
 * `null` means even scale 1 (including the mandatory quiet zone) cannot fit.
 * The function never crops or resamples the symbol.
 */
export function renderUnicodeQr(value: string, maxWidth: number, maxHeight: number): UnicodeQrRender | null {
  const widthLimit = normalizeLimit(maxWidth);
  const heightLimit = normalizeLimit(maxHeight);
  const matrix = qrMatrix(value);
  const sourceSide = matrix.size + (QR_QUIET_ZONE_MODULES * 2);
  let scale = Math.min(
    Math.floor(widthLimit / sourceSide),
    Math.floor((heightLimit * 2) / sourceSide),
  );

  // The ceil in terminal-row sizing matters when the scaled pixel side is odd.
  while (scale > 0 && Math.ceil((sourceSide * scale) / 2) > heightLimit) scale--;
  if (scale < 1) return null;

  const size = sizeFor(matrix.size, scale);
  const lines: string[] = [];
  for (let terminalRow = 0; terminalRow < size.height; terminalRow++) {
    const topPixelRow = terminalRow * 2;
    const bottomPixelRow = topPixelRow + 1;
    let glyphs = "";

    for (let pixelCol = 0; pixelCol < size.width; pixelCol++) {
      const top = isDark(matrix, topPixelRow, pixelCol, scale);
      // An odd final pixel row is paired with extra light area, never QR data.
      const bottom = bottomPixelRow < size.width && isDark(matrix, bottomPixelRow, pixelCol, scale);
      glyphs += halfBlock(top, bottom);
    }

    // Explicit black-on-bright-white colors make spaces part of the quiet zone
    // and avoid inheriting Record's dark application background.
    lines.push(`${QR_COLORS}${glyphs}${ANSI_RESET}`);
  }

  return { ...size, lines };
}
