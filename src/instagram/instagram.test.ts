import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTAGRAM_GUILD_ID, instagramChannelId, WHATSAPP_GUILD_ID } from "../chatproviders";
import { DIRECT_MESSAGES_GUILD_ID } from "../discord";
import { createInitialState } from "../state";
import { buildSidebarEntries } from "../sidebar";
import { renderStatusLine } from "../statusline";
import { loadInstagramSession, parseInstagramCookies, saveInstagramSession, validateSession } from "./auth";
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
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await tick();
  expect(predicate()).toBe(true);
}

describe("Instagram session", () => {
  test("accepts Cookie headers, optional wrapping quotes and opaque encoded values", () => {
    const header = "sessionid=1%3Atest==; csrftoken=test-csrf; ds_user_id=1";
    for (const value of [header, `Cookie: ${header}`, `cookie: ${header};`, `"${header}"`, `'${header}'`]) {
      expect(parseInstagramCookies(value)).toEqual({
        cookies: { ...session.cookies, sessionid: "1%3Atest==" },
      });
    }
    expect(parseInstagramCookies(`${header}; rur="ABC\\054123"; ig_did=device`).cookies.rur).toBe('"ABC\\054123"');
  });
  test("rejects missing, duplicate, malformed and injected credentials without echoing them", () => {
    const header = "sessionid=private-secret; csrftoken=test-csrf; ds_user_id=1";
    for (const value of [
      "", "private-secret", "sessionid=private-secret", `${header}; sessionid=other`,
      `${header}; broken`, `${header}; evil name=value`, `${header}\r\nX-Evil: private-secret`,
      `${header}; evil=\x1b[31m`, `${header}; empty=`, header.replace("test-csrf", "two words"),
    ]) {
      try { parseInstagramCookies(value); throw new Error("expected rejection"); }
      catch (error) {
        expect((error as Error).message).toContain("Invalid Instagram cookies");
        expect((error as Error).message).not.toContain("private-secret");
      }
    }
  });
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
    const query = new URL(calls[0]!.url).searchParams;
    expect(query.get("limit")).toBe("20");
    expect(query.get("thread_message_limit")).toBe("10");
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
      expect((error as Error).message).toContain("HTTP 503");
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
  test("pasted credentials connect and persist without touching vimbrowser", async () => {
    let imported = false;
    let saved: unknown;
    let received: unknown;
    const h = harness({}, {
      importSession: async () => { imported = true; throw new Error("Unexpected browser import"); },
      saveSession: async value => { saved = value; },
      clientFactory: value => {
        received = value;
        return { inbox: async () => inbox() } as unknown as InstagramClient;
      },
    });
    try {
      await h.controller.login({ source: "cookies", credential: "sessionid=test-session; csrftoken=test-csrf; ds_user_id=1" });
      expect(h.controller.isConnected).toBe(true);
      expect(imported).toBe(false);
      expect(saved).toEqual(session);
      expect(received).toEqual(session);
      expect(h.state.notice.text).not.toContain("test-session");
    } finally { await h.controller.shutdown(); }
  });
  test("invalid paste preserves a working connection and never writes auth", async () => {
    let writes = 0;
    const h = harness({}, { saveSession: async () => { writes++; } });
    try {
      await h.controller.autoConnect();
      await h.controller.login({ source: "cookies", credential: "private-secret" });
      expect(h.controller.isConnected).toBe(true);
      expect(writes).toBe(0);
      expect(h.state.notice.text).toContain("Invalid Instagram cookies");
      expect(h.state.notice.text).not.toContain("private-secret");
    } finally { await h.controller.shutdown(); }
  });
  test("shows logged-out status in the statusline and root refresh loads credentials added after startup", async () => {
    let saved = false;
    const h = harness({}, { loadSession: async () => saved ? session : null });
    try {
      await h.controller.autoConnect();
      h.state.sidebar.expandedGuildId = INSTAGRAM_GUILD_ID;
      h.controller.openRoot();
      await tick();
      const rows = buildSidebarEntries(h.state.sidebar, h.state.channelList.channels);
      expect(rows.some(row => row.guildId === INSTAGRAM_GUILD_ID && row.label.includes("/login instagram"))).toBe(false);
      h.state.notice.text = "";
      expect(renderStatusLine(h.state, 120).lines.join("")).toContain("/login instagram");
      expect(h.state.sidebar.focusedGuildId).toBe(INSTAGRAM_GUILD_ID);
      saved = true;
      await h.controller.refresh();
      expect(h.controller.isConnected).toBe(true);
      expect(buildSidebarEntries(h.state.sidebar, h.state.channelList.channels).some(row => row.id === "ig:100")).toBe(true);
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]).toBeUndefined();
    } finally { await h.controller.shutdown(); }
  });
  test("renders connecting state while the first inbox is pending, then stays quiet for an empty inbox", async () => {
    const pending = deferred<InstagramInbox>();
    const h = harness({ inbox: () => pending.promise });
    try {
      const connecting = h.controller.autoConnect();
      await tick();
      h.controller.openRoot();
      h.state.sidebar.expandedGuildId = INSTAGRAM_GUILD_ID;
      expect(buildSidebarEntries(h.state.sidebar, []).some(row => row.label.includes("Connecting Instagram"))).toBe(false);
      expect(renderStatusLine(h.state, 120).lines.join("")).toContain("Connecting Instagram");
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]?.loading).toBe(true);
      pending.resolve({ ...inbox(), inbox: { threads: [], has_older: false } });
      await connecting;
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]).toBeUndefined();
      expect(renderStatusLine(h.state, 120).lines.join("")).not.toContain("No conversations");
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
      h.controller.openRoot();
      h.state.notice.text = "";
      expect(renderStatusLine(h.state, 120).lines.join("")).toContain("Instagram: Offline · /refresh");
      await h.controller.refresh();
      expect(h.controller.isConnected).toBe(true);
      expect(renderStatusLine(h.state, 120).lines.join("")).not.toContain("Offline");
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
  test("resumes the failed inbox page after an automatic retry without losing chats", async () => {
    const calls: Array<string | undefined> = [];
    let failed = false;
    const h = harness({ inbox: async (cursor?: string) => {
      calls.push(cursor);
      if (cursor === "page2" && !failed) {
        failed = true;
        throw new InstagramApiError("Temporary page failure");
      }
      return cursor
        ? { ...inbox(), inbox: { threads: [thread("200")], has_older: false } }
        : { ...inbox(), inbox: { threads: [thread()], has_older: true, oldest_cursor: "page2" } };
    } }, { retryDelayMs: 1, inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => Boolean(h.state.instagram.threadsById["200"]));
      expect(calls).toEqual([undefined, "page2", undefined, "page2"]);
      expect(Object.keys(h.state.instagram.threadsById)).toEqual(["100", "200"]);
      expect(h.controller.isConnected).toBe(true);
      expect(h.state.notice.text).not.toContain("Temporary page failure");
    } finally { await h.controller.shutdown(); }
  });
  test("stops paging on fatal errors and resumes only on explicit refresh", async () => {
    let pageCalls = 0;
    const h = harness({ inbox: async (cursor?: string) => {
      if (!cursor) return { ...inbox(), inbox: { threads: [thread()], has_older: true, oldest_cursor: "page2" } };
      if (++pageCalls === 1) throw new InstagramApiError("Rate limited", true);
      return { ...inbox(), inbox: { threads: [thread("200")], has_older: false } };
    } }, { retryDelayMs: 1, inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => h.state.instagram.connection.status === "error");
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(pageCalls).toBe(1);
      await h.controller.refresh();
      await waitFor(() => Boolean(h.state.instagram.threadsById["200"]));
      expect(pageCalls).toBe(2);
    } finally { await h.controller.shutdown(); }
  });
  test("deduplicates paging during refresh and terminates repeated cursors", async () => {
    const pending = deferred<InstagramInbox>();
    let pageCalls = 0;
    const h = harness({ inbox: async (cursor?: string) => {
      if (cursor) { pageCalls++; return pending.promise; }
      return { ...inbox(), inbox: { threads: [thread()], has_older: true, oldest_cursor: "page2" } };
    } }, { inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => pageCalls === 1);
      await h.controller.refresh();
      pending.resolve({ ...inbox(), inbox: { threads: [thread("200")], has_older: true, oldest_cursor: "page2" } });
      await waitFor(() => Boolean(h.state.instagram.threadsById["200"]));
      await h.controller.refresh();
      await tick();
      expect(pageCalls).toBe(1);
    } finally { await h.controller.shutdown(); }
  });
  test("does not reset retry backoff when only the latest inbox succeeds", async () => {
    let fail = false;
    const h = harness({ thread: async () => {
      if (fail) throw new InstagramApiError("Temporary thread failure");
      return thread();
    } }, { retryDelayMs: 60_000 });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      fail = true;
      await h.controller.refresh();
      expect((h.controller as any).retryAttempt).toBe(1);
      await h.controller.refresh();
      expect((h.controller as any).retryAttempt).toBe(2);
      fail = false;
      await h.controller.refresh();
      expect((h.controller as any).retryAttempt).toBe(0);
    } finally { await h.controller.shutdown(); }
  });
  test("ignores an old pending page after logout and reconnect", async () => {
    const pending = deferred<InstagramInbox>();
    let pageCalls = 0;
    const h = harness({ inbox: async (cursor?: string) => {
      if (!cursor) return { ...inbox(), inbox: { threads: [thread()], has_older: true, oldest_cursor: "page2" } };
      if (++pageCalls === 1) return pending.promise;
      return { ...inbox(), inbox: { threads: [thread("300")], has_older: false } };
    } }, { inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => pageCalls === 1);
      await h.controller.logout();
      await h.controller.autoConnect();
      await waitFor(() => Boolean(h.state.instagram.threadsById["300"]));
      pending.resolve({ ...inbox(), inbox: { threads: [thread("200")], has_older: false } });
      await tick();
      expect(h.state.instagram.threadsById["200"]).toBeUndefined();
      expect(h.controller.isConnected).toBe(true);
    } finally { await h.controller.shutdown(); }
  });
  test("preserves page-failure backoff across successful head refreshes", async () => {
    let pageCalls = 0;
    const h = harness({ inbox: async (cursor?: string) => {
      if (!cursor) return { ...inbox(), inbox: { threads: [thread()], has_older: true, oldest_cursor: "page2" } };
      pageCalls++;
      throw new InstagramApiError("Temporary page failure");
    } }, { retryDelayMs: 60_000, inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => h.state.instagram.connection.status === "error");
      expect((h.controller as any).retryAttempt).toBe(1);
      await h.controller.refresh();
      await waitFor(() => h.state.instagram.connection.status === "error");
      expect(pageCalls).toBe(2);
      expect((h.controller as any).retryAttempt).toBe(2);
    } finally { await h.controller.shutdown(); }
  });
  test("head refresh does not reset backoff while another thread request is pending", async () => {
    const pending = deferred<InstagramThread>();
    const h = harness({ thread: () => pending.promise }, { retryDelayMs: 60_000 });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      // Represent a previous transient failure while openChannel's independent
      // history request is still pending. Skipping that request is not recovery.
      (h.controller as any).retryAttempt = 1;
      await h.controller.refresh();
      expect((h.controller as any).retryAttempt).toBe(1);
      pending.reject(new InstagramApiError("Temporary thread failure"));
      await tick();
      expect((h.controller as any).retryAttempt).toBe(2);
    } finally { await h.controller.shutdown(); }
  });
  test("stale thread refresh cannot unlock a new session's pending pagination", async () => {
    const pendingThread = deferred<InstagramThread>();
    const pendingPage = deferred<InstagramInbox>();
    let paging = false;
    let pageCalls = 0;
    const h = harness({
      inbox: async (cursor?: string) => {
        if (cursor) { pageCalls++; return pendingPage.promise; }
        return paging ? { ...inbox(), inbox: { threads: [thread()], has_older: true, oldest_cursor: "page2" } } : inbox();
      },
      thread: () => pendingThread.promise,
    }, { inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      h.state.timeline.channelId = "ig:100";
      const oldRefresh = h.controller.refresh();
      await tick();
      await h.controller.logout();
      paging = true;
      await h.controller.autoConnect();
      await waitFor(() => pageCalls === 1);
      pendingThread.resolve(thread());
      await oldRefresh;
      await h.controller.refresh();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(pageCalls).toBe(1);
      pendingPage.resolve({ ...inbox(), inbox: { threads: [thread("200")], has_older: false } });
      await tick();
    } finally { await h.controller.shutdown(); }
  });
  test("keeps explicitly imported auth when the first inbox request fails", async () => {
    let saved = false;
    const h = harness({ inbox: async () => { throw new InstagramApiError("Temporary failure"); } }, {
      saveSession: async () => { saved = true; }, retryDelayMs: 60_000,
    });
    try {
      await h.controller.login({ source: "browser" });
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
      const login = controller.login({ source: "browser" });
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
