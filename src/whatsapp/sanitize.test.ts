import { describe, expect, test } from "bun:test";

import { sanitizeTerminalLabel, sanitizeTerminalText } from "./sanitize";

describe("WhatsApp terminal text sanitization", () => {
  test("removes CSI and every terminal string-control family", () => {
    const value = [
      "safe",
      "\x1b[2Jcursor",
      "\x1b]52;c;Y2xpcGJvYXJk\x07after-osc",
      "\x1b]0;title\x1b\\after-st-osc",
      "\x1bPpayload\x1b\\after-dcs",
      "\x1bXpayload\x1b\\after-sos",
      "\x1b^payload\x1b\\after-pm",
      "\x1b_payload\x1b\\after-apc",
      "\x9b31mred",
      "\x9d52;c;bad\x9cafter-c1-osc",
    ].join("|");

    expect(sanitizeTerminalText(value)).toBe(
      "safe|cursor|after-osc|after-st-osc|after-dcs|after-sos|after-pm|after-apc|red|after-c1-osc",
    );
  });

  test("preserves intentional message newlines but flattens labels", () => {
    expect(sanitizeTerminalText("hello\nworld\t!\r", { multiline: true })).toBe("hello\nworld !");
    expect(sanitizeTerminalLabel("  Alice\n\tAdmin \u202eabc  ")).toBe("Alice Admin abc");
  });

  test("drops unterminated escape payloads rather than leaking them", () => {
    expect(sanitizeTerminalText("before\x1b]52;c;payload")).toBe("before");
    expect(sanitizeTerminalText("before\x9b123")).toBe("before");
  });
});
