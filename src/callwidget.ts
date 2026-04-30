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
  /** CSS hex color for this participant's highest colored guild role, when known. */
  roleColor?: string | null;
  speaking: boolean;
  self: boolean;
}

export interface CallWidgetControllerOptions {
  command?: string[];
  disabled?: boolean;
}

type WidgetProcess = ReturnType<typeof Bun.spawn>;

const DEFAULT_WIDGET_COMMAND = ["python3", fileURLToPath(new URL("../scripts/record-call-widget.py", import.meta.url))];

export function buildCallWidgetCommand(scriptPath = DEFAULT_WIDGET_COMMAND[1]): string[] {
  return ["python3", scriptPath];
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

export class CallWidgetController {
  private proc: WidgetProcess | null = null;
  private closed = false;

  constructor(private readonly options: CallWidgetControllerOptions = {}) {}

  update(participants: readonly CallWidgetParticipant[]): void {
    if (this.options.disabled || process.env.RECORD_DISABLE_CALL_WIDGET === "1") return;
    if (participants.length === 0) {
      this.stop();
      return;
    }
    const proc = this.ensureProcess();
    if (!proc) return;
    this.write({ type: "update", participants });
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
    if (command.length === 0 || !existsSync(command[1] ?? "")) {
      debugLog("call.widget.skipped", { reason: "missing_script", command });
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
      debugLog("call.widget.update", {
        participants: Array.isArray((payload as { participants?: unknown }).participants)
          ? ((payload as { participants: unknown[] }).participants.length)
          : null,
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
