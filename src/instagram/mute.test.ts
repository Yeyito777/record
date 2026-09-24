import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { INSTAGRAM_GUILD_ID } from "../chatproviders";
import { createInitialState } from "../state";
import { InstagramClient, type InstagramInbox } from "./client";
import { InstagramController, type InstagramControllerOptions } from "./controller";
import { instagramChannels } from "./integration";
import { instagramMutePath, isInstagramThreadMuted, loadInstagramMutes, saveInstagramMutes, type InstagramMuteOverrides } from "./mute";

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

function fixture(options: InstagramControllerOptions = {}) {
  const state = createInitialState(null, "test", {});
  const remote: InstagramInbox = {
    viewer: { pk: "1001", username: "self" },
    inbox: { has_older: false, threads: [{
      thread_id: "2001", thread_title: "Friend", users: [{ pk: "1002", username: "friend" }],
      marked_as_unread: true, muted: false,
      items: [{ item_id: "3001", user_id: "1002", timestamp: "1000000", item_type: "text", text: "hello" }],
    }] },
  };
  let requests = 0;
  let renders = 0;
  const saved: Record<string, InstagramMuteOverrides> = {};
  const auth = { cookies: { sessionid: "fake", csrftoken: "fake", ds_user_id: "1001" } };
  const client = {
    inbox: async () => { requests++; return structuredClone(remote); },
    thread: async () => { requests++; return structuredClone(remote.inbox.threads[0]); },
    markSeen: async () => { requests++; },
    sendText: async () => { throw new Error("unexpected send"); },
  } as unknown as InstagramClient;
  const controller = new InstagramController(state, () => renders++, {
    clientFactory: () => client, loadSession: async () => auth, importSession: async () => auth,
    saveSession: async () => {}, removeSession: async () => {},
    loadMutes: id => ({ ...saved[id] }),
    saveMutes: async (id, overrides) => { saved[id] = { ...overrides }; },
    ...options,
  });
  return { state, controller, remote, saved, requests: () => requests, renders: () => renders };
}

describe("Instagram local mute persistence", () => {
  test("isolates accounts, keeps false overrides, and stores private atomic files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "record-ig-mutes-"));
    const old = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      expect(loadInstagramMutes("1")).toEqual({});
      await saveInstagramMutes("1", { "10": true, "20": false });
      await saveInstagramMutes("2", { "10": false });
      expect(loadInstagramMutes("1")).toEqual({ "10": true, "20": false });
      expect(loadInstagramMutes("2")).toEqual({ "10": false });
      expect((await stat(instagramMutePath("1"))).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(instagramMutePath("1")))).mode & 0o777).toBe(0o700);
      expect(() => instagramMutePath("../other")).toThrow();
      await writeFile(instagramMutePath("1"), '{"version":1,"overrides":{"10":"false"}}');
      expect(() => loadInstagramMutes("1")).toThrow("Invalid");
    } finally {
      if (old === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = old;
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("an explicit local unmute overrides remote mute", () => {
    expect(isInstagramThreadMuted({}, { thread_id: "10", muted: true })).toBe(true);
    expect(isInstagramThreadMuted({ "10": false }, { thread_id: "10", muted: true })).toBe(false);
    expect(isInstagramThreadMuted({ "10": true }, { thread_id: "10", muted: false })).toBe(true);
  });
});

describe("Instagram optimistic local mute", () => {
  test("updates immediately before saving, suppresses unread, and makes no network requests", async () => {
    let finish!: () => void;
    const saving = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture({ saveMutes: () => saving });
    try {
      await f.controller.autoConnect();
      expect(f.state.notifications.byChannelId["ig:2001"]).toBe(1);
      const requests = f.requests();
      const renders = f.renders();
      expect(f.controller.toggleChatMute("ig:2001")).toBe(true);
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(true);
      expect(f.state.sidebar.cachedChannelsByGuildId[INSTAGRAM_GUILD_ID]?.[0]?.muted).toBe(true);
      expect(f.state.notifications.byChannelId["ig:2001"] ?? 0).toBe(0);
      expect(f.renders()).toBeGreaterThan(renders);
      expect(f.requests()).toBe(requests);
      expect(f.state.instagram.threadsById["2001"]?.muted).toBe(false);
      await tick();
      expect(f.requests()).toBe(requests);
    } finally { finish(); await f.controller.shutdown(); }
  });
  test("refresh never overwrites the local choice, and unmute restores unread", async () => {
    const f = fixture();
    try {
      await f.controller.autoConnect();
      f.controller.toggleChatMute("ig:2001");
      await f.controller.refresh();
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(true);
      expect(f.state.notifications.byChannelId["ig:2001"] ?? 0).toBe(0);
      f.state.instagram.connection = { status: "error" };
      expect(f.controller.toggleChatMute("ig:2001")).toBe(true);
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(false);
      expect(f.state.notifications.byChannelId["ig:2001"]).toBe(1);
      await tick();
      expect(f.saved["1001"]).toEqual({ "2001": false });
    } finally { await f.controller.shutdown(); }
  });
  test("updates the active channel's mute flag without leaving its timeline", async () => {
    const f = fixture();
    try {
      await f.controller.autoConnect();
      f.controller.openChannel("ig:2001");
      await tick();
      f.controller.toggleChatMute("ig:2001");
      expect(f.state.channelList.activeChannel?.muted).toBe(true);
      expect(f.state.timeline.channelId).toBe("ig:2001");
      expect(f.state.timeline.messages[0]?.content).toBe("hello");
    } finally { await f.controller.shutdown(); }
  });
  test("hydrates before the first unread update, persists through relogin, and isolates accounts", async () => {
    const f = fixture();
    f.saved["1001"] = { "2001": true };
    try {
      await f.controller.autoConnect();
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(true);
      expect(f.state.notifications.byChannelId["ig:2001"] ?? 0).toBe(0);
      f.controller.toggleChatMute("ig:2001");
      await f.controller.logout();
      await f.controller.autoConnect();
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(false);
      f.remote.viewer.pk = "1003";
      await f.controller.login();
      expect(f.state.instagram.muteOverridesByThreadId).toEqual({});
      expect(f.saved["1001"]).toEqual({ "2001": false });
      expect(f.controller.toggleChatMute("ig:999")).toBe(false);
      expect(f.controller.toggleChatMute("discord-channel")).toBe(false);
    } finally { await f.controller.shutdown(); }
  });
  test("serializes rapid toggles and ignores an obsolete write failure", async () => {
    let fail!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => { fail = reject; });
    const writes: InstagramMuteOverrides[] = [];
    const f = fixture({ saveMutes: async (_id, settings) => {
      writes.push({ ...settings });
      if (writes.length === 1) await first;
    } });
    try {
      await f.controller.autoConnect();
      f.controller.toggleChatMute("ig:2001");
      await tick();
      f.controller.toggleChatMute("ig:2001");
      expect(writes).toEqual([{ "2001": true }]);
      fail(new Error("old save failed"));
      await tick();
      expect(writes).toEqual([{ "2001": true }, { "2001": false }]);
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(false);
      expect(f.state.notice.text).not.toContain("could not be saved");
    } finally { fail(new Error("finish")); await f.controller.shutdown(); }
  });
  test("keeps the session choice and reports a persistence failure without leaking disk errors", async () => {
    const f = fixture({ saveMutes: async () => { throw new Error("private filesystem detail"); } });
    try {
      await f.controller.autoConnect();
      f.controller.toggleChatMute("ig:2001");
      await tick();
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(true);
      expect(f.state.notice.text).toContain("could not be saved");
      expect(f.state.notice.text).not.toContain("private filesystem detail");
    } finally { await f.controller.shutdown(); }
  });
  test("does not overwrite unreadable saved preferences", async () => {
    let writes = 0;
    const f = fixture({
      loadMutes: () => { throw new Error("bad settings"); },
      saveMutes: async () => { writes++; },
    });
    try {
      await f.controller.autoConnect();
      f.controller.toggleChatMute("ig:2001");
      await tick();
      expect(instagramChannels(f.state.instagram)[0]?.muted).toBe(true);
      expect(writes).toBe(0);
      expect(f.state.notice.text).toContain("left untouched");
    } finally { await f.controller.shutdown(); }
  });
});
