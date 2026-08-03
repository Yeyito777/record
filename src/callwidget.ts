/**
 * External X11 voice-call widget controller.
 *
 * The widget process is intentionally separate from the terminal UI so it can
 * float above the desktop and persist across dwm tag switches.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { debugLog } from "./debuglog";

export interface CallWidgetParticipant {
  id: string;
  name: string;
  avatarUrl: string;
  /** CSS hex text color for this participant (role color in guilds, deterministic user color in DMs). */
  textColor?: string | null;
  speaking: boolean;
  muted?: boolean;
  localMuted?: boolean;
  deafened?: boolean;
  self: boolean;
}

export interface CallWidgetControllerOptions {
  command?: string[];
  disabled?: boolean;
  avatarCacheDir?: string;
  fetchAvatar?: typeof fetch;
}

type WidgetProcess = ReturnType<typeof Bun.spawn>;

const RUN_WIDGET_PATH = fileURLToPath(new URL("../scripts/run-call-widget", import.meta.url));
const DEFAULT_WIDGET_COMMAND = buildCallWidgetCommand(RUN_WIDGET_PATH);
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const AVATAR_RETRY_DELAY_MS = 30_000;

export function buildCallWidgetCommand(widgetPath = RUN_WIDGET_PATH): string[] {
  return [widgetPath];
}

export function defaultDiscordAvatarIndex(userId: string, discriminator?: string | null): number {
  if (discriminator && discriminator !== "0" && /^\d+$/.test(discriminator)) {
    return Number(discriminator) % 5;
  }
  try {
    return Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    return 0;
  }
}

export function discordAvatarUrl(userId: string, avatarHash: string | null | undefined, discriminator?: string | null): string {
  if (avatarHash) {
    const extension = avatarHash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=128`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${defaultDiscordAvatarIndex(userId, discriminator)}.png`;
}

export function isDefaultDiscordAvatarUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/.test(url);
}

export function callWidgetAvatarKind(url: string | null | undefined): "custom" | "default" | "empty" {
  if (!url) return "empty";
  return isDefaultDiscordAvatarUrl(url) ? "default" : "custom";
}

export function callWidgetAvatarCacheDir(): string {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(root, "record", "call-widget-c");
}

/** Match the native widget's stable FNV-1a cache names so existing images remain useful. */
export function callWidgetAvatarCachePath(url: string, cacheDir = callWidgetAvatarCacheDir()): string {
  let hash = 1469598103934665603n;
  for (const byte of new TextEncoder().encode(url)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return join(cacheDir, `avatar-${hash.toString(16).padStart(16, "0")}.img`);
}

export function isCallWidgetAvatarImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || bytes.length > MAX_AVATAR_BYTES) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const gif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return png || gif || jpeg || webp;
}

export function cachedCallWidgetAvatarPath(url: string, cacheDir = callWidgetAvatarCacheDir()): string | null {
  const path = callWidgetAvatarCachePath(url, cacheDir);
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size < 12 || size > MAX_AVATAR_BYTES) return null;
    fd = openSync(path, "r");
    const header = Buffer.alloc(16);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return isCallWidgetAvatarImage(header.subarray(0, bytesRead)) ? path : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export async function cacheCallWidgetAvatar(
  url: string,
  options: { cacheDir?: string; fetchAvatar?: typeof fetch } = {},
): Promise<string | null> {
  const cacheDir = options.cacheDir ?? callWidgetAvatarCacheDir();
  const existing = cachedCallWidgetAvatarPath(url, cacheDir);
  if (existing) return existing;

  const path = callWidgetAvatarCachePath(url, cacheDir);
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const response = await (options.fetchAvatar ?? globalThis.fetch)(url, {
      headers: { "User-Agent": "record-call-widget/0.1" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isCallWidgetAvatarImage(bytes)) return null;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, path);
    return path;
  } catch {
    return null;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export function stabilizeCallWidgetParticipantAvatars(
  participants: readonly CallWidgetParticipant[],
  knownCustomAvatarUrlsByUserId: Map<string, string>,
): CallWidgetParticipant[] {
  let changed = false;
  const stable = participants.map((participant) => {
    const kind = callWidgetAvatarKind(participant.avatarUrl);
    if (kind === "custom") {
      knownCustomAvatarUrlsByUserId.set(participant.id, participant.avatarUrl);
      return participant;
    }
    const remembered = knownCustomAvatarUrlsByUserId.get(participant.id);
    if (!remembered) return participant;
    changed = true;
    return { ...participant, avatarUrl: remembered };
  });
  return changed ? stable : [...participants];
}

export class CallWidgetController {
  private proc: WidgetProcess | null = null;
  private closed = false;
  private readonly knownCustomAvatarUrlsByUserId = new Map<string, string>();
  private readonly avatarPathsByUrl = new Map<string, string>();
  private readonly avatarLoadsByUrl = new Map<string, Promise<string | null>>();
  private readonly avatarRetryAfterByUrl = new Map<string, number>();
  private latestParticipants: CallWidgetParticipant[] = [];

  constructor(private readonly options: CallWidgetControllerOptions = {}) {}

  update(participants: readonly CallWidgetParticipant[]): void {
    if (this.options.disabled || process.env.RECORD_DISABLE_CALL_WIDGET === "1") return;
    if (participants.length === 0) {
      this.stop();
      return;
    }
    const proc = this.ensureProcess();
    if (!proc) return;
    const stableParticipants = stabilizeCallWidgetParticipantAvatars(participants, this.knownCustomAvatarUrlsByUserId);
    this.latestParticipants = stableParticipants;
    const stabilized = stableParticipants
      .filter((participant, index) => participant.avatarUrl !== participants[index]?.avatarUrl)
      .map((participant) => ({ id: participant.id, name: participant.name }));
    if (stabilized.length > 0) debugLog("call.widget.avatar_stabilized", { participants: stabilized });
    this.writeCurrentParticipants();
    for (const participant of stableParticipants) this.ensureAvatar(participant.avatarUrl);
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.closed = true;
    this.latestParticipants = [];
    this.knownCustomAvatarUrlsByUserId.clear();
    if (!proc) return;
    try {
      writeProcessStdin(proc, `${JSON.stringify({ type: "close" })}\n`);
      endProcessStdin(proc);
    } catch {
      // Fall through to best-effort kill.
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // Best-effort stop.
    }
    debugLog("call.widget.stop", {});
  }

  private ensureProcess(): WidgetProcess | null {
    if (this.proc) return this.proc;
    const command = this.options.command ?? DEFAULT_WIDGET_COMMAND;
    const executablePath = command[0];
    if (command.length === 0 || !executablePath || !existsSync(executablePath)) {
      debugLog("call.widget.skipped", { reason: "missing_widget", command });
      return null;
    }
    try {
      this.closed = false;
      const proc = Bun.spawn(command, {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      this.proc = proc;
      void drainWidgetStderr(proc);
      void proc.exited.then((code) => {
        if (this.proc === proc) this.proc = null;
        debugLog("call.widget.exit", { code, closed: this.closed });
      }).catch((error) => {
        if (this.proc === proc) this.proc = null;
        debugLog("call.widget.exit_failed", { error: error instanceof Error ? error.message : String(error) });
      });
      debugLog("call.widget.start", { command });
      return proc;
    } catch (error) {
      debugLog("call.widget.start_failed", { command, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private write(payload: unknown): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      writeProcessStdin(proc, `${JSON.stringify(payload)}\n`);
      const participants = Array.isArray((payload as { participants?: unknown }).participants)
        ? ((payload as { participants: unknown[] }).participants)
        : null;
      debugLog("call.widget.update", {
        participants: participants ? participants.length : null,
        speaking: participants
          ? participants
              .filter((participant): participant is { id?: unknown; name?: unknown; speaking?: unknown } => Boolean(participant) && typeof participant === "object" && Boolean((participant as { speaking?: unknown }).speaking))
              .map((participant) => ({ id: String(participant.id ?? ""), name: String(participant.name ?? "") }))
          : [],
        avatars: participants
          ? participants
              .filter((participant): participant is { id?: unknown; name?: unknown; avatarUrl?: unknown } => Boolean(participant) && typeof participant === "object")
              .map((participant) => ({
                id: String(participant.id ?? ""),
                name: String(participant.name ?? ""),
                kind: callWidgetAvatarKind(typeof participant.avatarUrl === "string" ? participant.avatarUrl : null),
              }))
          : [],
      });
    } catch (error) {
      debugLog("call.widget.write_failed", { error: error instanceof Error ? error.message : String(error) });
      this.proc = null;
      try { proc.kill("SIGTERM"); } catch {}
    }
  }

  private writeCurrentParticipants(): void {
    this.write({
      type: "update",
      participants: this.latestParticipants.map((participant) => ({
        ...participant,
        avatarPath: this.avatarPath(participant.avatarUrl),
      })),
    });
  }

  private avatarPath(url: string): string | null {
    const remembered = this.avatarPathsByUrl.get(url);
    if (remembered && existsSync(remembered)) return remembered;
    if (remembered) this.avatarPathsByUrl.delete(url);
    const cached = cachedCallWidgetAvatarPath(url, this.options.avatarCacheDir);
    if (cached) this.avatarPathsByUrl.set(url, cached);
    return cached;
  }

  private ensureAvatar(url: string): void {
    if (!url || this.avatarPathsByUrl.has(url) || this.avatarLoadsByUrl.has(url)) return;
    if ((this.avatarRetryAfterByUrl.get(url) ?? 0) > Date.now()) return;
    const cached = cachedCallWidgetAvatarPath(url, this.options.avatarCacheDir);
    if (cached) {
      this.avatarPathsByUrl.set(url, cached);
      return;
    }

    const load = cacheCallWidgetAvatar(url, {
      cacheDir: this.options.avatarCacheDir,
      fetchAvatar: this.options.fetchAvatar,
    });
    this.avatarLoadsByUrl.set(url, load);
    void load.then((path) => {
      if (!path) {
        this.avatarRetryAfterByUrl.set(url, Date.now() + AVATAR_RETRY_DELAY_MS);
        for (const [userId, rememberedUrl] of this.knownCustomAvatarUrlsByUserId) {
          if (rememberedUrl === url) this.knownCustomAvatarUrlsByUserId.delete(userId);
        }
        debugLog("call.widget.avatar_failed", { kind: callWidgetAvatarKind(url) });
        return;
      }
      this.avatarRetryAfterByUrl.delete(url);
      this.avatarPathsByUrl.set(url, path);
      if (this.proc && this.latestParticipants.some((participant) => participant.avatarUrl === url)) {
        this.writeCurrentParticipants();
      }
    }).finally(() => {
      if (this.avatarLoadsByUrl.get(url) === load) this.avatarLoadsByUrl.delete(url);
    });
  }
}

function writeProcessStdin(proc: WidgetProcess, text: string): void {
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") return;
  stdin.write(text);
  stdin.flush?.();
}

function endProcessStdin(proc: WidgetProcess): void {
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") return;
  stdin.end();
}

async function drainWidgetStderr(proc: WidgetProcess): Promise<void> {
  const stderr = proc.stderr;
  if (!stderr || typeof stderr === "number") return;
  try {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value).trim();
      if (text) debugLog("call.widget.stderr", { text });
    }
  } catch (error) {
    debugLog("call.widget.stderr_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}
