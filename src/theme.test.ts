import { describe, expect, test } from "bun:test";

import { DM_AUTHOR_COLOR_COUNT, dmAuthorColor } from "./theme";
import { ansiColorToRgb } from "./terminalcolors";

describe("theme helpers", () => {
  test("maps DM author ids to deterministic ANSI colors", () => {
    expect(DM_AUTHOR_COLOR_COUNT).toBe(128);
    expect(dmAuthorColor("1234567890")).toBe(dmAuthorColor("1234567890"));
    expect(ansiColorToRgb(dmAuthorColor("1234567890"), 38)).not.toBeNull();
  });
});
