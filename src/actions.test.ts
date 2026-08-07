import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolveLoginCredential, submitCurrentBuffer, validateAndMaybeSave, type AppEffects } from "./actions";
import { loadConfig } from "./config";
import { createInitialState } from "./state";
import { whatsappChannelId, WHATSAPP_GUILD_ID } from "./chatproviders";
import { DIRECT_MESSAGES_GUILD_ID } from "./discord";

const originalFetch = globalThis.fetch;
const originalXdg = process.env.XDG_CONFIG_HOME;

const effects: AppEffects = {
  scheduleRender: () => {},
  quit: () => {},
  applyThemeCursor: () => {},
  bootstrapSession: () => {},
  loginWhatsApp: () => {},
  logoutWhatsApp: () => {},
  sendWhatsAppMessage: () => false,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
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

  test("discards a pre-auth cached sidebar when saved-token validation fails", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "401: Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const state = createInitialState("invalid-token", "/tmp/record-config.json");
    state.sidebar.guilds = [{ id: "guild-stale", name: "Stale", icon: null }];
    state.auth.cachedSidebarPreviewAccountId = "cached-account";

    await validateAndMaybeSave(state, "invalid-token", false, "Validating saved token…", effects);

    expect(state.auth.status).toBe("error");
    expect(state.auth.cachedSidebarPreviewAccountId).toBeNull();
    expect(state.sidebar.guilds.map((guild) => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID]);
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

  test("routes WhatsApp chat text without requiring a Discord token", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.channelList.activeChannelId = whatsappChannelId("15551234567@s.whatsapp.net");
    state.editor.buffer = "hello WhatsApp";
    state.editor.cursor = state.editor.buffer.length;
    let sent = "";

    submitCurrentBuffer(state, {
      ...effects,
      sendWhatsAppMessage: (content) => {
        sent = content;
        return true;
      },
    });

    expect(sent).toBe("hello WhatsApp");
    expect(state.notice.text).toBe("");
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

  test("sends an unknown slash command as an ordinary message", () => {
    let requestedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        type: 0,
        content: "/shrug I don't know",
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
    state.editor.buffer = "/shrug I don't know";

    submitCurrentBuffer(state, effects);

    expect(JSON.parse(requestedBody).content).toBe("/shrug I don't know");
    expect(state.timeline.messages[0]?.content).toBe("/shrug I don't know");
    expect(state.notice.text).toBe("");
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

  test("local gain commands update app state without requiring login", () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-action-config-test-"));
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/mic volume -20";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.audio.micVolume).toBe(-20);
    expect(state.editor.buffer).toBe("");
    expect(state.notice.text).toBe("Microphone record gain set to -20dB.");
    expect(state.notice.statusLine).toBe(false);
    expect(loadConfig().audio?.micGainDb).toBe(-20);

    state.editor.buffer = "/speaker volume 6";
    state.editor.cursor = state.editor.buffer.length;
    submitCurrentBuffer(state, effects);

    expect(state.audio.speakerVolume).toBe(6);
    expect(state.notice.text).toBe("Speaker playback gain set to 6dB.");
    expect(state.notice.statusLine).toBe(false);
  });

  test("/watch is handled as a command instead of being sent as chat", () => {
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.editor.buffer = "/watch friend";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.notice.text).toBe("Join a call before using /watch.");
    expect(state.notice.statusLine).toBe(false);
  });

  test("/thread creates a standalone thread without using the retained history cursor and opens it", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "record-thread-action-test-"));
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/channels/channel-1/threads") && method === "POST") {
        return new Response(JSON.stringify({
          id: "thread-1",
          guild_id: "guild-1",
          parent_id: "channel-1",
          owner_id: "self",
          name: "release discussion",
          type: 11,
          message_count: 0,
          member_count: 1,
          thread_metadata: {
            archived: false,
            auto_archive_duration: 1440,
            archive_timestamp: "2026-08-01T12:00:00.000Z",
            locked: false,
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/thread-1/messages?limit=50") && method === "GET") {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false, permissionOverwrites: [] }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.activeGuildId = "guild-1";
    state.timeline.channelId = "channel-1";
    state.timeline.messages = [{
      id: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      type: 0,
      content: "starter",
      mentionEveryone: false,
      mentionRoleIds: [],
      mentionUserIds: [],
      timestamp: Date.now(),
      editedTimestamp: null,
      author: { id: "other", username: "other", displayName: "Other", bot: false },
      reply: null,
      call: null,
      attachments: [],
      stickerNames: [],
      embedsCount: 0,
    }];
    state.historyCursor = { row: 0, col: 0 };
    state.historyMessageBounds = [{ messageId: "message-1", start: 0, end: 2, contentStart: 1, contentEnd: 2 }];
    state.guildRolesByGuildId["guild-1"] = [{ id: "guild-1", name: "@everyone", color: 0, position: 0, permissions: "1024" }];
    state.editor.buffer = "/thread release discussion";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);
    await waitForCondition(() => state.timeline.channelId === "thread-1"
      && state.timeline.systemMessages.some((message) => message.text.includes("Created thread")));

    expect(requests[0]).toEqual({
      url: "https://discord.com/api/v9/channels/channel-1/threads",
      method: "POST",
      body: { name: "release discussion", auto_archive_duration: 1440, rate_limit_per_user: 0, type: 11 },
    });
    expect(requests.some((request) => request.url.includes("/messages/message-1/threads"))).toBe(false);
    expect(state.channelList.activeChannel).toMatchObject({
      id: "thread-1",
      parentId: "channel-1",
      thread: { joined: true },
    });
    expect(state.sidebar.cachedChannelsByGuildId["guild-1"]?.map((channel) => channel.id)).toContain("thread-1");
    expect(state.sidebar.selectedItem).toEqual({ type: "channel", id: "thread-1", guildId: "guild-1" });
    expect(state.timeline.systemMessages.at(-1)?.text).toBe("Created thread “release discussion”. Send the first message below.");
    expect(state.editor.buffer).toBe("");
    expect(state.notice.text).toBe("");
  });

  test("/thread anchors to the active reply target", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/channels/channel-1/messages/message-1/threads") && method === "POST") {
        return new Response(JSON.stringify({
          id: "thread-1",
          guild_id: "guild-1",
          parent_id: "channel-1",
          owner_id: "self",
          name: "release discussion",
          type: 11,
          message_count: 1,
          member_count: 1,
          thread_metadata: {
            archived: false,
            auto_archive_duration: 1440,
            archive_timestamp: "2026-08-01T12:00:00.000Z",
            locked: false,
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/channels/thread-1/messages?limit=50") && method === "GET") {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const state = createInitialState("token-1", "/tmp/record-config.json");
    state.auth.user = { id: "self", username: "self", globalName: "Self", discriminator: "0", avatar: null, bot: false, email: null, verified: null };
    state.channelList.guildId = "guild-1";
    state.channelList.channels = [{ id: "channel-1", guildId: "guild-1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false, permissionOverwrites: [] }];
    state.channelList.activeChannelId = "channel-1";
    state.channelList.activeChannel = state.channelList.channels[0] ?? null;
    state.sidebar.guilds = [{ id: "guild-1", name: "Guild", icon: null }];
    state.sidebar.activeGuildId = "guild-1";
    state.timeline.channelId = "channel-1";
    state.replyTarget = {
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "other",
      authorDisplayName: "Other",
      authorColor: "",
      summary: "starter message",
      timestamp: Date.now(),
      mention: false,
    };
    state.editor.buffer = "/thread release discussion";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);
    await waitForCondition(() => state.timeline.channelId === "thread-1");

    expect(requests[0]).toEqual({
      url: "https://discord.com/api/v9/channels/channel-1/messages/message-1/threads",
      method: "POST",
      body: { name: "release discussion", auto_archive_duration: 1440, rate_limit_per_user: 0 },
    });
    expect(requests.some((request) => request.url === "https://discord.com/api/v9/channels/channel-1/threads")).toBe(false);
    expect(state.replyTarget).toBeNull();
    expect(state.timeline.systemMessages.some((message) => message.text.includes("Send the first message"))).toBe(false);
  });

  test("/status feedback stays out of the status line while logged out", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.buffer = "/status dnd";
    state.editor.cursor = state.editor.buffer.length;

    submitCurrentBuffer(state, effects);

    expect(state.editor.buffer).toBe("");
    expect(state.notice).toMatchObject({
      text: "Login first with /login <token|username>.",
      statusLine: false,
    });
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
    const payload = JSON.parse(String(form.get("payload_json")));
    expect(payload).toMatchObject({
      content: "",
      tts: false,
      attachments: [{ id: "0", filename: "note.txt" }],
    });
    expect(payload.nonce).toMatch(/^\d+$/);
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
