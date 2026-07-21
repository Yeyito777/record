import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type BaileysEventMap,
  type ConnectionState as BaileysConnectionState,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";

import {
  loadSecureWhatsAppAuthState,
  type WhatsAppAuthStateBundle,
  type WhatsAppAuthStateLoader,
} from "./auth";
import {
  toWhatsAppChat,
  toWhatsAppContact,
  toWhatsAppEphemeralChatPatch,
  toWhatsAppHistorySyncKind,
  toWhatsAppMessage,
  toWhatsAppMessageUpdate,
  toWhatsAppReactionEvent,
} from "./converters";
import { getRecordWhatsAppPaths } from "./paths";
import { sanitizeTerminalLabel } from "./sanitize";
import type {
  WhatsAppAccount,
  WhatsAppBackendCallbacks,
  WhatsAppBackendErrorEvent,
  WhatsAppBackendEventListener,
  WhatsAppBackendEventMap,
  WhatsAppBackendEventName,
  WhatsAppConnectionState,
  WhatsAppDisconnect,
  WhatsAppLoginResult,
  WhatsAppChat,
  WhatsAppMessage,
} from "./types";

function mergeMessageChatSettings(chats: WhatsAppChat[], messages: readonly WAMessage[]): WhatsAppChat[] {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  for (const message of messages) {
    const patch = toWhatsAppEphemeralChatPatch(message);
    if (!patch) continue;
    byId.set(patch.id, { ...(byId.get(patch.id) ?? {}), ...patch });
  }
  return [...byId.values()];
}

export interface WhatsAppReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  /** Proportion in [0, 1], applied symmetrically around the exponential delay. */
  jitterRatio: number;
}

export interface WhatsAppTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  random(): number;
}

export type WhatsAppSocketFactory = (config: UserFacingSocketConfig) => WASocket;
export type WhatsAppWebVersion = Awaited<ReturnType<typeof fetchLatestWaWebVersion>>["version"];
export type WhatsAppVersionFetcher = () => Promise<WhatsAppWebVersion | undefined>;

export interface RecordWhatsAppBackendOptions {
  authDirectory?: string;
  authLoader?: WhatsAppAuthStateLoader;
  socketFactory?: WhatsAppSocketFactory;
  versionFetcher?: WhatsAppVersionFetcher;
  timers?: WhatsAppTimers;
  reconnect?: Partial<WhatsAppReconnectPolicy>;
  callbacks?: WhatsAppBackendCallbacks;
  /** Additional non-secret Baileys options; auth and logging are always overridden. */
  socketConfig?: Omit<Partial<UserFacingSocketConfig>, "auth" | "logger" | "printQRInTerminal">;
}

export interface StartWhatsAppLoginOptions {
  signal?: AbortSignal;
}

const DEFAULT_RECONNECT_POLICY: WhatsAppReconnectPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 8,
  jitterRatio: 0.2,
};

const defaultTimers: WhatsAppTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  random: () => Math.random(),
};

// Baileys receives a permanently silent logger. In particular, QR payloads and
// auth metadata never pass through Record's debug logging infrastructure.
const silentBaileysLogger = pino({ level: "silent" });

interface ActiveSocket {
  id: number;
  generation: number;
  attempt: number;
  source: "login" | "saved-session" | "reconnect";
  socket: WASocket;
  removeListeners: Array<() => void>;
}

interface PendingLogin {
  promise: Promise<WhatsAppLoginResult>;
  resolve: (result: WhatsAppLoginResult) => void;
  settled: boolean;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

type UntypedListener = (event: unknown) => void | Promise<void>;

export function calculateReconnectDelay(
  attempt: number,
  policy: WhatsAppReconnectPolicy,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Reconnect attempt must be a positive integer.");
  }
  validateReconnectPolicy(policy);

  const exponent = Math.min(attempt - 1, 30);
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * (2 ** exponent));
  const unit = Math.min(1, Math.max(0, random()));
  const factor = 1 - policy.jitterRatio + (2 * policy.jitterRatio * unit);
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(base * factor)));
}

export function disconnectFromError(error: unknown): WhatsAppDisconnect {
  const candidate = error as {
    output?: { statusCode?: unknown };
    data?: { statusCode?: unknown };
    statusCode?: unknown;
  } | null | undefined;
  const rawCode = candidate?.output?.statusCode ?? candidate?.data?.statusCode ?? candidate?.statusCode;
  const numericCode = rawCode == null
    ? Number.NaN
    : typeof rawCode === "number" ? rawCode : Number(rawCode);
  const code = Number.isFinite(numericCode) ? numericCode : null;
  const name = code == null
    ? null
    : (DisconnectReason as unknown as Record<number, string>)[code] ?? null;
  return { code, name };
}

function validateReconnectPolicy(policy: WhatsAppReconnectPolicy): void {
  if (!Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0) {
    throw new Error("initialDelayMs must be a non-negative finite number.");
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs) {
    throw new Error("maxDelayMs must be finite and at least initialDelayMs.");
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 0) {
    throw new Error("maxAttempts must be a non-negative integer.");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new Error("jitterRatio must be between 0 and 1.");
  }
}

function hasSavedSession(auth: WhatsAppAuthStateBundle): boolean {
  const creds = auth.state.creds;
  return Boolean(creds.registered || creds.me?.id || creds.me?.lid);
}

function accountFromSocket(socket: WASocket): WhatsAppAccount | undefined {
  if (!socket.user?.id) return undefined;
  const account: WhatsAppAccount = { id: socket.user.id };
  if (socket.user.lid) account.lid = socket.user.lid;
  if (socket.user.phoneNumber) account.phoneId = socket.user.phoneNumber;
  if (socket.user.name) account.name = sanitizeTerminalLabel(socket.user.name);
  return account;
}

function createPendingLogin(): PendingLogin {
  let resolve!: (result: WhatsAppLoginResult) => void;
  const promise = new Promise<WhatsAppLoginResult>((done) => {
    resolve = done;
  });
  return { promise, resolve, settled: false };
}

export class RecordWhatsAppBackend {
  private readonly authDirectory: string;
  private readonly authLoader: WhatsAppAuthStateLoader;
  private readonly socketFactory: WhatsAppSocketFactory;
  private readonly versionFetcher: WhatsAppVersionFetcher;
  private readonly timers: WhatsAppTimers;
  private readonly reconnectPolicy: WhatsAppReconnectPolicy;
  private readonly socketConfig: RecordWhatsAppBackendOptions["socketConfig"];
  private readonly listeners = new Map<WhatsAppBackendEventName, Set<UntypedListener>>();

  private currentState: WhatsAppConnectionState = { status: "idle" };
  private auth: WhatsAppAuthStateBundle | null = null;
  private activeSocket: ActiveSocket | null = null;
  private reconnectTimer: unknown | null = null;
  private reconnectAttempts = 0;
  private socketSequence = 0;
  private generation = 0;
  private running = false;
  private stopped = false;
  private initialSavedSession = false;
  private pendingLogin: PendingLogin | null = null;
  private credentialWrites: Promise<void> = Promise.resolve();
  private credentialWriteFailure: unknown | null = null;
  private webVersion: WhatsAppWebVersion | undefined;
  private finalizingSocketId: number | null = null;

  constructor(options: RecordWhatsAppBackendOptions = {}) {
    this.authDirectory = options.authDirectory ?? getRecordWhatsAppPaths().authDirectory;
    this.authLoader = options.authLoader ?? loadSecureWhatsAppAuthState;
    this.socketFactory = options.socketFactory ?? makeWASocket;
    this.versionFetcher = options.versionFetcher ?? (async () => {
      const latest = await fetchLatestWaWebVersion({});
      return latest.version;
    });
    this.timers = options.timers ?? defaultTimers;
    this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...options.reconnect };
    this.socketConfig = options.socketConfig;
    validateReconnectPolicy(this.reconnectPolicy);
    this.installCallbacks(options.callbacks);
  }

  get state(): WhatsAppConnectionState {
    return this.currentState;
  }

  get isConnected(): boolean {
    return this.currentState.status === "connected";
  }

  /** The live Baileys socket for later send/read/media operations. */
  getSocket(): WASocket {
    if (!this.activeSocket || this.currentState.status !== "connected") {
      throw new Error("WhatsApp is not connected.");
    }
    return this.activeSocket.socket;
  }

  on<K extends WhatsAppBackendEventName>(
    event: K,
    listener: WhatsAppBackendEventListener<K>,
  ): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as UntypedListener);
    return () => listeners?.delete(listener as UntypedListener);
  }

  /**
   * Starts either a fresh QR login or the saved Record session. The promise
   * settles at the first connected or terminal state; reconnection after a
   * successful login remains owned by this backend.
   */
  startLogin(options: StartWhatsAppLoginOptions = {}): Promise<WhatsAppLoginResult> {
    if (this.stopped) return Promise.resolve({ status: "stopped" });
    if (this.pendingLogin) return this.pendingLogin.promise;
    if (this.currentState.status === "connected") {
      return Promise.resolve({
        status: "connected",
        resumed: this.currentState.resumed,
        account: this.currentState.account,
      });
    }
    if (this.running) {
      return Promise.reject(new Error("WhatsApp backend is already running; observe its state events."));
    }

    this.running = true;
    this.reconnectAttempts = 0;
    const generation = ++this.generation;
    const pending = createPendingLogin();
    this.pendingLogin = pending;
    this.setState({ status: "loading-auth" });

    if (options.signal) {
      pending.abortSignal = options.signal;
      pending.abortListener = () => this.cancelLogin();
      if (options.signal.aborted) {
        this.cancelLogin();
        return pending.promise;
      }
      options.signal.addEventListener("abort", pending.abortListener, { once: true });
    }

    void this.initialize(generation);
    return pending.promise;
  }

  /** Cancels only a not-yet-completed login. It never logs out a connected session. */
  cancelLogin(): boolean {
    if (!this.pendingLogin || this.pendingLogin.settled) return false;
    ++this.generation;
    this.running = false;
    this.clearReconnectTimer();
    this.disposeActiveSocket(true);
    this.setState({ status: "cancelled" });
    this.settleLogin({ status: "cancelled" });
    return true;
  }

  /** Stops reconnects and closes the socket without logging the linked device out. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    ++this.generation;
    this.clearReconnectTimer();
    this.disposeActiveSocket(true);
    await this.credentialWrites;
    if (this.credentialWriteFailure) throw this.credentialWriteFailure;
    this.setState({ status: "stopped" });
    this.settleLogin({ status: "stopped" });
    this.listeners.clear();
  }

  private installCallbacks(callbacks?: WhatsAppBackendCallbacks): void {
    if (!callbacks) return;
    if (callbacks.onStateChange) this.on("state", callbacks.onStateChange);
    if (callbacks.onQr) this.on("qr", callbacks.onQr);
    if (callbacks.onHistory) this.on("history", callbacks.onHistory);
    if (callbacks.onMessages) this.on("messages", callbacks.onMessages);
    if (callbacks.onReactions) this.on("reactions", callbacks.onReactions);
    if (callbacks.onChats) this.on("chats", callbacks.onChats);
    if (callbacks.onContacts) this.on("contacts", callbacks.onContacts);
    if (callbacks.onLidMapping) this.on("lid-mapping", callbacks.onLidMapping);
    if (callbacks.onError) this.on("error", callbacks.onError);
  }

  private async initialize(generation: number): Promise<void> {
    try {
      // A previous run may still be finishing a secure credential write.
      await this.credentialWrites;
      const [auth, webVersion] = await Promise.all([
        this.authLoader(this.authDirectory),
        this.versionFetcher().catch(() => undefined),
      ]);
      if (!this.isCurrentGeneration(generation)) return;
      this.auth = auth;
      this.webVersion = webVersion;
      this.initialSavedSession = hasSavedSession(auth);
      this.openSocket(generation, this.initialSavedSession ? "saved-session" : "login", 0);
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return;
      this.reportError({ phase: "auth", error, recoverable: false });
      this.failRun(error);
    }
  }

  private openSocket(
    generation: number,
    source: ActiveSocket["source"],
    attempt: number,
  ): void {
    if (!this.isCurrentGeneration(generation) || !this.auth) return;
    this.clearReconnectTimer();
    this.disposeActiveSocket(true);
    this.setState({ status: "connecting", source, attempt });

    let socket: WASocket;
    try {
      socket = this.socketFactory({
        ...this.socketConfig,
        auth: {
          creds: this.auth.state.creds,
          keys: makeCacheableSignalKeyStore(this.auth.state.keys, silentBaileysLogger),
        },
        // Keep this stable across pairing and later resumes. Existing Record
        // credentials were linked as Chrome; changing the browser identity for
        // the same device causes WhatsApp to repeatedly close the stream (428).
        // Explicit on-demand paging handles history backfill independently.
        browser: this.socketConfig?.browser ?? Browsers.macOS("Chrome"),
        ...(this.webVersion ? { version: this.webVersion } : {}),
        syncFullHistory: this.socketConfig?.syncFullHistory ?? true,
        printQRInTerminal: false,
        logger: silentBaileysLogger,
      });
    } catch (error) {
      this.reportError({ phase: "socket", error, recoverable: true });
      this.scheduleReconnect(generation, { code: null, name: null }, false, error);
      return;
    }

    const active: ActiveSocket = {
      id: ++this.socketSequence,
      generation,
      attempt,
      source,
      socket,
      removeListeners: [],
    };
    this.activeSocket = active;
    this.bindSocketEvents(active);
  }

  private bindSocketEvents(active: ActiveSocket): void {
    this.bind(active, "connection.update", (update) => this.onConnectionUpdate(active, update));
    this.bind(active, "creds.update", () => {
      this.queueCredentialSave(active);
      this.showPairingAccepted(active);
    });

    this.bind(active, "messaging-history.set", (event) => {
      this.forwardSocketEvent(active, () => {
        const messages = event.messages.map((message) => toWhatsAppMessage(message, {
          selfId: active.socket.user?.id,
        }));
        const reactions = event.messages.map((message) => {
          const normalized = normalizeMessageContent(message.message);
          return normalized?.reactionMessage
            ? toWhatsAppReactionEvent(normalized.reactionMessage.key, {
                ...normalized.reactionMessage,
                key: message.key,
              }, active.socket.user?.id)
            : null;
        }).filter((reaction) => reaction !== null);
        const chats = mergeMessageChatSettings(
          event.chats.map(toWhatsAppChat).filter((chat) => chat !== null),
          event.messages,
        );
        this.emit("history", {
          chats,
          contacts: event.contacts.map(toWhatsAppContact).filter((contact) => contact !== null),
          messages: messages.filter((message) => message !== null),
          reactions,
          skippedMessages: messages.filter((message) => message === null).length,
          isLatest: event.isLatest,
          progress: event.progress,
          syncKind: toWhatsAppHistorySyncKind(event.syncType),
          requestId: event.peerDataRequestSessionId ?? undefined,
        });
      });
    });

    this.bind(active, "messages.upsert", (event) => {
      this.forwardSocketEvent(active, () => {
        const chatSettings = mergeMessageChatSettings([], event.messages);
        if (chatSettings.length > 0) {
          this.emit("chats", { kind: "update", chats: chatSettings });
        }
        const messages = event.messages.map((message) => toWhatsAppMessage(message, {
          selfId: active.socket.user?.id,
        }));
        this.emit("messages", {
          kind: "upsert",
          upsertType: event.type,
          messages: messages.filter((message) => message !== null),
          skippedMessages: messages.filter((message) => message === null).length,
          requestId: event.requestId,
        });
      });
    });

    this.bind(active, "messages.update", (event) => {
      this.forwardSocketEvent(active, () => {
        const messages = event.map((entry) => toWhatsAppMessageUpdate(entry, {
          selfId: active.socket.user?.id,
        }));
        const converted = messages.filter((message): message is WhatsAppMessage => (
          message !== null && message.content.kind !== "unsupported"
        ));
        if (converted.length === 0) return;
        this.emit("messages", {
          kind: "update",
          messages: converted,
          skippedMessages: messages.length - converted.length,
        });
      });
    });

    this.bind(active, "messages.reaction", (event) => {
      this.forwardSocketEvent(active, () => {
        const reactions = event.map((entry) => toWhatsAppReactionEvent(
          entry.key,
          entry.reaction,
          active.socket.user?.id,
        )).filter((reaction) => reaction !== null);
        if (reactions.length > 0) this.emit("reactions", reactions);
      });
    });

    this.bind(active, "chats.upsert", (chats) => {
      this.forwardSocketEvent(active, () => {
        this.emit("chats", {
          kind: "upsert",
          chats: chats.map(toWhatsAppChat).filter((chat) => chat !== null),
        });
      });
    });

    this.bind(active, "chats.update", (chats) => {
      this.forwardSocketEvent(active, () => {
        this.emit("chats", {
          kind: "update",
          chats: chats.map(toWhatsAppChat).filter((chat) => chat !== null),
        });
      });
    });

    this.bind(active, "contacts.upsert", (contacts) => {
      this.forwardSocketEvent(active, () => {
        this.emit("contacts", {
          kind: "upsert",
          contacts: contacts.map(toWhatsAppContact).filter((contact) => contact !== null),
        });
      });
    });

    this.bind(active, "contacts.update", (contacts) => {
      this.forwardSocketEvent(active, () => {
        this.emit("contacts", {
          kind: "update",
          contacts: contacts.map(toWhatsAppContact).filter((contact) => contact !== null),
        });
      });
    });

    this.bind(active, "lid-mapping.update", ({ lid, pn }) => {
      this.forwardSocketEvent(active, () => this.emit("lid-mapping", { lid, phoneId: pn }));
    });
  }

  private bind<K extends keyof BaileysEventMap>(
    active: ActiveSocket,
    event: K,
    listener: (payload: BaileysEventMap[K]) => void,
  ): void {
    active.socket.ev.on(event, listener);
    active.removeListeners.push(() => active.socket.ev.off(event, listener));
  }

  private onConnectionUpdate(active: ActiveSocket, update: Partial<BaileysConnectionState>): void {
    if (!this.isCurrentSocket(active)) return;

    if (update.connection === "close") {
      this.onSocketClosed(active, disconnectFromError(update.lastDisconnect?.error));
      return;
    }

    if (update.connection === "open") {
      if (this.finalizingSocketId !== active.id) {
        this.finalizingSocketId = active.id;
        void this.finalizeConnectedSocket(active);
      }
      return;
    }

    if (update.connection === "connecting") {
      this.setState({ status: "connecting", source: active.source, attempt: active.attempt });
    }

    if (update.qr) {
      this.setState({ status: "awaiting-qr", attempt: active.attempt });
      this.emit("qr", { qr: update.qr, issuedAtMs: this.timers.now() });
    }
  }

  private onSocketClosed(active: ActiveSocket, disconnect: WhatsAppDisconnect): void {
    if (!this.isCurrentSocket(active)) return;
    this.disposeActiveSocket(false);
    if (!this.isCurrentGeneration(active.generation)) return;

    if (disconnect.code === DisconnectReason.loggedOut) {
      this.running = false;
      this.setState({ status: "logged-out", disconnect });
      this.settleLogin({ status: "logged-out", disconnect });
      return;
    }

    if (disconnect.code === DisconnectReason.connectionReplaced) {
      this.running = false;
      this.setState({ status: "connection-replaced", disconnect });
      this.settleLogin({ status: "connection-replaced", disconnect });
      return;
    }

    // 515 is Baileys' expected post-pairing stream restart. Recreate the socket
    // immediately using the just-updated in-memory auth state, but still count
    // it against the bounded retry budget to prevent a pathological hot loop.
    const restartRequired = disconnect.code === DisconnectReason.restartRequired || disconnect.code === 515;
    this.scheduleReconnect(active.generation, disconnect, restartRequired);
  }

  private scheduleReconnect(
    generation: number,
    disconnect: WhatsAppDisconnect,
    immediate: boolean,
    lastError?: unknown,
  ): void {
    if (!this.isCurrentGeneration(generation) || this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempts + 1;
    if (attempt > this.reconnectPolicy.maxAttempts) {
      const error = lastError ?? new Error(
        `WhatsApp reconnect limit reached${disconnect.code == null ? "" : ` (${disconnect.code})`}.`,
      );
      this.failRun(error, disconnect);
      return;
    }

    this.reconnectAttempts = attempt;
    const delayMs = immediate
      ? 0
      : calculateReconnectDelay(attempt, this.reconnectPolicy, () => this.timers.random());
    this.setState({ status: "reconnecting", attempt, delayMs, disconnect });
    const handle = this.timers.setTimeout(() => {
      if (this.reconnectTimer !== handle) return;
      this.reconnectTimer = null;
      this.openSocket(generation, "reconnect", attempt);
    }, delayMs);
    this.reconnectTimer = handle;
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      (handle as { unref?: () => void }).unref?.();
    }
  }

  private queueCredentialSave(active: ActiveSocket): void {
    if (!this.isCurrentSocket(active) || !this.auth) return;
    const generation = active.generation;
    const saveCreds = this.auth.saveCreds;
    this.credentialWrites = this.credentialWrites
      .then(async () => {
        try {
          await saveCreds();
        } catch (error) {
          this.credentialWriteFailure = error;
          throw error;
        }
      })
      .catch((error) => {
        if (this.isCurrentGeneration(generation)) {
          this.reportError({ phase: "auth", error, recoverable: true });
        }
      });
  }

  private showPairingAccepted(active: ActiveSocket): void {
    if (!this.isCurrentSocket(active) || !this.auth || this.initialSavedSession) return;
    if (this.currentState.status !== "awaiting-qr" || !hasSavedSession(this.auth)) return;
    // Baileys mutates the shared creds object before emitting creds.update. The
    // linked identity appearing there is the earliest reliable signal that the
    // phone accepted the QR, before the expected 515 stream restart arrives.
    this.setState({ status: "connecting", source: "login", attempt: active.attempt });
  }

  private async finalizeConnectedSocket(active: ActiveSocket): Promise<void> {
    if (!this.auth) return;
    const saveCreds = this.auth.saveCreds;
    const generation = active.generation;

    // Pairing is not successful until the linked identity is durably handed to
    // the auth store. Queue one final save behind every creds.update observed so
    // far; never close the QR modal early on a full disk or permission failure.
    const finalWrite = this.credentialWrites.then(saveCreds);
    this.credentialWrites = finalWrite.catch((error) => {
      this.credentialWriteFailure = error;
    });

    try {
      await finalWrite;
      if (!this.isCurrentSocket(active)) return;
      this.credentialWriteFailure = null;
      this.reconnectAttempts = 0;
      const account = accountFromSocket(active.socket);
      this.setState({
        status: "connected",
        resumed: this.initialSavedSession,
        connectedAtMs: this.timers.now(),
        account,
      });
      this.settleLogin({ status: "connected", resumed: this.initialSavedSession, account });
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return;
      this.reportError({ phase: "auth", error, recoverable: false });
      this.failRun(error);
    } finally {
      if (this.finalizingSocketId === active.id) this.finalizingSocketId = null;
    }
  }

  private forwardSocketEvent(active: ActiveSocket, forward: () => void): void {
    if (!this.isCurrentSocket(active)) return;
    try {
      forward();
    } catch (error) {
      this.reportError({ phase: "event", error, recoverable: true });
    }
  }

  private failRun(error: unknown, disconnect?: WhatsAppDisconnect): void {
    this.running = false;
    this.clearReconnectTimer();
    this.disposeActiveSocket(true);
    const state: WhatsAppConnectionState = { status: "failed", error, disconnect };
    this.setState(state);
    this.settleLogin({ status: "failed", error, disconnect });
  }

  private settleLogin(result: WhatsAppLoginResult): void {
    const pending = this.pendingLogin;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    this.pendingLogin = null;
    pending.resolve(result);
  }

  private setState(state: WhatsAppConnectionState): void {
    this.currentState = state;
    this.emit("state", state);
  }

  private emit<K extends WhatsAppBackendEventName>(event: K, payload: WhatsAppBackendEventMap[K]): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        const result = listener(payload);
        void Promise.resolve(result).catch((error) => {
          if (event !== "error") {
            this.reportError({ phase: "callback", error, recoverable: true });
          }
        });
      } catch (error) {
        if (event !== "error") {
          this.reportError({ phase: "callback", error, recoverable: true });
        }
      }
    }
  }

  private reportError(event: WhatsAppBackendErrorEvent): void {
    this.emit("error", event);
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.stopped && this.running && generation === this.generation;
  }

  private isCurrentSocket(active: ActiveSocket): boolean {
    return this.activeSocket === active &&
      active.generation === this.generation &&
      this.isCurrentGeneration(active.generation);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private disposeActiveSocket(end: boolean): void {
    const active = this.activeSocket;
    if (!active) return;
    if (this.finalizingSocketId === active.id) this.finalizingSocketId = null;
    this.activeSocket = null;
    for (const remove of active.removeListeners.splice(0)) {
      try { remove(); } catch { /* stale guards remain the final defense */ }
    }
    if (end) {
      try { active.socket.end(undefined); } catch { /* already closed */ }
    }
  }
}

export function createRecordWhatsAppBackend(
  options: RecordWhatsAppBackendOptions = {},
): RecordWhatsAppBackend {
  return new RecordWhatsAppBackend(options);
}
