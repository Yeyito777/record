import { describe, expect, test } from "bun:test";

import {
  buildFfplaySoundEffectPlaybackArgs,
  buildPaplaySoundEffectPlaybackArgs,
  buildPwPlaySoundEffectPlaybackArgs,
  buildSoundEffectPlaybackArgs,
  buildSoundEffectPlaybackCommands,
  soundEffectPath,
} from "./soundeffects";

describe("sound effects", () => {
  test("prefers lightweight event players before ffplay fallback", () => {
    expect(buildSoundEffectPlaybackCommands("/tmp/sound.mp3")).toEqual([
      { command: "pw-play", args: ["--media-role", "event", "--latency", "20ms", "/tmp/sound.mp3"] },
      { command: "paplay", args: ["--client-name=Record", "--stream-name=Record sound effect", "--latency-msec=20", "/tmp/sound.mp3"] },
      { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "/tmp/sound.mp3"] },
    ]);
  });

  test("keeps ffplay fallback compatible with detached playback", () => {
    expect(buildFfplaySoundEffectPlaybackArgs("/tmp/sound.mp3")).toEqual([
      "-nodisp",
      "-autoexit",
      "-loglevel", "quiet",
      "/tmp/sound.mp3",
    ]);
    expect(buildSoundEffectPlaybackArgs("/tmp/sound.mp3")).toEqual(buildFfplaySoundEffectPlaybackArgs("/tmp/sound.mp3"));
    expect(buildFfplaySoundEffectPlaybackArgs("/tmp/sound.mp3")).not.toContain("-nostdin");
  });

  test("builds PipeWire and PulseAudio event playback args", () => {
    expect(buildPwPlaySoundEffectPlaybackArgs("/tmp/sound.mp3")).toEqual([
      "--media-role", "event",
      "--latency", "20ms",
      "/tmp/sound.mp3",
    ]);
    expect(buildPaplaySoundEffectPlaybackArgs("/tmp/sound.mp3")).toEqual([
      "--client-name=Record",
      "--stream-name=Record sound effect",
      "--latency-msec=20",
      "/tmp/sound.mp3",
    ]);
  });

  test("builds local-gain playback args", () => {
    expect(buildPwPlaySoundEffectPlaybackArgs("/tmp/sound.mp3", -6)).toEqual([
      "--media-role", "event",
      "--latency", "20ms",
      "--volume", "0.5012",
      "/tmp/sound.mp3",
    ]);
    expect(buildPaplaySoundEffectPlaybackArgs("/tmp/sound.mp3", -6)).toContain("--volume=32846");
    expect(buildFfplaySoundEffectPlaybackArgs("/tmp/sound.mp3", 6)).toEqual([
      "-nodisp",
      "-autoexit",
      "-loglevel", "quiet",
      "-af", "volume=6dB",
      "/tmp/sound.mp3",
    ]);
  });

  test("resolves bundled Discord voice sounds", () => {
    expect(soundEffectPath("mute")).toEndWith("/assets/sounds/discord-mute.mp3");
    expect(soundEffectPath("deafen")).toEndWith("/assets/sounds/discord-deafen.mp3");
    expect(soundEffectPath("ringtone")).toEndWith("/assets/sounds/discord-call-ringing.mp3");
    expect(soundEffectPath("callJoin")).toEndWith("/assets/sounds/discord-user-join.mp3");
    expect(soundEffectPath("callUserLeave")).toEndWith("/assets/sounds/discord-user-leave.mp3");
    expect(soundEffectPath("callLeave")).toEndWith("/assets/sounds/discord-disconnect.mp3");
    expect(soundEffectPath("streamStarted")).toEndWith("/assets/sounds/discord-stream-started.mp3");
    expect(soundEffectPath("streamEnded")).toEndWith("/assets/sounds/discord-stream-ended.mp3");
  });
});
