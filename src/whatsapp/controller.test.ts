import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WHATSAPP_GUILD_ID, whatsappChannelId } from "../chatproviders";
import { createInitialState } from "../state";
import { WhatsAppController, type WhatsAppBackendHandle } from "./controller";
import type {
  WhatsAppBackendEventListener,
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppLoginResult,
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
  ) {
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
  ) {
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
    _message: import("./types").WhatsAppMessage,
    destinationPath: string,
  ): Promise<import("./worker-protocol").WhatsAppDownloadMediaResult> {
    return { path: destinationPath, sizeBytes: 0 };
  }

  async setChatMuted(chatId: string, muted: boolean): Promise<import("./worker-protocol").WhatsAppSetChatMutedResult> {
    this.muteRequests.push({ chatId, muted });
    if (this.muteError) throw this.muteError;
    return { mutedUntilMs: muted ? Date.now() + 7 * 24 * 60 * 60 * 1_000 : null };
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
    expect(state.whatsapp.chatsById[jid]?.mutedUntilMs).toBeGreaterThan(Date.now());
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(backend.sentImageBatches).toEqual([{ caption: "it's finished......", count: 2 }]);
    expect(state.timeline.messages.slice(-2).map((message) => [message.id, message.content])).toEqual([
      ["sent-image-1", "it's finished......"],
      ["sent-image-2", ""],
    ]);
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
