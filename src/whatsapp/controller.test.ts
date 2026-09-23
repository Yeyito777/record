import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { INSTAGRAM_GUILD_ID, WHATSAPP_GUILD_ID, whatsappChannelId } from "../chatproviders";
import { createInitialState } from "../state";
import { WhatsAppController, type WhatsAppBackendHandle } from "./controller";
import { MAX_WHATSAPP_MESSAGES_PER_CHAT } from "./integration";
import { WHATSAPP_MUTE_FOREVER_END_MS } from "./mute";
import type {
  WhatsAppBackendEventListener,
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppLoginResult,
  WhatsAppMessage,
} from "./types";

class FakeBackend implements WhatsAppBackendHandle {
  state: WhatsAppConnectionState = { status: "idle" };
  isConnected = false;
  cancelled = false;
  shutdownCalled = false;
  started = 0;
  sentTexts: string[] = [];
  sentImageBatches: Array<{ caption: string; count: number }> = [];
  sentExpirations: Array<number | undefined> = [];
  historyRequests: Array<{ count: number; oldestId: string; oldestTimestampMs: number }> = [];
  mediaDownloads: Array<{
    messageId: string;
    recoveryAnchor?: import("./types").WhatsAppMediaRecoveryAnchor;
  }> = [];
  mediaDownloadBytes: Uint8Array | null = null;
  readMessageIds: string[] = [];
  muteRequests: Array<{ chatId: string; muted: boolean }> = [];
  muteError: Error | null = null;
  private resolveLogin: ((result: WhatsAppLoginResult) => void) | null = null;
  private readonly listeners = new Map<WhatsAppBackendEventName, Set<(event: unknown) => void>>();

  startLogin(): Promise<WhatsAppLoginResult> {
    this.started += 1;
    return new Promise((resolve) => { this.resolveLogin = resolve; });
  }

  cancelLogin(): boolean {
    this.cancelled = true;
    this.resolveLogin?.({ status: "cancelled" });
    return true;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }

  async logout(): Promise<void> {
    this.shutdownCalled = true;
    this.isConnected = false;
  }

  async sendText(
    chatId: string,
    text: string,
    _quoted?: import("./types").WhatsAppMessage,
    ephemeralExpirationSeconds?: number,
    _messageId?: string,
  ): Promise<WhatsAppMessage> {
    this.sentTexts.push(text);
    this.sentExpirations.push(ephemeralExpirationSeconds);
    return {
      key: { id: "sent-1", chatId, fromMe: true },
      id: "sent-1",
      chatId,
      senderId: "self@s.whatsapp.net",
      fromMe: true,
      timestampMs: 123_000,
      content: { kind: "text" as const, text },
    };
  }

  async sendImages(
    chatId: string,
    images: import("./worker-protocol").WhatsAppImageUpload[],
    caption: string,
    _quoted?: WhatsAppMessage,
    _ephemeralExpirationSeconds?: number,
    _messageIds?: string[],
  ): Promise<WhatsAppMessage[]> {
    this.sentImageBatches.push({ caption, count: images.length });
    return images.map((image, index) => ({
      key: { id: `sent-image-${index + 1}`, chatId, fromMe: true },
      id: `sent-image-${index + 1}`,
      chatId,
      senderId: "self@s.whatsapp.net",
      fromMe: true,
      timestampMs: 123_000 + index,
      content: {
        kind: "media" as const,
        mediaKind: "image" as const,
        mimeType: image.mediaType,
        ...(index === 0 && caption ? { caption } : {}),
      },
    }));
  }

  async markRead(keys: import("./types").WhatsAppMessageKey[]): Promise<void> {
    this.readMessageIds.push(...keys.map((key) => key.id));
  }

  async fetchHistory(
    count: number,
    oldestKey: import("./types").WhatsAppMessageKey,
    oldestTimestampMs: number,
  ): Promise<string> {
    this.historyRequests.push({ count, oldestId: oldestKey.id, oldestTimestampMs });
    return `history-${this.historyRequests.length}`;
  }

  async downloadMedia(
    message: import("./types").WhatsAppMessage,
    destinationPath: string,
    recoveryAnchor?: import("./types").WhatsAppMediaRecoveryAnchor,
  ): Promise<import("./worker-protocol").WhatsAppDownloadMediaResult> {
    this.mediaDownloads.push({ messageId: message.id, recoveryAnchor });
    if (this.mediaDownloadBytes) {
      mkdirSync(dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, this.mediaDownloadBytes);
    }
    return { path: destinationPath, sizeBytes: this.mediaDownloadBytes?.byteLength ?? 0 };
  }

  async setChatMuted(chatId: string, muted: boolean): Promise<import("./worker-protocol").WhatsAppSetChatMutedResult> {
    this.muteRequests.push({ chatId, muted });
    if (this.muteError) throw this.muteError;
    return { mutedUntilMs: muted ? WHATSAPP_MUTE_FOREVER_END_MS : null };
  }

  on<K extends WhatsAppBackendEventName>(event: K, listener: WhatsAppBackendEventListener<K>): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as (event: unknown) => void);
    return () => listeners?.delete(listener as (event: unknown) => void);
  }

  emit<K extends WhatsAppBackendEventName>(event: K, payload: WhatsAppBackendEventMap[K]): void {
    if (event === "state") {
      this.state = payload as WhatsAppConnectionState;
      this.isConnected = this.state.status === "connected";
    }
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

class DelayedShutdownBackend extends FakeBackend {
  private finishShutdown: (() => void) | null = null;

  override async shutdown(): Promise<void> {
    this.shutdownCalled = true;
    await new Promise<void>((resolve) => { this.finishShutdown = resolve; });
  }

  releaseShutdown(): void {
    this.finishShutdown?.();
  }
}

function fixture(options: { historyPageDelayMs?: number; historyRequestTimeoutMs?: number } = {}) {
  const state = createInitialState(null, "/tmp/config.json");
  const backend = new FakeBackend();
  let renders = 0;
  const authDirectory = join(mkdtempSync(join(tmpdir(), "record-wa-controller-")), "auth");
  const controller = new WhatsAppController(state, () => { renders += 1; }, {
    backendFactory: () => backend,
    authDirectory,
    successModalDelayMs: 0,
    historyPageDelayMs: options.historyPageDelayMs ?? 0,
    historyRequestTimeoutMs: options.historyRequestTimeoutMs ?? 1_000,
  });
  return { state, backend, controller, renders: () => renders };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function raceMessage(id: string, chatId: string, timestampMs = 10, fromMe = false): WhatsAppMessage {
  return {
    id, chatId, key: { id, chatId, fromMe }, fromMe, timestampMs,
    senderId: fromMe ? "self@s.whatsapp.net" : chatId,
    content: { kind: "text", text: id },
  };
}

function historyPage(messages: WhatsAppMessage[], requestId?: string): WhatsAppBackendEventMap["history"] {
  return { chats: [], contacts: [], messages, skippedMessages: 0, syncKind: "on-demand", requestId };
}

function raceFixture(jid = "race@s.whatsapp.net") {
  const result = fixture();
  const { backend, controller } = result;
  backend.emit("state", {
    status: "connected", resumed: true, connectedAtMs: 1,
    account: { id: "self@s.whatsapp.net" },
  });
  backend.emit("history", historyPage([raceMessage("original", jid, 100)]));
  controller.openChannel(whatsappChannelId(jid));
  return { ...result, jid };
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("WhatsApp loading races", () => {
  test("defers restored-chat images until connected and still serves offline cached files", async () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const directory = mkdtempSync(join(tmpdir(), "record-wa-startup-image-"));
    process.env.XDG_CONFIG_HOME = directory;
    const { state, backend, controller, renders } = fixture();
    const jid = "startup@g.us";
    try {
      backend.emit("history", historyPage([{
        ...raceMessage("startup-image", jid),
        content: { kind: "media", mediaKind: "image", mimeType: "image/jpeg", sizeBytes: 4 },
      }]));
      controller.openChannel(whatsappChannelId(jid));
      const attachment = state.timeline.messages[0]!.attachments[0]!;
      expect(await controller.downloadAttachment(attachment)).toMatchObject({ ok: false, retryWhenConnected: true });
      expect(backend.mediaDownloads).toHaveLength(0);

      const before = renders();
      backend.emit("state", { status: "connected", resumed: true, connectedAtMs: 1 });
      expect(renders()).toBeGreaterThan(before); // Drives waiting-preview retry.
      backend.mediaDownloadBytes = new Uint8Array([1, 2, 3, 4]);
      expect(await controller.downloadAttachment(attachment)).toMatchObject({ ok: true, cached: false });
      expect(backend.mediaDownloads).toHaveLength(1);

      backend.emit("state", { status: "connecting", source: "saved-session", attempt: 0 });
      expect(await controller.downloadAttachment(attachment)).toMatchObject({ ok: true, cached: true });
      expect(backend.mediaDownloads).toHaveLength(1);
    } finally {
      await controller.shutdown();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retries connection-interrupted downloads but preserves genuine media failures", async () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const directory = mkdtempSync(join(tmpdir(), "record-wa-reconnect-image-"));
    process.env.XDG_CONFIG_HOME = directory;
    const { state, backend, controller, jid } = raceFixture();
    try {
      backend.emit("history", historyPage([{
        ...raceMessage("reconnect-image", jid, 200),
        content: { kind: "media", mediaKind: "image", mimeType: "image/jpeg", sizeBytes: 4 },
      }]));
      const attachment = state.timeline.messages.at(-1)!.attachments[0]!;
      const download = deferred<import("./worker-protocol").WhatsAppDownloadMediaResult>();
      backend.downloadMedia = () => download.promise;
      const result = controller.downloadAttachment(attachment);
      backend.emit("state", { status: "connecting", source: "saved-session", attempt: 1 });
      backend.emit("state", { status: "connected", resumed: true, connectedAtMs: 2 });
      download.reject(new Error("connection closed"));
      expect(await result).toMatchObject({ ok: false, retryWhenConnected: true });

      backend.downloadMedia = async () => { throw new Error("invalid media"); };
      expect(await controller.downloadAttachment(attachment)).toEqual({ ok: false, error: "invalid media" });
    } finally {
      await controller.shutdown();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not accept sends during asynchronous logout", async () => {
    const { state, backend, controller } = raceFixture();
    const logout = deferred<void>();
    backend.logout = () => logout.promise;
    controller.logout();
    state.editor.buffer = "keep this draft";
    expect(controller.sendMessage("keep this draft")).toBe(true);
    expect(backend.sentTexts).toEqual([]);
    expect(state.editor.buffer).toBe("keep this draft");
    expect(state.timeline.messages.some((m) => m.localStatus)).toBe(false);
    logout.resolve();
    await settle();
    await controller.shutdown();
  });

  test("updates an evicted message that is still visible", async () => {
    const { state, backend, controller, jid } = raceFixture();
    try {
      backend.emit("messages", {
        kind: "upsert", upsertType: "append", skippedMessages: 0,
        messages: Array.from({ length: MAX_WHATSAPP_MESSAGES_PER_CHAT },
          (_, index) => raceMessage(`new-${index}`, jid, 200 + index)),
      });
      expect(state.whatsapp.messagesByChatId[jid]?.some((m) => m.id === "original")).toBe(false);
      backend.emit("messages", {
        kind: "update", skippedMessages: 0,
        messages: [{ ...raceMessage("original", jid, 100), content: { kind: "text", text: "edited while evicted" } }],
      });
      expect(state.timeline.messages.find((m) => m.id === "original")?.content).toBe("edited while evicted");
    } finally { await controller.shutdown(); }
  });

  test("exact echoes acknowledge identical overlapping sends before their RPC responses", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const first = deferred<WhatsAppMessage>();
    const second = deferred<WhatsAppMessage>();
    const ids: string[] = [];
    backend.sendText = (_jid, _text, _quoted, _expiration, id) => {
      ids.push(id!);
      return ids.length === 1 ? first.promise : second.promise;
    };
    controller.sendMessage("same");
    controller.sendMessage("same");
    try {
      expect(ids[0]).not.toBe(ids[1]);
      const echo = { ...raceMessage(ids[1]!, jid, 200, true), content: { kind: "text" as const, text: "same" } };
      backend.emit("messages", { kind: "upsert", upsertType: "notify", skippedMessages: 0, messages: [echo] });
      backend.emit("history", historyPage([echo]));
      expect(state.timeline.messages.filter((m) => m.localStatus === "pending")).toHaveLength(1);
      expect(state.timeline.messages.filter((m) => m.id === ids[1])).toHaveLength(1);
      second.reject(new Error("lost RPC response"));
      await settle();
      expect(state.timeline.messages.some((m) => m.localStatus === "failed")).toBe(false);
      first.resolve({ ...raceMessage(ids[0]!, jid, 210, true), content: { kind: "text", text: "same" } });
      await settle();
      expect(state.timeline.messages.filter((m) => m.content === "same")).toHaveLength(2);
      expect(state.timeline.messages.some((m) => m.localStatus)).toBe(false);
    } finally { await controller.shutdown(); }
  });

  test("partial image delivery only leaves unsent images pending or failed", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const send = deferred<WhatsAppMessage[]>();
    let ids: string[] = [];
    backend.sendImages = (_jid, _images, _caption, _quoted, _expiration, messageIds) => {
      ids = messageIds!;
      return send.promise;
    };
    state.pendingImages = [
      { base64: "aW1hZ2U=", mediaType: "image/png", sizeBytes: 5 },
      { base64: "b3RoZXI=", mediaType: "image/png", sizeBytes: 5 },
    ];
    controller.sendMessage("caption");
    try {
      const echo = { ...raceMessage(ids[0]!, jid, 200, true), content: { kind: "media" as const, mediaKind: "image" as const, caption: "caption" } };
      backend.emit("messages", { kind: "upsert", upsertType: "notify", skippedMessages: 0, messages: [echo] });
      backend.emit("history", historyPage([]));
      const pending = state.timeline.messages.find((m) => m.localStatus);
      expect(pending?.attachments).toHaveLength(1);
      expect(pending?.content).toBe("");
      send.reject(new Error("second image failed"));
      await settle();
      expect(state.pendingImages.map((image) => image.base64)).toEqual(["b3RoZXI="]);
      expect(state.editor.buffer).toBe("");
      expect(state.timeline.messages.find((m) => m.localStatus === "failed")?.attachments).toHaveLength(1);
    } finally { await controller.shutdown(); }
  });

  test("learns history reactions on cached messages without resurrecting live removals", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const target = { id: "original", chatId: jid };
    try {
      backend.emit("reactions", [{ target, reaction: { senderId: "removed", fromMe: false, emoji: "" } }]);
      backend.emit("history", {
        ...historyPage([]),
        reactions: [
          { target, reaction: { senderId: "removed", fromMe: false, emoji: "👎" } },
          { target, reaction: { senderId: "new-person", fromMe: false, emoji: "👍" } },
        ],
      });
      expect(state.timeline.messages[0]?.reactions?.map((r) => r.emoji.name)).toEqual(["👍"]);
    } finally { await controller.shutdown(); }
  });

  test("retains reactions arriving before their history message", async () => {
    const { state, backend, controller, jid } = raceFixture();
    try {
      backend.emit("reactions", [{
        target: { id: "older", chatId: jid },
        reaction: { senderId: jid, fromMe: false, emoji: "👍" },
      }]);
      backend.emit("history", historyPage([raceMessage("older", jid, 10)]));
      expect(state.timeline.messages[0]?.reactions?.[0]?.emoji.name).toBe("👍");
    } finally { await controller.shutdown(); }
  });

  test("retains pending sends through history, reactions, live updates and navigation", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const send = deferred<WhatsAppMessage>();
    backend.sendText = () => send.promise;
    controller.sendMessage("outgoing");
    const localId = state.timeline.messages.at(-1)!.id;
    try {
      backend.emit("history", historyPage([raceMessage("older", jid)]));
      expect(state.timeline.messages.find((m) => m.id === localId)?.localStatus).toBe("pending");
      backend.emit("reactions", [{
        target: { id: "original", chatId: jid },
        reaction: { senderId: jid, fromMe: false, emoji: "👍" },
      }]);
      expect(state.timeline.messages.some((m) => m.id === localId)).toBe(true);
      backend.emit("messages", {
        kind: "upsert", upsertType: "notify", skippedMessages: 0,
        messages: [raceMessage("live", jid, 200)],
      });
      backend.emit("chats", { kind: "upsert", chats: [{ id: "other@g.us", kind: "group" }] });
      controller.openChannel(whatsappChannelId("other@g.us"));
      controller.openChannel(whatsappChannelId(jid));
      expect(state.timeline.messages.some((m) => m.id === localId)).toBe(true);
      const sent = raceMessage("sent", jid, 300, true);
      backend.emit("messages", { kind: "upsert", upsertType: "notify", skippedMessages: 0, messages: [sent] });
      backend.emit("history", historyPage([sent]));
      send.resolve(sent);
      await settle();
      expect(state.timeline.messages.map((m) => m.id)).toEqual(["older", "original", "live", "sent"]);
      expect(state.timeline.messages.some((m) => m.localStatus)).toBe(false);
    } finally { await controller.shutdown(); }
  });

  test("keeps failed sends visible without clobbering newer text, reply or images", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const send = deferred<WhatsAppMessage>();
    backend.sendText = () => send.promise;
    controller.sendMessage("failed text");
    const image = { base64: "bmV3", mediaType: "image/png" as const, sizeBytes: 3 };
    state.editor.buffer = "new draft";
    state.editor.cursor = 9;
    state.pendingImages = [image];
    const reply = { channelId: whatsappChannelId(jid), guildId: WHATSAPP_GUILD_ID, messageId: "original", authorId: jid, authorDisplayName: "Person", authorColor: "", mention: false, timestamp: 100, summary: "original" };
    state.replyTarget = reply;
    try {
      backend.emit("history", historyPage([raceMessage("older", jid)]));
      send.reject(new Error("offline"));
      await settle();
      expect(state.editor.buffer).toBe("new draft");
      expect(state.pendingImages).toEqual([image]);
      expect(state.replyTarget).toBe(reply);
      backend.emit("history", historyPage([]));
      expect(state.timeline.messages.find((m) => m.content === "failed text")).toMatchObject({ localStatus: "failed", localError: "offline" });
    } finally { await controller.shutdown(); }
  });

  test("does not restore failed text into another chat and retains it when returning", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const send = deferred<WhatsAppMessage>();
    backend.sendText = () => send.promise;
    controller.sendMessage("original draft");
    backend.emit("chats", { kind: "upsert", chats: [{ id: "other@g.us", kind: "group" }] });
    controller.openChannel(whatsappChannelId("other@g.us"));
    try {
      send.reject(new Error("offline"));
      await settle();
      expect(state.editor.buffer).toBe("");
      expect(state.timeline.messages).toEqual([]);
      controller.openChannel(whatsappChannelId(jid));
      expect(state.timeline.messages.at(-1)).toMatchObject({ content: "original draft", localStatus: "failed" });
    } finally { await controller.shutdown(); }
  });

  test("retains pending image bytes during backfill and replaces them after success", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const send = deferred<WhatsAppMessage[]>();
    backend.sendImages = () => send.promise;
    state.pendingImages = [{ base64: "aW1hZ2U=", mediaType: "image/png", sizeBytes: 5 }];
    controller.sendMessage("caption");
    const attachmentId = state.timeline.messages.at(-1)!.attachments[0]!.id;
    try {
      backend.emit("history", historyPage([raceMessage("older", jid)]));
      expect(state.timeline.messages.at(-1)!.attachments[0]!.id).toBe(attachmentId);
      expect(state.localAttachmentImages[attachmentId]?.base64).toBe("aW1hZ2U=");
      send.resolve([{ ...raceMessage("image", jid, 200, true), content: { kind: "media", mediaKind: "image", caption: "caption" } }]);
      await settle();
      expect(state.timeline.messages.at(-1)?.id).toBe("image");
      expect(state.localAttachmentImages[attachmentId]).toBeUndefined();
    } finally { await controller.shutdown(); }
  });

  test("ignores a send completing after logout", async () => {
    const { state, backend, controller, jid } = raceFixture();
    const send = deferred<WhatsAppMessage>();
    backend.sendText = () => send.promise;
    controller.sendMessage("old session");
    controller.logout();
    send.resolve(raceMessage("stale", jid, 200, true));
    await settle();
    expect(state.whatsapp.messagesByChatId[jid]?.some((m) => m.id === "stale") ?? false).toBe(false);
    await controller.shutdown();
  });

  test("correlates a history page arriving before the fetch response and continues paging", async () => {
    const { state, backend, controller } = fixture();
    const jid = "early@g.us";
    const ack = deferred<string>();
    let requests = 0;
    backend.fetchHistory = () => { requests++; return ack.promise; };
    backend.emit("state", { status: "connected", resumed: true, connectedAtMs: 1 });
    backend.emit("history", historyPage([raceMessage("recent", jid, 100)]));
    controller.openChannel(whatsappChannelId(jid));
    try {
      backend.emit("history", historyPage([raceMessage("older", jid, 50)], "early-request"));
      expect(state.timeline.loadingOlder).toBe(true);
      ack.resolve("early-request");
      await settle();
      expect(state.timeline.loadingOlder).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests).toBe(2);
    } finally { await controller.shutdown(); }
  });

  test("an empty early page ends loading, while unrelated history does not", async () => {
    const { state, backend, controller } = fixture();
    const jid = "empty@g.us";
    const ack = deferred<string>();
    backend.fetchHistory = () => ack.promise;
    backend.emit("state", { status: "connected", resumed: true, connectedAtMs: 1 });
    backend.emit("history", historyPage([raceMessage("recent", jid, 100)]));
    controller.openChannel(whatsappChannelId(jid));
    try {
      backend.emit("history", { ...historyPage([raceMessage("older", jid, 50)]), syncKind: "recent" });
      expect(state.timeline.loadingOlder).toBe(true);
      backend.emit("history", historyPage([], "empty-page"));
      ack.resolve("empty-page");
      await settle();
      expect(state.timeline.loadingOlder).toBe(false);
      expect(state.timeline.hasOlder).toBe(false);
    } finally { await controller.shutdown(); }
  });

  test("preserves sends and history requests when a LID becomes a phone JID", async () => {
    const lid = "opaque@lid";
    const phone = "15551234567@s.whatsapp.net";
    const { state, backend, controller } = raceFixture(lid);
    const send = deferred<WhatsAppMessage>();
    backend.sendText = () => send.promise;
    controller.sendMessage("migrating");
    await settle();
    try {
      backend.emit("lid-mapping", { lid, phoneId: phone });
      expect(state.timeline.channelId).toBe(whatsappChannelId(phone));
      expect(state.timeline.messages.at(-1)?.localStatus).toBe("pending");
      expect(state.timeline.loadingOlder).toBe(true);
      backend.emit("history", historyPage([], "history-1"));
      expect(state.timeline.loadingOlder).toBe(false);
      send.resolve(raceMessage("sent", lid, 200, true));
      await settle();
      expect(state.timeline.messages.map((m) => m.id)).toEqual(["original", "sent"]);
      expect(state.timeline.messages.every((m) => m.channelId === whatsappChannelId(phone))).toBe(true);
    } finally { await controller.shutdown(); }
  });

  test("backfill does not revert live edits or reactions", async () => {
    const { state, backend, controller, jid } = raceFixture();
    try {
      const edited = { ...raceMessage("original", jid, 100), editedTimestampMs: 200, content: { kind: "text" as const, text: "edited live" } };
      backend.emit("messages", { kind: "update", skippedMessages: 0, messages: [edited] });
      backend.emit("reactions", [{
        target: { id: "original", chatId: jid },
        reaction: { senderId: jid, fromMe: false, emoji: "👍" },
      }]);
      backend.emit("history", historyPage([{ ...raceMessage("original", jid, 100), reactions: [] }]));
      expect(state.timeline.messages[0]?.content).toBe("edited live");
      expect(state.timeline.messages[0]?.reactions?.[0]?.emoji.name).toBe("👍");
    } finally { await controller.shutdown(); }
  });
});

describe("WhatsApp controller", () => {
  test("drives the QR modal from backend events and cancels without Discord auth", async () => {
    const { state, backend, controller, renders } = fixture();

    controller.login();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.started).toBe(1);
    expect(state.whatsapp.loginModal?.phase).toBe("starting");

    backend.emit("state", { status: "awaiting-qr", attempt: 0 });
    backend.emit("qr", { qr: "sensitive-qr", issuedAtMs: 1 });
    expect(state.whatsapp.loginModal).toMatchObject({ phase: "qr", qr: "sensitive-qr" });

    controller.cancelLogin();
    expect(backend.cancelled).toBe(true);
    expect(state.whatsapp.loginModal).toBeNull();
    expect(renders()).toBeGreaterThan(0);
  });

  test("keeps WhatsApp as a top-level root and maps synchronized chats", () => {
    const { state, backend, controller } = fixture();
    state.sidebar.focusedGuildId = INSTAGRAM_GUILD_ID;
    state.sidebar.expandedGuildId = INSTAGRAM_GUILD_ID;
    backend.emit("history", {
      chats: [{ id: "15551234567@s.whatsapp.net", kind: "direct", name: "Mom", lastMessageAtMs: 10 }],
      contacts: [],
      messages: [{
        key: { id: "message-1", chatId: "15551234567@s.whatsapp.net" },
        id: "message-1",
        chatId: "15551234567@s.whatsapp.net",
        senderId: "15551234567@s.whatsapp.net",
        senderName: "Mom",
        fromMe: false,
        timestampMs: 10,
        content: { kind: "text", text: "hello" },
      }],
      skippedMessages: 0,
      syncKind: "full",
    });

    expect(state.sidebar.guilds.some((guild) => guild.id === WHATSAPP_GUILD_ID)).toBe(true);
    expect(state.sidebar.guilds.some((guild) => guild.id === INSTAGRAM_GUILD_ID)).toBe(true);
    expect(state.sidebar.focusedGuildId).toBe(INSTAGRAM_GUILD_ID);
    expect(state.sidebar.expandedGuildId).toBe(INSTAGRAM_GUILD_ID);
    controller.openRoot();
    expect(state.channelList.guildId).toBe(WHATSAPP_GUILD_ID);
    expect(state.channelList.channels.map((channel) => channel.name)).toEqual(["Mom"]);

    expect(controller.openChannel(whatsappChannelId("15551234567@s.whatsapp.net"))).toBe(true);
    expect(state.timeline.messages.map((message) => message.content)).toEqual(["hello"]);
  });

  test("sends text optimistically through WhatsApp without a Discord token", async () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("state", {
      status: "connected",
      resumed: false,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net", name: "Me" },
    });
    backend.emit("chats", {
      kind: "upsert",
      chats: [{
        id: jid,
        kind: "direct",
        name: "Mom",
        ephemeralExpirationSeconds: 86_400,
      }],
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));

    expect(controller.sendMessage("hello")).toBe(true);
    expect(state.timeline.messages.at(-1)?.localStatus).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(backend.sentTexts).toEqual(["hello"]);
    expect(backend.sentExpirations).toEqual([86_400]);
    expect(state.timeline.messages.at(-1)).toMatchObject({ id: "sent-1", content: "hello" });
  });

  test("keeps the draft and shows status-line feedback while reconnecting", () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("chats", { kind: "upsert", chats: [{ id: jid, kind: "direct", name: "Mom" }] });
    backend.emit("state", {
      status: "reconnecting",
      attempt: 3,
      delayMs: 1_000,
      disconnect: { code: 428, name: "connectionClosed" },
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));
    state.editor.buffer = "please send this";
    state.editor.cursor = state.editor.buffer.length;

    expect(controller.sendMessage(state.editor.buffer)).toBe(true);

    expect(state.editor.buffer).toBe("please send this");
    expect(state.timeline.messages).toHaveLength(0);
    expect(state.notice).toMatchObject({
      text: "WhatsApp is reconnecting (attempt 3); your draft was not sent.",
      tone: "warning",
      statusLine: true,
      chat: false,
    });
  });

  test("shows background WhatsApp connection state in the status line", () => {
    const { state, backend } = fixture();
    backend.emit("state", {
      status: "reconnecting",
      attempt: 2,
      delayMs: 4_200,
      disconnect: { code: 428, name: "connectionClosed" },
    });
    expect(state.notice).toMatchObject({
      text: "WhatsApp reconnecting in 5s…",
      loading: true,
      statusLine: true,
      chat: false,
    });

    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    expect(state.notice.text).toBe("");

    backend.emit("state", { status: "failed", error: new Error("stream closed") });
    expect(state.notice).toMatchObject({
      text: "WhatsApp connection failed: stream closed",
      tone: "error",
      statusLine: true,
      chat: false,
    });
  });

  test("mutes and unmutes a WhatsApp chat optimistically", async () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    const channelId = whatsappChannelId(jid);
    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    backend.emit("chats", { kind: "upsert", chats: [{ id: jid, kind: "direct", name: "Mom" }] });
    state.notifications.byChannelId[channelId] = 3;
    state.notifications.channelGuildIds[channelId] = WHATSAPP_GUILD_ID;

    expect(controller.toggleChatMute(channelId)).toBe(true);
    expect(state.whatsapp.chatsById[jid]?.mutedUntilMs).toBe(WHATSAPP_MUTE_FOREVER_END_MS);
    expect(state.notifications.byChannelId[channelId]).toBeUndefined();
    expect(state.sidebar.cachedChannelsByGuildId[WHATSAPP_GUILD_ID]?.[0]?.muted).toBe(true);
    await Promise.resolve();
    expect(backend.muteRequests).toEqual([{ chatId: jid, muted: true }]);

    expect(controller.toggleChatMute(channelId)).toBe(true);
    expect(state.whatsapp.chatsById[jid]?.mutedUntilMs).toBeNull();
    await Promise.resolve();
    expect(backend.muteRequests).toEqual([
      { chatId: jid, muted: true },
      { chatId: jid, muted: false },
    ]);
  });

  test("rolls back a failed WhatsApp mute and reports it in the status line", async () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    const channelId = whatsappChannelId(jid);
    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    backend.emit("chats", { kind: "upsert", chats: [{ id: jid, kind: "direct", name: "Mom" }] });
    backend.muteError = new Error("app-state rejected");

    expect(controller.toggleChatMute(channelId)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.whatsapp.chatsById[jid]?.mutedUntilMs).toBeUndefined();
    expect(state.sidebar.cachedChannelsByGuildId[WHATSAPP_GUILD_ID]?.[0]?.muted).toBe(false);
    expect(state.notice).toMatchObject({
      text: "Failed to mute Mom: app-state rejected",
      tone: "error",
      statusLine: true,
      chat: false,
    });
  });

  test("sends pasted WhatsApp images with text and optimistic attachments", async () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("state", {
      status: "connected",
      resumed: false,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net", name: "Me" },
    });
    backend.emit("chats", { kind: "upsert", chats: [{ id: jid, kind: "direct", name: "Mom" }] });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));
    state.pendingImages = [
      { mediaType: "image/png", base64: Buffer.from("one").toString("base64"), sizeBytes: 3, filename: "one.png" },
      { mediaType: "image/png", base64: Buffer.from("two").toString("base64"), sizeBytes: 3, filename: "two.png" },
    ];

    expect(controller.sendMessage("it's finished......")).toBe(true);
    expect(state.pendingImages).toEqual([]);
    expect(state.timeline.messages.at(-1)).toMatchObject({
      content: "it's finished......",
      localStatus: "pending",
      attachments: [
        { filename: "one.png", contentType: "image/png", size: 3 },
        { filename: "two.png", contentType: "image/png", size: 3 },
      ],
    });
    // The inline loader runs while the send is pending. These temporary IDs
    // cannot be downloaded from WhatsApp; preview bytes must already be local.
    const localAttachments = state.timeline.messages.at(-1)!.attachments;
    for (const [index, attachment] of localAttachments.entries()) {
      expect(state.localAttachmentImages[attachment.id]).toEqual({
        mediaType: "image/png",
        base64: Buffer.from(index === 0 ? "one" : "two").toString("base64"),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const attachment of localAttachments) {
      expect(state.localAttachmentImages[attachment.id]).toBeUndefined();
    }

    expect(backend.sentImageBatches).toEqual([{ caption: "it's finished......", count: 2 }]);
    expect(state.timeline.messages.slice(-2).map((message) => [message.id, message.content])).toEqual([
      ["sent-image-1", "it's finished......"],
      ["sent-image-2", ""],
    ]);
  });

  test("downloads a legacy cached attachment using a newer history anchor", async () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const xdg = mkdtempSync(join(tmpdir(), "record-wa-legacy-media-"));
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const { state, backend, controller } = fixture();
      const jid = "15551234567@s.whatsapp.net";
      backend.mediaDownloadBytes = new Uint8Array([1, 2, 3, 4]);
      backend.emit("state", {
        status: "connected",
        resumed: true,
        connectedAtMs: 1,
        account: { id: "self@s.whatsapp.net" },
      });
      backend.emit("history", {
        chats: [{ id: jid, kind: "direct", name: "Mom" }],
        contacts: [],
        messages: [{
          key: { id: "legacy-image", chatId: jid, fromMe: false },
          id: "legacy-image",
          chatId: jid,
          senderId: jid,
          fromMe: false,
          timestampMs: 10,
          content: {
            kind: "media",
            mediaKind: "image",
            mimeType: "image/jpeg",
            sizeBytes: 4,
          },
        }, {
          key: { id: "newer-message", chatId: jid, fromMe: true },
          id: "newer-message",
          chatId: jid,
          senderId: "self@s.whatsapp.net",
          fromMe: true,
          timestampMs: 20,
          content: { kind: "text", text: "newer" },
        }],
        skippedMessages: 0,
        syncKind: "recent",
      });
      controller.openRoot();
      controller.openChannel(whatsappChannelId(jid));
      const attachment = state.timeline.messages[0]?.attachments[0];
      expect(attachment).toBeDefined();

      expect(await controller.downloadAttachment(attachment!)).toMatchObject({
        ok: true,
        cached: false,
      });
      expect(backend.mediaDownloads).toEqual([{
        messageId: "legacy-image",
        recoveryAnchor: {
          key: { id: "newer-message", chatId: jid, fromMe: true },
          timestampMs: 20,
        },
      }]);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("downloads visible media after its provider-cache entry is evicted or the chat changes", async () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const xdg = mkdtempSync(join(tmpdir(), "record-wa-retained-media-"));
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      for (const scenario of ["evicted", "chat-changed"] as const) {
        const { state, backend, controller } = fixture();
        const jid = "15551234567@s.whatsapp.net";
        const imageId = `retained-image-${scenario}`;
        backend.mediaDownloadBytes = new Uint8Array([1, 2, 3, 4]);
        backend.emit("state", {
          status: "connected", resumed: true, connectedAtMs: 1,
          account: { id: "self@s.whatsapp.net" },
        });
        backend.emit("history", {
          chats: [{ id: jid, kind: "direct" }], contacts: [], skippedMessages: 0, syncKind: "recent",
          messages: [{
            key: { id: imageId, chatId: jid }, id: imageId, chatId: jid,
            senderId: jid, fromMe: false, timestampMs: 10,
            content: { kind: "media", mediaKind: "image", mimeType: "image/jpeg", sizeBytes: 4 },
          }],
        });
        controller.openRoot();
        controller.openChannel(whatsappChannelId(jid));
        const attachment = state.timeline.messages[0]!.attachments[0]!;

        if (scenario === "evicted") {
          backend.emit("messages", {
            kind: "upsert", upsertType: "append", skippedMessages: 0,
            messages: Array.from({ length: MAX_WHATSAPP_MESSAGES_PER_CHAT }, (_, i) => ({
              key: { id: `newer-${i}`, chatId: jid }, id: `newer-${i}`, chatId: jid,
              senderId: jid, fromMe: false, timestampMs: 20 + i,
              content: { kind: "text" as const, text: "newer" },
            })),
          });
          expect(state.whatsapp.messagesByChatId[jid]?.some((entry) => entry.id === imageId)).toBe(false);
          expect(state.timeline.messages.some((entry) => entry.id === imageId)).toBe(true);
        } else {
          state.timeline.channelId = "discord-channel";
        }

        expect(await controller.downloadAttachment(attachment)).toMatchObject({ ok: true, cached: false });
        expect(backend.mediaDownloads[0]?.messageId).toBe(imageId);
        if (scenario === "evicted") {
          expect(backend.mediaDownloads[0]?.recoveryAnchor?.key.id).toBe("newer-0");
        }
        await controller.shutdown();
      }
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("keeps a live unread notification when the cached chat count was zero", () => {
    const { state, backend } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("chats", { kind: "upsert", chats: [{ id: jid, kind: "direct", name: "Mom", unreadCount: 0 }] });
    backend.emit("chats", { kind: "update", chats: [{ id: jid, kind: "direct", unreadCount: 1 }] });
    backend.emit("messages", {
      kind: "upsert",
      upsertType: "notify",
      skippedMessages: 0,
      messages: [{
        key: { id: "incoming-1", chatId: jid },
        id: "incoming-1",
        chatId: jid,
        senderId: jid,
        fromMe: false,
        timestampMs: 10,
        content: { kind: "text", text: "ping" },
      }],
    });

    expect(state.notifications.byChannelId[whatsappChannelId(jid)]).toBe(1);
    expect(state.whatsapp.chatsById[jid]?.unreadCount).toBe(1);
  });

  test("keeps an open chat read across stale unread-count updates and new messages", () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    backend.emit("history", {
      chats: [{ id: jid, kind: "direct", name: "Mom", unreadCount: 2 }],
      contacts: [],
      messages: [{
        key: { id: "existing", chatId: jid, fromMe: false },
        id: "existing",
        chatId: jid,
        senderId: jid,
        fromMe: false,
        timestampMs: 10,
        content: { kind: "text", text: "existing" },
      }],
      skippedMessages: 0,
      syncKind: "recent",
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));
    expect(state.whatsapp.chatsById[jid]?.unreadCount).toBe(0);
    expect(state.notifications.byChannelId[whatsappChannelId(jid)]).toBeUndefined();

    backend.emit("chats", { kind: "update", chats: [{ id: jid, kind: "direct", unreadCount: 2 }] });
    expect(state.whatsapp.chatsById[jid]?.unreadCount).toBe(0);
    expect(state.notifications.byChannelId[whatsappChannelId(jid)]).toBeUndefined();

    backend.emit("messages", {
      kind: "upsert",
      upsertType: "notify",
      skippedMessages: 0,
      messages: [{
        key: { id: "new", chatId: jid, fromMe: false },
        id: "new",
        chatId: jid,
        senderId: jid,
        fromMe: false,
        timestampMs: 20,
        content: { kind: "text", text: "new" },
      }],
    });
    expect(state.notifications.byChannelId[whatsappChannelId(jid)]).toBeUndefined();
    expect(backend.readMessageIds).toContain("new");
  });

  test("updates a recovered existing message without jumping to the bottom or re-reading it", () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    backend.emit("history", {
      chats: [{ id: jid, kind: "direct", name: "Mom" }],
      contacts: [],
      messages: [{
        key: { id: "legacy-media", chatId: jid, fromMe: false },
        id: "legacy-media",
        chatId: jid,
        senderId: jid,
        fromMe: false,
        timestampMs: 10,
        content: { kind: "media", mediaKind: "image", mimeType: "image/jpeg" },
      }],
      skippedMessages: 0,
      syncKind: "recent",
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));
    state.timeline.scrollOffset = 7;
    const readCount = backend.readMessageIds.length;

    backend.emit("messages", {
      kind: "upsert",
      upsertType: "notify",
      skippedMessages: 0,
      messages: [{
        key: { id: "legacy-media", chatId: jid, fromMe: false },
        id: "legacy-media",
        chatId: jid,
        senderId: jid,
        fromMe: false,
        timestampMs: 10,
        content: {
          kind: "media",
          mediaKind: "image",
          mimeType: "image/jpeg",
          download: { mediaKeyBase64: "AQIDBA==", directPath: "/v/legacy.enc" },
        },
      }],
    });

    expect(state.timeline.scrollOffset).toBe(7);
    expect(backend.readMessageIds).toHaveLength(readCount);
    expect(state.whatsapp.messagesByChatId[jid]?.[0]?.content).toMatchObject({
      download: { directPath: "/v/legacy.enc" },
    });
  });

  test("requests and displays older WhatsApp history when opening a sparse chat", async () => {
    const { state, backend, controller } = fixture();
    const jid = "group@g.us";
    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    backend.emit("history", {
      chats: [{ id: jid, kind: "group", name: "Family" }],
      contacts: [],
      messages: [{
        key: { id: "preview", chatId: jid, fromMe: true },
        id: "preview",
        chatId: jid,
        senderId: "self@s.whatsapp.net",
        fromMe: true,
        timestampMs: 1,
        content: { kind: "text", text: "old preview" },
      }, {
        key: { id: "recent", chatId: jid, fromMe: false, participantId: "person@s.whatsapp.net" },
        id: "recent",
        chatId: jid,
        senderId: "person@s.whatsapp.net",
        fromMe: false,
        timestampMs: 10 * 24 * 60 * 60 * 1_000,
        content: { kind: "text", text: "recent" },
      }],
      skippedMessages: 0,
      syncKind: "recent",
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));
    await Promise.resolve();
    expect(backend.historyRequests).toEqual([{
      count: 50,
      oldestId: "recent",
      oldestTimestampMs: 10 * 24 * 60 * 60 * 1_000,
    }]);

    backend.emit("history", {
      chats: [],
      contacts: [],
      messages: [{
        key: { id: "older", chatId: jid, fromMe: false, participantId: "person@s.whatsapp.net" },
        id: "older",
        chatId: jid,
        senderId: "person@s.whatsapp.net",
        fromMe: false,
        timestampMs: 9 * 24 * 60 * 60 * 1_000,
        content: { kind: "text", text: "older" },
      }],
      skippedMessages: 0,
      syncKind: "on-demand",
      requestId: "history-1",
    });
    expect(state.timeline.messages.map((message) => message.id)).toEqual(["preview", "older", "recent"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.historyRequests.at(-1)).toEqual({
      count: 50,
      oldestId: "older",
      oldestTimestampMs: 9 * 24 * 60 * 60 * 1_000,
    });
  });

  test("keeps conversation order stable when focusing triggers stale on-demand metadata", async () => {
    const { state, backend, controller } = fixture();
    const focusedJid = "focused@s.whatsapp.net";
    const otherJid = "other@s.whatsapp.net";
    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    backend.emit("history", {
      chats: [
        { id: focusedJid, kind: "direct", name: "Focused", lastMessageAtMs: 300 },
        { id: otherJid, kind: "direct", name: "Other", lastMessageAtMs: 200 },
      ],
      contacts: [],
      messages: [
        {
          key: { id: "focused-recent", chatId: focusedJid, fromMe: false },
          id: "focused-recent",
          chatId: focusedJid,
          senderId: focusedJid,
          fromMe: false,
          timestampMs: 300,
          content: { kind: "text", text: "recent" },
        },
        {
          key: { id: "other-recent", chatId: otherJid, fromMe: false },
          id: "other-recent",
          chatId: otherJid,
          senderId: otherJid,
          fromMe: false,
          timestampMs: 200,
          content: { kind: "text", text: "other" },
        },
      ],
      skippedMessages: 0,
      syncKind: "recent",
    });
    controller.openRoot();
    expect(state.channelList.channels.map((channel) => channel.name)).toEqual(["Focused", "Other"]);
    controller.openChannel(whatsappChannelId(focusedJid));
    await Promise.resolve();

    backend.emit("history", {
      chats: [{ id: focusedJid, kind: "direct", lastMessageAtMs: 100 }],
      contacts: [],
      messages: [{
        key: { id: "focused-old", chatId: focusedJid, fromMe: false },
        id: "focused-old",
        chatId: focusedJid,
        senderId: focusedJid,
        fromMe: false,
        timestampMs: 100,
        content: { kind: "text", text: "old" },
      }],
      skippedMessages: 0,
      syncKind: "on-demand",
      requestId: "history-1",
    });

    expect(state.whatsapp.chatsById[focusedJid]?.lastMessageAtMs).toBe(300);
    expect(state.channelList.channels.map((channel) => channel.name)).toEqual(["Focused", "Other"]);
  });

  test("does not let a late timed-out history page complete its retry", async () => {
    const { backend, controller } = fixture({ historyRequestTimeoutMs: 5 });
    const jid = "group@g.us";
    backend.emit("state", {
      status: "connected",
      resumed: true,
      connectedAtMs: 1,
      account: { id: "self@s.whatsapp.net" },
    });
    backend.emit("history", {
      chats: [{ id: jid, kind: "group", name: "Family" }],
      contacts: [],
      messages: [{
        key: { id: "recent", chatId: jid, fromMe: false, participantId: "person@s.whatsapp.net" },
        id: "recent",
        chatId: jid,
        senderId: "person@s.whatsapp.net",
        fromMe: false,
        timestampMs: 30_000,
        content: { kind: "text", text: "recent" },
      }],
      skippedMessages: 0,
      syncKind: "recent",
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));
    await Promise.resolve();
    expect(backend.historyRequests).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.openChannel(whatsappChannelId(jid));
    await Promise.resolve();
    expect(backend.historyRequests).toHaveLength(2);

    backend.emit("history", {
      chats: [],
      contacts: [],
      messages: [{
        key: { id: "late", chatId: jid, fromMe: false, participantId: "person@s.whatsapp.net" },
        id: "late",
        chatId: jid,
        senderId: "person@s.whatsapp.net",
        fromMe: false,
        timestampMs: 20_000,
        content: { kind: "text", text: "late first page" },
      }],
      skippedMessages: 0,
      syncKind: "on-demand",
      requestId: "history-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.historyRequests).toHaveLength(2);

    backend.emit("history", {
      chats: [],
      contacts: [],
      messages: [{
        key: { id: "retry", chatId: jid, fromMe: false, participantId: "person@s.whatsapp.net" },
        id: "retry",
        chatId: jid,
        senderId: "person@s.whatsapp.net",
        fromMe: false,
        timestampMs: 10_000,
        content: { kind: "text", text: "retry page" },
      }],
      skippedMessages: 0,
      syncKind: "on-demand",
      requestId: "history-2",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.historyRequests).toHaveLength(3);
  });

  test("routes a new LID message into the existing phone-JID chat", () => {
    const { state, backend, controller } = fixture();
    const phoneId = "15551234567@s.whatsapp.net";
    const lid = "opaque-person@lid";
    backend.emit("chats", {
      kind: "upsert",
      chats: [{ id: phoneId, kind: "direct", name: "Mom", lastMessageAtMs: 1 }],
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(phoneId));

    backend.emit("chats", {
      kind: "update",
      chats: [{ id: lid, kind: "direct", unreadCount: 1 }],
    });
    expect(state.notifications.byChannelId[whatsappChannelId(lid)]).toBe(1);
    state.sidebar.channelPlacementsByGuildId[WHATSAPP_GUILD_ID] = {
      [whatsappChannelId(lid)]: { pinned: true, sortOrder: 0 },
    };
    state.sidebar.selectedItem = { type: "channel", id: whatsappChannelId(lid), guildId: WHATSAPP_GUILD_ID };

    backend.emit("messages", {
      kind: "upsert",
      upsertType: "notify",
      skippedMessages: 0,
      messages: [{
        key: { id: "incoming-lid", chatId: lid, alternateChatId: phoneId },
        id: "incoming-lid",
        chatId: lid,
        senderId: lid,
        senderName: "Mom",
        fromMe: false,
        timestampMs: 20,
        content: { kind: "text", text: "hello" },
      }],
    });

    expect(state.whatsapp.chatsById[lid]).toBeUndefined();
    expect(state.whatsapp.messagesByChatId[phoneId]?.at(-1)?.id).toBe("incoming-lid");
    expect(state.channelList.channels.filter((channel) => channel.name === "Mom")).toHaveLength(1);
    expect(state.timeline.channelId).toBe(whatsappChannelId(phoneId));
    expect(state.timeline.messages.at(-1)?.id).toBe("incoming-lid");
    expect(state.notifications.byChannelId[whatsappChannelId(phoneId)]).toBeUndefined();
    expect(state.notifications.byChannelId[whatsappChannelId(lid)]).toBeUndefined();
    expect(state.sidebar.channelPlacementsByGuildId[WHATSAPP_GUILD_ID]).toEqual({
      [whatsappChannelId(phoneId)]: { pinned: true, sortOrder: 0 },
    });
    expect(state.sidebar.selectedItem).toEqual({
      type: "channel",
      id: whatsappChannelId(phoneId),
      guildId: WHATSAPP_GUILD_ID,
    });
  });

  test("adds a new LID unread delta to the existing phone-JID unread total", () => {
    const { state, backend } = fixture();
    const phoneId = "15551234567@s.whatsapp.net";
    const lid = "opaque-person@lid";
    backend.emit("chats", {
      kind: "upsert",
      chats: [{ id: phoneId, kind: "direct", name: "Mom", unreadCount: 5 }],
    });
    backend.emit("chats", {
      kind: "update",
      chats: [{ id: lid, kind: "direct", unreadCount: 1 }],
    });
    backend.emit("messages", {
      kind: "upsert",
      upsertType: "notify",
      skippedMessages: 0,
      messages: [{
        key: { id: "incoming-lid", chatId: lid, alternateChatId: phoneId },
        id: "incoming-lid",
        chatId: lid,
        senderId: lid,
        senderName: "Mom",
        fromMe: false,
        timestampMs: 20,
        content: { kind: "text", text: "hello" },
      }],
    });

    expect(state.whatsapp.chatsById[lid]).toBeUndefined();
    expect(state.whatsapp.chatsById[phoneId]?.unreadCount).toBe(6);
    expect(state.notifications.byChannelId[whatsappChannelId(phoneId)]).toBe(6);
    expect(state.notifications.byChannelId[whatsappChannelId(lid)]).toBeUndefined();
  });

  test("applies edits in place without adding unread notifications", () => {
    const { state, backend, controller } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("history", {
      chats: [{ id: jid, kind: "direct", name: "Mom" }],
      contacts: [],
      messages: [{
        key: { id: "original", chatId: jid },
        id: "original",
        chatId: jid,
        senderId: jid,
        senderName: "Mom",
        fromMe: false,
        timestampMs: 10,
        content: { kind: "text", text: "before" },
      }],
      skippedMessages: 0,
      syncKind: "full",
    });
    controller.openRoot();
    controller.openChannel(whatsappChannelId(jid));
    state.timeline.scrollOffset = 4;

    backend.emit("messages", {
      kind: "update",
      skippedMessages: 0,
      messages: [{
        key: { id: "original", chatId: jid },
        id: "original",
        chatId: jid,
        senderId: jid,
        fromMe: false,
        timestampMs: null,
        editedTimestampMs: 20,
        content: { kind: "text", text: "after" },
      }],
    });

    expect(state.timeline.messages).toHaveLength(1);
    expect(state.timeline.messages[0]).toMatchObject({
      id: "original",
      content: "after",
      timestamp: 10,
      editedTimestamp: 20,
    });
    expect(state.timeline.scrollOffset).toBe(4);
    expect(state.notifications.byChannelId[whatsappChannelId(jid)]).toBeUndefined();
  });

  test("waits for a terminal backend to stop before deleting auth and starting its replacement", async () => {
    const state = createInitialState(null, "/tmp/config.json");
    const previous = new DelayedShutdownBackend();
    previous.state = { status: "logged-out", disconnect: { code: 401, name: "loggedOut" } };
    const replacement = new FakeBackend();
    const backends = [previous, replacement];
    const authDirectory = join(mkdtempSync(join(tmpdir(), "record-wa-controller-reset-")), "auth");
    const controller = new WhatsAppController(state, () => {}, {
      backendFactory: () => backends.shift() ?? replacement,
      authDirectory,
    });

    controller.login();
    expect(previous.shutdownCalled).toBe(true);
    expect(previous.started).toBe(0);
    expect(replacement.started).toBe(0);

    previous.releaseShutdown();
    // Auth cleanup uses async filesystem work and may take more than one turn.
    const deadline = Date.now() + 1_000;
    while (replacement.started === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(replacement.started).toBe(1);
  });

  test("restores cached WhatsApp chats after a process restart with no new history sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "record-wa-controller-cache-"));
    const authDirectory = join(root, "auth");
    const cacheFile = join(root, "cache.json");
    const firstState = createInitialState(null, "/tmp/config.json");
    const firstBackend = new FakeBackend();
    const first = new WhatsAppController(firstState, () => {}, {
      backendFactory: () => firstBackend,
      authDirectory,
      cacheFile,
      cacheSaveDelayMs: 0,
    });
    firstBackend.emit("history", {
      chats: [{ id: "15551234567@s.whatsapp.net", kind: "direct", name: "Cached person" }],
      contacts: [{ id: "15551234567@s.whatsapp.net", name: "Cached person" }],
      messages: [{
        key: { id: "cached-message", chatId: "15551234567@s.whatsapp.net" },
        id: "cached-message",
        chatId: "15551234567@s.whatsapp.net",
        fromMe: false,
        timestampMs: 10,
        content: { kind: "text", text: "cached hello" },
      }],
      skippedMessages: 0,
      syncKind: "full",
    });
    await first.shutdown();

    const restartedState = createInitialState(null, "/tmp/config.json");
    const restarted = new WhatsAppController(restartedState, () => {}, {
      backendFactory: () => new FakeBackend(),
      authDirectory,
      cacheFile,
    });
    const restoredChannelId = whatsappChannelId("15551234567@s.whatsapp.net");

    expect(await restarted.restoreCachedChannel(restoredChannelId)).toBe(true);
    expect(restartedState.whatsapp.chatsById["15551234567@s.whatsapp.net"]?.name).toBe("Cached person");
    expect(restartedState.whatsapp.messagesByChatId["15551234567@s.whatsapp.net"]?.[0]?.content)
      .toEqual({ kind: "text", text: "cached hello" });
    expect(restartedState.timeline.channelId).toBe(restoredChannelId);
    expect(restartedState.timeline.messages[0]?.content).toBe("cached hello");
    await restarted.shutdown();
  });
});
