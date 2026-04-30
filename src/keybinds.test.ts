import { describe, expect, test } from "bun:test";

import { resolveAction } from "./keybinds";

describe("keybinds", () => {
  test("Ctrl+S toggles the sidebar", () => {
    expect(resolveAction({ type: "ctrl-s" })).toBe("sidebar_toggle");
  });

  test("Ctrl+M toggles the sidebar", () => {
    expect(resolveAction({ type: "ctrl-m" })).toBe("sidebar_toggle");
  });

  test("Ctrl+J cycles panel focus forward", () => {
    expect(resolveAction({ type: "ctrl-j" })).toBe("focus_cycle_next");
  });

  test("Ctrl+K cycles panel focus backward", () => {
    expect(resolveAction({ type: "ctrl-k" })).toBe("focus_cycle_prev");
  });

  test("Ctrl+N toggles prompt/history focus", () => {
    expect(resolveAction({ type: "ctrl-n" })).toBe("focus_history");
  });

  test("Ctrl+; toggles the member list", () => {
    expect(resolveAction({ type: "ctrl-semicolon" })).toBe("member_list_toggle");
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

  test("navigation { and } jump between servers", () => {
    expect(resolveAction({ type: "char", char: "{" }, "navigation")).toBe("nav_prev_server");
    expect(resolveAction({ type: "char", char: "}" }, "navigation")).toBe("nav_next_server");
  });

  test("navigation [ and ] jump between categories", () => {
    expect(resolveAction({ type: "char", char: "[" }, "navigation")).toBe("nav_prev_category");
    expect(resolveAction({ type: "char", char: "]" }, "navigation")).toBe("nav_next_category");
  });

  test("navigation m toggles guild mute", () => {
    expect(resolveAction({ type: "char", char: "m" }, "navigation")).toBe("nav_toggle_guild_mute");
  });

  test("navigation e and E move servers like Exocortex conversations", () => {
    expect(resolveAction({ type: "char", char: "e" }, "navigation")).toBe("nav_move_guild_up");
    expect(resolveAction({ type: "char", char: "E" }, "navigation")).toBe("nav_move_guild_down");
  });

  test("navigation Shift+H/M/L jumps within the visible menu like Exocortex conversations", () => {
    expect(resolveAction({ type: "char", char: "H" }, "navigation")).toBe("nav_visible_top");
    expect(resolveAction({ type: "char", char: "M" }, "navigation")).toBe("nav_visible_middle");
    expect(resolveAction({ type: "char", char: "L" }, "navigation")).toBe("nav_visible_bottom");
  });

  test("ctrl brackets jump between notifications globally", () => {
    expect(resolveAction({ type: "ctrl-left-bracket" })).toBe("notification_prev");
    expect(resolveAction({ type: "ctrl-right-bracket" })).toBe("notification_next");
  });

  test("ctrl-r toggles reply mode globally", () => {
    expect(resolveAction({ type: "ctrl-r" })).toBe("reply_toggle");
  });

  test("ctrl-q cancels the current action globally", () => {
    expect(resolveAction({ type: "ctrl-q" })).toBe("cancel_action");
  });

  test("ctrl-v pastes an image globally", () => {
    expect(resolveAction({ type: "ctrl-v" })).toBe("paste_image");
  });
});
