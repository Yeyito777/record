/** Centered full-resolution image viewer modal. */

import type { DiscordMessageAttachment } from "./discord";
import type { InlineChatImageReady } from "./inlineimage";
import { fitPictureCells, inlineImagePlacementId } from "./inlineimage";
import type { KeyEvent } from "./input";
import { moveTo } from "./terminal";
import type { InlineTerminalImagePlacement } from "./terminalimage";
import { theme } from "./theme";
import { padRight, termWidth, truncate } from "./textwidth";

const MARGIN_COLUMNS = 2;
const MARGIN_ROWS = 1;
const MODAL_EXTRA_COLUMNS = 4; // border plus one cell of padding on each side
const MODAL_EXTRA_ROWS = 4; // border, title, footer, border

/**
 * Pixel geometry the viewer is laid out for. It is chosen once when the viewer
 * opens, so upgrading preview pixels to the full image never resizes the box.
 */
export interface ImageModalFrame {
  pixelWidth: number;
  pixelHeight: number;
  /** Fill the viewer: the source size is unknown, only its aspect ratio. */
  enlarge: boolean;
}

export interface ImageModalState {
  filename: string;
  image: InlineChatImageReady;
  /** Defaults to the current image at native size. */
  frame?: ImageModalFrame;
  loading?: boolean;
  preview?: boolean;
  /** The chat picture shown (for stepping through its message's pictures). */
  attachmentId?: string;
  /** The message's pictures (an album): which one this is, of how many. */
  album?: { index: number; count: number };
}

/** Accept provider metadata only if it describes the decoded preview's shape. */
function metadataMatchesPreview(
  width: number,
  height: number,
  preview: Pick<InlineChatImageReady, "pixelWidth" | "pixelHeight">,
): boolean {
  // Bounded previews round one axis to whole pixels. EXIF-rotated or otherwise
  // stale metadata has a different shape and would stretch the image.
  const tolerance = 2;
  return width >= preview.pixelWidth
    && height >= preview.pixelHeight
    && (Math.abs((preview.pixelWidth * height) / width - preview.pixelHeight) <= tolerance
      || Math.abs((preview.pixelHeight * width) / height - preview.pixelWidth) <= tolerance);
}

export function imageModalFrame(
  preview: Pick<InlineChatImageReady, "pixelWidth" | "pixelHeight" | "sourcePixelWidth" | "sourcePixelHeight">,
  metadata: Pick<DiscordMessageAttachment, "width" | "height"> = {},
): ImageModalFrame {
  if (preview.sourcePixelWidth && preview.sourcePixelHeight) {
    return { pixelWidth: preview.sourcePixelWidth, pixelHeight: preview.sourcePixelHeight, enlarge: false };
  }
  const { width, height } = metadata;
  if (width && height && metadataMatchesPreview(width, height, preview)) {
    return { pixelWidth: width, pixelHeight: height, enlarge: false };
  }
  return { pixelWidth: preview.pixelWidth, pixelHeight: preview.pixelHeight, enlarge: true };
}

/** Show resident preview pixels at the size the full image will occupy. */
export function openImageModalState(
  attachment: Pick<DiscordMessageAttachment, "filename" | "width" | "height">,
  preview: InlineChatImageReady,
): ImageModalState {
  return {
    filename: attachment.filename,
    image: preview,
    frame: imageModalFrame(preview, attachment),
    loading: true,
    preview: true,
  };
}

/** Upgrade only the still-open viewer; closing/reopening cannot revive stale work. */
export async function upgradeImageModal(
  modal: ImageModalState,
  load: () => Promise<InlineChatImageReady>,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const image = await load();
    if (!isCurrent()) return;
    modal.image = image;
    modal.preview = false;
  } finally {
    if (isCurrent()) modal.loading = false;
  }
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

export type ImageModalKeyResult = { type: "close" } | { type: "handled" } | { type: "step"; by: 1 | -1 };

export function handleImageModalKey(key: Readonly<KeyEvent>): ImageModalKeyResult {
  if (key.type === "escape" || key.type === "enter") return { type: "close" };
  // The next or previous picture of the same message.
  if (key.type === "right" || (key.type === "char" && key.char === "l")) return { type: "step", by: 1 };
  if (key.type === "left" || (key.type === "char" && key.char === "h")) return { type: "step", by: -1 };
  return { type: "handled" };
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

  const frame = state.frame ?? { pixelWidth: state.image.pixelWidth, pixelHeight: state.image.pixelHeight, enlarge: false };
  const { columns: imageColumns, rows: imageRows } = fitPictureCells(
    frame.pixelWidth, frame.pixelHeight, maxColumns, maxRows, cellWidthPixels, cellHeightPixels, frame.enlarge ? Infinity : 1);
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
      z: 2,
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
  const size = state.frame && !state.frame.enlarge ? state.frame : state.image;
  const title = `${state.filename} · ${size.pixelWidth}×${size.pixelHeight}${state.album ? ` · ${state.album.index + 1} / ${state.album.count}` : ""}`;
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
    + theme.sidebarBg + theme.muted + centeredText(
      (state.loading ? "Loading full image · Esc to close"
        : state.preview ? "Preview only · Enter / Esc close" : "Enter or Esc to close")
        + (state.album ? " · h / l: previous / next" : ""),
      innerWidth,
    )
    + theme.reset + border + "│" + theme.reset,
  );
  out.push(
    moveTo(layout.top + layout.height - 1, layout.left)
    + border + `╰${"─".repeat(innerWidth)}╯` + theme.reset,
  );
  return { payload: out.join(""), placement: layout.placement };
}
