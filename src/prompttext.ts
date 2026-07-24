/** Prompt-buffer text sanitization. */

// Strip complete ANSI/control strings first; orphan control bytes are removed
// by PROMPT_CONTROL_RE below. Newlines remain valid multiline prompt content.
const PROMPT_ESCAPE_SEQUENCE_RE = /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b[P^_][\s\S]*?\x1b\\|\x1b[@-Z\\-_])/g;
const PROMPT_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/** Convert arbitrary selected/pasted terminal text into safe prompt text. */
export function sanitizePromptTextForInsertion(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .replace(PROMPT_ESCAPE_SEQUENCE_RE, "")
    .replace(PROMPT_CONTROL_RE, "");
}
