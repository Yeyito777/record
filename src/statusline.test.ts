import { describe, expect, test } from "bun:test";

import { renderStatusLine } from "./statusline";
import { createInitialState } from "./state";
import { theme } from "./theme";

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

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

  test("colors idle/dnd/offline like Discord and spells out dnd", () => {
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
    expect(renderStatusLine(state, 80).lines[0]).toContain("Do Not Disturb");

    state.auth.presenceStatus = "offline";
    expect(renderStatusLine(state, 80).lines[0]).toContain(theme.dim);
  });

  test("shows N/A in red while logged out", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    const status = renderStatusLine(state, 80);

    expect(status.height).toBe(1);
    expect(status.lines[0]).toContain("Logged In As:");
    expect(status.lines[0]).toContain("Status:");
    expect(status.lines[0]).toContain("N/A");
    expect(status.lines[0]).toContain(theme.error);
  });

  test("shows active reply target after account details with text-colored truncated content", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-2",
      authorDisplayName: "Other",
      authorColor: "\x1b[38;2;1;2;3m",
      summary: "original message that is definitely longer than forty columns",
      timestamp: null,
      mention: true,
    };

    const line = renderStatusLine(state, 120).lines[0] ?? "";
    const plain = stripAnsi(line);

    expect(plain.indexOf("Replying:")).toBeGreaterThan(plain.indexOf("Logged In As:"));
    expect(plain.indexOf("Replying:")).toBeGreaterThan(plain.indexOf("Status:"));
    expect(plain).toContain("PING Other: original message that is definitely lon…");
    expect(line).toContain(`${theme.accent}PING \x1b[38;2;1;2;3mOther: ${theme.text}original message that is definitely lon…${theme.reset}`);
  });

  test("shows active edit target after account details", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      authorDisplayName: "Self",
      authorColor: "\x1b[38;2;1;2;3m",
      summary: "original message that is definitely longer than forty columns",
      originalContent: "original message that is definitely longer than forty columns",
      timestamp: null,
    };

    const line = renderStatusLine(state, 120).lines[0] ?? "";
    const plain = stripAnsi(line);

    expect(plain.indexOf("Editing:")).toBeGreaterThan(plain.indexOf("Logged In As:"));
    expect(plain.indexOf("Editing:")).toBeGreaterThan(plain.indexOf("Status:"));
    expect(plain).toContain("Editing: Self: original message that is definitely lon…");
    expect(line).toContain(`\x1b[38;2;1;2;3mSelf: ${theme.text}original message that is definitely lon…${theme.reset}`);
  });

  test("omits PING for non-pinging replies", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-2",
      authorDisplayName: "Other",
      authorColor: theme.accent,
      summary: "original message",
      timestamp: null,
      mention: false,
    };

    const line = renderStatusLine(state, 120).lines[0] ?? "";
    const plain = stripAnsi(line);

    expect(plain).toContain("Replying: Other: original message");
    expect(plain).not.toContain("PING");
  });

  test("shows active voice call info with elapsed time and audio state", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.voiceCall = {
      displayName: "Alice",
      state: "ready",
      startedAt: Date.now() - 222_000,
      selfMute: false,
      selfDeaf: false,
    };

    const line = renderStatusLine(state, 120).lines[0] ?? "";
    const plain = stripAnsi(line);

    expect(plain).toContain("▎ ☎ Alice 03:42  🎙 on  🔈 on");
    expect(plain.indexOf("▎ ☎ Alice")).toBeLessThan(plain.indexOf("Logged In As:"));
    expect(line).toContain(theme.accent);
  });

  test("shows muted and deafened call icons", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.voiceCall = {
      displayName: "Alice",
      state: "ready",
      startedAt: Date.now(),
      selfMute: true,
      selfDeaf: true,
    };

    const plain = stripAnsi(renderStatusLine(state, 120).lines[0] ?? "");

    expect(plain).toContain("🔇 muted  🔇 off");
  });

  test("shows notice feedback in the status line", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.notice = { text: "Downloading image.png… 50% (1 MB / 2 MB)", tone: "muted", loading: true };

    const status = renderStatusLine(state, 120);
    const plain = stripAnsi(status.lines[0] ?? "");

    expect(status.height).toBe(1);
    expect(plain).toContain("Downloading image.png… 50% (1 MB / 2 MB)");
    expect(plain.indexOf("Downloading image.png")).toBeGreaterThan(plain.indexOf("Status:"));
    expect(status.lines[0]).toContain(theme.muted);
  });

  test("keeps oversized notice feedback visible by truncating it", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.notice = { text: "Downloading extremely-long-record-progress-test-7mb.png… 50% (4 MB / 8 MB)", tone: "muted", loading: true };

    const status = renderStatusLine(state, 32);
    const plain = stripAnsi(status.lines[0] ?? "");

    expect(status.height).toBe(1);
    expect(plain).toContain("Downloading");
    expect(plain).toContain("…");
  });

  test("can keep notices out of the status line", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.notice = { text: "Hidden channels shown.", tone: "muted", loading: false, statusLine: false };

    const plain = stripAnsi(renderStatusLine(state, 120).lines[0] ?? "");

    expect(plain).not.toContain("Hidden channels shown");
  });

  test("shows N/A in red while auth is loading", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.auth.status = "loading";

    const status = renderStatusLine(state, 80);

    expect(status.height).toBe(1);
    expect(status.lines[0]).toContain("N/A");
    expect(status.lines[0]).toContain(theme.error);
  });
});
