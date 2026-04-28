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
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";
import { renderBodyLines } from "./bodypanel";
import {
  buildLineAnchorIndex,
  clampHistoryCursor,
  contentBounds,
  logicalLineRange,
  remapRenderedRow,
  stripAnsi,
} from "./historycursor";
import { renderLineWithCursor, renderLineWithSelection } from "./historyrender";
import { renderMemberList, MEMBER_LIST_WIDTH } from "./memberlist";
import { channelNotificationCounts, guildNotificationCounts } from "./notifications";
import { highlightPromptViewport } from "./prompthighlight";
import { SIDEBAR_WIDTH, renderSidebar } from "./sidebar";
import { renderStatusLine } from "./statusline";
import { padRight, termWidth, truncate } from "./textwidth";
import { formatSize, imageLabel } from "./imageclipboard";
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
import { isTimelineNearBottom, renderTimelineLines, setTimelineRenderContext } from "./timeline";
import { renderTopbar } from "./topbar";
import { channelsWithTyping, formatTypingUsers, getTypingUsers, typingFrame } from "./typing";

function renderImageIndicator(state: AppState, width: number): string {
  const images = state.pendingImages;
  if (width <= 0 || images.length === 0) return "";

  let label: string;
  if (images.length === 1) {
    const image = images[0];
    label = `📎 Image pasted (${imageLabel(image.mediaType)}, ${formatSize(image.sizeBytes)})`;
  } else {
    const parts = images.map((image) => `${imageLabel(image.mediaType)} ${formatSize(image.sizeBytes)}`);
    label = `📎 ${images.length} images (${parts.join(", ")})`;
  }

  const innerWidth = Math.max(0, width - 4);
  const clipped = truncate(label, innerWidth);
  const padded = padRight(clipped, innerWidth);
  return `${theme.accent}│${theme.reset} ${theme.dim}${padded}${theme.reset} ${theme.accent}│${theme.reset}`;
}

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

function isHistoryLineHighlighted(state: AppState, lineIndex: number, historyFocused: boolean): boolean {
  if (!historyFocused || state.editor.mode === "visual" || state.editor.mode === "visual-line") {
    return false;
  }
  const { first, last } = logicalLineRange(state.historyCursor.row, state.historyWrapContinuation);
  return lineIndex >= first && lineIndex <= last;
}

function renderHistoryViewportLine(
  state: AppState,
  rawLine: string,
  lineIndex: number,
  historyFocused: boolean,
): string {
  const inVisual = historyFocused && (state.editor.mode === "visual" || state.editor.mode === "visual-line");
  let rendered = rawLine;
  const plain = stripAnsi(rawLine);

  if (inVisual) {
    const anchor = state.historyVisualAnchor;
    const cursor = state.historyCursor;
    let startRow = Math.min(anchor.row, cursor.row);
    let endRow = Math.max(anchor.row, cursor.row);
    if (state.editor.mode === "visual-line") {
      startRow = logicalLineRange(startRow, state.historyWrapContinuation).first;
      endRow = logicalLineRange(endRow, state.historyWrapContinuation).last;
    }

    if (lineIndex >= startRow && lineIndex <= endRow) {
      const bounds = contentBounds(plain);
      let startCol: number;
      let endCol: number;

      if (state.editor.mode === "visual-line") {
        startCol = bounds.start;
        endCol = bounds.end;
      } else if (startRow === endRow) {
        startCol = Math.min(anchor.col, cursor.col);
        endCol = Math.max(anchor.col, cursor.col);
      } else if (lineIndex === startRow) {
        const anchorIsStart = anchor.row <= cursor.row;
        startCol = anchorIsStart ? anchor.col : cursor.col;
        endCol = bounds.end;
      } else if (lineIndex === endRow) {
        const anchorIsStart = anchor.row <= cursor.row;
        startCol = bounds.start;
        endCol = anchorIsStart ? cursor.col : anchor.col;
      } else {
        startCol = bounds.start;
        endCol = bounds.end;
      }

      rendered = renderLineWithSelection(rendered, startCol, endCol);
    }

    if (lineIndex === cursor.row) {
      rendered = renderLineWithCursor(rendered, cursor.col);
    }
  }

  return rendered;
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
  const memberListOpen = state.memberList.open;
  const sidebarW = sidebarOpen ? SIDEBAR_WIDTH : 0;
  const memberListW = memberListOpen ? MEMBER_LIST_WIDTH : 0;
  const mainCol = sidebarW + 1;
  const mainW = Math.max(1, cols - sidebarW - memberListW);
  const memberListCol = cols - memberListW + 1;

  const historyFocused = state.panelFocus === "chat" && state.chatFocus === "history";
  const promptFocused = state.panelFocus === "chat" && state.chatFocus === "prompt";

  const typingFrameText = typingFrame(state.loadingFrameIndex);
  const typingChannelIds = channelsWithTyping(state.typing, state.auth.user?.id ?? null);
  const channelNotifications = channelNotificationCounts(state.notifications);
  const guildNotifications = guildNotificationCounts(state.notifications, state.channelList.channels);
  const sidebarRows = sidebarOpen
    ? renderSidebar(
      state.sidebar,
      state.channelList.channels,
      rows,
      state.panelFocus === "sidebar",
      state.channelList.activeChannelId,
      state.loadingFrameIndex,
      typingChannelIds,
      typingFrameText,
      channelNotifications,
      guildNotifications,
      { showHiddenChannels: state.showHiddenChannels },
    )
    : [];
  const memberListRows = memberListOpen
    ? renderMemberList(
      state.memberList,
      rows,
      state.loadingFrameIndex,
      state.panelFocus === "memberlist",
      state.guildRolesByGuildId,
      state.memberRoleIdsByGuildId,
    )
    : [];

  const emitSidebarCol = (row: number): void => {
    if (sidebarOpen && sidebarRows[row - 1]) {
      out.push(sidebarRows[row - 1]);
    }
  };

  const emitMemberListCol = (row: number): void => {
    if (memberListOpen && memberListRows[row - 1]) {
      out.push(moveTo(row, memberListCol) + memberListRows[row - 1]);
    }
  };

  out.push(moveTo(1, 1) + clearedLine);
  emitSidebarCol(1);
  out.push(moveTo(1, mainCol) + renderTopbar(state, mainW));
  emitMemberListCol(1);

  const bodyBorder = historyFocused ? theme.borderFocused : theme.borderUnfocused;
  const promptColor = promptFocused ? theme.accent : theme.dim;

  out.push(moveTo(2, 1) + clearedLine);
  emitSidebarCol(2);
  out.push(moveTo(2, mainCol) + bgLine(`${bodyBorder}${"─".repeat(mainW)}${theme.reset}`));
  emitMemberListCol(2);

  const status = renderStatusLine(state, mainW);
  const statusHeight = status.height;
  const bottomStatusRows = statusHeight > 0 ? statusHeight + 1 : 0;
  const imageIndicatorRows = state.pendingImages.length > 0 ? 1 : 0;

  const maxInputWidth = Math.max(1, mainW - PROMPT_PREFIX_WIDTH);
  const input = getInputLines(
    state.editor.buffer,
    displayCursor(state.editor),
    maxInputWidth,
    Math.max(1, Math.min(MAX_PROMPT_ROWS, rows - 3 - bottomStatusRows - imageIndicatorRows)),
    state.editor.scroll,
  );
  state.editor.scroll = input.scrollOffset;

  const inputRowCount = Math.max(1, input.lines.length);
  const promptSeparatorRow = Math.max(3, rows - inputRowCount - bottomStatusRows - imageIndicatorRows);
  const imageIndicatorRow = promptSeparatorRow + 1;
  const firstInputRow = promptSeparatorRow + imageIndicatorRows + 1;
  const promptBottomSeparatorRow = firstInputRow + inputRowCount;
  const statusStartRow = promptBottomSeparatorRow + 1;
  const bodyTop = 3;
  const activeTypingUsers = getTypingUsers(
    state.typing,
    state.channelList.activeChannelId ?? state.timeline.channelId,
    state.auth.user?.id ?? null,
  );
  const typingLine = formatTypingUsers(activeTypingUsers);
  const typingRowCount = typingLine ? 1 : 0;
  const bodyRows = Math.max(0, promptSeparatorRow - bodyTop - typingRowCount);
  const typingRow = promptSeparatorRow - typingRowCount;
  const bodyInnerWidth = Math.max(0, mainW - 2);

  const oldAnchors = state.historyLineAnchors;
  const oldViewStart = state.timeline.scrollOffset;
  const oldCursorRow = state.historyCursor.row;
  const oldVisualAnchorRow = state.historyVisualAnchor.row;
  const pinHistoryToBottom = oldViewStart === Number.MAX_SAFE_INTEGER;
  const pinPromptChromeToBottom = state.chatFocus === "prompt" && isTimelineNearBottom(oldViewStart, state.timeline.maxScroll);
  const pinTypingToBottom = Boolean(typingLine) && isTimelineNearBottom(oldViewStart, state.timeline.maxScroll);
  if (pinPromptChromeToBottom || pinTypingToBottom) {
    state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  }

  setTimelineRenderContext(
    state.timeline,
    state.auth.user?.id ?? null,
    state.channelList.activeChannel?.guildId === DIRECT_MESSAGES_GUILD_ID,
    state.guildRolesByGuildId,
    state.memberRoleIdsByGuildId,
    state.memberRoleCacheVersion,
    state.channelList.activeChannel?.guildId ?? null,
  );
  const timeline = renderTimelineLines(state.timeline, bodyInnerWidth, bodyRows, state.notice, state.loadingFrameIndex);

  if (oldAnchors.length > 0 && !state.historyCursorPendingVisibleBottom && !pinHistoryToBottom && !pinPromptChromeToBottom && !pinTypingToBottom) {
    const anchorIndex = buildLineAnchorIndex(timeline.lineAnchors);
    state.timeline.scrollOffset = Math.max(0, Math.min(remapRenderedRow(oldViewStart, oldAnchors, anchorIndex), timeline.maxScroll));
    state.historyCursor = { ...state.historyCursor, row: remapRenderedRow(oldCursorRow, oldAnchors, anchorIndex) };
    state.historyVisualAnchor = {
      ...state.historyVisualAnchor,
      row: remapRenderedRow(oldVisualAnchorRow, oldAnchors, anchorIndex),
    };
  }

  state.historyLineAnchors = timeline.lineAnchors;
  state.historyLines = timeline.allLines;
  state.historyWrapContinuation = timeline.wrapContinuation;
  state.historyMessageBounds = timeline.messageBounds;
  if (state.chatFocus === "history" && state.historyCursorPendingVisibleBottom && state.historyLines.length > 0) {
    const visibleBottom = state.timeline.scrollOffset + Math.max(0, Math.min(bodyRows, timeline.lines.length) - 1);
    state.historyCursor = { row: Math.min(visibleBottom, state.historyLines.length - 1), col: 0 };
    state.historyVisualAnchor = { ...state.historyCursor };
    state.historyCursorPendingVisibleBottom = false;
  }
  state.historyCursor = clampHistoryCursor(state.historyCursor, state.historyLines);

  const fallbackBody = renderBodyLines(state, bodyInnerWidth);
  const useTimeline = timeline.allLines.length > 0;
  const timelineLines = useTimeline ? timeline.lines : fallbackBody;

  for (let i = 0; i < bodyRows; i++) {
    const row = bodyTop + i;
    out.push(moveTo(row, 1) + clearedLine);
    emitSidebarCol(row);

    const lineIndex = state.timeline.scrollOffset + i;
    const line = useTimeline && lineIndex < state.historyLines.length
      ? renderHistoryViewportLine(state, state.historyLines[lineIndex] ?? "", lineIndex, historyFocused)
      : (timelineLines[i] ?? "");

    const renderedLine = useTimeline && isHistoryLineHighlighted(state, lineIndex, historyFocused)
      ? applyLineBg(` ${line}`, theme.historyLineBg)
      : bgLine(` ${line}`);

    out.push(moveTo(row, mainCol) + renderedLine);
    emitMemberListCol(row);
  }

  if (typingLine) {
    out.push(moveTo(typingRow, 1) + clearedLine);
    emitSidebarCol(typingRow);
    out.push(moveTo(typingRow, mainCol) + bgLine(` ${theme.muted}${typingFrameText} ${typingLine}${theme.reset}`));
    emitMemberListCol(typingRow);
  }

  if (state.autocomplete) {
    out.push(renderAutocompletePopup(state, mainW, promptSeparatorRow, mainCol));
  }

  out.push(moveTo(promptSeparatorRow, 1) + clearedLine);
  emitSidebarCol(promptSeparatorRow);
  out.push(moveTo(promptSeparatorRow, mainCol) + bgLine(`${promptColor}${"─".repeat(mainW)}${theme.reset}`));
  emitMemberListCol(promptSeparatorRow);

  if (imageIndicatorRows > 0) {
    out.push(moveTo(imageIndicatorRow, 1) + clearedLine);
    emitSidebarCol(imageIndicatorRow);
    out.push(moveTo(imageIndicatorRow, mainCol) + bgLine(renderImageIndicator(state, mainW)));
    emitMemberListCol(imageIndicatorRow);
  }

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
        lineContent = highlightPromptViewport(input.lines[i] ?? "", state.editor.buffer, offsets[input.scrollOffset + i] ?? 0, state);
      }
    }

    out.push(moveTo(row, 1) + clearedLine);
    emitSidebarCol(row);
    out.push(moveTo(row, mainCol) + bgLine(`${prefix}${lineContent}`));
    emitMemberListCol(row);
  }

  if (statusHeight > 0) {
    out.push(moveTo(promptBottomSeparatorRow, 1) + clearedLine);
    emitSidebarCol(promptBottomSeparatorRow);
    out.push(moveTo(promptBottomSeparatorRow, mainCol) + bgLine(`${promptColor}${"─".repeat(mainW)}${theme.reset}`));
    emitMemberListCol(promptBottomSeparatorRow);

    for (let i = 0; i < statusHeight; i++) {
      const row = statusStartRow + i;
      out.push(moveTo(row, 1) + clearedLine);
      emitSidebarCol(row);
      out.push(moveTo(row, mainCol) + bgLine(status.lines[i] ?? ""));
      emitMemberListCol(row);
    }
  }

  if (historyFocused && state.historyLines.length > 0) {
    const visibleRow = state.historyCursor.row - state.timeline.scrollOffset;
    if (visibleRow >= 0 && visibleRow < bodyRows) {
      const cursorRow = bodyTop + visibleRow;
      const cursorCol = Math.min(cols, mainCol + 1 + state.historyCursor.col);
      out.push(moveTo(cursorRow, cursorCol));
      out.push(
        state.editor.mode === "visual" || state.editor.mode === "visual-line"
          ? cursorUnderline
          : cursorBlock,
      );
      out.push(showCursor);
    } else {
      out.push(hideCursor);
    }
  } else {
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
  }

  process.stdout.write(out.join(""));
}
