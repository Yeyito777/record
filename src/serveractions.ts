/**
 * State and rendering for the sidebar server-actions context menu.
 */

import type { KeyEvent } from "./input";
import { moveTo } from "./frame";
import { theme } from "./theme";
import { padRight, termWidth, truncate } from "./textwidth";

export type ServerAction = "copy_invite" | "toggle_mute" | "leave_server";

export interface ServerActionModalState {
  guildId: string;
  guildName: string;
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
    muted,
    selection: "copy_invite",
    leaveConfirmation: false,
    busy: false,
    error: null,
  };
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
    const actions: ServerAction[] = ["copy_invite", "toggle_mute", "leave_server"];
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

  const labels = [
    "Copy invite",
    modal.muted ? "Unmute server" : "Mute server",
    modal.leaveConfirmation ? "You sure?" : "Leave server",
  ];
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
    const selected = index === 0
      ? modal.selection === "copy_invite"
      : index === 1
        ? modal.selection === "toggle_mute"
        : index === 2 && modal.selection === "leave_server";
    const marker = selected ? "▸ " : "  ";
    const label = index === 0
      ? labels[0]!
      : index === 1
        ? labels[1]!
        : index === 2
          ? labels[2]!
          : errorText!;
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = index === 2
      ? theme.error
      : index >= 3
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
