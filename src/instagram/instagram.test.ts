import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTAGRAM_GUILD_ID, instagramChannelId, WHATSAPP_GUILD_ID } from "../chatproviders";
import { DIRECT_MESSAGES_GUILD_ID } from "../discord";
import { createInitialState } from "../state";
import { buildSidebarEntries } from "../sidebar";
import { loadInstagramSession, saveInstagramSession, validateSession } from "./auth";
import { InstagramApiError, InstagramClient, type InstagramInbox, type InstagramThread } from "./client";
import { InstagramController, type InstagramControllerOptions } from "./controller";
import { createInstagramUiState, instagramChannels, instagramMessageToTimeline, mergeInstagramThread } from "./integration";

const session = { cookies: { sessionid: "test-session", csrftoken: "test-csrf", ds_user_id: "1" } };
function thread(id = "100"): InstagramThread {
  return {
    thread_id: id, thread_title: "Friend", users: [{ pk: "2", username: "friend" }],
    items: [{ item_id: "10", user_id: "2", timestamp: "1000000", item_type: "text", text: "hello" }],
    has_older: true, oldest_cursor: "first", last_activity_at: "1000000",
  };
}
function inbox(): InstagramInbox {
  return { viewer: { pk: "1", username: "me" }, inbox: { threads: [thread()], has_older: false } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }

describe("Instagram session", () => {
  test("validates required cookies and rejects header injection", () => {
    expect(validateSession(session)).toEqual(session);
    expect(() => validateSession({ cookies: {} })).toThrow();
    expect(() => validateSession({ cookies: { ...session.cookies, csrftoken: "x\r\ninjected: y" } })).toThrow();
    expect(validateSession({ cookies: { ...session.cookies, "evil\nname": "x" } })).toEqual(session);
  });
  test("stores private auth and loads it without leaking to config or caches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "record-ig-"));
    const path = join(directory, "instagram", "session.json");
    try {
      expect(await loadInstagramSession(path)).toBeNull();
      await saveInstagramSession(session, path);
      expect(await loadInstagramSession(path)).toEqual(session);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "instagram"))).mode & 0o777).toBe(0o700);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("Instagram client", () => {
  test("scopes credentials, encodes cursors and sends text/replies exactly once", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const client = new InstagramClient(session, (async (url: any, options: RequestInit) => {
      calls.push({ url: String(url), options });
      return Response.json(options.method === "POST"
        ? { status: "ok", payload: { item_id: "11", timestamp: "2000000" } }
        : inbox());
    }) as unknown as typeof fetch);
    await client.inbox("a&b");
    expect(calls[0]!.url).toContain("cursor=a%26b");
    expect(calls[0]!.options.redirect).toBe("manual");
    expect((calls[0]!.options.headers as Record<string, string>)["X-CSRFToken"]).toBe("test-csrf");
    const sent = await client.sendText("100", "test & hello", "10");
    expect(sent.item_id).toBe("11");
    const body = calls[1]!.options.body as URLSearchParams;
    expect(body.get("thread_ids")).toBe('["100"]');
    expect(body.get("text")).toBe("test & hello");
    expect(body.get("replied_to_item_id")).toBe("10");
    expect(body.get("client_context")).toBe(body.get("mutation_token"));
    expect(calls).toHaveLength(2);
    await expect(client.thread("../elsewhere")).rejects.toThrow("Invalid");
    expect(calls).toHaveLength(2);
  });
  test("redacts response bodies and stops for auth/rate-limit errors", async () => {
    for (const status of [302, 401, 403, 429]) {
      const client = new InstagramClient(session, (async () => new Response("secret-session", { status })) as unknown as typeof fetch);
      try { await client.inbox(); throw new Error("expected rejection"); }
      catch (error) {
        expect(error).toBeInstanceOf(InstagramApiError);
        expect((error as InstagramApiError).fatal).toBe(true);
        expect(String(error)).not.toContain("secret-session");
      }
    }
  });
  test("rejects ambiguous send acknowledgements without retrying", async () => {
    let calls = 0;
    const client = new InstagramClient(session, (async () => { calls++; return Response.json({ status: "ok" }); }) as unknown as typeof fetch);
    await expect(client.sendText("100", "hello")).rejects.toThrow("Refresh before retrying");
    expect(calls).toBe(1);
  });
  test("treats HTML service errors as transient rather than expired auth", async () => {
    const client = new InstagramClient(session, (async () => new Response("<html>Unavailable</html>", { status: 503 })) as unknown as typeof fetch);
    try { await client.inbox(); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(InstagramApiError);
      expect((error as InstagramApiError).fatal).toBe(false);
    }
  });
});

describe("Instagram conversions", () => {
  test("sanitizes labels/content, uses microsecond timestamps and own account identity", () => {
    const state = createInstagramUiState();
    state.account = { id: "1", username: "me", name: "My Name" };
    const t = { ...thread(), thread_title: "\x1b[31mFriend" };
    mergeInstagramThread(state, t);
    expect(instagramChannels(state)[0]!.name).toBe("Friend");
    const message = instagramMessageToTimeline(state, t, {
      item_id: "20", user_id: "1", timestamp: "2000000", item_type: "text", text: "\x1b[31mhello",
      reactions: { emojis: [{ sender_id: "1", emoji: "👍" }, { sender_id: "2", emoji: "👍" }] },
    });
    expect(message.content).toBe("hello");
    expect(message.timestamp).toBe(2000);
    expect(message.author.displayName).toBe("My Name");
    expect(message.reactions?.[0]).toMatchObject({ count: 2, me: true });
  });
  test("shows ordinary media but never downloads disappearing media or unsafe URLs", () => {
    const state = createInstagramUiState();
    const media = { image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/image.jpg" }] } };
    const base = { item_id: "20", user_id: "2", timestamp: "2000000" };
    expect(instagramMessageToTimeline(state, thread(), { ...base, item_type: "media", media }).attachments).toHaveLength(1);
    const disappearing = instagramMessageToTimeline(state, thread(), { ...base, item_type: "raven_media", raven_media: media });
    expect(disappearing.attachments).toHaveLength(0);
    expect(disappearing.content).toContain("Disappearing");
    expect(instagramMessageToTimeline(state, thread(), {
      ...base, item_type: "media", media: { image_versions2: { candidates: [{ url: "http://localhost/private" }] } },
    }).attachments).toHaveLength(0);
  });
  test("deduplicates items and preserves older cursor across inbox refresh", () => {
    const state = createInstagramUiState();
    mergeInstagramThread(state, thread());
    mergeInstagramThread(state, { ...thread(), items: [{ ...thread().items[0]!, text: "updated" }], oldest_cursor: "poll" });
    expect(state.threadsById["100"]!.items).toHaveLength(1);
    expect(state.threadsById["100"]!.items[0]!.text).toBe("updated");
    expect(state.threadsById["100"]!.oldest_cursor).toBe("first");
    mergeInstagramThread(state, { ...thread(), oldest_cursor: "older", has_older: false }, true);
    expect(state.threadsById["100"]!.oldest_cursor).toBe("older");
    expect(state.threadsById["100"]!.has_older).toBe(false);
  });
});

function harness(overrides: Partial<InstagramClient> = {}, options: InstagramControllerOptions = {}) {
  const state = createInitialState(null, "test", {});
  let sends = 0;
  const fake = {
    inbox: async () => inbox(), thread: async () => thread(), markSeen: async () => {},
    sendText: async (_id: string, text: string) => {
      sends++;
      return { item_id: "11", user_id: "1", timestamp: "2000000", item_type: "text", text };
    },
    ...overrides,
  } as unknown as InstagramClient;
  const controller = new InstagramController(state, () => {}, {
    clientFactory: () => fake, loadSession: async () => session, importSession: async () => session,
    saveSession: async () => {}, removeSession: async () => {}, pollIntervalMs: 60_000,
    ...options,
  });
  return { state, controller, sends: () => sends };
}

describe("Instagram controller", () => {
  test("shows a logged-out row and root refresh loads credentials added after startup", async () => {
    let saved = false;
    const h = harness({}, { loadSession: async () => saved ? session : null });
    try {
      await h.controller.autoConnect();
      h.state.sidebar.expandedGuildId = INSTAGRAM_GUILD_ID;
      h.controller.openRoot();
      await tick();
      const rows = buildSidebarEntries(h.state.sidebar, h.state.channelList.channels);
      expect(rows.some(row => row.guildId === INSTAGRAM_GUILD_ID && row.label.includes("/login instagram"))).toBe(true);
      expect(h.state.sidebar.focusedGuildId).toBe(INSTAGRAM_GUILD_ID);
      expect(h.state.notice.text).toContain("/login instagram");
      saved = true;
      await h.controller.refresh();
      expect(h.controller.isConnected).toBe(true);
      expect(buildSidebarEntries(h.state.sidebar, h.state.channelList.channels).some(row => row.id === "ig:100")).toBe(true);
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]).toBeUndefined();
    } finally { await h.controller.shutdown(); }
  });
  test("renders connecting state while the first inbox is pending and distinguishes empty inbox", async () => {
    const pending = deferred<InstagramInbox>();
    const h = harness({ inbox: () => pending.promise });
    try {
      const connecting = h.controller.autoConnect();
      await tick();
      h.controller.openRoot();
      h.state.sidebar.expandedGuildId = INSTAGRAM_GUILD_ID;
      expect(buildSidebarEntries(h.state.sidebar, []).some(row => row.label.includes("Connecting Instagram"))).toBe(true);
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]?.loading).toBe(true);
      pending.resolve({ ...inbox(), inbox: { threads: [], has_older: false } });
      await connecting;
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]?.text).toBe("No conversations");
    } finally { await h.controller.shutdown(); }
  });
  test("retries transient initial failures without requiring another login", async () => {
    let calls = 0;
    const h = harness({ inbox: async () => {
      if (++calls === 1) throw new InstagramApiError("Temporary failure");
      return inbox();
    } }, { retryDelayMs: 1 });
    try {
      await h.controller.autoConnect();
      expect(h.state.instagram.connection.status).toBe("error");
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]?.text).toContain("Retrying");
      const deadline = Date.now() + 1000;
      while (!h.controller.isConnected && Date.now() < deadline) await tick();
      expect(h.controller.isConnected).toBe(true);
      expect(calls).toBe(2);
      expect(h.state.notice.text).not.toContain("Temporary failure");
    } finally { await h.controller.shutdown(); }
  });
  test("does not retry auth/rate-limit failures, but explicit refresh can reconnect", async () => {
    let calls = 0;
    const h = harness({ inbox: async () => {
      if (++calls === 1) throw new InstagramApiError("Session expired", true);
      return inbox();
    } }, { retryDelayMs: 1 });
    try {
      await h.controller.autoConnect();
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(calls).toBe(1);
      expect(h.state.instagram.connection.status).toBe("error");
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]?.loading).toBe(false);
      await h.controller.refresh();
      expect(h.controller.isConnected).toBe(true);
    } finally { await h.controller.shutdown(); }
  });
  test("logout cancels pending startup retries", async () => {
    let calls = 0;
    const h = harness({ inbox: async () => {
      calls++;
      throw new InstagramApiError("Temporary failure");
    } }, { retryDelayMs: 5 });
    await h.controller.autoConnect();
    await h.controller.logout();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(h.state.instagram.connection.status).toBe("idle");
  });
  test("keeps explicitly imported auth when the first inbox request fails", async () => {
    let saved = false;
    const h = harness({ inbox: async () => { throw new InstagramApiError("Temporary failure"); } }, {
      saveSession: async () => { saved = true; }, retryDelayMs: 60_000,
    });
    try {
      await h.controller.login();
      expect(saved).toBe(true);
      expect(h.state.instagram.connection.status).toBe("error");
    } finally { await h.controller.shutdown(); }
  });
  test("connects without Discord, opens history and sends to Instagram", async () => {
    const h = harness();
    try {
      await h.controller.autoConnect();
      expect(h.controller.isConnected).toBe(true);
      expect(h.state.sidebar.guilds.map(guild => guild.id)).toEqual([
        DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID, INSTAGRAM_GUILD_ID,
      ]);
      expect(h.controller.openChannel("ig:100")).toBe(true);
      await tick();
      expect(h.state.channelList.guildId).toBe(INSTAGRAM_GUILD_ID);
      expect(h.state.timeline.messages[0]!.content).toBe("hello");
      h.state.editor.buffer = "reply";
      expect(h.controller.sendMessage("reply")).toBe(true);
      await tick();
      expect(h.sends()).toBe(1);
      expect(h.state.editor.buffer).toBe("");
      expect(h.state.timeline.messages.at(-1)!.content).toBe("reply");
      expect(h.controller.sendMessage.call(h.controller, "")).toBe(true);
      expect(h.sends()).toBe(1);
    } finally { await h.controller.shutdown(); }
  });
  test("keeps failed drafts and blocks uploads without issuing requests", async () => {
    const h = harness({ sendText: async () => { throw new Error("failed"); } });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      h.state.editor.buffer = "draft";
      h.controller.sendMessage("draft");
      await tick();
      expect(h.state.editor.buffer).toBe("draft");
      h.state.pendingImages.push({} as any);
      h.controller.sendMessage("draft");
      expect(h.state.editor.buffer).toBe("draft");
      expect(h.state.pendingImages).toHaveLength(1);
    } finally { await h.controller.shutdown(); }
  });
  test("does not clear a draft edited while sending, and blocks double sends", async () => {
    const pending = deferred<any>();
    let calls = 0;
    const h = harness({ sendText: async () => { calls++; return pending.promise; } });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      h.state.editor.buffer = "first";
      h.controller.sendMessage("first");
      h.state.editor.buffer = "second";
      h.controller.sendMessage("second");
      expect(calls).toBe(1);
      pending.resolve({ item_id: "11", user_id: "1", timestamp: "2000000", item_type: "text", text: "first" });
      await tick();
      expect(h.state.editor.buffer).toBe("second");
    } finally { await h.controller.shutdown(); }
  });
  test("logout invalidates late login and history responses", async () => {
    const pendingInbox = deferred<InstagramInbox>();
    const h = harness({ inbox: () => pendingInbox.promise });
    const connecting = h.controller.autoConnect();
    await tick();
    await h.controller.logout();
    pendingInbox.resolve(inbox());
    await connecting;
    expect(h.controller.isConnected).toBe(false);
    expect(h.state.instagram.account).toBeNull();
    expect(Object.keys(h.state.instagram.threadsById)).toHaveLength(0);
  });
  test("history request cannot replace another active channel", async () => {
    const pendingThread = deferred<InstagramThread>();
    const h = harness({ thread: () => pendingThread.promise });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel(instagramChannelId("100"));
      h.state.timeline.channelId = "discord-channel";
      h.state.timeline.messages = [];
      pendingThread.resolve(thread());
      await tick();
      expect(h.state.timeline.channelId).toBe("discord-channel");
      expect(h.state.timeline.messages).toHaveLength(0);
    } finally { await h.controller.shutdown(); }
  });
  test("refresh cannot use the previous account while new auth is being imported", async () => {
    const state = createInitialState(null, "test", {});
    const imported = deferred<typeof session>();
    let inboxCalls = 0;
    const client = {
      inbox: async () => { inboxCalls++; return inbox(); },
    } as unknown as InstagramClient;
    const controller = new InstagramController(state, () => {}, {
      clientFactory: () => client, loadSession: async () => session,
      importSession: () => imported.promise, saveSession: async () => {},
    });
    try {
      await controller.autoConnect();
      const login = controller.login();
      await controller.refresh();
      expect(inboxCalls).toBe(1);
      expect(state.instagram.connection.status).toBe("connecting");
      imported.resolve(session);
      await login;
      expect(inboxCalls).toBe(2);
    } finally { await controller.shutdown(); }
  });
  test("preserves the reading viewport and does not mark unseen newest messages read", async () => {
    let reads = 0;
    const h = harness({ markSeen: async () => { reads++; } });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      const initiallyRead = reads;
      h.state.timeline.maxScroll = 100;
      h.state.timeline.scrollOffset = 20;
      await h.controller.refresh();
      expect(h.state.timeline.maxScroll).toBe(100);
      expect(h.state.timeline.scrollOffset).toBe(20);
      expect(reads).toBe(initiallyRead);
      h.state.timeline.scrollOffset = 100;
      await h.controller.refresh();
      expect(h.state.timeline.scrollOffset).toBe(Number.MAX_SAFE_INTEGER);
    } finally { await h.controller.shutdown(); }
  });
});
