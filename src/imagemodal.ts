/** Centered full-resolution image viewer modal. */

import type { InlineChatImageReady } from "./inlineimage";
import { inlineImagePlacementId } from "./inlineimage";
import type { KeyEvent } from "./input";
import { moveTo } from "./terminal";
import type { InlineTerminalImagePlacement } from "./terminalimage";
import { theme } from "./theme";
import { padRight, termWidth, truncate } from "./textwidth";

const MARGIN_COLUMNS = 2;
const MARGIN_ROWS = 1;
const MODAL_EXTRA_COLUMNS = 4; // border plus one cell of padding on each side
const MODAL_EXTRA_ROWS = 4; // border, title, footer, border

export interface ImageModalState {
  filename: string;
  image: InlineChatImageReady;
}

export interface ImageModalLayout {
  top: number;
  left: number;
  width: number;
  height: number;
  placement: InlineTerminalImagePlacement;
}

export interface RenderedImageModal {
  payload: string;
  placement: InlineTerminalImagePlacement | null;
}

export type ImageModalKeyResult = { type: "close" } | { type: "handled" };

export function handleImageModalKey(key: Readonly<KeyEvent>): ImageModalKeyResult {
  return key.type === "escape" || key.type === "enter"
    ? { type: "close" }
    : { type: "handled" };
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function sanitizeDisplayText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function centeredText(value: string, width: number): string {
  const text = truncate(sanitizeDisplayText(value), width);
  const visible = termWidth(text);
  const left = Math.max(0, Math.floor((width - visible) / 2));
  return " ".repeat(left) + text + " ".repeat(Math.max(0, width - left - visible));
}

export function imageModalLayout(
  state: Readonly<ImageModalState>,
  totalRows: number,
  totalCols: number,
  cellWidthPixels = 8,
  cellHeightPixels = 16,
): ImageModalLayout | null {
  const rows = normalizeDimension(totalRows);
  const cols = normalizeDimension(totalCols);
  const outerMaxWidth = cols - (MARGIN_COLUMNS * 2);
  const outerMaxHeight = rows - (MARGIN_ROWS * 2);
  const maxColumns = outerMaxWidth - MODAL_EXTRA_COLUMNS;
  const maxRows = outerMaxHeight - MODAL_EXTRA_ROWS;
  if (maxColumns < 1 || maxRows < 1) return null;

  const pixelWidth = Math.max(1, state.image.pixelWidth);
  const pixelHeight = Math.max(1, state.image.pixelHeight);
  const cellWidth = Math.max(1, cellWidthPixels);
  const cellHeight = Math.max(1, cellHeightPixels);
  const scale = Math.min(
    1,
    (maxColumns * cellWidth) / pixelWidth,
    (maxRows * cellHeight) / pixelHeight,
  );
  const imageColumns = Math.max(1, Math.min(maxColumns, Math.ceil((pixelWidth * scale) / cellWidth)));
  const imageRows = Math.max(1, Math.min(maxRows, Math.ceil((pixelHeight * scale) / cellHeight)));
  const width = imageColumns + MODAL_EXTRA_COLUMNS;
  const height = imageRows + MODAL_EXTRA_ROWS;
  const top = Math.floor((rows - height) / 2) + 1;
  const left = Math.floor((cols - width) / 2) + 1;

  return {
    top,
    left,
    width,
    height,
    placement: {
      image: state.image,
      placementId: inlineImagePlacementId(state.image.imageId, "image-modal"),
      row: top + 2,
      col: left + 2,
      columns: imageColumns,
      rows: imageRows,
    },
  };
}

function tinyModal(rows: number, cols: number): string {
  if (rows < 1 || cols < 1) return "";
  const lines = ["Image viewer", "Resize terminal", "Enter / Esc close"];
  return lines.slice(0, rows).map((line, index) => (
    moveTo(index + 1, 1)
    + theme.sidebarBg + theme.warning
    + padRight(truncate(line, cols), cols)
    + theme.reset
  )).join("");
}

export function renderImageModal(
  state: Readonly<ImageModalState>,
  totalRows: number,
  totalCols: number,
  cellWidthPixels = 8,
  cellHeightPixels = 16,
): RenderedImageModal {
  const rows = normalizeDimension(totalRows);
  const cols = normalizeDimension(totalCols);
  const layout = imageModalLayout(state, rows, cols, cellWidthPixels, cellHeightPixels);
  if (!layout) return { payload: tinyModal(rows, cols), placement: null };

  const innerWidth = layout.width - 2;
  const border = theme.sidebarBg + theme.accent;
  const blank = " ".repeat(innerWidth);
  const title = `${state.filename} · ${state.image.pixelWidth}×${state.image.pixelHeight}`;
  const out: string[] = [
    moveTo(layout.top, layout.left) + border + `╭${"─".repeat(innerWidth)}╮` + theme.reset,
    moveTo(layout.top + 1, layout.left) + border + "│"
      + theme.sidebarBg + theme.text + centeredText(title, innerWidth)
      + theme.reset + border + "│" + theme.reset,
  ];

  for (let row = 0; row < layout.placement.rows; row++) {
    out.push(
      moveTo(layout.top + 2 + row, layout.left) + border + "│"
      + theme.sidebarBg + blank
      + theme.reset + border + "│" + theme.reset,
    );
  }
  out.push(
    moveTo(layout.top + 2 + layout.placement.rows, layout.left) + border + "│"
    + theme.sidebarBg + theme.muted + centeredText("Enter or Esc to close", innerWidth)
    + theme.reset + border + "│" + theme.reset,
  );
  out.push(
    moveTo(layout.top + layout.height - 1, layout.left)
    + border + `╰${"─".repeat(innerWidth)}╯` + theme.reset,
  );
  return { payload: out.join(""), placement: layout.placement };
}
