import { describe, expect, test } from "bun:test";

import { invalidateFrame } from "./frame";
import { render } from "./render";
import { createServerActionModal } from "./serveractions";
import { setSidebarGuilds } from "./sidebar";
import { createInitialState, type AppState } from "./state";
import { termWidth } from "./textwidth";
import { VtScreen } from "./vtscreen.testutil";

function capture(state: AppState): string {
  let output = "";
  const originalWrite = process.stdout.write;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
  }
  return output;
}

/** Widest positioned write past its column; > 0 means the terminal would autowrap it. */
function overflow(output: string, cols: number): number {
  let worst = 0;
  const moves = [...output.matchAll(/\x1b\[(\d+);(\d+)H/g)];
  moves.forEach((move, index) => {
    const end = moves[index + 1]?.index ?? output.length;
    const text = output.slice(move.index! + move[0].length, end)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b_[^\x1b]*\x1b\\/g, "")
      .replace(/\x1b\[[0-9;?<>= ]*[@-~]/g, "");
    worst = Math.max(worst, Number(move[2]) - 1 + termWidth(text) - cols);
  });
  return worst;
}

describe("server action modal on screen", () => {
  for (const cols of [100, 70]) {
    test(`growing and shrinking (confirmation, long error) leaves no stale frame (${cols} columns)`, () => {
      const state = createInitialState(null, "/tmp/record-config.json");
      state.cols = cols;
      state.rows = 24;
      setSidebarGuilds(state.sidebar, Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, name: `Guild ${i}`, icon: null })));
      state.sidebar.open = true;
      state.panelFocus = "sidebar";
      const screen = new VtScreen(state.rows, state.cols);
      const modal = createServerActionModal("g1", "Guild 1");
      const steps: Array<() => void> = [
        () => { state.sidebar.serverActionModal = modal; },
        () => { modal.selection = "leave_server"; modal.confirmationAction = "leave_server"; },
        () => { modal.confirmationAction = null; modal.error = "Could not leave server: Discord returned 400. The request body contains invalid JSON. (50109)"; },
        () => { modal.error = null; },
        () => { state.sidebar.serverActionModal = null; },
      ];
      for (const step of steps) {
        step();
        const out = capture(state);
        expect(overflow(out, state.cols)).toBeLessThanOrEqual(0);
        screen.write(out);
        const reference = new VtScreen(state.rows, state.cols);
        invalidateFrame(state);
        reference.write(capture(state));
        expect(screen.text()).toEqual(reference.text());
        const corners = screen.text().join("\n").match(/[┌└]/g)?.length ?? 0;
        expect(corners).toBe(state.sidebar.serverActionModal ? 2 : 0);
      }
    });
  }
});
