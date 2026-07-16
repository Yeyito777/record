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
  sentExpirations: Array<number | undefined> = [];
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

  async markRead(): Promise<void> {
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

function fixture() {
  const state = createInitialState(null, "/tmp/config.json");
  const backend = new FakeBackend();
  let renders = 0;
  const authDirectory = join(mkdtempSync(join(tmpdir(), "record-wa-controller-")), "auth");
  const controller = new WhatsAppController(state, () => { renders += 1; }, {
    backendFactory: () => backend,
    authDirectory,
    successModalDelayMs: 0,
  });
  return { state, backend, controller, renders: () => renders };
}

describe("WhatsApp controller", () => {
  test("drives the QR modal from backend events and cancels without Discord auth", () => {
    const { state, backend, controller, renders } = fixture();

    controller.login();
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

    expect(controller.sendText("hello")).toBe(true);
    expect(state.timeline.messages.at(-1)?.localStatus).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(backend.sentTexts).toEqual(["hello"]);
    expect(backend.sentExpirations).toEqual([86_400]);
    expect(state.timeline.messages.at(-1)).toMatchObject({ id: "sent-1", content: "hello" });
  });

  test("keeps a live unread notification when the cached chat count was zero", () => {
    const { state, backend } = fixture();
    const jid = "15551234567@s.whatsapp.net";
    backend.emit("chats", { kind: "upsert", chats: [{ id: jid, kind: "direct", name: "Mom", unreadCount: 0 }] });
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
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(restartedState.whatsapp.chatsById["15551234567@s.whatsapp.net"]?.name).toBe("Cached person");
    expect(restartedState.whatsapp.messagesByChatId["15551234567@s.whatsapp.net"]?.[0]?.content)
      .toEqual({ kind: "text", text: "cached hello" });
    await restarted.shutdown();
  });
});
