import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { defaultOpenersConfig, saveConfig } from "./config";
import type { DiscordMessage } from "./discord";
import { attachmentAtHistoryCursor, forwardedOriginAtHistoryCursor, openableTargetAtHistoryCursor } from "./historyopenable";
import { createInitialState } from "./state";

const previousXdg = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-history-openable-test-"));
  saveConfig({ openers: defaultOpenersConfig() });
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
});

function baseMessage(overrides: Partial<DiscordMessage>): DiscordMessage {
  return {
    id: "m1",
    channelId: "c1",
    guildId: null,
    type: 0,
    content: "",
    mentionEveryone: false,
    mentionRoleIds: [],
    mentionUserIds: [],
    timestamp: 0,
    editedTimestamp: null,
    author: { id: "u1", username: "alice", displayName: "Alice", bot: false },
    reply: null,
    call: null,
    attachments: [],
    stickerNames: [],
    embedsCount: 0,
    ...overrides,
  };
}

describe("history openable target lookup", () => {
  test("returns the link under the history cursor", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    const url = "https://example.com/reference";
    state.historyLines = [`Reference: ${url}`];
    state.historyCursor = { row: 0, col: "Reference: https://example".length };

    expect(openableTargetAtHistoryCursor(state)).toBe(url);
  });

  test("maps attachment filenames back to their CDN URL", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = ["📎 cat.png • 10 B"];
    state.historyCursor = { row: 0, col: "📎 cat".length };
    state.historyMessageBounds = [{ messageId: "m1", start: 0, end: 1, contentStart: 0, contentEnd: 1 }];
    state.timeline.messages = [baseMessage({
      attachments: [
        { id: "a1", filename: "cat.png", contentType: "image/png", size: 10, url: "https://cdn.example/cat.png" },
        { id: "a2", filename: "sound.mp3", contentType: "audio/mpeg", size: 20, url: "https://cdn.example/sound.mp3" },
      ],
    })];

    expect(openableTargetAtHistoryCursor(state)).toBe("https://cdn.example/cat.png");
  });

  test("maps the attachment clip icon to its attachment", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = ["📎 cat.png • 10 B"];
    state.historyCursor = { row: 0, col: 0 };
    state.historyMessageBounds = [{ messageId: "m1", start: 0, end: 1, contentStart: 0, contentEnd: 1 }];
    const attachment = { id: "a1", filename: "cat.png", contentType: "image/png", size: 10, url: "https://cdn.example/cat.png" };
    state.timeline.messages = [baseMessage({ attachments: [attachment] })];

    expect(attachmentAtHistoryCursor(state)).toEqual(attachment);
    expect(openableTargetAtHistoryCursor(state)).toBe("https://cdn.example/cat.png");
  });

  test("finds forwarded message origins under the history cursor", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.historyLines = ["[Forwarded]: source text"];
    state.historyCursor = { row: 0, col: 0 };
    state.historyMessageBounds = [{ messageId: "m1", start: 0, end: 1, contentStart: 0, contentEnd: 1 }];
    state.timeline.messages = [baseMessage({
      forwarded: {
        content: "source text",
        originMessageId: "source-message",
        originChannelId: "source-channel",
        originGuildId: "source-guild",
        mentionEveryone: false,
        mentionRoleIds: [],
        mentionUsers: [],
        attachments: [],
        stickerNames: [],
        embedsCount: 0,
        embeds: [],
      },
    })];

    expect(forwardedOriginAtHistoryCursor(state)).toEqual({
      messageId: "source-message",
      channelId: "source-channel",
      guildId: "source-guild",
    });
  });
});
