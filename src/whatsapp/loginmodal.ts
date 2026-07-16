/**
 * Pure state, key handling, and positioned ANSI rendering for WhatsApp login.
 *
 * The returned payload starts every physical row with an absolute cursor move,
 * so it can be passed directly to appendPositionedPayload during render.
 */

import type { KeyEvent } from "../input";
import { moveTo } from "../frame";
import { theme } from "../theme";
import { padRight, termWidth, truncate } from "../textwidth";
import { measureUnicodeQr, renderUnicodeQr, type UnicodeQrRender } from "./qr";

export type LoginPhase =
  | "starting"
  | "qr"
  | "linking"
  | "connecting"
  | "syncing"
  | "success"
  | "error"
  | "cancelled";

export interface LoginModalState {
  phase: LoginPhase;
  /** Raw WhatsApp QR event value. It is encoded directly and never displayed. */
  qr: string | null;
  /** Optional safe-to-display status/error detail supplied by the controller. */
  message: string | null;
}

export type LoginModalKeyResult = { type: "cancel" } | { type: "handled" };

export interface LoginModalStateInit {
  phase?: LoginPhase;
  qr?: string | null;
  message?: string | null;
}

const SCREEN_MARGIN_X = 2;
const SCREEN_MARGIN_Y = 1;
const CONTENT_PADDING_X = 2;
const QR_MODAL_CHROME_ROWS = 8;
const STANDARD_MODAL_WIDTH = 82;
const STANDARD_MODAL_HEIGHT = 15;

export function createLoginModalState(init: LoginModalStateInit = {}): LoginModalState {
  return {
    phase: init.phase ?? "starting",
    qr: init.qr ?? null,
    message: init.message ?? null,
  };
}

/** Immutable state update helper for UI/controller boundaries. */
export function setLoginModalPhase(
  state: LoginModalState,
  phase: LoginPhase,
  update: Pick<LoginModalStateInit, "qr" | "message"> = {},
): LoginModalState {
  return {
    phase,
    qr: update.qr === undefined ? state.qr : update.qr,
    message: update.message === undefined ? state.message : update.message,
  };
}

/** The modal consumes every key; Escape is the sole controller action. */
export function handleLoginModalKey(_state: Readonly<LoginModalState>, key: Readonly<KeyEvent>): LoginModalKeyResult {
  return key.type === "escape" ? { type: "cancel" } : { type: "handled" };
}

interface BoxLine {
  text: string;
  color?: string;
  align?: "left" | "center";
}

interface BoxSpec {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PhasePresentation {
  heading: string;
  detail: string;
  color: string;
  mark: string;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function centeredBox(totalRows: number, totalCols: number, width: number, height: number): BoxSpec {
  return {
    top: Math.floor((totalRows - height) / 2) + 1,
    left: Math.floor((totalCols - width) / 2) + 1,
    width,
    height,
  };
}

function availableModalSize(rows: number, cols: number): { width: number; height: number } {
  const marginX = cols >= 8 ? Math.min(SCREEN_MARGIN_X, Math.floor((cols - 4) / 2)) : 0;
  const marginY = rows >= 5 ? SCREEN_MARGIN_Y : 0;
  return {
    width: Math.max(0, cols - (marginX * 2)),
    height: Math.max(0, rows - (marginY * 2)),
  };
}

function sanitizeDisplayText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function alignedContent(line: BoxLine, width: number): string {
  const safeText = truncate(sanitizeDisplayText(line.text), width);
  const visible = termWidth(safeText);
  const leftPadding = line.align === "left" ? 0 : Math.max(0, Math.floor((width - visible) / 2));
  return " ".repeat(leftPadding) + safeText + " ".repeat(Math.max(0, width - leftPadding - visible));
}

function renderBox(spec: BoxSpec, lines: BoxLine[]): string {
  if (spec.width <= 0 || spec.height <= 0) return "";
  if (spec.width < 2 || spec.height < 2) {
    const text = padRight(truncate("Resize terminal", spec.width), spec.width);
    return moveTo(spec.top, spec.left) + theme.sidebarBg + theme.warning + text + theme.reset;
  }

  const innerWidth = spec.width - 2;
  const border = theme.sidebarBg + theme.accent;
  const out: string[] = [
    moveTo(spec.top, spec.left) + border + `╭${"─".repeat(innerWidth)}╮` + theme.reset,
  ];

  for (let index = 0; index < spec.height - 2; index++) {
    const line = lines[index] ?? { text: "" };
    const content = alignedContent(line, innerWidth);
    out.push(
      moveTo(spec.top + index + 1, spec.left)
      + border + "│"
      + theme.sidebarBg + (line.color ?? theme.text) + content
      + theme.reset + border + "│" + theme.reset,
    );
  }

  out.push(
    moveTo(spec.top + spec.height - 1, spec.left)
    + border + `╰${"─".repeat(innerWidth)}╯` + theme.reset,
  );
  return out.join("");
}

function renderQrBox(spec: BoxSpec, qr: UnicodeQrRender): string {
  const heading = "WhatsApp · Scan QR code";
  const instruction = "Open WhatsApp → Settings → Linked devices";
  const helper = "Point your phone at this complete code";
  const footer = "Esc  cancel";
  const innerWidth = spec.width - 2;
  const rowsBeforeQr: BoxLine[] = [
    { text: "" },
    { text: heading, color: theme.accent },
    { text: instruction, color: theme.text },
  ];
  const rowsAfterQr: BoxLine[] = [
    { text: "" },
    { text: helper, color: theme.muted },
    { text: footer, color: theme.muted },
  ];
  const border = theme.sidebarBg + theme.accent;
  const out: string[] = [
    moveTo(spec.top, spec.left) + border + `╭${"─".repeat(innerWidth)}╮` + theme.reset,
  ];

  const writeNormalRow = (row: number, line: BoxLine): void => {
    const content = alignedContent(line, innerWidth);
    out.push(
      moveTo(row, spec.left) + border + "│"
      + theme.sidebarBg + (line.color ?? theme.text) + content
      + theme.reset + border + "│" + theme.reset,
    );
  };

  let row = spec.top + 1;
  for (const line of rowsBeforeQr) writeNormalRow(row++, line);

  for (const qrLine of qr.lines) {
    const qrWidth = termWidth(qrLine);
    const leftPadding = Math.max(0, Math.floor((innerWidth - qrWidth) / 2));
    const rightPadding = Math.max(0, innerWidth - leftPadding - qrWidth);
    out.push(
      moveTo(row++, spec.left) + border + "│"
      + theme.sidebarBg + " ".repeat(leftPadding)
      + qrLine
      + theme.sidebarBg + " ".repeat(rightPadding)
      + theme.reset + border + "│" + theme.reset,
    );
  }

  for (const line of rowsAfterQr) writeNormalRow(row++, line);
  out.push(
    moveTo(spec.top + spec.height - 1, spec.left)
    + border + `╰${"─".repeat(innerWidth)}╯` + theme.reset,
  );
  return out.join("");
}

function phasePresentation(state: Readonly<LoginModalState>): PhasePresentation {
  switch (state.phase) {
    case "starting":
      return { heading: "Starting WhatsApp", detail: "Preparing a secure login session…", color: theme.accent, mark: "◌" };
    case "qr":
      return { heading: "Waiting for a QR code", detail: "A login code will appear here shortly.", color: theme.accent, mark: "◌" };
    case "linking":
      return { heading: "QR code scanned", detail: "Linking this device to your account…", color: theme.accent, mark: "●" };
    case "connecting":
      return { heading: "Connecting to WhatsApp", detail: "Establishing an encrypted session…", color: theme.accent, mark: "◌" };
    case "syncing":
      return { heading: "Syncing messages", detail: "Loading your chats and contacts…", color: theme.accent, mark: "◌" };
    case "success":
      return { heading: "WhatsApp connected", detail: "Your linked device is ready.", color: theme.success, mark: "✓" };
    case "error":
      return { heading: "Could not connect WhatsApp", detail: "Try again to request a new QR code.", color: theme.error, mark: "!" };
    case "cancelled":
      return { heading: "WhatsApp login cancelled", detail: "No account changes were made.", color: theme.muted, mark: "×" };
  }
}

function standardLines(state: Readonly<LoginModalState>, innerHeight: number): BoxLine[] {
  const presentation = phasePresentation(state);
  const detail = state.message ? sanitizeDisplayText(state.message) : presentation.detail;
  const core: BoxLine[] = [
    { text: "" },
    { text: "WhatsApp login", color: theme.accent },
    { text: "" },
    { text: presentation.mark, color: presentation.color },
    { text: presentation.heading, color: presentation.color },
    { text: detail, color: state.phase === "error" ? theme.error : theme.text },
  ];
  const footer: BoxLine = {
    text: state.phase === "success" || state.phase === "cancelled" ? "" : "Esc  cancel",
    color: theme.muted,
  };

  while (core.length < Math.max(0, innerHeight - 1)) core.push({ text: "" });
  if (innerHeight > 0) core.push(footer);
  return core.slice(0, innerHeight);
}

function resizeLines(requiredRows: number, requiredCols: number, rows: number, cols: number, innerHeight: number): BoxLine[] {
  const candidates: BoxLine[] = [
    { text: "Terminal too small for WhatsApp QR", color: theme.warning },
    { text: `Resize to at least ${requiredCols} × ${requiredRows}.`, color: theme.text },
    { text: `Current terminal: ${cols} × ${rows}.`, color: theme.muted },
    { text: "QR codes are never clipped.", color: theme.muted },
    { text: "" },
    { text: "Esc  cancel", color: theme.muted },
  ];
  return candidates.slice(0, innerHeight);
}

function renderTinyTerminal(rows: number, cols: number): string {
  if (rows < 1 || cols < 1) return "";
  const lines = ["Resize terminal", "WhatsApp QR needs more room", "Esc cancel"];
  const out: string[] = [];
  for (let row = 1; row <= Math.min(rows, lines.length); row++) {
    out.push(
      moveTo(row, 1)
      + theme.sidebarBg + theme.warning
      + padRight(truncate(lines[row - 1] ?? "", cols), cols)
      + theme.reset,
    );
  }
  return out.join("");
}

/**
 * Render a centered modal over the full terminal.
 *
 * Argument order follows Record's positioned modal renderers: rows, then cols.
 * Every emitted row is fully padded and starts with an absolute cursor move.
 */
export function renderLoginModal(state: Readonly<LoginModalState>, totalRows: number, totalCols: number): string {
  const rows = normalizeDimension(totalRows);
  const cols = normalizeDimension(totalCols);
  if (rows < 3 || cols < 4) return renderTinyTerminal(rows, cols);

  const available = availableModalSize(rows, cols);
  if (available.width < 2 || available.height < 2) return renderTinyTerminal(rows, cols);

  if (state.phase === "qr" && state.qr) {
    let minimum;
    try {
      minimum = measureUnicodeQr(state.qr);
    } catch {
      const presentationState: LoginModalState = {
        phase: "error",
        qr: null,
        message: "WhatsApp supplied an invalid QR code.",
      };
      const width = Math.min(available.width, STANDARD_MODAL_WIDTH);
      const height = Math.min(available.height, STANDARD_MODAL_HEIGHT);
      const spec = centeredBox(rows, cols, width, height);
      return renderBox(spec, standardLines(presentationState, height - 2));
    }

    const qrMaxWidth = Math.max(0, available.width - 2 - (CONTENT_PADDING_X * 2));
    const qrMaxHeight = Math.max(0, available.height - QR_MODAL_CHROME_ROWS);
    const requiredCols = minimum.width + 2 + (CONTENT_PADDING_X * 2) + (SCREEN_MARGIN_X * 2);
    const requiredRows = minimum.height + QR_MODAL_CHROME_ROWS + (SCREEN_MARGIN_Y * 2);
    const qr = renderUnicodeQr(state.qr, qrMaxWidth, qrMaxHeight);

    if (!qr) {
      const width = Math.min(available.width, Math.max(42, Math.min(68, available.width)));
      const height = Math.min(available.height, 10);
      const spec = centeredBox(rows, cols, width, height);
      return renderBox(spec, resizeLines(requiredRows, requiredCols, rows, cols, height - 2));
    }

    const desiredWidth = Math.max(64, qr.width + 2 + (CONTENT_PADDING_X * 2));
    const width = Math.min(available.width, desiredWidth);
    const height = qr.height + QR_MODAL_CHROME_ROWS;
    const spec = centeredBox(rows, cols, width, height);
    return renderQrBox(spec, qr);
  }

  const width = Math.min(available.width, STANDARD_MODAL_WIDTH);
  const height = Math.min(available.height, STANDARD_MODAL_HEIGHT);
  const spec = centeredBox(rows, cols, width, height);
  return renderBox(spec, standardLines(state, height - 2));
}
