import type { DiscordMessageAttachment } from "./discord";
import { contentBounds, logicalLineRange, stripAnsi } from "./historycursor";
import { findOpenableTargetMatches } from "./openable";
import type { AppState } from "./state";

interface LogicalCursorLine {
  text: string;
  cursorOffset: number;
}

function logicalLineAtHistoryCursor(state: AppState): LogicalCursorLine | null {
  const row = state.historyCursor.row;
  const lines = state.historyLines;
  if (row < 0 || row >= lines.length) return null;

  const range = state.historyWrapContinuation.length > 0
    ? logicalLineRange(row, state.historyWrapContinuation)
    : { first: row, last: row };

  let logicalText = "";
  let cursorOffset: number | null = null;
  for (let r = range.first; r <= range.last; r++) {
    const plain = stripAnsi(lines[r] ?? "");
    const bounds = contentBounds(plain);
    const segment = plain.slice(bounds.start, bounds.end + 1);
    const joiner = r === range.first ? "" : " ";
    logicalText += joiner;
    const segmentStart = logicalText.length;
    logicalText += segment;

    if (r !== row) continue;
    const col = state.historyCursor.col;
    if (col < bounds.start || col > bounds.end) return null;
    cursorOffset = segmentStart + Math.max(0, Math.min(col - bounds.start, segment.length - 1));
  }

  return cursorOffset == null ? null : { text: logicalText, cursorOffset };
}

function selectedHistoryMessage(state: AppState) {
  const row = state.historyCursor.row;
  const bound = state.historyMessageBounds.find((entry) => row >= entry.start && row < entry.end);
  if (!bound) return null;
  return state.timeline.messages.find((message) => message.id === bound.messageId) ?? null;
}

export function attachmentAtHistoryCursor(state: AppState): DiscordMessageAttachment | null {
  const logicalLine = logicalLineAtHistoryCursor(state);
  if (!logicalLine) return null;

  const message = selectedHistoryMessage(state);
  if (!message || message.attachments.length === 0) return null;

  for (const attachment of message.attachments) {
    let searchFrom = 0;
    while (searchFrom < logicalLine.text.length) {
      const start = logicalLine.text.indexOf(attachment.filename, searchFrom);
      if (start === -1) break;
      const end = start + attachment.filename.length;
      if (logicalLine.cursorOffset >= start && logicalLine.cursorOffset < end) return attachment;
      searchFrom = end;
    }
  }

  return null;
}

/**
 * Return the configured-openable target currently under the history cursor.
 *
 * This supports http/https links and configured local file paths in rendered
 * message text. It also maps Discord attachment filenames back to their CDN URL
 * when the cursor is on an attachment name.
 */
export function openableTargetAtHistoryCursor(state: AppState): string | null {
  const logicalLine = logicalLineAtHistoryCursor(state);
  if (!logicalLine) return null;

  for (const match of findOpenableTargetMatches(logicalLine.text)) {
    if (logicalLine.cursorOffset >= match.start && logicalLine.cursorOffset < match.end) return match.target;
  }

  return attachmentAtHistoryCursor(state)?.url ?? null;
}
