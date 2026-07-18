import { describe, expect, test } from "bun:test";

import { renderPromptSeparator } from "./promptbar";
import { createInitialState } from "./state";
import { termWidth } from "./textwidth";
import { ansiTrueColor, theme } from "./theme";

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("promptbar", () => {
  test("embeds active reply target in the prompt separator with existing colors", () => {
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

    const line = renderPromptSeparator(state, 120, theme.accent);
    const plain = stripAnsi(line);

    expect(plain).toContain("────↩ Replying: PING Other: original message that is definitely lon…");
    expect(plain.endsWith("─")).toBe(true);
    expect(line).toContain(`${theme.accent}PING \x1b[38;2;1;2;3mOther: ${theme.text}original message that is definitely lon…${theme.reset}`);
  });

  test("embeds active edit target in the prompt separator", () => {
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

    const line = renderPromptSeparator(state, 120, theme.accent);
    const plain = stripAnsi(line);

    expect(plain).toContain("────✎ Editing: Self: original message that is definitely lon…");
    expect(plain.endsWith("─")).toBe(true);
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

    const plain = stripAnsi(renderPromptSeparator(state, 80, theme.accent));

    expect(plain).toContain("────↩ Replying: Other: original message");
    expect(plain).not.toContain("PING");
  });

  test("renders user mentions as display names in reply summaries", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.guildRolesByGuildId["guild-1"] = [
      { id: "role-1", name: "Blue", color: 0x010203, position: 1 },
    ];
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-2",
      authorDisplayName: "Other",
      authorColor: theme.accent,
      summary: "hey <@123456789012345678> and <@!987654321098765432>",
      mentionUsers: [
        { id: "123456789012345678", username: "alice", displayName: "Alice", bot: false, roleIds: ["role-1"] },
        { id: "987654321098765432", username: "bob", displayName: "Bob", bot: false },
      ],
      timestamp: null,
      mention: false,
    };

    const line = renderPromptSeparator(state, 100, theme.accent);
    const plain = stripAnsi(line);

    expect(plain).toContain("Other: hey @Alice and @Bob");
    expect(plain).not.toContain("<@");
    expect(line).toContain(`${ansiTrueColor(0x010203)}@Alice${theme.text}`);
  });

  test("renders role and broadcast mentions by name in reply summaries", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.guildRolesByGuildId["guild-1"] = [
      { id: "role-1", name: "Block Tales", color: 0x00aaff, position: 1 },
    ];
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-2",
      authorDisplayName: "Other",
      authorColor: theme.accent,
      summary: "<@&role-1> @here",
      mentionRoleIds: ["role-1"],
      timestamp: null,
      mention: false,
    };

    const line = renderPromptSeparator(state, 100, theme.accent);
    const plain = stripAnsi(line);

    expect(plain).toContain("Other: @Block Tales @here");
    expect(plain).not.toContain("<@&role-1>");
    expect(line).toContain(`${ansiTrueColor(0x00aaff)}@Block Tales${theme.text}`);
    expect(line).toContain(`${theme.accent}@here${theme.text}`);
  });

  test("truncates inline context to stay inside the separator width", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      authorDisplayName: "Self",
      authorColor: theme.accent,
      summary: "a very long message that cannot fit in the prompt separator",
      originalContent: "a very long message that cannot fit in the prompt separator",
      timestamp: null,
    };

    const line = renderPromptSeparator(state, 24, theme.accent);
    const plain = stripAnsi(line);

    expect(termWidth(line)).toBe(24);
    expect(plain).toContain("✎ Editing:");
    expect(plain).toContain("…");
    expect(plain.endsWith("─")).toBe(true);
  });
});
