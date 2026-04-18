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

  test("navigation j moves down", () => {
    expect(resolveAction({ type: "char", char: "j" }, "navigation")).toBe("nav_down");
  });
});
