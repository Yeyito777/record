import { describe, expect, test } from "bun:test";

import { renderStatusLine } from "./statusline";
import { createInitialState } from "./state";
import { theme } from "./theme";

describe("statusline", () => {
  test("shows nickname and online status when authenticated", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.status = "authenticated";
    state.auth.user = {
      id: "user-1",
      username: "yeyito",
      globalName: "Yeyito",
      discriminator: "0",
      avatar: null,
      bot: false,
      email: null,
      verified: true,
    };
    state.auth.presenceStatus = "online";

    const status = renderStatusLine(state, 80);

    expect(status.height).toBe(1);
    expect(status.lines[0]).toContain("Logged In As:");
    expect(status.lines[0]).toContain("Yeyito");
    expect(status.lines[0]).not.toContain("@yeyito");
    expect(status.lines[0]).toContain("Status:");
    expect(status.lines[0]).toContain("online");
    expect(status.lines[0]).toContain(theme.success);
  });

  test("colors idle/dnd/offline like Discord", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.status = "authenticated";
    state.auth.user = {
      id: "user-1",
      username: "yeyito",
      globalName: "Yeyito",
      discriminator: "0",
      avatar: null,
      bot: false,
      email: null,
      verified: true,
    };

    state.auth.presenceStatus = "idle";
    expect(renderStatusLine(state, 80).lines[0]).toContain(theme.warning);

    state.auth.presenceStatus = "dnd";
    expect(renderStatusLine(state, 80).lines[0]).toContain(theme.error);

    state.auth.presenceStatus = "offline";
    expect(renderStatusLine(state, 80).lines[0]).toContain(theme.dim);
  });

  test("renders nothing while logged out", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    const status = renderStatusLine(state, 80);

    expect(status.height).toBe(0);
    expect(status.lines).toEqual([]);
  });

  test("renders nothing while auth is loading", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.status = "loading";

    const status = renderStatusLine(state, 80);

    expect(status.height).toBe(0);
    expect(status.lines).toEqual([]);
  });
});
