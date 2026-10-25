import { describe, expect, test } from "bun:test";

import { sanitizePromptTextForInsertion } from "./prompttext";

describe("sanitizePromptTextForInsertion", () => {
  test("strips ANSI and control sequences before text enters the prompt", () => {
    expect(sanitizePromptTextForInsertion("E\x1b[31mred\x1b[0m\u009b32mgreen\x07!"))
      .toBe("Eredgreen!");
  });

  test("normalizes line endings and tabs while preserving multiline text", () => {
    expect(sanitizePromptTextForInsertion("a\r\nb\rc\td")).toBe("a\nb\nc    d");
  });
});

describe("completion queries read only the token before the cursor", () => {
  const MENTION_RE = /(^|[\s([{])@([A-Za-z0-9._-]*)$/;
  const EMOJI_RE = /(^|[\s([{])(:([A-Za-z0-9_+-]*))$/;

  test("match the whole-prefix regexes at every cursor", async () => {
    const { mentionQueryAtCursor } = await import("./mentions");
    const { emojiQueryAtCursor } = await import("./emojis");
    for (const buffer of ["hi @al.ex and :smi", "(@x :+1: [@ {:a", "a@b c:d", "@", ":", " @-_. :_+-", "x\n@yo\n:ok"]) {
      for (let cursor = 0; cursor <= buffer.length; cursor++) {
        const before = buffer.slice(0, cursor);
        const mention = before.match(MENTION_RE);
        const emoji = before.match(EMOJI_RE);
        expect(mentionQueryAtCursor(buffer, cursor)?.start ?? null)
          .toBe(mention ? cursor - (mention[2] ?? "").length - 1 : null);
        expect(emojiQueryAtCursor(buffer, cursor)?.query ?? null).toBe(emoji ? emoji[3] ?? "" : null);
      }
    }
  });
});
