import { describe, expect, test } from "bun:test";
import {
  DisconnectReason,
  type AuthenticationState,
  type BaileysEventMap,
  type SignalKeyStore,
  type UserFacingSocketConfig,
  type WASocket,
} from "@whiskeysockets/baileys";

import {
  RecordWhatsAppBackend,
  calculateReconnectDelay,
  type WhatsAppTimers,
} from "./backend";
import type { WhatsAppAuthStateBundle } from "./auth";
import type { WhatsAppBackendEventMap, WhatsAppConnectionState } from "./types";

type EventCallback = (payload: unknown) => void;

class MockBaileysEmitter {
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly historicalListeners = new Map<string, EventCallback[]>();

  on(event: string, listener: EventCallback): void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    const history = this.historicalListeners.get(event) ?? [];
    history.push(listener);
    this.historicalListeners.set(event, history);
  }

  off(event: string, listener: EventCallback): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof BaileysEventMap>(event: K, payload: BaileysEventMap[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  emitHistorical<K extends keyof BaileysEventMap>(
    event: K,
    listenerIndex: number,
    payload: BaileysEventMap[K],
  ): void {
    this.historicalListeners.get(event)?.[listenerIndex]?.(payload);
  }
}

interface MockSocket {
  socket: WASocket;
  emitter: MockBaileysEmitter;
  endCalls: number;
}

function mockSocket(user?: { id: string; lid?: string; name?: string }): MockSocket {
  const emitter = new MockBaileysEmitter();
  const mock: MockSocket = {
    socket: undefined as unknown as WASocket,
    emitter,
    endCalls: 0,
  };
  mock.socket = {
    ev: emitter,
    user,
    end: () => { mock.endCalls += 1; },
  } as unknown as WASocket;
  return mock;
}

class FakeTimers implements WhatsAppTimers {
  nowValue = 1_725_000_000_000;
  randomValue = 0.5;
  readonly scheduled: Array<{
    handle: object;
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];

  setTimeout(callback: () => void, delayMs: number): object {
    const timer = { handle: {}, callback, delayMs, cancelled: false };
    this.scheduled.push(timer);
    return timer.handle;
  }

  clearTimeout(handle: unknown): void {
    const timer = this.scheduled.find((candidate) => candidate.handle === handle);
    if (timer) timer.cancelled = true;
  }

  now(): number { return this.nowValue; }
  random(): number { return this.randomValue; }

  runNext(): void {
    const timer = this.scheduled.find((candidate) => !candidate.cancelled);
    if (!timer) throw new Error("No scheduled timer");
    timer.cancelled = true;
    timer.callback();
  }
}

function authBundle(saved = false, saveCreds: () => Promise<void> = async () => {}): WhatsAppAuthStateBundle {
  const keys: SignalKeyStore = {
    get: async () => ({}),
    set: async () => {},
  };
  return {
    state: {
      creds: {
        registered: saved,
        me: saved ? { id: "15550001:1@s.whatsapp.net", lid: "opaque:1@lid", name: "Saved" } : undefined,
      },
      keys,
    } as AuthenticationState,
    saveCreds,
  };
}

function closeUpdate(code: number): BaileysEventMap["connection.update"] {
  return {
    connection: "close",
    lastDisconnect: {
      error: { output: { statusCode: code } } as unknown as Error,
      date: new Date(0),
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setup(
  saved = false,
  reconnect: Record<string, number> = {},
  saveCreds: () => Promise<void> = async () => {},
) {
  const sockets: MockSocket[] = [];
  const configs: UserFacingSocketConfig[] = [];
  const timers = new FakeTimers();
  const auth = authBundle(saved, saveCreds);
  const backend = new RecordWhatsAppBackend({
    authDirectory: "/test/record/whatsapp/auth",
    authLoader: async () => auth,
    versionFetcher: async () => [2, 3000, 1],
    socketFactory: (config) => {
      configs.push(config);
      const socket = mockSocket({ id: "15550001:1@s.whatsapp.net", lid: "opaque:1@lid", name: "Ada" });
      sockets.push(socket);
      return socket.socket;
    },
    timers,
    reconnect,
  });
  return { backend, sockets, configs, timers, auth };
}

describe("RecordWhatsAppBackend", () => {
  test("runs a fresh QR login without retaining the QR in connection state", async () => {
    const { backend, sockets, configs } = setup(false);
    const states: WhatsAppConnectionState[] = [];
    const qrEvents: string[] = [];
    backend.on("state", (state) => { states.push(state); });
    backend.on("qr", ({ qr }) => { qrEvents.push(qr); });

    const resultPromise = backend.startLogin();
    await flushPromises();
    expect(sockets).toHaveLength(1);
    expect(backend.state).toEqual({ status: "connecting", source: "login", attempt: 0 });
    expect(configs[0].printQRInTerminal).toBe(false);
    expect(configs[0].syncFullHistory).toBe(true);
    expect(configs[0].version).toEqual([2, 3000, 1]);
    expect(configs[0].browser).toEqual(["Mac OS", "Chrome", "14.4.1"]);

    sockets[0].emitter.emit("connection.update", { qr: "sensitive-qr" });
    expect(qrEvents).toEqual(["sensitive-qr"]);
    expect(backend.state).toEqual({ status: "awaiting-qr", attempt: 0 });
    expect(JSON.stringify(backend.state)).not.toContain("sensitive-qr");

    sockets[0].emitter.emit("connection.update", { connection: "open" });
    expect(await resultPromise).toEqual({
      status: "connected",
      resumed: false,
      account: {
        id: "15550001:1@s.whatsapp.net",
        lid: "opaque:1@lid",
        name: "Ada",
      },
    });
    expect(backend.isConnected).toBe(true);
    expect(backend.getSocket()).toBe(sockets[0].socket);
    expect(states.some((state) => state.status === "loading-auth")).toBe(true);
  });

  test("reports that the phone accepted a fresh QR as soon as paired creds appear", async () => {
    const { backend, sockets, auth } = setup(false);
    const states: WhatsAppConnectionState[] = [];
    backend.on("state", (state) => { states.push(state); });
    void backend.startLogin();
    await flushPromises();
    sockets[0].emitter.emit("connection.update", { qr: "sensitive-qr" });

    auth.state.creds.registered = true;
    auth.state.creds.me = { id: "15550001:1@s.whatsapp.net", name: "Ada" };
    sockets[0].emitter.emit("creds.update", {});
    await flushPromises();

    expect(backend.state).toEqual({ status: "connecting", source: "login", attempt: 0 });
    expect(states.at(-1)?.status).toBe("connecting");
  });

  test("resumes saved sessions, handles 515 immediately, backs off, and ignores stale sockets", async () => {
    const { backend, sockets, timers } = setup(true, {
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      maxAttempts: 4,
      jitterRatio: 0,
    });
    const qrEvents: string[] = [];
    backend.on("qr", ({ qr }) => { qrEvents.push(qr); });

    const login = backend.startLogin();
    await flushPromises();
    expect(backend.state).toEqual({ status: "connecting", source: "saved-session", attempt: 0 });
    sockets[0].emitter.emit("connection.update", { connection: "open" });
    expect((await login).status).toBe("connected");

    sockets[0].emitter.emit("connection.update", closeUpdate(515));
    expect(backend.state).toEqual({
      status: "reconnecting",
      attempt: 1,
      delayMs: 0,
      disconnect: { code: 515, name: "restartRequired" },
    });
    timers.runNext();
    expect(sockets).toHaveLength(2);

    sockets[0].emitter.emitHistorical("connection.update", 0, { qr: "stale-qr" });
    expect(qrEvents).toEqual([]);
    expect(backend.state).toEqual({ status: "connecting", source: "reconnect", attempt: 1 });

    sockets[1].emitter.emit("connection.update", { connection: "open" });
    await flushPromises();
    sockets[1].emitter.emit("connection.update", closeUpdate(DisconnectReason.connectionLost));
    expect(backend.state).toMatchObject({ status: "reconnecting", attempt: 1, delayMs: 1_000 });
    timers.runNext();
    expect(sockets).toHaveLength(3);
  });

  test("does not reconnect logged-out or replaced sessions", async () => {
    for (const [code, expected] of [
      [DisconnectReason.loggedOut, "logged-out"],
      [DisconnectReason.connectionReplaced, "connection-replaced"],
    ] as const) {
      const { backend, sockets, timers } = setup(false);
      const login = backend.startLogin();
      await flushPromises();
      sockets[0].emitter.emit("connection.update", closeUpdate(code));
      expect((await login).status).toBe(expected);
      expect(backend.state.status).toBe(expected);
      expect(timers.scheduled).toHaveLength(0);
    }
  });

  test("bounds reconnect attempts and settles an in-progress login as failed", async () => {
    const { backend, sockets, timers } = setup(false, {
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      maxAttempts: 1,
      jitterRatio: 0,
    });
    const login = backend.startLogin();
    await flushPromises();
    sockets[0].emitter.emit("connection.update", closeUpdate(DisconnectReason.connectionLost));
    timers.runNext();
    sockets[1].emitter.emit("connection.update", closeUpdate(DisconnectReason.connectionLost));

    expect((await login).status).toBe("failed");
    expect(backend.state).toMatchObject({
      status: "failed",
      disconnect: { code: DisconnectReason.connectionLost },
    });
  });

  test("supports AbortSignal cancellation and idempotent shutdown", async () => {
    const { backend, sockets } = setup(false);
    const abort = new AbortController();
    const login = backend.startLogin({ signal: abort.signal });
    await flushPromises();
    abort.abort();
    expect(await login).toEqual({ status: "cancelled" });
    expect(sockets[0].endCalls).toBe(1);
    sockets[0].emitter.emitHistorical("connection.update", 0, { connection: "open" });
    expect(backend.state).toEqual({ status: "cancelled" });

    await backend.shutdown();
    await backend.shutdown();
    expect(backend.state).toEqual({ status: "stopped" });
    expect(await backend.startLogin()).toEqual({ status: "stopped" });
  });

  test("forwards history, message, chat, contact, and LID events as domain data", async () => {
    const { backend, sockets } = setup(false);
    const received: string[] = [];
    backend.on("history", (event) => { received.push(`history:${event.messages[0]?.content.kind}`); });
    backend.on("messages", (event) => {
      received.push(event.kind === "upsert"
        ? `messages:${event.upsertType}:${event.messages[0]?.id}`
        : `messages:update:${event.messages[0]?.id}`);
    });
    backend.on("chats", (event) => { received.push(`chats:${event.kind}:${event.chats[0]?.kind}`); });
    backend.on("contacts", (event) => { received.push(`contacts:${event.kind}:${event.contacts[0]?.name}`); });
    backend.on("lid-mapping", (event) => { received.push(`lid:${event.lid}:${event.phoneId}`); });

    const login = backend.startLogin();
    await flushPromises();
    sockets[0].emitter.emit("connection.update", { connection: "open" });
    await login;
    const rawMessage = {
      key: { id: "m1", remoteJid: "person@s.whatsapp.net", fromMe: false },
      message: { conversation: "hello" },
      messageTimestamp: 123,
    } as BaileysEventMap["messages.upsert"]["messages"][number];

    sockets[0].emitter.emit("messaging-history.set", {
      chats: [{ id: "group@g.us" }],
      contacts: [{ id: "person@s.whatsapp.net", name: "Person" }],
      messages: [rawMessage],
      syncType: 0,
    });
    sockets[0].emitter.emit("messages.upsert", { messages: [rawMessage], type: "notify" });
    sockets[0].emitter.emit("chats.upsert", [{ id: "group@g.us" }]);
    sockets[0].emitter.emit("contacts.update", [{ id: "person@s.whatsapp.net", name: "Person" }]);
    sockets[0].emitter.emit("lid-mapping.update", { lid: "opaque@lid", pn: "person@s.whatsapp.net" });

    expect(received).toEqual([
      "history:text",
      "messages:notify:m1",
      "chats:upsert:group",
      "contacts:update:Person",
      "lid:opaque@lid:person@s.whatsapp.net",
    ]);
  });

  test("forwards message-level disappearing settings as chat patches", async () => {
    const { backend, sockets } = setup(false);
    const histories: WhatsAppBackendEventMap["history"][] = [];
    const chatEvents: WhatsAppBackendEventMap["chats"][] = [];
    const messageEvents: WhatsAppBackendEventMap["messages"][] = [];
    backend.on("history", (event) => { histories.push(event); });
    backend.on("chats", (event) => { chatEvents.push(event); });
    backend.on("messages", (event) => { messageEvents.push(event); });

    const login = backend.startLogin();
    await flushPromises();
    sockets[0].emitter.emit("connection.update", { connection: "open" });
    await login;

    const expiring = {
      key: { id: "temporary", remoteJid: "person@s.whatsapp.net", fromMe: false },
      message: { extendedTextMessage: { text: "temporary", contextInfo: { expiration: 86_400 } } },
      messageTimestamp: 123,
    } as BaileysEventMap["messages.upsert"]["messages"][number];
    sockets[0].emitter.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [expiring],
      syncType: 0,
    });

    expect(histories[0]?.chats).toEqual([{
      id: "person@s.whatsapp.net",
      kind: "direct",
      ephemeralExpirationSeconds: 86_400,
    }]);
    expect(histories[0]?.messages[0]?.content).toEqual({ kind: "text", text: "temporary" });

    const disabled = {
      key: { id: "setting", remoteJid: "group@g.us", fromMe: false },
      message: { protocolMessage: { type: 3, ephemeralExpiration: 0 } },
      messageTimestamp: 124,
    } as BaileysEventMap["messages.upsert"]["messages"][number];
    sockets[0].emitter.emit("messages.upsert", { messages: [disabled], type: "notify" });

    expect(chatEvents).toEqual([{
      kind: "update",
      chats: [{ id: "group@g.us", kind: "group", ephemeralExpirationSeconds: 0 }],
    }]);
    expect(messageEvents[0]).toMatchObject({ messages: [], skippedMessages: 1 });
  });

  test("forwards edits as message replacements instead of protocol placeholders", async () => {
    const { backend, sockets } = setup(false);
    const messageEvents: WhatsAppBackendEventMap["messages"][] = [];
    backend.on("messages", (event) => { messageEvents.push(event); });
    const login = backend.startLogin();
    await flushPromises();
    sockets[0].emitter.emit("connection.update", { connection: "open" });
    await login;

    sockets[0].emitter.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "edit-envelope", remoteJid: "person@s.whatsapp.net", fromMe: false },
        message: {
          protocolMessage: {
            type: 14,
            key: { id: "original", remoteJid: "person@s.whatsapp.net", fromMe: false },
            editedMessage: { conversation: "after" },
          },
        },
      }],
    });
    sockets[0].emitter.emit("messages.update", [{
      key: { id: "original", remoteJid: "person@s.whatsapp.net", fromMe: false },
      update: {
        message: { editedMessage: { message: { conversation: "after" } } },
        messageTimestamp: 200,
      },
    }]);

    expect(messageEvents[0]).toMatchObject({ kind: "upsert", messages: [], skippedMessages: 1 });
    expect(messageEvents[1]).toMatchObject({
      kind: "update",
      skippedMessages: 0,
      messages: [{
        id: "original",
        timestampMs: null,
        editedTimestampMs: 200_000,
        content: { kind: "text", text: "after" },
      }],
    });
  });

  test("does not report a linked session until credentials finish saving", async () => {
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
    const { backend, sockets } = setup(false, {}, async () => saveGate);
    let settled = false;
    const login = backend.startLogin().then((result) => {
      settled = true;
      return result;
    });
    await flushPromises();

    sockets[0].emitter.emit("connection.update", { connection: "open" });
    await flushPromises();
    expect(settled).toBe(false);
    expect(backend.state.status).toBe("connecting");

    finishSave();
    expect((await login).status).toBe("connected");
    expect(backend.state.status).toBe("connected");
  });

  test("treats a final credential persistence failure as a terminal login error", async () => {
    const persistenceError = new Error("disk full");
    const { backend, sockets } = setup(false, {}, async () => { throw persistenceError; });
    const errors: Array<{ recoverable: boolean; error: unknown }> = [];
    backend.on("error", (event) => { errors.push(event); });
    const login = backend.startLogin();
    await flushPromises();

    sockets[0].emitter.emit("connection.update", { connection: "open" });
    expect(await login).toMatchObject({ status: "failed", error: persistenceError });
    expect(backend.state).toMatchObject({ status: "failed", error: persistenceError });
    expect(errors.some((event) => !event.recoverable && event.error === persistenceError)).toBe(true);
    expect(sockets[0].endCalls).toBe(1);
  });
});

describe("calculateReconnectDelay", () => {
  test("uses bounded exponential backoff with symmetric jitter", () => {
    const policy = { initialDelayMs: 1_000, maxDelayMs: 5_000, maxAttempts: 10, jitterRatio: 0.2 };
    expect(calculateReconnectDelay(1, policy, () => 0)).toBe(800);
    expect(calculateReconnectDelay(2, policy, () => 0.5)).toBe(2_000);
    expect(calculateReconnectDelay(10, policy, () => 1)).toBe(5_000);
  });
});
