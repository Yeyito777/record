/**
 * State and rendering for the sidebar server-actions context menu.
 */

import type { KeyEvent } from "./input";
import { moveTo } from "./frame";
import { theme } from "./theme";
import { padRight, termWidth, truncate } from "./textwidth";

export type ServerAction = "copy_invite" | "toggle_mute" | "leave_server";
export type ServerActionTargetKind = "guild" | "category" | "channel";

export interface ServerActionModalState {
  guildId: string;
  guildName: string;
  targetKind: ServerActionTargetKind;
  targetId: string;
  muted: boolean;
  selection: ServerAction;
  leaveConfirmation: boolean;
  busy: boolean;
  error: string | null;
}

export type ServerActionModalKeyResult =
  | { type: "handled" }
  | { type: "close" }
  | { type: "action"; action: ServerAction };

export function createServerActionModal(guildId: string, guildName: string, muted = false): ServerActionModalState {
  return {
    guildId,
    guildName,
    targetKind: "guild",
    targetId: guildId,
    muted,
    selection: "copy_invite",
    leaveConfirmation: false,
    busy: false,
    error: null,
  };
}

export function createChannelActionModal(
  targetKind: "category" | "channel",
  guildId: string,
  targetId: string,
  targetName: string,
  muted = false,
): ServerActionModalState {
  return {
    guildId,
    guildName: targetName,
    targetKind,
    targetId,
    muted,
    selection: "toggle_mute",
    leaveConfirmation: false,
    busy: false,
    error: null,
  };
}

function availableActions(modal: ServerActionModalState): ServerAction[] {
  return modal.targetKind === "guild"
    ? ["copy_invite", "toggle_mute", "leave_server"]
    : ["toggle_mute"];
}

export function handleServerActionModalKey(modal: ServerActionModalState, key: KeyEvent): ServerActionModalKeyResult {
  if (key.type === "escape") return { type: "close" };
  if (modal.busy) return { type: "handled" };

  const direction = key.type === "up" || (key.type === "char" && key.char === "k")
    ? -1
    : key.type === "down" || (key.type === "char" && key.char === "j")
      ? 1
      : 0;
  if (direction !== 0) {
    const actions = availableActions(modal);
    const currentIndex = actions.indexOf(modal.selection);
    const nextIndex = Math.max(0, Math.min(actions.length - 1, currentIndex + direction));
    modal.selection = actions[nextIndex] ?? "copy_invite";
    modal.leaveConfirmation = false;
    modal.error = null;
    return { type: "handled" };
  }

  if (key.type !== "enter") return { type: "handled" };
  modal.error = null;
  if (modal.selection === "copy_invite") {
    return { type: "action", action: "copy_invite" };
  }
  if (modal.selection === "toggle_mute") {
    return { type: "action", action: "toggle_mute" };
  }
  if (!modal.leaveConfirmation) {
    modal.leaveConfirmation = true;
    return { type: "handled" };
  }
  return { type: "action", action: "leave_server" };
}

/** Render the menu immediately to the right of the fixed-width sidebar. */
export function renderServerActionModal(
  modal: ServerActionModalState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): string {
  const availableWidth = totalCols - leftCol + 1;
  if (availableWidth < 6 || totalRows < 4) return "";

  const muteTarget = modal.targetKind === "guild" ? "server" : modal.targetKind;
  const muteLabel = `${modal.muted ? "Unmute" : "Mute"} ${muteTarget}`;
  const actions = availableActions(modal);
  const labels = actions.map((action) => (
    action === "copy_invite"
      ? "Copy invite"
      : action === "toggle_mute"
        ? muteLabel
        : modal.leaveConfirmation ? "You sure?" : "Leave server"
  ));
  const errorText = modal.error ? truncate(modal.error, Math.max(1, Math.min(38, availableWidth - 4))) : null;
  const rawLines = labels.map((label) => `  ${label} `);
  if (errorText) rawLines.push(`  ${errorText} `);

  const innerWidth = Math.max(1, Math.min(
    Math.max(...rawLines.map(termWidth)),
    availableWidth - 2,
  ));
  const boxHeight = rawLines.length + 2;
  const topRow = Math.max(1, Math.min(anchorRow, totalRows - boxHeight + 1));
  const border = theme.sidebarBg + theme.accent;
  const out: string[] = [
    moveTo(topRow, leftCol) + border + `┌${"─".repeat(innerWidth)}┐` + theme.reset,
  ];

  for (let index = 0; index < rawLines.length; index++) {
    const action = actions[index];
    const selected = action !== undefined && modal.selection === action;
    const marker = selected ? "▸ " : "  ";
    const label = labels[index] ?? errorText!;
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = action === "leave_server"
      ? theme.error
      : action === undefined
        ? theme.warning
        : theme.text;
    const content = truncate(`${marker}${label} `, innerWidth);
    out.push(
      moveTo(topRow + index + 1, leftCol)
      + border + "│"
      + bg + fg + padRight(content, innerWidth)
      + theme.reset + border + "│" + theme.reset,
    );
  }

  out.push(
    moveTo(topRow + boxHeight - 1, leftCol)
    + border + `└${"─".repeat(innerWidth)}┘` + theme.reset,
  );
  return out.join("");
}
