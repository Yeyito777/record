import { describe, expect, test } from "bun:test";

import { resolveAction } from "./keybinds";

describe("keybinds", () => {
  test("Ctrl+S toggles the sidebar", () => {
    expect(resolveAction({ type: "ctrl-s" })).toBe("sidebar_toggle");
  });

  test("Ctrl+M toggles the sidebar", () => {
    expect(resolveAction({ type: "ctrl-m" })).toBe("sidebar_toggle");
  });
});
