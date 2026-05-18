import { describe, expect, test } from "bun:test";

import {
  analyzePcmWavForDiscordVoiceMessage,
  buildFfmpegVoiceMessageEncodeArgs,
  buildDiscordVoiceWaveformFromSamples,
  chooseLinuxVoiceMessageRecorderCommand,
  voiceMessagePromptText,
} from "./voice-message";

function pcm16Wav(samples: number[], sampleRate = 8000): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2);
  });
  return buffer;
}

describe("voice message helpers", () => {
  test("formats Exocortex-style prompt placeholders", () => {
    expect(voiceMessagePromptText({ phase: "recording", frameIndex: 0 })).toBe("⠋ Listening…");
    expect(voiceMessagePromptText({ phase: "sending", frameIndex: 1 })).toBe("⠙ Sending voice message…");
  });

  test("chooses the same Linux capture backends as voice input", () => {
    expect(chooseLinuxVoiceMessageRecorderCommand((command) => command === "pw-record", "/tmp/in.wav")?.command).toBe("pw-record");
    expect(chooseLinuxVoiceMessageRecorderCommand((command) => command === "arecord", "/tmp/in.wav")?.command).toBe("arecord");
    expect(chooseLinuxVoiceMessageRecorderCommand((command) => command === "ffmpeg", "/tmp/in.wav")?.command).toBe("ffmpeg");
    expect(chooseLinuxVoiceMessageRecorderCommand(() => false, "/tmp/in.wav")).toBeNull();
  });

  test("applies configured mic gain when encoding Ogg Opus", () => {
    expect(buildFfmpegVoiceMessageEncodeArgs("/tmp/in.wav", "/tmp/out.ogg", 6)).toContain("volume=6dB");
    expect(buildFfmpegVoiceMessageEncodeArgs("/tmp/in.wav", "/tmp/out.ogg", 0)).not.toContain("-af");
  });

  test("builds Discord waveform data and duration from PCM WAV", () => {
    const wav = pcm16Wav([0, 0.25, -0.5, 1], 4);
    const analysis = analyzePcmWavForDiscordVoiceMessage(wav);

    expect(analysis.durationSecs).toBe(1);
    expect(Buffer.from(analysis.waveform, "base64")).toHaveLength(256);
  });

  test("normalizes waveform peak to 255", () => {
    const waveform = Buffer.from(buildDiscordVoiceWaveformFromSamples(new Float32Array([0, 0.5, 1, 0.5]), 4), "base64");
    expect(waveform).toHaveLength(4);
    expect(Math.max(...waveform)).toBe(255);
  });
});
