/**
 * Full-screen renderer for record.
 *
 * Layout follows the Exocortex TUI style:
 * topbar, separator, collapsible server tree, timeline, prompt separator, prompt.
 */

import {
  displayCursor,
  getInputLines,
  getVisualRange,
  MAX_PROMPT_ROWS,
  PROMPT_PREFIX_WIDTH,
  wrappedLineOffsets,
} from "./editor";
import { renderBodyLines } from "./bodypanel";
import { highlightPromptViewport } from "./prompthighlight";
import { SIDEBAR_WIDTH, renderSidebar } from "./sidebar";
import { renderStatusLine } from "./statusline";
import { padRight, termWidth } from "./textwidth";
import type { AppState } from "./state";
import {
  applyLineBg,
  clearLine,
  cursorBar,
  cursorBlock,
  cursorUnderline,
  hideCursor,
  moveTo,
  showCursor,
} from "./terminal";
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
  const maxName = matches.reduce((max, item) => Math.max(max, termWidth(item.name)), 0);
  const maxDesc = matches.reduce((max, item) => Math.max(max, termWidth(item.desc)), 0);
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
    const name = padRight(matches[index].name, nameWidth);
    const desc = padRight(matches[index].desc, descWidth);
    out.push(
      moveTo(row, mainCol)
      + `${bg}${theme.accent}${marker}${theme.text}${name}${theme.muted}${desc}${theme.reset}`,
    );
  }

  return out.join("");
}

function modeLabel(mode: AppState["editor"]["mode"]): string {
  return mode === "visual" || mode === "visual-line"
    ? "V"
    : mode === "normal"
      ? "N"
      : "I";
}

function modeColor(mode: AppState["editor"]["mode"]): string {
  return mode === "visual" || mode === "visual-line"
    ? theme.vimVisual
    : mode === "normal"
      ? theme.vimNormal
      : theme.vimInsert;
}

function highlightPromptSelection(
  line: string,
  wrappedLineIdx: number,
  selectionStart: number,
  selectionEndExclusive: number,
  offsets: number[],
): string {
  if (wrappedLineIdx >= offsets.length) {
    return `${theme.text}${line}${theme.reset}`;
  }

  const lineStart = offsets[wrappedLineIdx];
  const lineEndExclusive = lineStart + line.length;
  const overlapStart = Math.max(selectionStart, lineStart);
  const overlapEndExclusive = Math.min(selectionEndExclusive, lineEndExclusive);

  if (overlapStart >= overlapEndExclusive) {
    return `${theme.text}${line}${theme.reset}`;
  }

  const relStart = overlapStart - lineStart;
  const relEnd = overlapEndExclusive - lineStart;

  return `${theme.text}${line.slice(0, relStart)}`
    + `${theme.selectionBg}${theme.text}${line.slice(relStart, relEnd)}${theme.reset}${theme.text}`
    + `${line.slice(relEnd)}${theme.reset}`;
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
    ? renderSidebar(
      state.sidebar,
      state.channelList.channels,
      rows,
      state.panelFocus === "sidebar",
      state.channelList.activeChannelId,
      state.loadingFrameIndex,
    )
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

  const status = renderStatusLine(state, mainW);
  const statusHeight = status.height;
  const bottomStatusRows = statusHeight > 0 ? statusHeight + 1 : 0;

  const maxInputWidth = Math.max(1, mainW - PROMPT_PREFIX_WIDTH);
  const input = getInputLines(
    state.editor.buffer,
    displayCursor(state.editor),
    maxInputWidth,
    Math.max(1, Math.min(MAX_PROMPT_ROWS, rows - 3 - bottomStatusRows)),
    state.editor.scroll,
  );
  state.editor.scroll = input.scrollOffset;

  const inputRowCount = Math.max(1, input.lines.length);
  const promptSeparatorRow = Math.max(3, rows - inputRowCount - bottomStatusRows);
  const firstInputRow = promptSeparatorRow + 1;
  const promptBottomSeparatorRow = firstInputRow + inputRowCount;
  const statusStartRow = promptBottomSeparatorRow + 1;
  const bodyTop = 3;
  const bodyRows = Math.max(0, promptSeparatorRow - bodyTop);

  const timeline = renderTimelineLines(state.timeline, mainW, bodyRows, state.notice, state.loadingFrameIndex);
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

  const offsets = wrappedLineOffsets(state.editor.buffer, maxInputWidth);
  const promptInVisual = promptFocused && (state.editor.mode === "visual" || state.editor.mode === "visual-line");
  const selection = promptInVisual
    ? getVisualRange(state.editor.buffer, state.editor.visualAnchor, state.editor.cursor, state.editor.mode)
    : null;

  for (let i = 0; i < inputRowCount; i++) {
    const row = firstInputRow + i;
    const isFirst = i === 0 && !input.isNewLine[i];
    const promptGlyph = isFirst ? ">" : "+";
    const prefix = isFirst
      ? `${modeColor(state.editor.mode)}${modeLabel(state.editor.mode)}${theme.reset} ${promptColor}${promptGlyph}${theme.reset} `
      : `  ${promptColor}${promptGlyph}${theme.reset} `;

    let lineContent: string;
    if (selection) {
      lineContent = highlightPromptSelection(
        input.lines[i] ?? "",
        input.scrollOffset + i,
        selection.start,
        selection.endExclusive,
        offsets,
      );
    } else {
      lineContent = `${theme.text}${input.lines[i] ?? ""}${theme.reset}`;
      if (state.editor.buffer.length > 0) {
        lineContent = highlightPromptViewport(input.lines[i] ?? "", state.editor.buffer, offsets[input.scrollOffset + i] ?? 0);
      }
    }

    out.push(moveTo(row, 1) + clearedLine);
    emitSidebarCol(row);
    out.push(moveTo(row, mainCol) + bgLine(`${prefix}${lineContent}`));
  }

  if (statusHeight > 0) {
    out.push(moveTo(promptBottomSeparatorRow, 1) + clearedLine);
    emitSidebarCol(promptBottomSeparatorRow);
    out.push(moveTo(promptBottomSeparatorRow, mainCol) + bgLine(`${promptColor}${"─".repeat(mainW)}${theme.reset}`));

    for (let i = 0; i < statusHeight; i++) {
      const row = statusStartRow + i;
      out.push(moveTo(row, 1) + clearedLine);
      emitSidebarCol(row);
      out.push(moveTo(row, mainCol) + bgLine(status.lines[i] ?? ""));
    }
  }

  const cursorRow = firstInputRow + input.cursorLine;
  const cursorCol = Math.min(cols, mainCol + PROMPT_PREFIX_WIDTH + input.cursorCol);
  out.push(moveTo(cursorRow, cursorCol));
  if (promptFocused) {
    out.push(
      state.editor.mode === "insert"
        ? cursorBar
        : (state.editor.pendingOperator || state.editor.pendingReplace)
          ? cursorUnderline
          : cursorBlock,
    );
    out.push(showCursor);
  } else {
    out.push(hideCursor);
  }

  process.stdout.write(out.join(""));
}
