/**
 * Full-screen renderer for record.
 *
 * Layout follows the Exocortex TUI style:
 * topbar, separator, collapsible server tree, timeline, prompt separator, prompt.
 */

import { displayCursor, getViewport } from "./editor";
import { renderBodyLines } from "./bodypanel";
import { highlightPromptViewport } from "./prompthighlight";
import { SIDEBAR_WIDTH, renderSidebar } from "./sidebar";
import { truncate } from "./strings";
import type { AppState } from "./state";
import { applyLineBg, clearLine, cursorBar, cursorBlock, hideCursor, moveTo, showCursor } from "./terminal";
import { theme } from "./theme";
import { renderTimelineLines } from "./timeline";
import { renderTopbar } from "./topbar";

function renderAutocompletePopup(
  state: AppState,
  width: number,
  promptSeparatorRow: number,
  mainCol: number,
): string {
  const autocomplete = state.autocomplete;
  if (!autocomplete || autocomplete.matches.length === 0) return "";

  const out: string[] = [];
  const { matches, selection } = autocomplete;
  const maxName = matches.reduce((max, item) => Math.max(max, item.name.length), 0);
  const maxDesc = matches.reduce((max, item) => Math.max(max, item.desc.length), 0);
  const popupWidth = Math.max(1, Math.min(maxName + maxDesc + 6, Math.max(1, width - 2)));
  const nameWidth = Math.min(maxName + 1, popupWidth - 4);
  const descWidth = Math.max(0, popupWidth - nameWidth - 4);

  const maxVisible = Math.max(1, promptSeparatorRow - 3);
  const total = matches.length;
  const winSize = Math.min(total, maxVisible);
  let winStart = 0;

  if (total > maxVisible && selection >= 0) {
    const ideal = selection - Math.floor(winSize / 2);
    winStart = Math.max(0, Math.min(ideal, total - winSize));
  }

  const topRow = promptSeparatorRow - winSize;
  for (let visibleIndex = 0; visibleIndex < winSize; visibleIndex++) {
    const index = winStart + visibleIndex;
    const row = topRow + visibleIndex;
    const selected = selection === index;
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const marker = selected ? "▸ " : "  ";
    const name = truncate(matches[index].name, nameWidth).padEnd(nameWidth);
    const desc = truncate(matches[index].desc, descWidth).padEnd(descWidth);
    out.push(
      moveTo(row, mainCol)
      + `${bg}${theme.accent}${marker}${theme.text}${name}${theme.muted}${desc}${theme.reset}`,
    );
  }

  return out.join("");
}

export function render(state: AppState): void {
  const cols = Math.max(1, state.cols);
  const rows = Math.max(3, state.rows);
  const out: string[] = [];

  const appBg = theme.appBg ?? "";
  const clearedLine = appBg + clearLine;
  const bgLine = appBg
    ? (line: string) => applyLineBg(line, appBg)
    : (line: string) => line;

  const sidebarOpen = state.sidebar.open;
  const sidebarW = sidebarOpen ? SIDEBAR_WIDTH : 0;
  const mainCol = sidebarW + 1;
  const mainW = Math.max(1, cols - sidebarW);

  const historyFocused = state.panelFocus === "chat" && state.chatFocus === "history";
  const promptFocused = state.panelFocus === "chat" && state.chatFocus === "prompt";

  const sidebarRows = sidebarOpen
    ? renderSidebar(state.sidebar, state.channelList.channels, rows, state.panelFocus === "sidebar", state.channelList.activeChannelId)
    : [];

  const emitSidebarCol = (row: number): void => {
    if (sidebarOpen && sidebarRows[row - 1]) {
      out.push(sidebarRows[row - 1]);
    }
  };

  out.push(moveTo(1, 1) + clearedLine);
  emitSidebarCol(1);
  out.push(moveTo(1, mainCol) + renderTopbar(state, mainW));

  const bodyBorder = historyFocused ? theme.borderFocused : theme.borderUnfocused;
  const promptColor = promptFocused ? theme.accent : theme.dim;

  out.push(moveTo(2, 1) + clearedLine);
  emitSidebarCol(2);
  out.push(moveTo(2, mainCol) + bgLine(`${bodyBorder}${"─".repeat(mainW)}${theme.reset}`));

  const promptSeparatorRow = Math.max(3, rows - 1);
  const promptRow = rows;
  const bodyTop = 3;
  const bodyRows = Math.max(0, promptSeparatorRow - bodyTop);

  const timeline = renderTimelineLines(state.timeline, mainW, bodyRows, state.notice);
  const fallbackBody = renderBodyLines(state, mainW);
  const timelineLines = timeline.lines.length > 0 ? timeline.lines : fallbackBody;

  for (let i = 0; i < bodyRows; i++) {
    const row = bodyTop + i;
    out.push(moveTo(row, 1) + clearedLine);
    emitSidebarCol(row);
    out.push(moveTo(row, mainCol) + bgLine(timelineLines[i] ?? ""));
  }

  if (state.autocomplete) {
    out.push(renderAutocompletePopup(state, mainW, promptSeparatorRow, mainCol));
  }

  out.push(moveTo(promptSeparatorRow, 1) + clearedLine);
  emitSidebarCol(promptSeparatorRow);
  out.push(moveTo(promptSeparatorRow, mainCol) + bgLine(`${promptColor}${"─".repeat(mainW)}${theme.reset}`));

  const modeLabel = state.editor.mode === "insert" ? "I" : "N";
  const modeColor = state.editor.mode === "insert" ? theme.vimInsert : theme.vimNormal;
  const promptPrefixPlain = `${modeLabel} > `;
  const promptPrefix = `${modeColor}${modeLabel}${theme.reset} ${promptColor}>${theme.reset} `;
  const fieldWidth = Math.max(1, mainW - promptPrefixPlain.length);

  const cursor = displayCursor(state.editor);
  const viewport = getViewport(state.editor.buffer, cursor, fieldWidth, state.editor.scroll);
  state.editor.scroll = viewport.scroll;

  const isCommandBuffer = state.editor.buffer.trimStart().startsWith("/");
  let promptText = viewport.text ? `${theme.text}${viewport.text}${theme.reset}` : "";
  if (isCommandBuffer && state.editor.buffer.length > 0) {
    promptText = highlightPromptViewport(viewport.text, state.editor.buffer, viewport.scroll);
  }

  out.push(moveTo(promptRow, 1) + clearedLine);
  emitSidebarCol(promptRow);
  out.push(moveTo(promptRow, mainCol) + bgLine(`${promptPrefix}${promptText}`));

  const cursorCol = Math.min(cols, mainCol + promptPrefixPlain.length + viewport.cursorCol);
  out.push(moveTo(promptRow, cursorCol));
  if (promptFocused) {
    out.push(state.editor.mode === "insert" ? cursorBar : cursorBlock);
    out.push(showCursor);
  } else {
    out.push(hideCursor);
  }

  process.stdout.write(out.join(""));
}
