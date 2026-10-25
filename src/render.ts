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
  promptRowLimit,
  PROMPT_PREFIX_WIDTH,
} from "./editor";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";
import { customEmojiImages, customEmojiMarker, type CustomEmojiRenderBatch } from "./customemoji";
import { renderBodyLines } from "./bodypanel";
import {
  appendPositionedPayload,
  appendRowWrite,
  createFrameRows,
  flushFrame,
  hasRetainedFrame,
  type FrameImages,
  type ScrollRegion,
} from "./frame";
import {
  buildLineAnchorIndex,
  clampHistoryCursor,
  contentBounds,
  logicalLineRange,
  remapRenderedRow,
  stripAnsi,
} from "./historycursor";
import { renderLineWithCursor, renderLineWithSelection } from "./historyrender";
import { imageModalLayout, renderImageModal } from "./imagemodal";
import { renderMemberList, MEMBER_LIST_WIDTH } from "./memberlist";
import { channelNotificationCounts, guildNotificationCounts } from "./notifications";
import { highlightPromptViewport, promptHighlightRegions, type PromptHighlightRegion } from "./prompthighlight";
import {
  SIDEBAR_WIDTH,
  createSidebarIconFrame,
  getSidebarSearchBarViewport,
  renderSidebar,
  type SidebarIconFrame,
} from "./sidebar";
import {
  SIDEBAR_ICON_COLUMNS,
  SIDEBAR_ICON_MAX_IDLE_BYTES,
  SIDEBAR_ICON_MAX_IDLE_IMAGES,
  sidebarIconTerminalOwner,
  sidebarIcons,
} from "./sidebaricons";
import { INSTAGRAM_GUILD_ID, isFixedTopLevelGuildId, WHATSAPP_GUILD_ID } from "./chatproviders";
import { renderServerActionModal } from "./serveractions";
import { renderStatusLine } from "./statusline";
import { renderPromptSeparator } from "./promptbar";
import { padRight, termWidth, truncate } from "./textwidth";
import { formatSize, imageLabel } from "./imageclipboard";
import type { InlineChatImageReady } from "./inlineimage";
import type { AppState } from "./state";
import { renderLoginModal } from "./whatsapp/loginmodal";
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
import { renderTimelineLines, setTimelineRenderContext, type RenderedTimeline } from "./timeline";
import {
  planInlineTerminalImages,
  type InlineTerminalImagePlacement,
  type InlineTerminalImageUpdate,
} from "./terminalimage";
import { renderTopbar } from "./topbar";
import { smoothScrollerFor, type ScrollRect } from "./smoothscroll";
import { channelsWithTyping, formatTypingUsers, getTypingUsers, typingFrame } from "./typing";
import { voiceMessagePromptText } from "./voice-message";

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
  customEmojiFrame: CustomEmojiRenderBatch,
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
    const item = matches[index];
    const displayName = item.customEmoji ? customEmojiMarker(item.customEmoji) : item.name;
    const name = padRight(displayName, nameWidth);
    const desc = padRight(item.desc, descWidth);
    const nameColor = item.color ?? theme.text;
    const line = `${bg}${theme.accent}${marker}${nameColor}${name}${theme.muted}${desc}${theme.reset}`;
    out.push(moveTo(row, mainCol) + customEmojiImages.renderLine(line, row, mainCol, customEmojiFrame));
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
  lineStart: number | undefined,
  selectionStart: number,
  selectionEndExclusive: number,
): string {
  if (lineStart === undefined) {
    return `${theme.text}${line}${theme.reset}`;
  }

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

function historyVisualSelectionRows(
  state: AppState,
  historyFocused: boolean,
): { first: number; last: number } | null {
  if (!historyFocused || (state.editor.mode !== "visual" && state.editor.mode !== "visual-line")) {
    return null;
  }

  let first = Math.min(state.historyVisualAnchor.row, state.historyCursor.row);
  let last = Math.max(state.historyVisualAnchor.row, state.historyCursor.row);
  if (state.editor.mode === "visual-line") {
    first = logicalLineRange(first, state.historyWrapContinuation).first;
    last = logicalLineRange(last, state.historyWrapContinuation).last;
  }
  return { first, last };
}

function inlineImageColumnsOnLine(timeline: RenderedTimeline, lineIndex: number): number {
  return timeline.inlineImages.reduce((columns, placement) => (
    lineIndex >= placement.lineIndex && lineIndex < placement.lineIndex + placement.rows
      ? Math.max(columns, placement.columns)
      : columns
  ), 0);
}

function isHistoryLinePendingDelete(state: AppState, lineIndex: number): boolean {
  const pending = state.messageDeletePending;
  if (!pending || state.timeline.channelId !== pending.channelId) return false;
  const bound = state.historyMessageBounds.find((entry) => entry.messageId === pending.messageId);
  return Boolean(bound && lineIndex >= bound.start && lineIndex < bound.end);
}

function renderLineWithDeleteForeground(line: string): string {
  const plain = stripAnsi(line);
  return plain.length > 0 ? `${theme.messageDeleteFg}${plain}${theme.reset}` : line;
}

function sameLineAnchors(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
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

function readyInlineImages(state: AppState): InlineChatImageReady[] {
  const images = Object.values(state.timeline.inlineImages)
    .filter((image): image is InlineChatImageReady => image.phase === "ready");
  if (state.imageModal) images.push(state.imageModal.image);
  return images;
}

function visibleInlineImagePlacements(
  timeline: RenderedTimeline,
  viewStart: number,
  bodyTop: number,
  bodyRows: number,
  imageCol: number,
  selectedRows: { first: number; last: number } | null,
  extendBelow = false,
): InlineTerminalImagePlacement[] {
  if (bodyRows <= 0) return [];
  const viewEnd = viewStart + bodyRows;
  const placements: InlineTerminalImagePlacement[] = [];

  for (const placement of timeline.inlineImages) {
    const imageStart = placement.lineIndex;
    const imageEnd = imageStart + placement.rows;
    const visibleStart = Math.max(imageStart, viewStart);
    // While a smooth glide runs, an image cut off by the pane's bottom keeps
    // its rows below too, so the part leaving at the bottom still shows; the
    // terminal clips it to the moving rectangle while it moves.
    const visibleEnd = extendBelow && visibleStart < viewEnd ? imageEnd : Math.min(imageEnd, viewEnd);
    const visibleRows = visibleEnd - visibleStart;
    if (visibleRows <= 0) continue;

    const clippedTopRows = visibleStart - imageStart;
    const sourceY = Math.floor((placement.image.pixelHeight * clippedTopRows) / placement.rows);
    const sourceEnd = Math.min(
      placement.image.pixelHeight,
      Math.ceil((placement.image.pixelHeight * (clippedTopRows + visibleRows)) / placement.rows),
    );
    placements.push({
      image: placement.image,
      placementId: placement.placementId,
      row: bodyTop + visibleStart - viewStart,
      col: imageCol,
      columns: placement.columns,
      rows: visibleRows,
      sourceY,
      sourceHeight: Math.max(1, sourceEnd - sourceY),
      selected: Boolean(selectedRows
        && imageStart <= selectedRows.last
        && imageEnd > selectedRows.first),
    });
  }

  return placements;
}

const SIDEBAR_ICON_PLACEMENT_ID = 1;
// The selected row's icon is a distinct placement so st snapshots the
// highlighted cells under it, instead of treating the highlight as a cover.
const SIDEBAR_ICON_HIGHLIGHTED_PLACEMENT_ID = 2;

/**
 * Sidebar icon placements minus any an overlay covers. Covered icons are
 * removed, not drawn under the overlay: Kitty itself has no cell occlusion.
 */
function visibleSidebarIconPlacements(
  state: AppState,
  frame: SidebarIconFrame | null,
  rows: number,
  cols: number,
): InlineTerminalImagePlacement[] {
  if (!frame || state.whatsapp.loginModal) return [];
  let cover: { top: number; left: number; bottom: number; right: number } | null = null;
  if (state.imageModal) {
    const layout = imageModalLayout(
      state.imageModal,
      rows,
      cols,
      state.timeline.terminalCellWidthPixels,
      state.timeline.terminalCellHeightPixels,
    );
    // Without a layout the viewer's "too small" notice fills the screen.
    cover = layout
      ? { top: layout.top, left: layout.left, bottom: layout.top + layout.height - 1, right: layout.left + layout.width - 1 }
      : { top: 1, left: 1, bottom: rows, right: cols };
  }

  const seen = new Set<string>();
  const placements: InlineTerminalImagePlacement[] = [];
  for (const placement of frame.placements) {
    if (cover && placement.row >= cover.top && placement.row <= cover.bottom
      && placement.col + SIDEBAR_ICON_COLUMNS - 1 >= cover.left && placement.col <= cover.right) continue;
    const placementId = placement.highlighted ? SIDEBAR_ICON_HIGHLIGHTED_PLACEMENT_ID : SIDEBAR_ICON_PLACEMENT_ID;
    const key = `${placement.image.imageId}:${placementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    placements.push({
      image: placement.image,
      placementId,
      row: placement.row,
      col: placement.col,
      columns: SIDEBAR_ICON_COLUMNS,
      rows: 1,
    });
  }
  return placements;
}

function joinImageUpdates(a: InlineTerminalImageUpdate, b: InlineTerminalImageUpdate): InlineTerminalImageUpdate {
  return { transmit: a.transmit + b.transmit, update: a.update + b.update };
}

/** What moves when the history scrolls smoothly: the pane's columns of the band. */
export function smoothScrollRects(band: ScrollRegion | null, mainCol: number, mainW: number): ScrollRect[] {
  return band ? [{ top: band.start, left: mainCol, bottom: band.end, right: mainCol + mainW - 1 }] : [];
}

/** The longest run of rows in [start, end] that no covered row range touches (null below 4 rows). */
export function freeMessageBand(
  start: number,
  end: number,
  covered: readonly { top: number; bottom: number }[],
): ScrollRegion | null {
  let best: ScrollRegion | null = null;
  let runStart = start;
  for (let row = start; row <= end + 1; row++) {
    const blocked = row > end || covered.some((range) => range.top <= row && row <= range.bottom);
    if (!blocked) continue;
    if (row - runStart >= 4 && (!best || row - runStart > best.end - best.start + 1)) {
      best = { start: runStart, end: row - 1 };
    }
    runStart = row + 1;
  }
  return best;
}

/** Rows a cursor-positioned overlay payload draws on. */
function payloadRows(payload: string): { top: number; bottom: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const match of payload.matchAll(/\x1b\[(\d+);\d+H/g)) {
    const row = Number(match[1]);
    top = Math.min(top, row);
    bottom = Math.max(bottom, row);
  }
  return top <= bottom ? { top, bottom } : null;
}

/** Each state's maxScroll at its previous smooth-scroll layout. */
const smoothMaxScroll = new WeakMap<object, number>();

export function render(state: AppState): void {
  const cols = Math.max(1, state.cols);
  const rows = Math.max(3, state.rows);

  const appBg = theme.appBg ?? "";
  const clearedLine = appBg + clearLine;
  const frameRows = createFrameRows(rows, clearedLine);
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
  const sidebarIconFrame = sidebarOpen && sidebarIcons.isEnabled()
    ? createSidebarIconFrame((source) => sidebarIcons.get(source))
    : null;
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
      {
        showHiddenChannels: state.showHiddenChannels,
        currentUserId: state.auth.user?.id ?? null,
      },
      sidebarIconFrame,
    )
    : [];
  if (sidebarIconFrame) sidebarIcons.want(sidebarIconFrame.visible, sidebarIconFrame.nearby);
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

  // Side panels' segments of each row (RenderFrame.pinned): a smooth-scroll
  // region scroll moves whole rows, so beside moved rows only these repaint.
  const pinnedRows: string[][] = [];
  const pinRow = (row: number, segment: string): void => {
    (pinnedRows[row - 1] ??= []).push(segment);
  };

  const emitSidebarCol = (row: number): void => {
    if (sidebarOpen && sidebarRows[row - 1]) {
      appendRowWrite(frameRows, row, 1, sidebarRows[row - 1]);
      pinRow(row, moveTo(row, 1) + sidebarRows[row - 1]);
    }
  };

  const emitMemberListCol = (row: number): void => {
    if (memberListOpen && memberListRows[row - 1]) {
      appendRowWrite(frameRows, row, memberListCol, memberListRows[row - 1]);
      pinRow(row, moveTo(row, memberListCol) + memberListRows[row - 1]);
    }
  };

  emitSidebarCol(1);
  appendRowWrite(frameRows, 1, mainCol, renderTopbar(state, mainW));
  emitMemberListCol(1);

  const bodyBorder = historyFocused ? theme.borderFocused : theme.borderUnfocused;
  const promptColor = promptFocused ? theme.accent : theme.dim;

  emitSidebarCol(2);
  appendRowWrite(frameRows, 2, mainCol, bgLine(`${bodyBorder}${"─".repeat(mainW)}${theme.reset}`));
  emitMemberListCol(2);

  const status = renderStatusLine(state, mainW);
  const statusHeight = status.height;
  const bottomStatusRows = statusHeight > 0 ? statusHeight + 1 : 0;
  const imageIndicatorRows = state.pendingImages.length > 0 ? 1 : 0;

  const voicePromptText = state.voiceMessagePrompt ? voiceMessagePromptText(state.voiceMessagePrompt) : null;
  const promptBuffer = voicePromptText ?? state.editor.buffer;
  const promptCursor = voicePromptText ? promptBuffer.length : displayCursor(state.editor);
  const maxInputWidth = Math.max(1, mainW - PROMPT_PREFIX_WIDTH);
  const input = getInputLines(
    promptBuffer,
    promptCursor,
    maxInputWidth,
    promptRowLimit(rows - 3 - bottomStatusRows - imageIndicatorRows),
    state.editor.scroll,
  );
  state.editor.scroll = input.scrollOffset;
  state.editor.wrapWidth = maxInputWidth;

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
  const previousTypingRowCount = state.lastTypingRowCount;
  const bodyRows = Math.max(0, promptSeparatorRow - bodyTop - typingRowCount);
  const typingRow = promptSeparatorRow - typingRowCount;
  const bodyInnerWidth = Math.max(0, mainW - 2);
  state.chatMouseLayout = {
    firstCol: mainCol,
    lastCol: mainCol + mainW - 1,
    bodyTop,
    bodyRows,
    firstInputRow,
    inputRows: inputRowCount,
  };

  const oldAnchors = state.historyLineAnchors;
  const oldViewStart = state.timeline.scrollOffset;
  const oldCursorRow = state.historyCursor.row;
  const oldVisualAnchorRow = state.historyVisualAnchor.row;
  const pinHistoryToBottom = oldViewStart === Number.MAX_SAFE_INTEGER;
  const wasPinnedToBottom = oldViewStart === Number.MAX_SAFE_INTEGER || oldViewStart >= state.timeline.maxScroll;
  const pinPromptChromeToBottom = state.chatFocus === "prompt" && wasPinnedToBottom;
  const pinTypingToBottom = Boolean(typingLine) && wasPinnedToBottom;
  if (pinPromptChromeToBottom || pinTypingToBottom) {
    state.timeline.scrollOffset = Number.MAX_SAFE_INTEGER;
  }

  const activeGuildId = state.channelList.activeChannel?.guildId ?? null;
  const activeViewerId = activeGuildId === INSTAGRAM_GUILD_ID
    ? state.instagram.account?.id ?? null
    : activeGuildId === WHATSAPP_GUILD_ID
    ? state.whatsapp.account?.id ?? null
    : state.auth.user?.id ?? null;
  setTimelineRenderContext(
    state.timeline,
    activeViewerId,
    isFixedTopLevelGuildId(activeGuildId),
    state.guildRolesByGuildId,
    state.memberRoleIdsByGuildId,
    state.memberRoleCacheVersion,
    activeGuildId,
  );
  const timelineNotice = state.timeline.messages.length === 0 && state.timeline.channelId === null
    ? state.notice
    : { ...state.notice, chat: false };
  const timeline = renderTimelineLines(state.timeline, bodyInnerWidth, bodyRows, timelineNotice, state.loadingFrameIndex);

  // Same anchors array = the cached content was reused and no row moved;
  // indexing every row of a long channel per frame was 40% of a scroll step.
  if (oldAnchors.length > 0 && timeline.lineAnchors !== oldAnchors && !state.historyCursorPendingVisibleBottom && !pinHistoryToBottom && !pinPromptChromeToBottom && !pinTypingToBottom) {
    const anchorIndex = buildLineAnchorIndex(timeline.lineAnchors);
    state.timeline.scrollOffset = Math.max(0, Math.min(remapRenderedRow(oldViewStart, oldAnchors, anchorIndex), timeline.maxScroll));
    state.historyCursor = { ...state.historyCursor, row: remapRenderedRow(oldCursorRow, oldAnchors, anchorIndex) };
    state.historyVisualAnchor = {
      ...state.historyVisualAnchor,
      row: remapRenderedRow(oldVisualAnchorRow, oldAnchors, anchorIndex),
    };
  }

  const typingRowsDelta = typingRowCount - previousTypingRowCount;
  if (historyFocused
    && typingRowsDelta !== 0
    && !wasPinnedToBottom
    && oldAnchors.length > 0
    && sameLineAnchors(oldAnchors, timeline.lineAnchors)) {
    state.timeline.scrollOffset = Math.max(0, Math.min(state.timeline.scrollOffset + typingRowsDelta, timeline.maxScroll));
  }
  state.lastTypingRowCount = typingRowCount;

  state.historyLineAnchors = timeline.lineAnchors;
  state.historyLines = timeline.allLines;
  state.historyLineBackgrounds = timeline.lineBackgrounds;
  state.historyWrapContinuation = timeline.wrapContinuation;
  state.historyMessageBounds = timeline.messageBounds;
  if (state.chatFocus === "history" && state.historyCursorPendingVisibleBottom && state.historyLines.length > 0) {
    const visibleBottom = state.timeline.scrollOffset + Math.max(0, Math.min(bodyRows, timeline.lines.length) - 1);
    state.historyCursor = { row: Math.min(visibleBottom, state.historyLines.length - 1), col: 0 };
    state.historyCurswant = null;
    state.historyVisualAnchor = { ...state.historyCursor };
    state.historyCursorPendingVisibleBottom = false;
  }
  state.historyCursor = clampHistoryCursor(state.historyCursor, state.historyLines);

  const fallbackBody = renderBodyLines(state, bodyInnerWidth);
  const useTimeline = timeline.allLines.length > 0;
  const timelineLines = useTimeline ? timeline.lines : fallbackBody;

  // App-driven smooth scrolling (st mode 2032, smoothscroll.ts) decides which
  // whole row to lay the history out at while st animates the glide; input,
  // the history cursor and pinning keep working on the logical scrollOffset.
  const smooth = state.scrollRegions ? smoothScrollerFor(state) : null;
  let viewStart = state.timeline.scrollOffset;
  if (smooth) {
    const maxScroll = useTimeline ? timeline.maxScroll : 0;
    // The scroller counts rows from the bottom: following the bottom is 0,
    // and older history arriving above the view changes nothing.
    const logical = useTimeline ? maxScroll - state.timeline.scrollOffset : 0;
    const followed = pinHistoryToBottom || pinPromptChromeToBottom || pinTypingToBottom;
    const previousMaxScroll = smoothMaxScroll.get(state);
    // How far keeping the same content in view moved the position (messages
    // arriving below a scrolled-up view, the typing line): not a scroll.
    const pinDelta = followed || !useTimeline || previousMaxScroll === undefined
      ? 0
      : (maxScroll - previousMaxScroll) - (state.timeline.scrollOffset - oldViewStart);
    smoothMaxScroll.set(state, maxScroll);
    // Another channel or view, or a different pane geometry, re-lays
    // everything out: no glide. The typing line only moves the pane's bottom.
    const context = [
      state.timeline.channelId, state.timeline.view, useTimeline, cols, rows,
      bodyTop, promptSeparatorRow, mainCol, bodyInnerWidth,
    ].join("|");
    viewStart = maxScroll - smooth.layout(logical, maxScroll, pinDelta, bodyRows, context);
  }
  const customEmojiFrame = customEmojiImages.beginFrame();
  const selectedHistoryRows = historyVisualSelectionRows(state, historyFocused);

  for (let i = 0; i < bodyRows; i++) {
    const row = bodyTop + i;
    emitSidebarCol(row);

    const lineIndex = viewStart + i;
    const pendingDeleteLine = useTimeline && isHistoryLinePendingDelete(state, lineIndex);
    const rawLine = useTimeline && lineIndex < state.historyLines.length
      ? (state.historyLines[lineIndex] ?? "")
      : (timelineLines[i] ?? "");
    const line = useTimeline && lineIndex < state.historyLines.length
      ? renderHistoryViewportLine(state, pendingDeleteLine ? renderLineWithDeleteForeground(rawLine) : rawLine, lineIndex, historyFocused)
      : rawLine;

    const lineBackground = useTimeline ? (state.historyLineBackgrounds[lineIndex] ?? "") : "";
    const highlighted = useTimeline
      && !pendingDeleteLine
      && isHistoryLineHighlighted(state, lineIndex, historyFocused);
    const imageBackground = lineBackground || appBg || "\x1b[49m";
    let renderedLine = highlighted
      ? applyLineBg(` ${line}`, theme.historyLineBg)
      : lineBackground
        ? applyLineBg(` ${line}`, lineBackground)
        : bgLine(` ${line}`);
    const inlineImageColumns = highlighted ? inlineImageColumnsOnLine(timeline, lineIndex) : 0;
    if (inlineImageColumns > 0) {
      // Expanded attachment rows are otherwise blank. Keep the passive line
      // highlight around the image while restoring its exact occupied cells to
      // their ordinary background so st does not treat it as an occluding menu.
      renderedLine += `${imageBackground}${" ".repeat(inlineImageColumns)}${theme.reset}`;
    }

    appendRowWrite(
      frameRows,
      row,
      mainCol,
      customEmojiImages.renderLine(renderedLine, row, mainCol, customEmojiFrame, highlighted ? {
        imageBackground,
        restoreBackground: theme.historyLineBg,
      } : undefined),
    );
    emitMemberListCol(row);
  }

  if (typingLine) {
    emitSidebarCol(typingRow);
    appendRowWrite(frameRows, typingRow, mainCol, bgLine(` ${theme.muted}${typingFrameText} ${typingLine}${theme.reset}`));
    emitMemberListCol(typingRow);
  }

  // Overlays drawn over the message rows; a smooth-scroll band avoids them.
  const overlayRows: { top: number; bottom: number }[] = [];
  const addOverlay = (payload: string): void => {
    appendPositionedPayload(frameRows, payload);
    const covered = payloadRows(payload);
    if (covered) overlayRows.push(covered);
  };

  if (state.autocomplete) {
    addOverlay(renderAutocompletePopup(state, mainW, promptSeparatorRow, mainCol, customEmojiFrame));
  }

  emitSidebarCol(promptSeparatorRow);
  appendRowWrite(frameRows, promptSeparatorRow, mainCol, bgLine(renderPromptSeparator(state, mainW, promptColor)));
  emitMemberListCol(promptSeparatorRow);

  if (imageIndicatorRows > 0) {
    emitSidebarCol(imageIndicatorRow);
    appendRowWrite(frameRows, imageIndicatorRow, mainCol, bgLine(renderImageIndicator(state, mainW)));
    emitMemberListCol(imageIndicatorRow);
  }

  const promptInVisual = !voicePromptText && promptFocused && (state.editor.mode === "visual" || state.editor.mode === "visual-line");
  const selection = promptInVisual
    ? getVisualRange(state.editor.buffer, state.editor.visualAnchor, state.editor.cursor, state.editor.mode)
    : null;

  let highlightRegions: PromptHighlightRegion[] | null = null;
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
        input.lineStarts[i],
        selection.start,
        selection.endExclusive,
      );
    } else {
      lineContent = `${theme.text}${input.lines[i] ?? ""}${theme.reset}`;
      if (voicePromptText) {
        lineContent = `${theme.accent}${input.lines[i] ?? ""}${theme.reset}`;
      } else if (state.editor.buffer.length > 0) {
        highlightRegions ??= promptHighlightRegions(state.editor.buffer, state);
        lineContent = highlightPromptViewport(
          input.lines[i] ?? "", state.editor.buffer, input.lineStarts[i] ?? 0, state, highlightRegions,
        );
      }
    }

    emitSidebarCol(row);
    appendRowWrite(
      frameRows,
      row,
      mainCol,
      customEmojiImages.renderLine(bgLine(`${prefix}${lineContent}`), row, mainCol, customEmojiFrame),
    );
    emitMemberListCol(row);
  }

  if (statusHeight > 0) {
    emitSidebarCol(promptBottomSeparatorRow);
    appendRowWrite(frameRows, promptBottomSeparatorRow, mainCol, bgLine(`${promptColor}${"─".repeat(mainW)}${theme.reset}`));
    emitMemberListCol(promptBottomSeparatorRow);

    for (let i = 0; i < statusHeight; i++) {
      const row = statusStartRow + i;
      emitSidebarCol(row);
      appendRowWrite(frameRows, row, mainCol, bgLine(status.lines[i] ?? ""));
      emitMemberListCol(row);
    }
  }

  if (sidebarOpen && state.sidebar.serverActionModal) {
    const selectedSidebarRow = 3 + state.sidebar.selectedIndex - state.sidebar.scrollOffset;
    addOverlay(renderServerActionModal(
      state.sidebar.serverActionModal,
      selectedSidebarRow,
      SIDEBAR_WIDTH + 1,
      rows,
      cols,
    ));
  }

  if (state.whatsapp.loginModal) {
    addOverlay(renderLoginModal(state.whatsapp.loginModal, rows, cols));
  }

  const imageModal = state.imageModal
    ? renderImageModal(
      state.imageModal,
      rows,
      cols,
      state.timeline.terminalCellWidthPixels,
      state.timeline.terminalCellHeightPixels,
    )
    : null;
  if (imageModal) addOverlay(imageModal.payload);

  const cursorPayload: string[] = [];
  if (state.whatsapp.loginModal || state.imageModal) {
    cursorPayload.push(hideCursor);
  } else if (state.panelFocus === "sidebar" && state.sidebar.search?.barOpen) {
    const { cursorCol } = getSidebarSearchBarViewport(state.sidebar.search, SIDEBAR_WIDTH - 1);
    cursorPayload.push(moveTo(rows, 1 + cursorCol));
    cursorPayload.push(cursorBar);
    cursorPayload.push(showCursor);
  } else if (historyFocused && state.historyLines.length > 0) {
    const visibleRow = state.historyCursor.row - viewStart;
    if (visibleRow >= 0 && visibleRow < bodyRows) {
      const cursorRow = bodyTop + visibleRow;
      const cursorLine = stripAnsi(state.historyLines[state.historyCursor.row] ?? "");
      const cursorCellOffset = termWidth(cursorLine.slice(0, state.historyCursor.col));
      const cursorCol = Math.min(cols, mainCol + 1 + cursorCellOffset);
      cursorPayload.push(moveTo(cursorRow, cursorCol));
      cursorPayload.push(
        state.editor.mode === "visual" || state.editor.mode === "visual-line"
          ? cursorUnderline
          : cursorBlock,
      );
      cursorPayload.push(showCursor);
    } else {
      cursorPayload.push(hideCursor);
    }
  } else {
    const cursorRow = firstInputRow + input.cursorLine;
    const cursorCol = Math.min(cols, mainCol + PROMPT_PREFIX_WIDTH + input.cursorCol);
    cursorPayload.push(moveTo(cursorRow, cursorCol));
    if (promptFocused) {
      cursorPayload.push(
        state.editor.mode === "insert"
          ? cursorBar
          : (state.editor.pendingOperator || state.editor.pendingReplace
            || state.editor.pendingKeys === "<" || state.editor.pendingKeys === ">")
            ? cursorUnderline
            : cursorBlock,
      );
      cursorPayload.push(showCursor);
    } else {
      cursorPayload.push(hideCursor);
    }
  }

  // A terminal region scroll moves whole rows: st has no left/right margins
  // (DECLRMM). The body rows qualify only while the pane spans the full width
  // with nothing drawn over it; otherwise side columns would scroll with it
  // (and glide under smooth scrolling) and need a full rewrite anyway.
  const canScrollMessageRegion = !sidebarOpen
    && !memberListOpen
    && !state.autocomplete
    && !state.whatsapp.loginModal
    && !state.imageModal
    && bodyRows > 0;
  // With smooth scrolling, or on a terminal that confirmed synchronized
  // updates (so no frame shows the side panels displaced), the band is the
  // longest run of message rows no overlay touches, beside the sidebar and
  // member list too: their segments are repainted beside the moved rows in
  // the same update, and a moving rectangle covers only the pane's columns.
  const bands = !!smooth || (state.scrollRegions && state.synchronizedUpdates);
  const scrollRegion = bands
    ? freeMessageBand(bodyTop, bodyTop + bodyRows - 1, overlayRows)
    : canScrollMessageRegion ? { start: bodyTop, end: bodyTop + bodyRows - 1 } : null;
  const smoothRects = smooth ? smoothScrollRects(scrollRegion, mainCol, mainW) : [];

  const inlinePlacements = state.whatsapp.loginModal
    ? []
    : visibleInlineImagePlacements(
      timeline,
      viewStart,
      bodyTop,
      bodyRows,
      mainCol + 1,
      state.imageModal ? null : selectedHistoryRows,
      // Only while gliding, and only at the band's bottom edge: at rest images
      // are cropped to the pane exactly as without smooth scrolling.
      !!smooth?.busy() && scrollRegion?.end === bodyTop + bodyRows - 1,
    );
  if (imageModal?.placement) inlinePlacements.push(imageModal.placement);
  const inlineImageOptions = { allowPlacementUpdates: !state.autocomplete || !!state.imageModal };
  const sidebarPlacements = visibleSidebarIconPlacements(state, sidebarIconFrame, rows, cols);
  const sidebarImageOptions = {
    replacePlacements: !hasRetainedFrame(state),
    maxIdleImages: SIDEBAR_ICON_MAX_IDLE_IMAGES,
    maxIdleBytes: SIDEBAR_ICON_MAX_IDLE_BYTES,
  };
  const planImages = (movedRows: ScrollRegion | null = null) => joinImageUpdates(
    planInlineTerminalImages(state, readyInlineImages(state), inlinePlacements, { ...inlineImageOptions, movedRows }),
    planInlineTerminalImages(
      sidebarIconTerminalOwner,
      sidebarPlacements.map((placement) => placement.image),
      sidebarPlacements,
      // A smooth-scroll region scroll moves whole rows: sidebar icons beside
      // the moved rows moved too and are placed back where they belong.
      { ...sidebarImageOptions, movedRows },
    ),
  );
  // Band frames tell the planners which rows their region scroll moved.
  const images: FrameImages = bands ? planImages : planImages();

  flushFrame(state, {
    rows: frameRows,
    pinned: pinnedRows,
    cursor: cursorPayload.join(""),
    scrollRegion,
    viewStart,
    regionScrolls: state.scrollRegions,
    bands,
    graphics: smooth ? customEmojiImages.finishTrackedFrame(customEmojiFrame) : customEmojiImages.finishFrame(customEmojiFrame),
    afterScroll: smooth ? (regionShift, intact, scrolled) => smooth.afterFlush(regionShift, smoothRects, intact, scrolled) : undefined,
  }, images);
}
