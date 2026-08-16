/**
 * State and rendering for sidebar semicolon action menus.
 */

import type { KeyEvent } from "./input";
import { moveTo } from "./frame";
import { theme } from "./theme";
import { padRight, termWidth, truncate } from "./textwidth";
import { DEFAULT_REMOTE_USER_VOLUME_PERCENT, REMOTE_USER_VOLUME_FINE_STEP_PERCENT, REMOTE_USER_VOLUME_STEP_PERCENT, normalizeRemoteUserVolumePercent } from "./volume";

export type ServerAction =
  | "copy_invite"
  | "toggle_mute"
  | "delete_channel"
  | "adjust_volume"
  | "leave_server"
  | "watch_stream"
  | "toggle_server_mute"
  | "toggle_server_deafen"
  | "kick_from_vc"
  | "kick_from_server"
  | "ban_from_server";
export type ServerActionTargetKind = "guild" | "category" | "channel" | "thread" | "voice_member";

export interface ServerActionModalState {
  guildId: string;
  guildName: string;
  targetKind: ServerActionTargetKind;
  targetId: string;
  channelId: string | null;
  muted: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  watchingStream: boolean;
  volumePercent: number | null;
  actions: ServerAction[];
  selection: ServerAction;
  confirmationAction: ServerAction | null;
  busy: boolean;
  error: string | null;
}

export interface VoiceMemberActionModalOptions {
  guildId: string;
  channelId: string;
  userId: string;
  displayName: string;
  muted?: boolean;
  streaming?: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
  watching?: boolean;
  volumePercent?: number | null;
  canServerMute?: boolean;
  canServerDeafen?: boolean;
  canKickFromVc?: boolean;
  canKickFromServer?: boolean;
  canBanFromServer?: boolean;
}

export type ServerActionModalKeyResult =
  | { type: "handled" }
  | { type: "close" }
  | { type: "adjust_volume"; deltaPercent: number }
  | { type: "action"; action: ServerAction };

const DESTRUCTIVE_ACTIONS = new Set<ServerAction>([
  "delete_channel",
  "leave_server",
  "kick_from_server",
  "ban_from_server",
]);

export function createServerActionModal(guildId: string, guildName: string, muted = false): ServerActionModalState {
  return {
    guildId,
    guildName,
    targetKind: "guild",
    targetId: guildId,
    channelId: null,
    muted,
    serverMuted: false,
    serverDeafened: false,
    watchingStream: false,
    volumePercent: null,
    actions: ["copy_invite", "toggle_mute", "leave_server"],
    selection: "copy_invite",
    confirmationAction: null,
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
  options: { canDelete?: boolean; isThread?: boolean } = {},
): ServerActionModalState {
  const modalTargetKind = targetKind === "channel" && options.isThread ? "thread" : targetKind;
  const actions: ServerAction[] = ["toggle_mute"];
  if (targetKind === "channel" && options.canDelete) actions.push("delete_channel");
  return {
    guildId,
    guildName: targetName,
    targetKind: modalTargetKind,
    targetId,
    channelId: modalTargetKind === "channel" || modalTargetKind === "thread" ? targetId : null,
    muted,
    serverMuted: false,
    serverDeafened: false,
    watchingStream: false,
    volumePercent: null,
    actions,
    selection: "toggle_mute",
    confirmationAction: null,
    busy: false,
    error: null,
  };
}

export function createVoiceMemberActionModal(options: VoiceMemberActionModalOptions): ServerActionModalState {
  const actions: ServerAction[] = ["toggle_mute"];
  if (typeof options.volumePercent === "number") actions.push("adjust_volume");
  if (options.streaming) actions.push("watch_stream");
  if (options.canServerMute) actions.push("toggle_server_mute");
  if (options.canServerDeafen) actions.push("toggle_server_deafen");
  if (options.canKickFromVc) actions.push("kick_from_vc");
  if (options.canKickFromServer) actions.push("kick_from_server");
  if (options.canBanFromServer) actions.push("ban_from_server");

  return {
    guildId: options.guildId,
    guildName: options.displayName,
    targetKind: "voice_member",
    targetId: options.userId,
    channelId: options.channelId,
    muted: Boolean(options.muted),
    serverMuted: Boolean(options.serverMuted),
    serverDeafened: Boolean(options.serverDeafened),
    watchingStream: Boolean(options.watching),
    volumePercent: typeof options.volumePercent === "number"
      ? normalizeRemoteUserVolumePercent(options.volumePercent)
      : null,
    actions,
    selection: actions[0] ?? "toggle_mute",
    confirmationAction: null,
    busy: false,
    error: null,
  };
}

export function handleServerActionModalKey(modal: ServerActionModalState, key: KeyEvent): ServerActionModalKeyResult {
  if (key.type === "escape") return { type: "close" };
  if (modal.busy) return { type: "handled" };

  if (modal.selection === "adjust_volume") {
    if (key.type === "char" && key.char === "h") {
      return { type: "adjust_volume", deltaPercent: -REMOTE_USER_VOLUME_FINE_STEP_PERCENT };
    }
    if (key.type === "char" && key.char === "l") {
      return { type: "adjust_volume", deltaPercent: REMOTE_USER_VOLUME_FINE_STEP_PERCENT };
    }
    if (key.type === "left" || (key.type === "char" && key.char === "H")) {
      return { type: "adjust_volume", deltaPercent: -REMOTE_USER_VOLUME_STEP_PERCENT };
    }
    if (key.type === "right" || (key.type === "char" && key.char === "L")) {
      return { type: "adjust_volume", deltaPercent: REMOTE_USER_VOLUME_STEP_PERCENT };
    }
  }

  const direction = key.type === "up" || (key.type === "char" && key.char === "k")
    ? -1
    : key.type === "down" || (key.type === "char" && key.char === "j")
      ? 1
      : 0;
  if (direction !== 0) {
    const currentIndex = modal.actions.indexOf(modal.selection);
    const nextIndex = Math.max(0, Math.min(modal.actions.length - 1, currentIndex + direction));
    modal.selection = modal.actions[nextIndex] ?? modal.actions[0] ?? "toggle_mute";
    modal.confirmationAction = null;
    modal.error = null;
    return { type: "handled" };
  }

  if (key.type !== "enter") return { type: "handled" };
  modal.error = null;
  if (modal.selection === "adjust_volume") return { type: "handled" };
  if (!DESTRUCTIVE_ACTIONS.has(modal.selection)) {
    modal.confirmationAction = null;
    return { type: "action", action: modal.selection };
  }
  if (modal.confirmationAction !== modal.selection) {
    modal.confirmationAction = modal.selection;
    return { type: "handled" };
  }
  return { type: "action", action: modal.selection };
}

function actionLabel(modal: ServerActionModalState, action: ServerAction): string {
  if (modal.confirmationAction === action && DESTRUCTIVE_ACTIONS.has(action)) return "You sure?";

  switch (action) {
    case "copy_invite":
      return "Copy Invite";
    case "toggle_mute": {
      if (modal.targetKind === "voice_member") return modal.muted ? "Unmute" : "Mute";
      const muteTarget = modal.targetKind === "guild"
        ? "Server"
        : modal.targetKind === "category"
          ? "Category"
          : modal.targetKind === "thread"
            ? "Thread"
            : "Channel";
      return `${modal.muted ? "Unmute" : "Mute"} ${muteTarget}`;
    }
    case "delete_channel":
      return modal.targetKind === "thread" ? "Delete Thread" : "Delete Channel";
    case "adjust_volume": {
      const volumePercent = normalizeRemoteUserVolumePercent(modal.volumePercent ?? DEFAULT_REMOTE_USER_VOLUME_PERCENT);
      return `Volume ${volumePercent}%`;
    }
    case "leave_server":
      return "Leave Server";
    case "watch_stream":
      return modal.watchingStream ? "Stop Watching" : "Watch Stream";
    case "toggle_server_mute":
      return `Server ${modal.serverMuted ? "Unmute" : "Mute"}`;
    case "toggle_server_deafen":
      return `Server ${modal.serverDeafened ? "Undeafen" : "Deafen"}`;
    case "kick_from_vc":
      return "Kick From VC";
    case "kick_from_server":
      return "Kick From Server";
    case "ban_from_server":
      return "Ban From Server";
  }
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

  const errorText = modal.error ? truncate(modal.error, Math.max(1, Math.min(38, availableWidth - 4))) : null;
  const maxVisibleActions = Math.max(1, totalRows - 2 - (errorText ? 1 : 0));
  const selectionIndex = Math.max(0, modal.actions.indexOf(modal.selection));
  const windowStart = Math.max(0, Math.min(
    selectionIndex - Math.floor(maxVisibleActions / 2),
    modal.actions.length - maxVisibleActions,
  ));
  const visibleActions = modal.actions.slice(windowStart, windowStart + maxVisibleActions);
  const labels = visibleActions.map((action) => actionLabel(modal, action));
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
    const action = visibleActions[index];
    const selected = action !== undefined && modal.selection === action;
    const marker = selected ? "▸ " : "  ";
    const label = labels[index] ?? errorText!;
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = action !== undefined && DESTRUCTIVE_ACTIONS.has(action)
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
