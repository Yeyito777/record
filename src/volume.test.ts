import { describe, expect, test } from "bun:test";

import { normalizeParticipantVolumes } from "./volume";

describe("participant volumes", () => {
  test("normalizes persisted values and discards invalid or neutral entries", () => {
    expect(normalizeParticipantVolumes({
      quiet: 73,
      boosted: 999,
      muted: -20,
      neutral: 100,
      invalid: "80",
      infinite: Number.POSITIVE_INFINITY,
    })).toEqual({
      quiet: 70,
      boosted: 200,
      muted: 0,
    });
  });

  test("treats malformed persisted collections as empty", () => {
    expect(normalizeParticipantVolumes(null)).toEqual({});
    expect(normalizeParticipantVolumes([80])).toEqual({});
    expect(normalizeParticipantVolumes("80")).toEqual({});
  });
});
