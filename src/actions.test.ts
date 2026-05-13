import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("Timed out waiting for condition."));
      setTimeout(check, 5);
    };
    check();
  });
}

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

  test("expands /kao macros before sending instead of treating them as commands", () => {
    let requestedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        type: 0,
        content: "ヽ(o＾▽＾o)ノ friend",
        mentions: [],
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
    state.editor.buffer = "/kao happy friend";

    submitCurrentBuffer(state, effects);

    expect(JSON.parse(requestedBody).content).toBe("ヽ(o＾▽＾o)ノ friend");
    expect(state.timeline.messages[0]?.content).toBe("ヽ(o＾▽＾o)ノ friend");
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
    state.guildRolesByGuildId["guild-1"] = [{ id: "role-2", name: "artist", color: 0x3366ff, position: 1 }];
    state.editor.buffer = "hi @zosa @here @artist";

    submitCurrentBuffer(state, effects);

    expect(JSON.parse(requestedBody).content).toBe("hi <@user-1> @here <@&role-2>");
    expect(state.timeline.messages[0]?.content).toBe("hi @zosa @here @artist");
    expect(state.timeline.messages[0]?.localMentionUsers).toEqual([
      { id: "user-1", username: "zosa", displayName: "Zosa", bot: false, roleIds: ["role-1"] },
    ]);
  });

  test("local volume commands update app state without requiring login", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/mic volume 25%";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.audio.micVolume).toBe(25);
    expect(state.editor.buffer).toBe("");
    expect(state.notice.text).toBe("Microphone volume set to 25%.");
    expect(state.notice.statusLine).toBe(false);

    state.editor.buffer = "/speaker volume 150";
    state.editor.cursor = state.editor.buffer.length;
    submitCurrentBuffer(state, effects);

    expect(state.audio.speakerVolume).toBe(100);
    expect(state.notice.text).toBe("Speaker volume set to 100%.");
    expect(state.notice.statusLine).toBe(false);
  });

  test("/upload sends a local file as a multipart message attachment", async () => {
    let requestedBody: BodyInit | null | undefined = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = init?.body;
      return new Response(JSON.stringify({
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        type: 0,
        content: "",
        mentions: [],
        timestamp: "2026-01-01T12:00:00.000Z",
        edited_timestamp: null,
        author: { id: "self", username: "self", global_name: "Self" },
        attachments: [{ id: "attachment-1", filename: "note.txt", content_type: "text/plain", size: 12, url: "https://cdn.example/note.txt" }],
        embeds: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), "record-upload-action-test-"));
    const path = join(dir, "note.txt");
    writeFileSync(path, "hello upload");

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.timeline.channelId = "channel-1";
    state.editor.buffer = `/upload ${path}`;

    submitCurrentBuffer(state, effects);

    expect(state.editor.buffer).toBe("");
    await waitForCondition(() => state.timeline.messages.length > 0 && requestedBody instanceof FormData);
    expect(state.timeline.messages[0]).toMatchObject({
      content: "",
      attachments: [{ filename: "note.txt", contentType: "text/plain", size: "hello upload".length }],
    });
    expect(requestedBody).toBeInstanceOf(FormData);
    const form = requestedBody as unknown as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({
      content: "",
      tts: false,
      attachments: [{ id: "0", filename: "note.txt" }],
    });
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
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
