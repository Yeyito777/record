/**
 * Full-screen renderer for record.
 *
 * Layout follows the Exocortex TUI style:
 * topbar, separator, body, prompt separator, prompt.
 */

import { displayCursor, getViewport } from "./editor";
import { renderBodyLines } from "./bodypanel";
import { highlightPromptViewport } from "./prompthighlight";
import { truncate } from "./strings";
import type { AppState } from "./state";
import { applyLineBg, clearLine, cursorBar, cursorBlock, moveTo, showCursor } from "./terminal";
import { theme } from "./theme";
import { renderTopbar } from "./topbar";

function renderAutocompletePopup(state: AppState, width: number, promptSeparatorRow: number): string {
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
      moveTo(row, 1)
      + `${bg}${theme.accent}${marker}${theme.text}${name}${theme.muted}${desc}${theme.reset}`,
    );
  }

  return out.join("");
}

export function render(state: AppState): void {
  const width = Math.max(1, state.cols);
  const rows = Math.max(3, state.rows);
  const out: string[] = [];

  const appBg = theme.appBg ?? "";
  const clearedLine = appBg + clearLine;
  const bgLine = appBg
    ? (line: string) => applyLineBg(line, appBg)
    : (line: string) => line;

  const writeRow = (row: number, line = ""): void => {
    out.push(moveTo(row, 1) + clearedLine + moveTo(row, 1) + bgLine(line));
  };

  const writeTopbarRow = (row: number, line: string): void => {
    out.push(moveTo(row, 1) + clearedLine + moveTo(row, 1) + applyLineBg(line, theme.topbarBg));
  };

  writeTopbarRow(1, renderTopbar(width));
  if (rows >= 2) {
    writeRow(2, `${theme.borderUnfocused}${"─".repeat(width)}${theme.reset}`);
  }

  const promptSeparatorRow = Math.max(3, rows - 1);
  const promptRow = rows;
  const bodyTop = 3;
  const bodyBottom = Math.max(2, promptSeparatorRow - 1);
  const bodyHeight = Math.max(0, bodyBottom - bodyTop + 1);
  const bodyLines = renderBodyLines(state, width);

  for (let i = 0; i < bodyHeight; i++) {
    writeRow(bodyTop + i, bodyLines[i] ?? "");
  }

  if (state.autocomplete) {
    out.push(renderAutocompletePopup(state, width, promptSeparatorRow));
  }

  writeRow(promptSeparatorRow, `${theme.borderFocused}${"─".repeat(width)}${theme.reset}`);

  const modeLabel = state.editor.mode === "insert" ? "I" : "N";
  const modeColor = state.editor.mode === "insert" ? theme.vimInsert : theme.vimNormal;
  const promptPrefixPlain = `${modeLabel} > `;
  const promptPrefix = `${modeColor}${modeLabel}${theme.reset} ${theme.prompt}>${theme.reset} `;
  const fieldWidth = Math.max(1, width - promptPrefixPlain.length);

  const cursor = displayCursor(state.editor);
  const viewport = getViewport(state.editor.buffer, cursor, fieldWidth, state.editor.scroll);
  state.editor.scroll = viewport.scroll;

  const isCommandBuffer = state.editor.buffer.trimStart().startsWith("/");
  let promptText = viewport.text ? `${theme.text}${viewport.text}${theme.reset}` : "";
  if (isCommandBuffer && state.editor.buffer.length > 0) {
    promptText = highlightPromptViewport(viewport.text, state.editor.buffer, viewport.scroll);
  }

  writeRow(promptRow, `${promptPrefix}${promptText}`);

  const cursorCol = Math.min(width, promptPrefixPlain.length + viewport.cursorCol + 1);
  out.push(moveTo(promptRow, cursorCol));
  out.push(state.editor.mode === "insert" ? cursorBar : cursorBlock);
  out.push(showCursor);

  process.stdout.write(out.join(""));
}
