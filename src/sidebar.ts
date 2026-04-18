/**
 * Sidebar shell.
 *
 * Visual style is copied from Exocortex TUI, but the body is intentionally
 * empty for now.
 */

import { theme } from "./theme";

export const SIDEBAR_WIDTH = 28;

export interface SidebarState {
  open: boolean;
}

export function createSidebarState(): SidebarState {
  return { open: false };
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

export function renderSidebar(sidebar: SidebarState, totalRows: number, focused = false): string[] {
  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1;
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;
  const borderBg = theme.appBg ?? "";

  rows.push(
    theme.sidebarBg + theme.text + theme.bold + pad(" Servers", innerWidth)
    + theme.reset + borderBg + borderFg + "│" + theme.reset,
  );

  rows.push(
    theme.sidebarBg + borderFg + "─".repeat(innerWidth) + borderBg + "┤" + theme.reset,
  );

  for (let row = 3; row <= totalRows; row++) {
    rows.push(
      theme.sidebarBg + " ".repeat(innerWidth) + theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  return sidebar.open ? rows : [];
}
