import { afterEach, describe, expect, test } from "bun:test";

import { resolveLoginCredential, submitCurrentBuffer, type AppEffects } from "./actions";
import { createInitialState } from "./state";

const originalFetch = globalThis.fetch;

const effects: AppEffects = {
  scheduleRender: () => {},
  quit: () => {},
  applyThemeCursor: () => {},
  bootstrapSession: () => {},
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("submitCurrentBuffer", () => {
  test("resolves saved login usernames before validation", () => {
    const state = createInitialState(null, "/tmp/record-config.json", { alice: "token-1" });

    expect(resolveLoginCredential(state, "alice")).toBe("token-1");
    expect(resolveLoginCredential(state, "raw-token")).toBe("raw-token");
  });

  test("non-command prompt text requires a login before sending", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "hello world";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("Login first with /login <token|username>.");
    expect(state.editor.buffer).toBe("hello world");
  });

  test("image-only messages submit", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.pendingImages = [{ mediaType: "image/png", base64: "", sizeBytes: 1, filename: "image-1.png" }];

    submitCurrentBuffer(state, effects);

    expect(state.notice.text).toBe("Login first with /login <token|username>.");
  });

  test("converts loaded @mentions before sending", () => {
    let requestedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        type: 0,
        content: "hi <@user-1>",
        mentions: [{ id: "user-1", username: "zosa", global_name: "Zosa" }],
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "self", username: "self", global_name: "Self" },
        attachments: [],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.timeline.channelId = "channel-1";
    state.memberList.guildId = "guild-1";
    state.memberList.channelId = "channel-1";
    state.memberList.members = [{ id: "user-1", username: "zosa", displayName: "Zosa", bot: false, roleIds: ["role-1"] }];
    state.editor.buffer = "hi @zosa";

    submitCurrentBuffer(state, effects);

    expect(JSON.parse(requestedBody).content).toBe("hi <@user-1>");
    expect(state.timeline.messages[0]?.content).toBe("hi @zosa");
    expect(state.timeline.messages[0]?.localMentionUsers).toEqual([
      { id: "user-1", username: "zosa", displayName: "Zosa", bot: false, roleIds: ["role-1"] },
    ]);
  });

  test("empty prompt submits while editing", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      authorDisplayName: "Self",
      authorColor: "",
      summary: "original",
      originalContent: "original",
      timestamp: null,
    };

    submitCurrentBuffer(state, effects);

    expect(state.notice.text).toBe("Login first with /login <token|username>.");
  });

  test("empty prompt does nothing", () => {
    const state = createInitialState(null, "/tmp/record-config.json");

    submitCurrentBuffer(state, effects);

    expect(state.auth.status).toBe("idle");
    expect(state.notice.text).toBe("");
  });
});
