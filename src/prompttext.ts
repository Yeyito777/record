/** Prompt-buffer text sanitization. */

import { PROMPT_TAB } from "./editor-tabs";

// Strip complete ANSI/control strings first; orphan control bytes are removed
// by PROMPT_CONTROL_RE below. Newlines remain valid multiline prompt content.
const PROMPT_ESCAPE_SEQUENCE_RE = /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b[P^_][\s\S]*?\x1b\\|\x1b[@-Z\\-_])/g;
const PROMPT_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Convert arbitrary selected/pasted terminal text into safe prompt text. */
export function sanitizePromptTextForInsertion(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, PROMPT_TAB)
    .replace(PROMPT_ESCAPE_SEQUENCE_RE, "")
    .replace(PROMPT_CONTROL_RE, "");
}

const TOKEN_TAIL_CHAR_RE = /[A-Za-z0-9._+-]/;

/**
 * Start of the text a cursor-anchored completion regex (`@name`, `:emoji`)
 * needs: the run of name characters before the cursor, its sigil and the
 * boundary character before that. Matching that tail instead of everything
 * before the cursor keeps completion O(token) in a long prompt.
 */
export function completionTailStart(buffer: string, cursor: number): number {
  let start = cursor;
  while (start > 0 && TOKEN_TAIL_CHAR_RE.test(buffer[start - 1]!)) start--;
  return Math.max(0, start - 2);
}
