/** Which side panels a window is wide enough for. */

import { MEMBER_LIST_WIDTH } from "./memberlist";
import { SIDEBAR_WIDTH } from "./sidebar";
import type { AppState } from "./state";

/** The narrowest message pane worth keeping beside the side panels. */
export const MIN_MESSAGE_PANE_WIDTH = 20;

export interface VisiblePanels {
  sidebar: boolean;
  memberList: boolean;
}

/**
 * The side panels drawn at this width: the open ones that still leave the
 * message pane MIN_MESSAGE_PANE_WIDTH columns, giving up the member list
 * first, then the sidebar. The toggles (and what is saved) are untouched, so
 * the panels come back when the window widens.
 */
export function visiblePanels(state: Pick<AppState, "cols" | "sidebar" | "memberList">): VisiblePanels {
  const cols = Math.max(1, state.cols);
  let sidebar = state.sidebar.open;
  let memberList = state.memberList.open;
  const pane = () => cols - (sidebar ? SIDEBAR_WIDTH : 0) - (memberList ? MEMBER_LIST_WIDTH : 0);
  if (memberList && pane() < MIN_MESSAGE_PANE_WIDTH) memberList = false;
  if (sidebar && pane() < MIN_MESSAGE_PANE_WIDTH) sidebar = false;
  return { sidebar, memberList };
}
