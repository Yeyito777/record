import { describe, expect, test } from "bun:test";

import {
  createChannelActionModal,
  createServerActionModal,
  createVoiceMemberActionModal,
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
    expect(modal.confirmationAction).toBe("leave_server");
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

  test("renders title-cased actions beside the sidebar with destructive text in theme red", () => {
    const modal = createServerActionModal("guild-1", "Example");
    modal.selection = "leave_server";
    modal.confirmationAction = "leave_server";
    const rendered = renderServerActionModal(modal, 3, 29, 20, 80);
    const plain = stripAnsi(rendered);

    expect(plain).toContain("Copy Invite");
    expect(plain).toContain("Mute Server");
    expect(plain).toContain("You sure?");
    expect(rendered).toContain(theme.error);
    expect(rendered).toContain("\x1b[3;29H");
  });

  test("labels the toggle as unmute for a muted server", () => {
    const modal = createServerActionModal("guild-1", "Example", true);
    const rendered = stripAnsi(renderServerActionModal(modal, 3, 29, 20, 80));

    expect(rendered).toContain("Unmute Server");
  });

  test("shows only the relevant title-cased mute action for categories and channels", () => {
    const category = createChannelActionModal("category", "guild-1", "category-1", "News", false);
    const channel = createChannelActionModal("channel", "guild-1", "channel-1", "general", true);

    const categoryRendered = stripAnsi(renderServerActionModal(category, 3, 29, 20, 80));
    const channelRendered = stripAnsi(renderServerActionModal(channel, 3, 29, 20, 80));
    expect(categoryRendered).toContain("Mute Category");
    expect(categoryRendered).not.toContain("Copy Invite");
    expect(categoryRendered).not.toContain("Leave Server");
    expect(channelRendered).toContain("Unmute Channel");
    expect(handleServerActionModalKey(category, { type: "enter" })).toEqual({
      type: "action",
      action: "toggle_mute",
    });
  });

  test("puts permitted channel and thread deletion last in red and requires confirmation", () => {
    const channel = createChannelActionModal(
      "channel",
      "guild-1",
      "channel-1",
      "general",
      false,
      { canDelete: true },
    );
    const thread = createChannelActionModal(
      "channel",
      "guild-1",
      "thread-1",
      "release discussion",
      false,
      { canDelete: true, isThread: true },
    );

    expect(channel.actions).toEqual(["toggle_mute", "delete_channel"]);
    expect(thread.actions).toEqual(["toggle_mute", "delete_channel"]);
    expect(thread.targetKind).toBe("thread");
    expect(stripAnsi(renderServerActionModal(channel, 3, 29, 20, 80))).toContain("Delete Channel");
    expect(stripAnsi(renderServerActionModal(thread, 3, 29, 20, 80))).toContain("Delete Thread");

    thread.selection = "delete_channel";
    expect(handleServerActionModalKey(thread, { type: "enter" })).toEqual({ type: "handled" });
    expect(thread.confirmationAction).toBe("delete_channel");
    const confirmation = renderServerActionModal(thread, 3, 29, 20, 80);
    expect(stripAnsi(confirmation)).toContain("You sure?");
    expect(confirmation).toContain(theme.error);
    expect(handleServerActionModalKey(thread, { type: "enter" })).toEqual({
      type: "action",
      action: "delete_channel",
    });
  });

  test("does not offer deletion without permission or on a category", () => {
    const channel = createChannelActionModal("channel", "guild-1", "channel-1", "general");
    const category = createChannelActionModal(
      "category",
      "guild-1",
      "category-1",
      "Chat",
      false,
      { canDelete: true },
    );

    expect(channel.actions).toEqual(["toggle_mute"]);
    expect(category.actions).toEqual(["toggle_mute"]);
  });

  test("keeps the selected copy option in normal text color", () => {
    const modal = createServerActionModal("guild-1", "Example");
    const rendered = renderServerActionModal(modal, 3, 29, 20, 80);
    const copyRow = rendered.split("\x1b[5;29H")[0]?.split("\x1b[4;29H")[1] ?? "";

    expect(copyRow).toContain(`│${theme.sidebarSelBg}${theme.text}▸ Copy Invite`);
    expect(copyRow).not.toContain(`│${theme.sidebarSelBg}${theme.accent}▸ Copy Invite`);
  });

  test("offers every permitted voice-member action in the requested order", () => {
    const modal = createVoiceMemberActionModal({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-1",
      displayName: "Alice",
      muted: true,
      volumePercent: 100,
      streaming: true,
      serverMuted: true,
      serverDeafened: true,
      canServerMute: true,
      canServerDeafen: true,
      canKickFromVc: true,
      canKickFromServer: true,
      canBanFromServer: true,
    });

    expect(modal.actions).toEqual([
      "toggle_mute",
      "adjust_volume",
      "watch_stream",
      "toggle_server_mute",
      "toggle_server_deafen",
      "kick_from_vc",
      "kick_from_server",
      "ban_from_server",
    ]);
    const rendered = stripAnsi(renderServerActionModal(modal, 3, 29, 20, 80));
    expect(rendered).toContain("Unmute");
    expect(rendered).toContain("Volume 100%");
    expect(rendered).not.toContain("█");
    expect(rendered).not.toContain("░");
    expect(rendered).toContain("Watch Stream");
    expect(rendered).toContain("Server Unmute");
    expect(rendered).toContain("Server Undeafen");
    expect(rendered).toContain("Kick From VC");
    expect(rendered).toContain("Kick From Server");
    expect(rendered).toContain("Ban From Server");
  });

  test("omits unavailable stream and moderation actions", () => {
    const modal = createVoiceMemberActionModal({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-1",
      displayName: "Alice",
    });

    expect(modal.actions).toEqual(["toggle_mute"]);
    expect(stripAnsi(renderServerActionModal(modal, 3, 29, 20, 80))).toContain("Mute");
  });

  test("labels an already watched stream action as Stop Watching", () => {
    const modal = createVoiceMemberActionModal({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-1",
      displayName: "Alice",
      streaming: true,
      watching: true,
    });

    expect(stripAnsi(renderServerActionModal(modal, 3, 29, 20, 80))).toContain("Stop Watching");
  });

  test("adjusts voice-member volume by 5% with h/l and 10% with H/L or arrow keys", () => {
    const modal = createVoiceMemberActionModal({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-1",
      displayName: "Alice",
      volumePercent: 90,
    });
    modal.selection = "adjust_volume";

    expect(stripAnsi(renderServerActionModal(modal, 3, 29, 20, 80))).toContain("Volume 90%");
    expect(handleServerActionModalKey(modal, { type: "char", char: "h" })).toEqual({
      type: "adjust_volume",
      deltaPercent: -5,
    });
    expect(handleServerActionModalKey(modal, { type: "char", char: "l" })).toEqual({
      type: "adjust_volume",
      deltaPercent: 5,
    });
    expect(handleServerActionModalKey(modal, { type: "char", char: "H" })).toEqual({
      type: "adjust_volume",
      deltaPercent: -10,
    });
    expect(handleServerActionModalKey(modal, { type: "char", char: "L" })).toEqual({
      type: "adjust_volume",
      deltaPercent: 10,
    });
    expect(handleServerActionModalKey(modal, { type: "left" })).toEqual({
      type: "adjust_volume",
      deltaPercent: -10,
    });
    expect(handleServerActionModalKey(modal, { type: "right" })).toEqual({
      type: "adjust_volume",
      deltaPercent: 10,
    });
    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({ type: "handled" });
  });

  test("kick and ban are red and each requires its own confirmation", () => {
    const modal = createVoiceMemberActionModal({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-1",
      displayName: "Alice",
      canKickFromServer: true,
      canBanFromServer: true,
    });
    modal.selection = "kick_from_server";

    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({ type: "handled" });
    expect(modal.confirmationAction).toBe("kick_from_server");
    expect(stripAnsi(renderServerActionModal(modal, 3, 29, 20, 80))).toContain("You sure?");
    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({ type: "action", action: "kick_from_server" });

    handleServerActionModalKey(modal, { type: "char", char: "j" });
    expect(String(modal.selection)).toBe("ban_from_server");
    expect(modal.confirmationAction).toBeNull();
    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({ type: "handled" });
    const rendered = renderServerActionModal(modal, 3, 29, 20, 80);
    expect(rendered).toContain(theme.error);
    expect(handleServerActionModalKey(modal, { type: "enter" })).toEqual({ type: "action", action: "ban_from_server" });
  });

  test("scrolls a long voice menu so the selected action remains visible on short terminals", () => {
    const modal = createVoiceMemberActionModal({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-1",
      displayName: "Alice",
      streaming: true,
      canServerMute: true,
      canServerDeafen: true,
      canKickFromVc: true,
      canKickFromServer: true,
      canBanFromServer: true,
    });
    modal.selection = "ban_from_server";

    const rendered = stripAnsi(renderServerActionModal(modal, 3, 29, 5, 80));
    expect(rendered).toContain("Ban From Server");
    expect(rendered).not.toContain("Watch Stream");
  });
});
