import { describe, expect, test } from "bun:test";

import { normalizeToken } from "./token";

describe("token helpers", () => {
  test("normalizeToken trims and squeezes whitespace", () => {
    expect(normalizeToken("  \nBot   abc\r\n  ")).toBe("Bot abc");
  });
});
