import { describe, expect, test } from "bun:test";

import { DM_AUTHOR_COLOR_COUNT, dmAuthorColor } from "./theme";

describe("theme helpers", () => {
  test("maps DM author ids to deterministic ANSI colors", () => {
    expect(DM_AUTHOR_COLOR_COUNT).toBe(128);
    expect(dmAuthorColor("1234567890")).toBe(dmAuthorColor("1234567890"));
    expect(dmAuthorColor("1234567890")).toMatch(/^\x1b\[38;2;/);
  });
});
