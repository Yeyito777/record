import { describe, expect, test } from "bun:test";

import { appendPositionedPayload, createFrameRows } from "../frame";
import { termWidth } from "../textwidth";
import {
  createLoginModalState,
  handleLoginModalKey,
  renderLoginModal,
  setLoginModalPhase,
  type LoginPhase,
} from "./loginmodal";

const MOVE_RE = /\x1b\[(\d+);(\d+)H/g;
const SGR_RE = /\x1b\[[0-9;]*m/g;

interface PositionedRow {
  row: number;
  col: number;
  text: string;
}

function positionedRows(payload: string): PositionedRow[] {
  const matches = [...payload.matchAll(MOVE_RE)];
  return matches.map((match, index) => ({
    row: Number(match[1]),
    col: Number(match[2]),
    text: payload.slice(match.index! + match[0].length, matches[index + 1]?.index ?? payload.length),
  }));
}

function plain(text: string): string {
  return text.replace(SGR_RE, "");
}

describe("WhatsApp login modal", () => {
  test("renders a fully padded QR modal centered over the terminal", () => {
    const state = createLoginModalState({ phase: "qr", qr: "record-whatsapp-login-test" });
    const terminalRows = 55;
    const terminalCols = 120;
    const rows = positionedRows(renderLoginModal(state, terminalRows, terminalCols));

    expect(rows.length).toBeGreaterThan(20);
    expect(rows.map((row) => row.row)).toEqual(
      Array.from({ length: rows.length }, (_, index) => rows[0].row + index),
    );

    const widths = rows.map((row) => termWidth(plain(row.text)));
    expect(new Set(widths).size).toBe(1);
    const modalWidth = widths[0];
    const leftMargin = rows[0].col - 1;
    const rightMargin = terminalCols - (rows[0].col + modalWidth - 1);
    const topMargin = rows[0].row - 1;
    const bottomMargin = terminalRows - rows.at(-1)!.row;

    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1);
    expect(Math.abs(topMargin - bottomMargin)).toBeLessThanOrEqual(1);
    expect(rows.every((row) => row.col + termWidth(plain(row.text)) - 1 <= terminalCols)).toBe(true);
    expect(rows.at(-1)!.row).toBeLessThanOrEqual(terminalRows);
    expect(plain(rows.map((row) => row.text).join("\n"))).toContain("WhatsApp · Scan QR code");
    expect(plain(rows.map((row) => row.text).join("\n"))).toContain("Esc cancel");
  });

  test("renders deterministic QR content without exposing the raw value as text", () => {
    const rawQr = "raw-whatsapp-qr-value,with,secrets";
    const state = createLoginModalState({ phase: "qr", qr: rawQr });
    const first = renderLoginModal(state, 60, 130);
    const second = renderLoginModal(state, 60, 130);
    const visible = plain(first);

    expect(first).toBe(second);
    expect(visible).not.toContain(rawQr);
    expect(visible).toMatch(/[▀▄█]/);
  });

  test("shows an explicit resize requirement instead of clipping a large QR", () => {
    const state = createLoginModalState({ phase: "qr", qr: "x".repeat(280) });
    const payload = renderLoginModal(state, 20, 64);
    const rows = positionedRows(payload);
    const visible = plain(rows.map((row) => row.text).join("\n"));

    expect(visible).toContain("Terminal too small for WhatsApp QR");
    expect(visible).toContain("Resize to at least");
    expect(visible).toContain("Current terminal: 64 × 20.");
    expect(visible).toContain("QR codes are never clipped.");
    expect(visible).not.toMatch(/[▀▄█]/);
    expect(rows.every((row) => row.row <= 20 && row.col + termWidth(plain(row.text)) - 1 <= 64)).toBe(true);
  });

  test("can be appended to retained render frame rows", () => {
    const state = createLoginModalState({ phase: "linking" });
    const payload = renderLoginModal(state, 25, 100);
    const frameRows = createFrameRows(25, "");

    appendPositionedPayload(frameRows, payload);

    expect(frameRows.some((row) => plain(row).includes("QR code scanned"))).toBe(true);
    expect(frameRows.filter((row) => plain(row).includes("╭")).length).toBe(1);
    expect(frameRows.filter((row) => plain(row).includes("╰")).length).toBe(1);
  });

  test("presents every login phase", () => {
    const expected: Record<LoginPhase, string> = {
      starting: "Starting WhatsApp",
      qr: "Waiting for a QR code",
      linking: "QR code scanned",
      connecting: "Connecting to WhatsApp",
      syncing: "Syncing messages",
      success: "WhatsApp connected",
      error: "Could not connect WhatsApp",
      cancelled: "WhatsApp login cancelled",
    };

    for (const [phase, label] of Object.entries(expected) as Array<[LoginPhase, string]>) {
      const state = createLoginModalState({ phase });
      expect(plain(renderLoginModal(state, 25, 100))).toContain(label);
    }
  });

  test("Escape requests cancellation without mutating state and other keys are consumed", () => {
    const state = Object.freeze(createLoginModalState({
      phase: "connecting",
      qr: "unchanged",
      message: "Still connecting",
    }));

    expect(handleLoginModalKey(state, { type: "escape" })).toEqual({ type: "cancel" });
    expect(handleLoginModalKey(state, { type: "char", char: "x" })).toEqual({ type: "handled" });
    expect(state).toEqual({ phase: "connecting", qr: "unchanged", message: "Still connecting" });
  });

  test("phase updates are immutable", () => {
    const starting = createLoginModalState();
    const qr = setLoginModalPhase(starting, "qr", { qr: "new-raw-code" });

    expect(starting).toEqual({ phase: "starting", qr: null, message: null });
    expect(qr).toEqual({ phase: "qr", qr: "new-raw-code", message: null });
    expect(qr).not.toBe(starting);
  });
});
