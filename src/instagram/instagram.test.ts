import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTAGRAM_GUILD_ID, instagramChannelId, WHATSAPP_GUILD_ID } from "../chatproviders";
import { DIRECT_MESSAGES_GUILD_ID, PROVIDER_SYSTEM_MESSAGE_TYPE } from "../discord";
import { createInitialState } from "../state";
import { buildSidebarEntries } from "../sidebar";
import { renderStatusLine } from "../statusline";
import { loadInstagramSession, parseInstagramCookies, saveInstagramSession, validateSession } from "./auth";
import { loadInstagramCache, saveInstagramCache, trimInstagramSnapshot, type InstagramCacheSnapshot } from "./cache";
import { InstagramApiError, type InstagramClient } from "./client";
import { InstagramController, type InstagramControllerOptions } from "./controller";
import { sweepInstagramTemps } from "./files";
import { createInstagramUiState, instagramChannels, instagramMessageToTimeline, instagramTimelineMessages } from "./integration";
import type { IgInboxPage, IgMessage, IgThread } from "./model";
import { FRIEND_FBID, igMessage, igPage, igThread, VIEWER_FBID } from "./testkit";

const session = { cookies: { sessionid: "test-session", csrftoken: "test-csrf", ds_user_id: "1" } };
const thread = igThread;
const inbox = (threads: IgThread[] = [igThread()], next: string | null = null): IgInboxPage => igPage(threads, next);
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

describe("Instagram files leave no temp files behind", () => {
  test("a session save leaves only session.json; a startup sweep removes temp files a killed write left", async () => {
    const directory = await mkdtemp(join(tmpdir(), "record-ig-tmp-"));
    const path = join(directory, "instagram", "session.json");
    try {
      await saveInstagramSession(session, path);
      expect(await readdir(join(directory, "instagram"))).toEqual(["session.json"]);
      const accounts = join(directory, "instagram", "accounts", "1");
      await mkdir(accounts, { recursive: true });
      const old = Date.now() - 3 * 86_400_000;
      const names = {
        legacy: `session.json.${crypto.randomUUID()}.tmp`,
        deadWriter: `session.json.999999999.${crypto.randomUUID()}.tmp`,
        liveWriter: `session.json.${process.pid}.${crypto.randomUUID()}.tmp`,
      };
      for (const name of Object.values(names)) await writeFile(join(directory, "instagram", name), "{}");
      await utimes(join(directory, "instagram", names.legacy), old / 1000, old / 1000);
      await writeFile(join(accounts, `cache.json.${crypto.randomUUID()}.tmp`), "{}");
      await utimes(join(accounts, (await readdir(accounts))[0]!), old / 1000, old / 1000);
      await writeFile(join(accounts, "notes.txt"), "kept");
      expect(sweepInstagramTemps(join(directory, "instagram"))).toBe(3);
      expect((await readdir(join(directory, "instagram"))).sort()).toEqual(["accounts", names.liveWriter, "session.json"].sort());
      expect(await readdir(accounts)).toEqual(["notes.txt"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("shutdown waits for a session save Instagram's cookie rotation started", async () => {
    let rotate: ((value: typeof session) => void) | undefined;
    let saved = false;
    const h = harness({}, {
      saveSession: async () => { await new Promise(resolve => setTimeout(resolve, 40)); saved = true; },
    });
    const factory = (h.controller as unknown as { options: InstagramControllerOptions }).options.clientFactory!;
    (h.controller as unknown as { options: InstagramControllerOptions }).options.clientFactory = (value, options) => {
      rotate = options.onSessionRotated;
      return factory(value, options);
    };
    await h.controller.autoConnect();
    rotate!({ cookies: { ...session.cookies, csrftoken: "rotated" } });
    await h.controller.shutdown();
    expect(saved).toBe(true);
  });
});

describe("Instagram conversions", () => {
  function setup() {
    const state = createInstagramUiState();
    state.account = { id: "1", fbid: VIEWER_FBID, username: "me", name: "My Name" };
    return state;
  }
  const cdn = (name: string) => `https://scontent.cdninstagram.com/v/${name}`;
  const convert = (state: ReturnType<typeof setup>, message: IgMessage, t = thread()) => instagramMessageToTimeline(state, t, message);

  test("sanitizes labels/content, uses ms timestamps, own identity and aggregated reactions", () => {
    const state = setup();
    const t = thread("100", { users: [{ id: "2", fbid: FRIEND_FBID, username: "friend", name: "\x1b[31mFriend" }] });
    state.threadsById[t.id] = t;
    expect(instagramChannels(state)[0]!.name).toBe("Friend");
    const message = convert(state, igMessage("20", {
      senderFbid: VIEWER_FBID, timestampMs: 2000, content: { kind: "text", text: "\x1b[31mhello" },
      reactions: [{ emoji: "👍", senderFbid: VIEWER_FBID }, { emoji: "👍", senderFbid: FRIEND_FBID }],
    }), t);
    expect(message.content).toBe("hello");
    expect(message.timestamp).toBe(2000);
    expect(message.author).toMatchObject({ id: "1", displayName: "My Name" });
    expect(message.reactions?.[0]).toMatchObject({ count: 2, me: true, emoji: { name: "👍" } });
  });

  test("pictures without a size get the shape Instagram draws them in; real sizes win", () => {
    const state = setup();
    const shareOf = (fields: Record<string, unknown>) => ({ kind: "share" as const, share: {
      kind: "post" as const, title: "", caption: "", author: "a", preview: cdn("x.jpg"), previewWidth: 0, previewHeight: 0, text: "", expired: false, ...fields,
    } });
    const box = (content: IgMessage["content"]) => {
      const image = convert(state, igMessage("30", { content })).attachments.find(a => a.contentType?.startsWith("image/"))!;
      return [image.width ?? null, image.height ?? null, image.placeholderWidth ?? null, image.placeholderHeight ?? null];
    };
    expect(box(shareOf({ kind: "post", code: "P" }))).toEqual([null, null, 1080, 1350]);
    expect(box(shareOf({ kind: "reel", code: "R" }))).toEqual([null, null, 1080, 1920]);
    expect(box(shareOf({ kind: "story", username: "maya" }))).toEqual([null, null, 1080, 1920]);
    expect(box(shareOf({ kind: "post", code: "P", portrait: true }))).toEqual([null, null, 1080, 1920]);
    expect(box(shareOf({ kind: "link", url: "https://example.com/" }))).toEqual([null, null, 1200, 630]);
    expect(box(shareOf({ kind: "post", code: "P", previewWidth: 1080, previewHeight: 566 }))).toEqual([1080, 566, null, null]);
    expect(box({ kind: "media", items: [{ id: "a", video: false, preview: cdn("p.jpg"), url: cdn("f.jpg"), width: 0, height: 0 }] })).toEqual([null, null, 1080, 1440]);
    expect(box({ kind: "media", items: [{ id: "a", video: true, preview: cdn("p.jpg"), url: cdn("v.mp4"), width: 0, height: 0 }] })).toEqual([null, null, 1080, 1920]);
    expect(box({ kind: "sticker", url: cdn("s.webp"), alt: "" })).toEqual([null, null, 512, 512]);
    expect(box({ kind: "music", title: "Song", artist: "", artwork: cdn("a.jpg"), audio: null })).toEqual([null, null, 640, 640]);
  });

  test("photos inline, videos and voice as openable files, never view-once media or unsafe URLs", () => {
    const state = setup();
    const media = convert(state, igMessage("20", { content: { kind: "media", items: [
      { id: "a", video: false, preview: cdn("p.jpg"), url: cdn("full.jpg"), width: 960, height: 720 },
      { id: "b", video: true, preview: cdn("t.jpg"), url: cdn("v.mp4"), width: 720, height: 1280 },
    ] } }));
    expect(media.attachments.map(a => [a.contentType, a.url])).toEqual([
      ["image/jpeg", cdn("full.jpg")], ["image/jpeg", cdn("t.jpg")], ["video/mp4", cdn("v.mp4")],
    ]);
    expect(media.attachments[0]).toMatchObject({ width: 960, height: 720 });
    const voice = convert(state, igMessage("21", { content: { kind: "voice", url: cdn("a.mp4"), durationSecs: 14 } }));
    expect(voice.content).toBe("🎤 Voice message (0:14)");
    expect(voice.attachments[0]).toMatchObject({ contentType: "audio/mp4", durationSecs: 14 });
    const once = convert(state, igMessage("22", { content: { kind: "disappearing", video: true } }));
    expect(once.attachments).toHaveLength(0);
    expect(once.content).toContain("View-once video");
    const gif = convert(state, igMessage("23", { content: { kind: "animated", mp4: cdn("g.mp4"), still: cdn("g.webp"), width: 4, height: 3, sticker: false } }));
    expect(gif.attachments.map(a => a.contentType)).toEqual(["image/webp", "video/mp4"]);
  });

  test("shares: posts and stories with context, reels as one video with no feed link", () => {
    const state = setup();
    const post = convert(state, igMessage("30", { content: { kind: "share", share: {
      kind: "post", code: "ABC", url: "https://www.instagram.com/p/ABC/", title: "", caption: "First loaf", author: "ana",
      preview: cdn("i.jpg"), previewWidth: 1080, previewHeight: 1350, text: "", expired: false,
    } } }));
    expect(post.content).toBe("↪ Shared a post by @ana\nFirst loaf\nhttps://www.instagram.com/p/ABC/");
    expect(post.attachments[0]!.contentType).toBe("image/jpeg");
    const reel = convert(state, igMessage("31", { content: { kind: "share", share: {
      kind: "reel", code: "R1", url: "https://www.instagram.com/reel/R1/", title: "", caption: "Focaccia", author: "chef",
      preview: cdn("r.jpg"), previewWidth: 720, previewHeight: 1280, text: "", expired: false,
    } } }));
    expect(reel.content).toBe("▶ Shared a reel by @chef: Focaccia");
    expect(reel.content).not.toContain("instagram.com/reel");
    expect(reel.attachments.map(a => a.id)).toEqual(["ig:31:0", "ig-reel:R1"]);
    const story = convert(state, igMessage("32", { content: { kind: "share", share: {
      kind: "story", username: "me", title: "", caption: "", author: "me", preview: cdn("s.jpg"), previewWidth: 0, previewHeight: 0,
      text: "this looks amazing", storyContext: "reply", expired: false,
    } } }));
    expect(story.content).toBe("↩ Replied to your story\nthis looks amazing");
    const gone = convert(state, igMessage("33", { senderFbid: VIEWER_FBID, content: { kind: "share", share: {
      kind: "story", username: "friend", title: "", caption: "", author: "", preview: cdn("s.jpg"), previewWidth: 0, previewHeight: 0,
      text: "", storyContext: "reply", expired: true,
    } } }));
    expect(gone.content).toBe("↩ You replied to @friend's story (no longer available)");
    expect(gone.attachments).toHaveLength(0);
    const placeholder = convert(state, igMessage("34", { content: { kind: "share", share: {
      kind: "unavailable", title: "Post unavailable", caption: "", author: "", preview: null, previewWidth: 0, previewHeight: 0, text: "", expired: true,
    } } }));
    expect(placeholder.content).toBe("[Post unavailable]");
  });

  test("calls and system lines are compact rows; previews fall back to Instagram's snippet", () => {
    const state = setup();
    const missed = convert(state, igMessage("40", { timestampMs: new Date(2026, 9, 19, 17, 53).getTime(),
      content: { kind: "call", call: { video: false, outcome: "missed", line: "x" } } }));
    expect(missed.type).toBe(PROVIDER_SYSTEM_MESSAGE_TYPE);
    expect(missed.content).toBe("✕ ☎ Missed call · 17:53");
    const outgoing = convert(state, igMessage("41", { senderFbid: VIEWER_FBID, timestampMs: new Date(2026, 9, 19, 9, 5).getTime(),
      content: { kind: "call", call: { video: true, outcome: "ended", line: "x", duration: "4:12" } } }));
    expect(outgoing.content).toBe("📹 Video call ended · You · 09:05 · 4:12");
    expect(convert(state, igMessage("42", { content: { kind: "system", text: "Kai added Ines" } })).type).toBe(PROVIDER_SYSTEM_MESSAGE_TYPE);
    expect(convert(state, igMessage("43", { snippet: "Sent a photo", content: { kind: "unsupported", text: "Sent a photo" } })).content).toBe("Sent a photo");
  });

  test("replies quote their author; unsent sends sort below confirmed history", () => {
    const state = setup();
    const t = thread("100", { messages: [igMessage("10"), igMessage("11", { timestampMs: 2_000_000, replyTo: { id: "10", senderFbid: FRIEND_FBID, senderName: "", summary: "hello" } })] });
    state.threadsById[t.id] = t;
    state.outgoing.push({ localId: "local:ig:1", threadId: "100", text: "pending", reply: null, otid: "7", createdAt: 1, status: "failed", error: "no" });
    const messages = instagramTimelineMessages(state, "ig:100");
    expect(messages.map(m => m.id)).toEqual(["10", "11", "local:ig:1"]);
    expect(messages[1]!.reply).toMatchObject({ messageId: "10", authorDisplayName: "Friend", summary: "hello", timestamp: 1_000_000 });
    expect(messages[2]).toMatchObject({ localStatus: "failed", localError: "no" });
  });

  test("requests and /dm drafts are listed after inbox chats", () => {
    const state = setup();
    state.threadsById["100"] = thread("100");
    state.threadsById["300"] = thread("300", { folder: "pending" });
    state.requestIds = ["300"];
    state.draftUsers["u42"] = { id: "42", fbid: "", username: "newfriend", name: "" };
    expect(instagramChannels(state).map(c => [c.id, c.name])).toEqual([
      ["ig:100", "Friend"], ["ig:300", "Request · Friend"], ["ig:u42", "New · newfriend"],
    ]);
  });
});

describe("Instagram disk cache", () => {
  test("round-trips per account, privately; trims and never resurrects an in-flight send as pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "record-ig-cache-"));
    const path = join(directory, "accounts", "1", "cache.json");
    try {
      const snapshot: InstagramCacheSnapshot = {
        version: 1, accountId: "1", account: { id: "1", fbid: VIEWER_FBID, username: "me", name: "Me" }, mailboxId: "m", sequenceId: "s",
        threads: [thread("100", { messages: Array.from({ length: 100 }, (_, i) => igMessage(`m${i}`, { timestampMs: i })) })],
        requestIds: [], outgoing: [{ localId: "local:ig:1", threadId: "100", text: "hi", reply: null, otid: "1", createdAt: 1, status: "pending" }],
      };
      await saveInstagramCache(snapshot, path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const loaded = loadInstagramCache("1", path)!;
      expect(loaded.threads[0]!.messages).toHaveLength(80);
      expect(loaded.threads[0]!.messages.at(-1)!.id).toBe("m99");
      expect(loaded.outgoing[0]!.status).toBe("unconfirmed");
      expect(loadInstagramCache("2", path)).toBeNull();
      expect(trimInstagramSnapshot(snapshot).threads[0]!.detailLoaded).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

interface FakeClient {
  inbox: () => Promise<IgInboxPage>;
  inboxPage: (mailboxId: string, cursor: string) => Promise<IgInboxPage>;
  thread: (id: string, sequenceId: string) => Promise<IgThread>;
  olderMessages: (id: string, cursor: string) => Promise<{ messages: IgMessage[]; cursor: string | null; hasOlder: boolean }>;
  requests: () => Promise<{ pending: IgThread[]; spamCount: number }>;
  sendText: (text: string, target: { threadId: string } | { recipientIds: string[] }, options?: { replyTo?: string; otid?: string }) => Promise<{ messageId: string; timestampMs: number }>;
  react: (threadId: string, messageId: string, emoji: string, remove: boolean) => Promise<void>;
  markRead: (threadId: string, legacyId: string, messageId: string) => Promise<number | null>;
  acceptRequest: (threadId: string) => Promise<void>;
  searchUsers: (query: string) => Promise<Array<{ id: string; fbid: string; username: string; name: string }>>;
  reel: (code: string) => Promise<{ videoUrl: string; previewUrl: string | null; author: string; caption: string }>;
  readOnly: boolean;
}

function harness(overrides: Partial<FakeClient> = {}, options: InstagramControllerOptions = {}) {
  const state = createInitialState(null, "test", {});
  const sent: Array<{ text: string; target: unknown; options?: { replyTo?: string; otid?: string } }> = [];
  const reads: string[] = [];
  const fake: FakeClient = {
    inbox: async () => inbox(), inboxPage: async () => inbox([], null), thread: async id => thread(id),
    olderMessages: async () => ({ messages: [], cursor: null, hasOlder: false }),
    requests: async () => ({ pending: [], spamCount: 0 }),
    sendText: async (text, target, sendOptions) => { sent.push({ text, target, options: sendOptions }); return { messageId: `mid.$sent${sent.length}`, timestampMs: 2_000_000 + sent.length }; },
    react: async () => {}, markRead: async (_id, _legacy, messageId) => { reads.push(messageId); return null; },
    acceptRequest: async () => {}, searchUsers: async () => [], reel: async () => ({ videoUrl: "https://scontent.cdninstagram.com/r.mp4", previewUrl: null, author: "", caption: "" }),
    readOnly: false,
    ...overrides,
  };
  const controller = new InstagramController(state, () => {}, {
    clientFactory: () => fake as unknown as InstagramClient, loadSession: async () => session, importSession: async () => session,
    saveSession: async () => {}, removeSession: async () => {}, pollIntervalMs: 60_000, saveCache: null, loadCache: () => null,
    loadMutes: () => ({}), saveMutes: async () => {},
    ...options,
  });
  return { state, controller, fake, sent, reads, sends: () => sent.length };
}

describe("Instagram controller: reaction notices", () => {
  test("a notice in the inbox shows no line, counts as no unread and leaves the chat's place in the list", async () => {
    const read = { [VIEWER_FBID]: 1_000, [FRIEND_FBID]: 1_000 };
    const reacted = igThread("100", {
      lastActivityMs: 3_000, receipts: read,
      messages: [
        igMessage("m1", { senderFbid: VIEWER_FBID, timestampMs: 1_000 }),
        igMessage("n1", { timestampMs: 3_000, content: { kind: "unsupported", text: "Message" }, snippet: "Reacted 😂 to your message" }),
      ],
    });
    const other = igThread("200", { lastActivityMs: 2_000, users: [{ id: "3", fbid: "700", username: "other", name: "Other" }],
      messages: [igMessage("o1", { senderFbid: "700", timestampMs: 2_000 })], receipts: { [VIEWER_FBID]: 2_000, "700": 2_000 } });
    const h = harness({ inbox: async () => inbox([reacted, other]) });
    try {
      await h.controller.autoConnect();
      expect(instagramChannels(h.state.instagram).map((channel) => channel.id)).toEqual([instagramChannelId("200"), instagramChannelId("100")]);
      expect(h.state.notifications.byChannelId[instagramChannelId("100")] ?? 0).toBe(0);
      expect(instagramTimelineMessages(h.state.instagram, instagramChannelId("100")).map((message) => message.content).join("\n")).not.toContain("Reacted");
    } finally { await h.controller.shutdown(); }
  });
});

describe("Instagram controller: connection and paging", () => {
  test("pasted credentials connect and persist without touching vimbrowser", async () => {
    let imported = false;
    let saved: unknown;
    const h = harness({}, {
      importSession: async () => { imported = true; throw new Error("Unexpected browser import"); },
      saveSession: async value => { saved = value; },
    });
    try {
      await h.controller.login({ source: "cookies", credential: "sessionid=test-session; csrftoken=test-csrf; ds_user_id=1" });
      expect(h.controller.isConnected).toBe(true);
      expect(imported).toBe(false);
      expect(saved).toEqual(session);
      expect(h.state.notice.text).not.toContain("test-session");
      expect(h.state.instagram.account).toMatchObject({ id: "1", fbid: VIEWER_FBID });
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
  test("shows logged-out status and root refresh loads credentials added after startup", async () => {
    let saved = false;
    const h = harness({}, { loadSession: async () => saved ? session : null });
    try {
      await h.controller.autoConnect();
      h.state.sidebar.expandedGuildId = INSTAGRAM_GUILD_ID;
      h.controller.openRoot();
      await tick();
      h.state.notice.text = "";
      expect(renderStatusLine(h.state, 120).lines.join("")).toContain("/login instagram");
      saved = true;
      await h.controller.refresh();
      expect(h.controller.isConnected).toBe(true);
      expect(buildSidebarEntries(h.state.sidebar, h.state.channelList.channels).some(row => row.id === "ig:100")).toBe(true);
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]).toBeUndefined();
    } finally { await h.controller.shutdown(); }
  });
  test("shows cached chats at once on startup, then resyncs them", async () => {
    const pending = deferred<IgInboxPage>();
    const cached: InstagramCacheSnapshot = {
      version: 1, accountId: "1", account: { id: "1", fbid: VIEWER_FBID, username: "me", name: "Me" }, mailboxId: "m", sequenceId: "s",
      threads: [thread("100", { messages: [igMessage("10", { content: { kind: "text", text: "cached" } })] })], requestIds: [],
      outgoing: [{ localId: "local:ig:9", threadId: "100", text: "unsure", reply: null, otid: "9", createdAt: 5, status: "pending" }],
    };
    const fresh = () => thread("100", { messages: [igMessage("11", { timestampMs: 2_000_000, content: { kind: "text", text: "fresh" } })] });
    const h = harness({ inbox: () => pending.promise, thread: async () => fresh() }, { loadCache: () => structuredClone(cached) });
    try {
      const connecting = h.controller.autoConnect();
      await tick();
      expect(h.controller.isConnected).toBe(false);
      expect(instagramChannels(h.state.instagram).map(c => c.id)).toEqual(["ig:100"]);
      expect(h.state.sidebar.providerStatusByGuildId[INSTAGRAM_GUILD_ID]?.text).toBe("Syncing Instagram…");
      expect(h.controller.openChannel("ig:100")).toBe(true);
      expect(h.state.timeline.messages.map(m => m.content)).toEqual(["cached", "unsure"]);
      // A send interrupted by quitting comes back unconfirmed, never pending/resent.
      expect(h.state.timeline.messages[1]!.localStatus).toBe("unconfirmed");
      pending.resolve(inbox([fresh()]));
      await connecting;
      await waitFor(() => h.state.timeline.messages.some(m => m.content === "fresh"));
      expect(h.sends()).toBe(0);
      expect(h.state.instagram.fromCache).toBe(false);
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
      await waitFor(() => h.controller.isConnected);
      expect(calls).toBe(2);
      expect(h.state.notice.text).not.toContain("Temporary failure");
    } finally { await h.controller.shutdown(); }
  });
  test("does not retry auth/rate-limit failures, but explicit refresh can reconnect", async () => {
    let calls = 0;
    const h = harness({ inbox: async () => {
      if (++calls === 1) throw new InstagramApiError("Session expired", true, "auth");
      return inbox();
    } }, { retryDelayMs: 1 });
    try {
      await h.controller.autoConnect();
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(calls).toBe(1);
      expect(h.state.instagram.connection.status).toBe("error");
      h.controller.openRoot();
      h.state.notice.text = "";
      expect(renderStatusLine(h.state, 120).lines.join("")).toContain("Instagram: Offline · /refresh");
      await h.controller.refresh();
      expect(h.controller.isConnected).toBe(true);
    } finally { await h.controller.shutdown(); }
  });
  test("logout cancels pending startup retries", async () => {
    let calls = 0;
    const h = harness({ inbox: async () => { calls++; throw new InstagramApiError("Temporary failure"); } }, { retryDelayMs: 5 });
    await h.controller.autoConnect();
    await h.controller.logout();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(h.state.instagram.connection.status).toBe("idle");
  });
  test("resumes the failed inbox page after an automatic retry without losing chats", async () => {
    const pages: string[] = [];
    let failed = false;
    const h = harness({
      inbox: async () => inbox([thread()], "page2"),
      inboxPage: async (mailbox, cursor) => {
        pages.push(`${mailbox}:${cursor}`);
        if (!failed) { failed = true; throw new InstagramApiError("Temporary page failure"); }
        return inbox([thread("200")], null);
      },
    }, { retryDelayMs: 1, inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => Boolean(h.state.instagram.threadsById["200"]));
      expect(pages).toEqual(["17850000000000001:page2", "17850000000000001:page2"]);
      expect(Object.keys(h.state.instagram.threadsById).sort()).toEqual(["100", "200"]);
      expect(h.controller.isConnected).toBe(true);
    } finally { await h.controller.shutdown(); }
  });
  test("stops paging on fatal errors and resumes only on explicit refresh", async () => {
    let pageCalls = 0;
    const h = harness({
      inbox: async () => inbox([thread()], "page2"),
      inboxPage: async () => { if (++pageCalls === 1) throw new InstagramApiError("Rate limited", true, "rate_limit"); return inbox([thread("200")]); },
    }, { retryDelayMs: 1, inboxPageDelayMs: 0 });
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
    const pending = deferred<IgInboxPage>();
    let pageCalls = 0;
    const h = harness({ inbox: async () => inbox([thread()], "page2"), inboxPage: () => { pageCalls++; return pending.promise; } }, { inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => pageCalls === 1);
      await h.controller.refresh();
      pending.resolve(inbox([thread("200")], "page2"));
      await waitFor(() => Boolean(h.state.instagram.threadsById["200"]));
      await h.controller.refresh();
      await tick();
      expect(pageCalls).toBe(1);
    } finally { await h.controller.shutdown(); }
  });
  test("does not reset retry backoff when only the latest inbox succeeds", async () => {
    let fail = false;
    const h = harness({ thread: async id => { if (fail) throw new InstagramApiError("Temporary thread failure"); return thread(id); } }, { retryDelayMs: 60_000 });
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
    const pending = deferred<IgInboxPage>();
    let pageCalls = 0;
    const h = harness({
      inbox: async () => inbox([thread()], "page2"),
      inboxPage: () => (++pageCalls === 1 ? pending.promise : Promise.resolve(inbox([thread("300")]))),
    }, { inboxPageDelayMs: 0 });
    try {
      await h.controller.autoConnect();
      await waitFor(() => pageCalls === 1);
      await h.controller.logout();
      await h.controller.autoConnect();
      await waitFor(() => Boolean(h.state.instagram.threadsById["300"]));
      pending.resolve(inbox([thread("200")]));
      await tick();
      expect(h.state.instagram.threadsById["200"]).toBeUndefined();
      expect(h.controller.isConnected).toBe(true);
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
  test("logout invalidates late login and history responses", async () => {
    const pendingInbox = deferred<IgInboxPage>();
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
    const pendingThread = deferred<IgThread>();
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
    const imported = deferred<typeof session>();
    let inboxCalls = 0;
    const h = harness({ inbox: async () => { inboxCalls++; return inbox(); } }, { importSession: () => imported.promise });
    try {
      await h.controller.autoConnect();
      const login = h.controller.login({ source: "browser" });
      await h.controller.refresh();
      expect(inboxCalls).toBe(1);
      expect(h.state.instagram.connection.status).toBe("connecting");
      imported.resolve(session);
      await login;
      expect(inboxCalls).toBe(2);
    } finally { await h.controller.shutdown(); }
  });
});

describe("Instagram controller: chats", () => {
  test("connects without Discord, opens full history, pages older and counts unread", async () => {
    const unread = thread("100", { receipts: { [VIEWER_FBID]: 1 }, messages: [igMessage("10"), igMessage("11", { timestampMs: 1_100_000 })] });
    const older = [igMessage("5", { timestampMs: 500, content: { kind: "text", text: "older" } })];
    const h = harness({
      inbox: async () => inbox([unread, thread("101")]),
      thread: async id => thread(id, { messages: [igMessage("10"), igMessage("11", { timestampMs: 1_100_000 })], cursor: "c1", hasOlder: true }),
      olderMessages: async (_id, cursor) => { expect(cursor).toBe("c1"); return { messages: older, cursor: null, hasOlder: false }; },
    });
    try {
      await h.controller.autoConnect();
      expect(h.state.sidebar.guilds.map(guild => guild.id)).toEqual([DIRECT_MESSAGES_GUILD_ID, WHATSAPP_GUILD_ID, INSTAGRAM_GUILD_ID]);
      expect(h.state.notifications.byChannelId["ig:100"]).toBe(2);
      expect(h.state.notifications.byChannelId["ig:101"]).toBeUndefined();
      expect(h.controller.openChannel("ig:100")).toBe(true);
      await tick();
      expect(h.state.timeline.messages.map(m => m.id)).toEqual(["10", "11"]);
      expect(h.state.notifications.byChannelId["ig:100"]).toBeUndefined();
      h.controller.loadOlder();
      await waitFor(() => h.state.timeline.messages.length === 3);
      expect(h.state.timeline.messages[0]!.content).toBe("older");
      expect(h.state.timeline.hasOlder).toBe(false);
    } finally { await h.controller.shutdown(); }
  });
  test("marks read only the newest message from others, only at the bottom, never twice or in read-only mode", async () => {
    const unread = () => thread("100", { receipts: { [VIEWER_FBID]: 1 } });
    const h = harness({ inbox: async () => inbox([unread()]), thread: async () => unread() });
    try {
      await h.controller.autoConnect();
      h.state.timeline.maxScroll = 100;
      h.state.timeline.scrollOffset = 20;
      h.controller.openChannel("ig:100");
      h.state.timeline.maxScroll = 100;
      h.state.timeline.scrollOffset = 20;
      await tick();
      expect(h.reads).toEqual([]);
      h.state.timeline.scrollOffset = 100;
      h.controller.markActiveRead();
      h.controller.markActiveRead();
      await tick();
      expect(h.reads).toEqual(["10"]);
    } finally { await h.controller.shutdown(); }
    const ro = harness({ readOnly: true, inbox: async () => inbox([unread()]), thread: async () => unread() });
    try {
      await ro.controller.autoConnect();
      ro.controller.openChannel("ig:100");
      await tick();
      ro.controller.markActiveRead();
      await tick();
      expect(ro.reads).toEqual([]);
    } finally { await ro.controller.shutdown(); }
  });
  test("preserves the reading viewport across refresh", async () => {
    const h = harness();
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      h.state.timeline.maxScroll = 100;
      h.state.timeline.scrollOffset = 20;
      await h.controller.refresh();
      expect(h.state.timeline.maxScroll).toBe(100);
      expect(h.state.timeline.scrollOffset).toBe(20);
    } finally { await h.controller.shutdown(); }
  });
});

describe("Instagram controller: sending", () => {
  test("clears the composer immediately, shows a pending bubble, then the confirmed message", async () => {
    const pending = deferred<{ messageId: string; timestampMs: number }>();
    const h = harness({ sendText: () => pending.promise });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      h.state.editor.buffer = "reply";
      h.state.replyTarget = { messageId: "10", channelId: "ig:100", authorId: "2", authorDisplayName: "Friend", summary: "hello", timestamp: 1 } as any;
      expect(h.controller.sendMessage("reply")).toBe(true);
      expect(h.state.editor.buffer).toBe("");
      expect(h.state.replyTarget).toBeNull();
      expect(h.state.timeline.messages.at(-1)).toMatchObject({ content: "reply", localStatus: "pending" });
      // The next draft is independent, even if identical.
      h.state.editor.buffer = "reply";
      pending.resolve({ messageId: "mid.$sent", timestampMs: 2_000_000 });
      await waitFor(() => h.state.timeline.messages.at(-1)?.id === "mid.$sent");
      expect(h.state.editor.buffer).toBe("reply");
      expect(h.state.timeline.messages.at(-1)!.reply?.messageId).toBe("10");
      expect(h.controller.sendMessage("   ")).toBe(true);
    } finally { await h.controller.shutdown(); }
  });
  test("sends one at a time in order, with the reply id and a client id", async () => {
    const first = deferred<{ messageId: string; timestampMs: number }>();
    const calls: string[] = [];
    const h = harness({ sendText: async (text, _target, options) => {
      calls.push(`${text}:${options?.replyTo ?? ""}:${options?.otid ? "otid" : ""}`);
      return text === "first" ? first.promise : { messageId: "mid.$2", timestampMs: 2_000_002 };
    } });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      h.state.replyTarget = { messageId: "10", channelId: "ig:100", authorId: "2", authorDisplayName: "Friend", summary: "hello", timestamp: 1 } as any;
      h.controller.sendMessage("first");
      h.controller.sendMessage("second");
      await tick();
      expect(calls).toEqual(["first:10:otid"]);
      first.resolve({ messageId: "mid.$1", timestampMs: 2_000_001 });
      await waitFor(() => calls.length === 2);
      expect(calls[1]).toBe("second::otid");
    } finally { await h.controller.shutdown(); }
  });
  test("a refused send keeps a failed bubble and returns the text to an empty prompt; later sends wait", async () => {
    let calls = 0;
    const h = harness({ sendText: async () => { calls++; throw new InstagramApiError("Instagram did not accept this request.", false, "rejected"); } });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      h.controller.sendMessage("draft");
      h.controller.sendMessage("next");
      await waitFor(() => h.state.timeline.messages.filter(m => m.localStatus === "failed").length === 2);
      expect(calls).toBe(1);
      expect(h.state.editor.buffer).toBe("draft");
      expect(h.state.timeline.messages.find(m => m.content === "next")!.localError).toContain("earlier message");
      // Nothing is resent by later refreshes.
      await h.controller.refresh();
      await tick();
      expect(calls).toBe(1);
      const failed = h.state.timeline.messages.find(m => m.content === "draft")!;
      expect(h.controller.discardLocalMessage(failed.id)).toBe(true);
      expect(h.state.timeline.messages.some(m => m.content === "draft")).toBe(false);
    } finally { await h.controller.shutdown(); }
  });
  test("an uncertain send stays unconfirmed, isn't put back in the prompt, and clears once a refresh shows it landed", async () => {
    let otid = "";
    let landed = false;
    const h = harness({
      sendText: async (_text, _target, options) => { otid = options!.otid!; throw new InstagramApiError("may not", false, "uncertain"); },
      thread: async id => thread(id, { messages: landed
        ? [igMessage("10"), igMessage("mid.$landed", { senderFbid: VIEWER_FBID, timestampMs: 2_000_000, offlineThreadingId: otid })]
        : [igMessage("10")] }),
    });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      h.controller.sendMessage("maybe");
      await waitFor(() => h.state.timeline.messages.some(m => m.localStatus === "unconfirmed"));
      expect(h.state.editor.buffer).toBe("");
      expect(h.state.notice.text).toContain("won't be resent automatically");
      landed = true;
      await h.controller.refresh();
      await waitFor(() => !h.state.timeline.messages.some(m => m.localStatus));
      expect(h.state.timeline.messages.at(-1)!.id).toBe("mid.$landed");
    } finally { await h.controller.shutdown(); }
  });
  test("blocks uploads, requests and disconnected sends without issuing requests", async () => {
    const h = harness({ requests: async () => ({ pending: [thread("300", { folder: "pending" })], spamCount: 1 }) });
    try {
      await h.controller.autoConnect();
      await waitFor(() => h.state.instagram.requestIds.length === 1);
      h.controller.openChannel("ig:100");
      await tick();
      h.state.editor.buffer = "draft";
      h.state.pendingImages.push({} as any);
      h.controller.sendMessage("draft");
      expect(h.state.editor.buffer).toBe("draft");
      h.state.pendingImages = [];
      expect(h.controller.openChannel("ig:300")).toBe(true);
      await tick();
      h.controller.sendMessage("draft");
      expect(h.state.notice.text).toContain("/accept");
      expect(h.sends()).toBe(0);
    } finally { await h.controller.shutdown(); }
  });
});

describe("Instagram controller: reactions, requests, /dm, reels", () => {
  test("reactions are optimistic, one per person, and roll back when refused", async () => {
    const calls: string[] = [];
    let refuse = false;
    const h = harness({ react: async (_t, id, emoji, remove) => {
      calls.push(`${id}:${emoji}:${remove}`);
      if (refuse) throw new InstagramApiError("Read-only mode", false, "read_only");
    } });
    try {
      await h.controller.autoConnect();
      h.controller.openChannel("ig:100");
      await tick();
      const target = h.state.timeline.messages[0]!;
      await h.controller.reactToMessage(target, "😂", false);
      expect(h.state.timeline.messages[0]!.reactions).toEqual([{ count: 1, me: true, emoji: { id: null, name: "😂", animated: false } }]);
      await h.controller.reactToMessage(target, "❤️", false);
      expect(h.state.timeline.messages[0]!.reactions?.map(r => r.emoji.name)).toEqual(["❤️"]);
      refuse = true;
      await expect(h.controller.reactToMessage(target, "", true)).rejects.toThrow("Read-only");
      expect(h.state.timeline.messages[0]!.reactions?.map(r => r.emoji.name)).toEqual(["❤️"]);
      refuse = false;
      await h.controller.reactToMessage(target, "", true);
      expect(h.state.timeline.messages[0]!.reactions).toEqual([]);
      expect(calls).toEqual(["10:😂:false", "10:❤️:false", "10:❤️:true", "10:❤️:true"]);
    } finally { await h.controller.shutdown(); }
  });
  test("lists requests separately and accepts one into the inbox", async () => {
    let accepted = "";
    const h = harness({
      requests: async () => ({ pending: [thread("300", { folder: "pending", receipts: {} })], spamCount: 2 }),
      acceptRequest: async id => { accepted = id; },
    });
    try {
      await h.controller.autoConnect();
      await waitFor(() => h.state.instagram.requestIds.length === 1);
      expect(instagramChannels(h.state.instagram).at(-1)!.name).toBe("Request · Friend");
      expect(h.state.notifications.byChannelId["ig:300"]).toBeUndefined();
      h.controller.openChannel("ig:300");
      await tick();
      expect(h.reads).toEqual([]);
      await h.controller.acceptActiveRequest();
      expect(accepted).toBe("300");
      expect(h.state.instagram.threadsById["300"]!.folder).toBe("inbox");
      expect(instagramChannels(h.state.instagram).find(c => c.id === "ig:300")!.name).toBe("Friend");
    } finally { await h.controller.shutdown(); }
  });
  test("/dm opens an existing chat or a draft whose first message uses recipient ids, then moves to the real thread", async () => {
    let created = false;
    const h = harness({
      searchUsers: async () => [{ id: "42", fbid: "", username: "Newfriend", name: "New" }, { id: "43", fbid: "", username: "other", name: "" }],
      inbox: async () => inbox(created ? [thread(), thread("500", { users: [{ id: "42", fbid: "4200", username: "newfriend", name: "New" }] })] : [thread()]),
    });
    try {
      await h.controller.autoConnect();
      await h.controller.startDirectMessage("friend");
      expect(h.state.timeline.channelId).toBe("ig:100");
      await h.controller.startDirectMessage("@newfriend");
      expect(h.state.timeline.channelId).toBe("ig:u42");
      h.controller.sendMessage("hi there");
      created = true;
      await waitFor(() => h.state.timeline.channelId === "ig:500");
      expect(h.sent[0]!.target).toEqual({ recipientIds: ["42"] });
      expect(h.state.instagram.draftUsers).toEqual({});
      await h.controller.startDirectMessage("nobody");
      expect(h.state.notice.text).toContain("Did you mean @Newfriend, @other");
    } finally { await h.controller.shutdown(); }
  });
  test("a shared reel opens as its one video", async () => {
    const downloads: string[] = [];
    const h = harness({}, { downloadAttachment: async attachment => { downloads.push(attachment.url); return { ok: true, path: "/tmp/x.mp4", cached: false }; } });
    try {
      await h.controller.autoConnect();
      const result = await h.controller.downloadAttachment({ id: "ig-reel:R1", filename: "reel.mp4", contentType: "video/mp4", size: 0, url: "https://www.instagram.com/reel/R1/" });
      expect(result.ok).toBe(true);
      expect(downloads).toEqual(["https://scontent.cdninstagram.com/r.mp4"]);
    } finally { await h.controller.shutdown(); }
  });
});
