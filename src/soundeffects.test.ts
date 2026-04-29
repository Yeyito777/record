import { describe, expect, test } from "bun:test";

import { buildSoundEffectPlaybackArgs, soundEffectPath } from "./soundeffects";

describe("sound effects", () => {
  test("uses ffplay-compatible detached playback args", () => {
    expect(buildSoundEffectPlaybackArgs("/tmp/sound.mp3")).toEqual([
      "-nodisp",
      "-autoexit",
      "-loglevel", "quiet",
      "/tmp/sound.mp3",
    ]);
    expect(buildSoundEffectPlaybackArgs("/tmp/sound.mp3")).not.toContain("-nostdin");
  });

  test("resolves bundled Discord voice sounds", () => {
    expect(soundEffectPath("mute")).toEndWith("/assets/sounds/discord-mute.mp3");
    expect(soundEffectPath("deafen")).toEndWith("/assets/sounds/discord-deafen.mp3");
    expect(soundEffectPath("ringtone")).toEndWith("/assets/sounds/discord-call-ringing.mp3");
    expect(soundEffectPath("callJoin")).toEndWith("/assets/sounds/discord-user-join.mp3");
  });
});
