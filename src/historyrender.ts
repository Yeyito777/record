/**
 * ANSI cursor and selection overlays for chat history.
 */

import { stripAnsi } from "./historycursor";
import { hexToAnsi, theme } from "./theme";

const CURSOR_FG = hexToAnsi("#000000");
const ANSI_OR_HYPERLINK = /^\x1b(?:\[[0-9;]*[A-Za-z]|\]8;[^;]*;[^\x1b]*\x1b\\)/;

export function renderLineWithCursor(line: string, col: number): string {
  const plain = stripAnsi(line);
  if (plain.length === 0) {
    return `${CURSOR_FG}${theme.cursorBg} ${theme.reset}`;
  }

  const parts: string[] = [];
  let visibleIndex = 0;
  let i = 0;
  let cursorRendered = false;
  let activeEscapes: string[] = [];

  while (i < line.length) {
    if (line[i] === "\x1b") {
      const match = line.slice(i).match(ANSI_OR_HYPERLINK);
      if (match) {
        const esc = match[0];
        if (esc === theme.reset || esc === "\x1b[0m") {
          activeEscapes = [];
        } else {
          activeEscapes.push(esc);
        }
        parts.push(esc);
        i += esc.length;
        continue;
      }
    }

    if (visibleIndex === col) {
      parts.push(`${CURSOR_FG}${theme.cursorBg}${line[i]}${theme.reset}${activeEscapes.join("")}`);
      cursorRendered = true;
    } else {
      parts.push(line[i]);
    }
    visibleIndex++;
    i++;
  }

  if (!cursorRendered) {
    parts.push(`${CURSOR_FG}${theme.cursorBg} ${theme.reset}`);
  }

  return parts.join("");
}

export function renderLineWithSelection(line: string, startCol: number, endCol: number): string {
  const plain = stripAnsi(line);
  if (plain.length === 0 || startCol >= plain.length) {
    return `${line}${theme.selectionBg} ${theme.reset}`;
  }

  const fullLine = startCol === -1;
  const parts: string[] = [];
  let visibleIndex = 0;
  let i = 0;
  let activeEscapes: string[] = [];
  let inSelection = fullLine;

  if (fullLine) parts.push(theme.selectionBg);

  while (i < line.length) {
    if (line[i] === "\x1b") {
      const match = line.slice(i).match(ANSI_OR_HYPERLINK);
      if (match) {
        const esc = match[0];
        if (esc === theme.reset || esc === "\x1b[0m") {
          activeEscapes = [];
          parts.push(esc);
          if (inSelection) parts.push(theme.selectionBg);
        } else {
          activeEscapes.push(esc);
          parts.push(esc);
        }
        i += esc.length;
        continue;
      }
    }

    if (!fullLine && visibleIndex === startCol) {
      inSelection = true;
      parts.push(theme.selectionBg);
    }

    parts.push(line[i]);

    if (!fullLine && visibleIndex === endCol) {
      inSelection = false;
      parts.push(`${theme.reset}${activeEscapes.join("")}`);
    }

    visibleIndex++;
    i++;
  }

  if (inSelection) parts.push(theme.reset);
  return parts.join("");
}
