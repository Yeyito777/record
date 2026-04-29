/**
 * Local UI sound effects.
 *
 * The bundled files are Discord web client MP3 assets used for familiar voice
 * call feedback. Playback is best-effort and intentionally silent on failure.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type SoundEffect =
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "ringtone"
  | "callCalling"
  | "callJoin";

const SOUND_FILES: Record<SoundEffect, string> = {
  mute: "discord-mute.mp3",
  unmute: "discord-unmute.mp3",
  deafen: "discord-deafen.mp3",
  undeafen: "discord-undeafen.mp3",
  ringtone: "discord-call-ringing.mp3",
  callCalling: "discord-call-calling.mp3",
  callJoin: "discord-user-join.mp3",
};

const SOUND_DIR = fileURLToPath(new URL("../assets/sounds/", import.meta.url));

export function soundEffectPath(effect: SoundEffect): string {
  return `${SOUND_DIR}${SOUND_FILES[effect]}`;
}

export function buildSoundEffectPlaybackArgs(path: string): string[] {
  return [
    "-nodisp",
    "-autoexit",
    "-loglevel", "quiet",
    path,
  ];
}

export function playSoundEffect(effect: SoundEffect): void {
  if (process.env.RECORD_DISABLE_SOUND_EFFECTS === "1") return;
  const path = soundEffectPath(effect);
  if (!existsSync(path)) return;

  try {
    const proc = Bun.spawn(["ffplay", ...buildSoundEffectPlaybackArgs(path)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref?.();
  } catch {
    // Sound effects should never interfere with chat/call behavior.
  }
}
