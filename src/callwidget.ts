/**
 * External X11 voice-call widget controller.
 *
 * The widget process is intentionally separate from the terminal UI so it can
 * float above the desktop and persist across dwm tag switches.
 */

import { existsSync } from "node:fs";
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
}

type WidgetProcess = ReturnType<typeof Bun.spawn>;

const RUN_WIDGET_PATH = fileURLToPath(new URL("../scripts/run-call-widget", import.meta.url));
const DEFAULT_WIDGET_COMMAND = buildCallWidgetCommand(RUN_WIDGET_PATH);

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
    const stabilized = stableParticipants
      .filter((participant, index) => participant.avatarUrl !== participants[index]?.avatarUrl)
      .map((participant) => ({ id: participant.id, name: participant.name }));
    if (stabilized.length > 0) debugLog("call.widget.avatar_stabilized", { participants: stabilized });
    this.write({ type: "update", participants: stableParticipants });
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.closed = true;
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
