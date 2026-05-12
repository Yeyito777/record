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
import { DEFAULT_LOCAL_VOLUME_PERCENT, clampVolumePercent, volumePercentToLinear } from "./volume";

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

export interface SoundEffectPlaybackHandle {
  stop(): void;
}

export interface LoopingSoundEffectOptions {
  intervalMs: number;
  maxDurationMs?: number;
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
let soundEffectVolume = DEFAULT_LOCAL_VOLUME_PERCENT;

export function setSoundEffectVolume(volume: number): void {
  soundEffectVolume = clampVolumePercent(volume);
}

export function getSoundEffectVolume(): number {
  return soundEffectVolume;
}

export function soundEffectPath(effect: SoundEffect): string {
  return `${SOUND_DIR}${SOUND_FILES[effect]}`;
}

export function buildPwPlaySoundEffectPlaybackArgs(path: string, volume = DEFAULT_LOCAL_VOLUME_PERCENT): string[] {
  const args = [
    "--media-role", "event",
    "--latency", "20ms",
  ];
  const normalizedVolume = clampVolumePercent(volume);
  if (normalizedVolume !== DEFAULT_LOCAL_VOLUME_PERCENT) args.push("--volume", volumePercentToLinear(normalizedVolume).toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
  args.push(path);
  return args;
}

export function buildPaplaySoundEffectPlaybackArgs(path: string, volume = DEFAULT_LOCAL_VOLUME_PERCENT): string[] {
  const args = [
    "--client-name=Record",
    "--stream-name=Record sound effect",
    "--latency-msec=20",
  ];
  const normalizedVolume = clampVolumePercent(volume);
  if (normalizedVolume !== DEFAULT_LOCAL_VOLUME_PERCENT) args.push(`--volume=${Math.round(volumePercentToLinear(normalizedVolume) * 65536)}`);
  args.push(path);
  return args;
}

export function buildFfplaySoundEffectPlaybackArgs(path: string, volume = DEFAULT_LOCAL_VOLUME_PERCENT): string[] {
  const args = [
    "-nodisp",
    "-autoexit",
    "-loglevel", "quiet",
  ];
  const normalizedVolume = clampVolumePercent(volume);
  if (normalizedVolume !== DEFAULT_LOCAL_VOLUME_PERCENT) args.push("-volume", String(normalizedVolume));
  args.push(path);
  return args;
}

export function buildSoundEffectPlaybackArgs(path: string, volume = DEFAULT_LOCAL_VOLUME_PERCENT): string[] {
  return buildFfplaySoundEffectPlaybackArgs(path, volume);
}

export function buildSoundEffectPlaybackCommands(path: string, volume = DEFAULT_LOCAL_VOLUME_PERCENT): SoundEffectPlaybackCommand[] {
  return [
    { command: "pw-play", args: buildPwPlaySoundEffectPlaybackArgs(path, volume) },
    { command: "paplay", args: buildPaplaySoundEffectPlaybackArgs(path, volume) },
    { command: "ffplay", args: buildFfplaySoundEffectPlaybackArgs(path, volume) },
  ];
}

export function playSoundEffect(effect: SoundEffect): SoundEffectPlaybackHandle | null {
  if (process.env.RECORD_DISABLE_SOUND_EFFECTS === "1") {
    debugLog("sound.effect.skipped", { effect, reason: "disabled" });
    return null;
  }
  const path = soundEffectPath(effect);
  if (!existsSync(path)) {
    debugLog("sound.effect.skipped", { effect, path, reason: "missing_file" });
    return null;
  }

  for (const { command, args } of buildSoundEffectPlaybackCommands(path, soundEffectVolume)) {
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
      return {
        stop: () => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // Best-effort stop for short-lived sound effect players.
          }
        },
      };
    } catch (error) {
      COMMAND_AVAILABILITY.set(command, false);
      debugLog("sound.effect.spawn_failed", { effect, command, error: error instanceof Error ? error.message : String(error) });
    }
  }
  debugLog("sound.effect.skipped", { effect, path, reason: "no_player" });
  // Sound effects should never interfere with chat/call behavior.
  return null;
}

export function playLoopingSoundEffect(effect: SoundEffect, options: LoopingSoundEffectOptions): SoundEffectPlaybackHandle {
  let stopped = false;
  let current: SoundEffectPlaybackHandle | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const play = (): void => {
    if (stopped) return;
    current?.stop();
    current = playSoundEffect(effect);
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    if (timeout) clearTimeout(timeout);
    interval = null;
    timeout = null;
    current?.stop();
    current = null;
    debugLog("sound.effect.loop.stop", { effect });
  };

  debugLog("sound.effect.loop.start", { effect, intervalMs: options.intervalMs, maxDurationMs: options.maxDurationMs ?? null });
  play();
  interval = setInterval(play, options.intervalMs);
  if (options.maxDurationMs !== undefined) timeout = setTimeout(stop, options.maxDurationMs);

  return { stop };
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
