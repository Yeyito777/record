import { describe, expect, test } from "bun:test";

import { renderStatusLine } from "./statusline";
import { createInitialState } from "./state";
import { theme } from "./theme";
import { INSTAGRAM_GUILD_ID, WHATSAPP_GUILD_ID } from "./chatproviders";
import { buildSidebarEntries } from "./sidebar";
import { termWidth } from "./textwidth";

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("statusline", () => {
  test.each([
    [INSTAGRAM_GUILD_ID, "Instagram", "Offline · /refresh", false],
    [INSTAGRAM_GUILD_ID, "Instagram", "Retrying Instagram…", true],
    [INSTAGRAM_GUILD_ID, "Instagram", "No conversations", false],
    [WHATSAPP_GUILD_ID, "WhatsApp", "Connecting WhatsApp…", true],
    [WHATSAPP_GUILD_ID, "WhatsApp", "WhatsApp offline · /login whatsapp", false],
  ] as const)("renders %s %s status %s only in a statusline block", (guildId, name, text, loading) => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.notice.text = "";
    state.sidebar.providerStatusByGuildId[guildId] = { text, loading };
    expect(renderStatusLine(state, 160).lines.join("")).not.toContain(text);
    state.sidebar.expandedGuildId = guildId;
    state.sidebar.loadingGuildId = guildId;
    const plain = stripAnsi(renderStatusLine(state, 160).lines.join(""));
    expect(plain).toContain(text);
    expect(plain).toContain(name);
    expect(plain).toContain(" │ ");
    expect(buildSidebarEntries(state.sidebar, []).some(row => row.guildId === guildId && row.kind === "loading")).toBe(false);
    for (const cols of [12, 40, 80]) {
      for (const line of renderStatusLine(state, cols).lines) expect(termWidth(line)).toBeLessThanOrEqual(cols);
    }
    state.sidebar.expandedGuildId = null;
    expect(renderStatusLine(state, 160).lines.join("")).not.toContain(text);
    state.channelList.guildId = guildId;
    expect(renderStatusLine(state, 160).lines.join("")).toContain(text);
    delete state.sidebar.providerStatusByGuildId[guildId];
    expect(renderStatusLine(state, 160).lines.join("")).not.toContain(text);
  });

  test("Instagram status follows its active chat and uses warning color when offline", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.notice.text = "";
    state.timeline.channelId = "ig:100";
    state.instagram.connection = { status: "error", error: "Session expired" };
    state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID] = { text: "Offline · /refresh" };
    const line = renderStatusLine(state, 120).lines.join("");
    expect(line).toContain("Instagram: Offline · /refresh");
    expect(line).toContain(theme.warning);
    state.timeline.channelId = "discord-channel";
    expect(renderStatusLine(state, 120).lines.join("")).not.toContain("Offline");
  });

  test("WhatsApp loading survives cleared notices and disappears when loading ends or chat changes", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.timeline.channelId = "wa:loading@g.us";
    state.timeline.loadingOlder = true;
    state.notice.text = "";
    expect(stripAnsi(renderStatusLine(state, 40).lines.join(""))).toContain("Loading WhatsApp history");
    state.timeline.loadingOlder = false;
    expect(stripAnsi(renderStatusLine(state, 80).lines.join(""))).not.toContain("Loading WhatsApp");
    state.timeline.loadingOlder = true;
    state.timeline.channelId = "discord-channel";
    expect(stripAnsi(renderStatusLine(state, 80).lines.join(""))).not.toContain("Loading WhatsApp");
  });
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
    expect(status.lines[0]).toContain("Online");
    expect(status.lines[0]).toContain(theme.success);
  });

  test("colors idle/dnd/invisible like Discord and spells out dnd", () => {
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
    expect(renderStatusLine(state, 80).lines[0]).toContain("Idle");

    state.auth.presenceStatus = "dnd";
    expect(renderStatusLine(state, 80).lines[0]).toContain(theme.error);
    expect(renderStatusLine(state, 80).lines[0]).toContain("Do Not Disturb");

    state.auth.presenceStatus = "invisible";
    const invisibleLine = renderStatusLine(state, 80).lines[0];
    expect(invisibleLine).toContain(theme.dim);
    expect(invisibleLine).toContain("Invisible");
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

  test("does not render active reply targets as status-line blocks", () => {
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

    expect(plain).toContain("Logged In As:");
    expect(plain).toContain("Status:");
    expect(plain).not.toContain("Replying:");
    expect(plain).not.toContain("PING Other:");
  });

  test("does not render active edit targets as status-line blocks", () => {
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

    expect(plain).toContain("Logged In As:");
    expect(plain).toContain("Status:");
    expect(plain).not.toContain("Editing:");
    expect(plain).not.toContain("Self: original message");
  });

  test("shows active voice call info with elapsed time and audio state", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.voiceCall = {
      displayName: "Alice",
      state: "ready",
      startedAt: Date.now() - 222_000,
      selfMute: false,
      selfDeaf: false,
      participantUserIds: [],
    };

    const line = renderStatusLine(state, 120).lines[0] ?? "";
    const plain = stripAnsi(line);

    expect(plain).toContain("☎ Alice 03:42  🎙 on  🔈 on");
    expect(plain).not.toContain("▎");
    expect(plain.indexOf("Logged In As:")).toBeLessThan(plain.indexOf("Status:"));
    expect(plain.indexOf("Status:")).toBeLessThan(plain.indexOf("☎ Alice"));
    expect(line).toContain(theme.accent);
  });

  test("keeps call status after account and presence but before notices", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.voiceCall = {
      displayName: "Alice",
      state: "ready",
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      participantUserIds: [],
    };
    state.notice = { text: "notice", tone: "muted", loading: false };
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: null,
      authorId: "user-2",
      authorDisplayName: "Other",
      authorColor: theme.accent,
      summary: "reply",
      timestamp: null,
      mention: false,
    };

    const plain = stripAnsi(renderStatusLine(state, 160).lines[0] ?? "");

    expect(plain.indexOf("Logged In As:")).toBeLessThan(plain.indexOf("Status:"));
    expect(plain.indexOf("Status:")).toBeLessThan(plain.indexOf("☎ Alice"));
    expect(plain.indexOf("☎ Alice")).toBeLessThan(plain.indexOf("notice"));
    expect(plain).not.toContain("Replying:");
  });

  test("shows pending voice calls as muted spinner progress", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.loadingFrameIndex = 0;
    state.voiceCall = {
      displayName: "Alice",
      state: "signaling",
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      participantUserIds: [],
    };

    const line = renderStatusLine(state, 120).lines[0] ?? "";
    const plain = stripAnsi(line);

    expect(plain).toContain("☎ Alice 00:00  🎙 on  🔈 on  ⠋ Calling…");
    expect(plain).not.toContain("▎");
    expect(plain.indexOf("Logged In As:")).toBeLessThan(plain.indexOf("Status:"));
    expect(plain.indexOf("Status:")).toBeLessThan(plain.indexOf("☎ Alice"));
    expect(line).toContain(theme.muted);
  });

  test("does not show a transient calling notice next to the canonical call block", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.loadingFrameIndex = 0;
    state.voiceCall = {
      displayName: "Alice",
      state: "signaling",
      startedAt: Date.now(),
      selfMute: false,
      selfDeaf: false,
      participantUserIds: [],
    };
    state.notice = { text: "Calling Alice…", tone: "muted", loading: true };

    const plain = stripAnsi(renderStatusLine(state, 140).lines[0] ?? "");

    expect(plain.match(/Calling/g)?.length).toBe(1);
    expect(plain).toContain("☎ Alice");
  });

  test("shows muted and deafened call icons", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.voiceCall = {
      displayName: "Alice",
      state: "ready",
      startedAt: Date.now(),
      selfMute: true,
      selfDeaf: true,
      participantUserIds: [],
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
