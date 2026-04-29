/**
 * Local UI sound effects.
 *
 * The bundled files are Discord web client MP3 assets used for familiar voice
 * call feedback. Playback is best-effort and intentionally silent on failure.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { debugLog } from "./debuglog";

export type SoundEffect =
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "ringtone"
  | "callCalling"
  | "callJoin"
  | "callUserLeave"
  | "callLeave";

export interface SoundEffectPlaybackCommand {
  command: string;
  args: string[];
}

const SOUND_FILES: Record<SoundEffect, string> = {
  mute: "discord-mute.mp3",
  unmute: "discord-unmute.mp3",
  deafen: "discord-deafen.mp3",
  undeafen: "discord-undeafen.mp3",
  ringtone: "discord-call-ringing.mp3",
  callCalling: "discord-call-calling.mp3",
  callJoin: "discord-user-join.mp3",
  callUserLeave: "discord-user-leave.mp3",
  callLeave: "discord-disconnect.mp3",
};

const SOUND_DIR = fileURLToPath(new URL("../assets/sounds/", import.meta.url));
const COMMAND_AVAILABILITY = new Map<string, boolean>();

export function soundEffectPath(effect: SoundEffect): string {
  return `${SOUND_DIR}${SOUND_FILES[effect]}`;
}

export function buildPwPlaySoundEffectPlaybackArgs(path: string): string[] {
  return [
    "--media-role", "event",
    "--latency", "20ms",
    path,
  ];
}

export function buildPaplaySoundEffectPlaybackArgs(path: string): string[] {
  return [
    "--client-name=Record",
    "--stream-name=Record sound effect",
    "--latency-msec=20",
    path,
  ];
}

export function buildFfplaySoundEffectPlaybackArgs(path: string): string[] {
  return [
    "-nodisp",
    "-autoexit",
    "-loglevel", "quiet",
    path,
  ];
}

export function buildSoundEffectPlaybackArgs(path: string): string[] {
  return buildFfplaySoundEffectPlaybackArgs(path);
}

export function buildSoundEffectPlaybackCommands(path: string): SoundEffectPlaybackCommand[] {
  return [
    { command: "pw-play", args: buildPwPlaySoundEffectPlaybackArgs(path) },
    { command: "paplay", args: buildPaplaySoundEffectPlaybackArgs(path) },
    { command: "ffplay", args: buildFfplaySoundEffectPlaybackArgs(path) },
  ];
}

export function playSoundEffect(effect: SoundEffect): void {
  if (process.env.RECORD_DISABLE_SOUND_EFFECTS === "1") {
    debugLog("sound.effect.skipped", { effect, reason: "disabled" });
    return;
  }
  const path = soundEffectPath(effect);
  if (!existsSync(path)) {
    debugLog("sound.effect.skipped", { effect, path, reason: "missing_file" });
    return;
  }

  for (const { command, args } of buildSoundEffectPlaybackCommands(path)) {
    if (!commandAvailable(command)) {
      debugLog("sound.effect.player_unavailable", { effect, command });
      continue;
    }
    try {
      const proc = Bun.spawn([command, ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref?.();
      debugLog("sound.effect.play", { effect, command, path });
      return;
    } catch (error) {
      COMMAND_AVAILABILITY.set(command, false);
      debugLog("sound.effect.spawn_failed", { effect, command, error: error instanceof Error ? error.message : String(error) });
    }
  }
  debugLog("sound.effect.skipped", { effect, path, reason: "no_player" });
  // Sound effects should never interfere with chat/call behavior.
}

function commandAvailable(command: string): boolean {
  const cached = COMMAND_AVAILABILITY.get(command);
  if (cached !== undefined) return cached;
  const available = findExecutable(command) !== null;
  COMMAND_AVAILABILITY.set(command, available);
  return available;
}

function findExecutable(command: string): string | null {
  if (command.includes("/")) return isExecutable(command) ? command : null;
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
