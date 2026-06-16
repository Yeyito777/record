import { describe, expect, test } from "bun:test";

import { adaptAnsiTruecolor, ansiColorToRgb, detectTerminalColorLevel, hexToAnsiColor, rgbToXterm256 } from "./terminalcolors";

describe("terminal color capability detection", () => {
  test("treats xterm-256color without COLORTERM as 256-color", () => {
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", COLORTERM: "" })).toBe("256");
  });

  test("treats Apple Terminal as 256-color unless truecolor is explicit", () => {
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" })).toBe("256");
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal", NO_COLOR: "1" })).toBe("256");
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal", COLORTERM: "truecolor" })).toBe("truecolor");
  });

  test("supports RECORD_TUI_COLOR and FORCE_COLOR overrides", () => {
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", RECORD_TUI_COLOR: "truecolor" })).toBe("truecolor");
    expect(detectTerminalColorLevel({ TERM: "xterm-direct", RECORD_TUI_COLOR: "256" })).toBe("256");
    expect(detectTerminalColorLevel({ TERM: "xterm-direct", RECORD_TUI_COLOR: "16" })).toBe("16");
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", EXOCORTEX_TUI_COLOR: "truecolor" })).toBe("truecolor");
    expect(detectTerminalColorLevel({ TERM: "xterm-direct", EXOCORTEX_TUI_COLOR: "256" })).toBe("256");
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", RECORD_TUI_COLOR: "256", EXOCORTEX_TUI_COLOR: "truecolor" })).toBe("256");
    expect(detectTerminalColorLevel({ TERM: "xterm-256color", FORCE_COLOR: "3" })).toBe("truecolor");
  });
});

describe("terminal color downsampling", () => {
  test("keeps truecolor escapes in truecolor mode", () => {
    expect(hexToAnsiColor(38, "#1d9bf0", "truecolor")).toBe("\x1b[38;2;29;155;240m");
    expect(hexToAnsiColor(48, "#00050f", "truecolor")).toBe("\x1b[48;2;0;5;15m");
  });

  test("converts RGB to xterm-256 foreground/background escapes", () => {
    expect(hexToAnsiColor(38, "#1d9bf0", "256")).toMatch(/^\x1b\[38;5;\d+m$/);
    expect(hexToAnsiColor(48, "#00050f", "256")).toMatch(/^\x1b\[48;5;\d+m$/);
  });

  test("keeps dark chromatic backgrounds on the color cube", () => {
    expect(rgbToXterm256(9, 13, 53)).toBe(17);
    expect(hexToAnsiColor(48, "#090d35", "256")).toBe("\x1b[48;5;17m");
  });

  test("rewrites truecolor SGR spans inside existing ANSI strings", () => {
    const out = adaptAnsiTruecolor("a\x1b[38;2;29;155;240mb\x1b[48;2;0;5;15mc", "256");
    expect(out).not.toContain(";2;");
    expect(out).toContain("\x1b[38;5;");
    expect(out).toContain("\x1b[48;5;");
  });

  test("extracts RGB approximations from truecolor, xterm-256, and ANSI-16 SGR", () => {
    expect(ansiColorToRgb("\x1b[38;2;29;155;240m", 38)).toEqual([29, 155, 240]);
    expect(ansiColorToRgb("\x1b[38;5;39m", 38)).toEqual([0, 175, 255]);
    expect(ansiColorToRgb("\x1b[36m", 38)).toEqual([0, 205, 205]);
  });
});
