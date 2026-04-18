import { describe, expect, test } from "bun:test";

import { resolveAction } from "./keybinds";

describe("keybinds", () => {
  test("Ctrl+S toggles the sidebar", () => {
    expect(resolveAction({ type: "ctrl-s" })).toBe("sidebar_toggle");
  });

  test("Ctrl+M toggles the sidebar", () => {
    expect(resolveAction({ type: "ctrl-m" })).toBe("sidebar_toggle");
  });

  test("Ctrl+J cycles panel focus", () => {
    expect(resolveAction({ type: "ctrl-j" })).toBe("focus_cycle");
  });

  test("Ctrl+N toggles prompt/history focus", () => {
    expect(resolveAction({ type: "ctrl-n" })).toBe("focus_history");
  });

  test("prompt scroll bindings match Exocortex", () => {
    expect(resolveAction({ type: "ctrl-y" })).toBe("scroll_line_up");
    expect(resolveAction({ type: "ctrl-e" })).toBe("scroll_line_down");
    expect(resolveAction({ type: "ctrl-u" })).toBe("scroll_half_up");
    expect(resolveAction({ type: "ctrl-d" })).toBe("scroll_half_down");
    expect(resolveAction({ type: "ctrl-b" })).toBe("scroll_page_up");
    expect(resolveAction({ type: "ctrl-f" })).toBe("scroll_page_down");
  });

  test("Shift+J jumps to next sidebar item", () => {
    expect(resolveAction({ type: "char", char: "J" })).toBe("sidebar_next");
  });

  test("Shift+K jumps to previous sidebar item", () => {
    expect(resolveAction({ type: "char", char: "K" })).toBe("sidebar_prev");
  });

  test("navigation j moves down", () => {
    expect(resolveAction({ type: "char", char: "j" }, "navigation")).toBe("nav_down");
  });
});
