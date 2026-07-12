import { describe, expect, test } from "bun:test";

import {
  createChannelActionModal,
  createServerActionModal,
  handleServerActionModalKey,
  renderServerActionModal,
} from "./serveractions";
import { theme } from "./theme";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[\d+;\d+H/g, "\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

describe("server actions modal", () => {
  test("navigates with j/k and closes with escape", () => {
    const modal = createServerActionModal("guild-1", "Example");

    expect(modal.selection).toBe("copy_invite");
    handleServerActionModalKey(modal, { type: "char", char: "k" });
    expect(modal.selection).toBe("copy_invite");
    expect(handleServerActionModalKey(modal, { type: "char", char: "j" })).toEqual({ type: "handled" });
    expect(modal.selection).toBe("toggle_mute");
    handleServerActionModalKey(modal, { type: "char", char: "j" });
    expect(modal.selection).toBe("leave_server");
    expect(handleServerActionModalKey(modal, { type: "char", char: "k" })).toEqual({ type: "handled" });
    expect(modal.selection).toBe("toggle_mute");
    handleServerActionModalKey(modal, { type: "char", char: "k" });
    expect(modal.selection).toBe("copy_invite");
    expect(handleServerActionModalKey(modal, { type: "escape" })).toEqual({ type: "close" });
  });

  test("requires two enter presses before leaving", () => {
    const modal = createServerActionModal("guild-1", "Example");
    handleServerActionModalKey(modal, { type: "char", char: "j" });
    handleServerActionModalKey(modal, { type: "char", char: "j" });

    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({ type: "handled" });
    expect(modal.leaveConfirmation).toBe(true);
    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({
      type: "action",
      action: "leave_server",
    });
  });

  test("emits copy-invite immediately on enter", () => {
    const modal = createServerActionModal("guild-1", "Example");
    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({
      type: "action",
      action: "copy_invite",
    });
  });

  test("offers mute as the middle action", () => {
    const modal = createServerActionModal("guild-1", "Example");
    handleServerActionModalKey(modal, { type: "char", char: "j" });

    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({
      type: "action",
      action: "toggle_mute",
    });
  });

  test("renders beside the sidebar with destructive text in theme red", () => {
    const modal = createServerActionModal("guild-1", "Example");
    modal.selection = "leave_server";
    modal.leaveConfirmation = true;
    const rendered = renderServerActionModal(modal, 3, 29, 20, 80);
    const plain = stripAnsi(rendered);

    expect(plain).toContain("Copy invite");
    expect(plain).toContain("Mute server");
    expect(plain).toContain("You sure?");
    expect(rendered).toContain(theme.error);
    expect(rendered).toContain("\x1b[3;29H");
  });

  test("labels the toggle as unmute for a muted server", () => {
    const modal = createServerActionModal("guild-1", "Example", true);
    const rendered = stripAnsi(renderServerActionModal(modal, 3, 29, 20, 80));

    expect(rendered).toContain("Unmute server");
  });

  test("shows only the relevant mute action for categories and channels", () => {
    const category = createChannelActionModal("category", "guild-1", "category-1", "News", false);
    const channel = createChannelActionModal("channel", "guild-1", "channel-1", "general", true);

    const categoryRendered = stripAnsi(renderServerActionModal(category, 3, 29, 20, 80));
    const channelRendered = stripAnsi(renderServerActionModal(channel, 3, 29, 20, 80));
    expect(categoryRendered).toContain("Mute category");
    expect(categoryRendered).not.toContain("Copy invite");
    expect(categoryRendered).not.toContain("Leave server");
    expect(channelRendered).toContain("Unmute channel");
    expect(handleServerActionModalKey(category, { type: "enter" })).toEqual({
      type: "action",
      action: "toggle_mute",
    });
  });

  test("keeps the selected copy option in normal text color", () => {
    const modal = createServerActionModal("guild-1", "Example");
    const rendered = renderServerActionModal(modal, 3, 29, 20, 80);
    const copyRow = rendered.split("\x1b[5;29H")[0]?.split("\x1b[4;29H")[1] ?? "";

    expect(copyRow).toContain(`│${theme.sidebarSelBg}${theme.text}▸ Copy invite`);
    expect(copyRow).not.toContain(`│${theme.sidebarSelBg}${theme.accent}▸ Copy invite`);
  });
});
