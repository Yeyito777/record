import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type VoiceMessagePromptPhase = "recording" | "sending";

export interface VoiceMessagePromptState {
  phase: VoiceMessagePromptPhase;
  frameIndex: number;
}

export interface VoiceMessageClip {
  filename: string;
  mediaType: "audio/ogg";
  base64: string;
  sizeBytes: number;
  durationSecs: number;
  waveform: string;
}

export interface RecorderCommand {
  command: string;
  args: string[];
}

interface PcmWaveData {
  samples: Float32Array;
  sampleRate: number;
  durationSecs: number;
}

export const VOICE_MESSAGE_FILENAME = "voice-message.ogg";
export const VOICE_MESSAGE_MEDIA_TYPE = "audio/ogg" as const;
export const VOICE_MESSAGE_FLAG = 8192;
export const VOICE_MESSAGE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const CAPTURE_SAMPLE_RATE = 48_000;
const CAPTURE_CHANNELS = 1;
const ENCODE_TIMEOUT_MS = 60_000;

function commandExists(command: string): boolean {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which(command) !== null;
  }
  const result = spawnSync("command", ["-v", command], { timeout: 2_000, stdio: "ignore", shell: true });
  return !result.error && result.status === 0;
}

function cleanupPath(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
}

export function voiceMessagePromptText(voice: VoiceMessagePromptState): string {
  const frame = VOICE_MESSAGE_SPINNER_FRAMES[voice.frameIndex % VOICE_MESSAGE_SPINNER_FRAMES.length];
  return voice.phase === "recording"
    ? `${frame} Listening…`
    : `${frame} Sending voice message…`;
}

export function chooseLinuxVoiceMessageRecorderCommand(
  hasCommand: (command: string) => boolean,
  outputPath: string,
): RecorderCommand | null {
  if (hasCommand("pw-record")) {
    return {
      command: "pw-record",
      args: ["--rate", String(CAPTURE_SAMPLE_RATE), "--channels", String(CAPTURE_CHANNELS), "--format", "s16", "--container", "wav", outputPath],
    };
  }
  if (hasCommand("arecord")) {
    return {
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-r", String(CAPTURE_SAMPLE_RATE), "-c", String(CAPTURE_CHANNELS), "-t", "wav", outputPath],
    };
  }
  if (hasCommand("ffmpeg")) {
    return {
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "pulse",
        "-i",
        "default",
        "-ac",
        String(CAPTURE_CHANNELS),
        "-ar",
        String(CAPTURE_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-y",
        outputPath,
      ],
    };
  }
  return null;
}

function readChunkId(buffer: Buffer, offset: number): string {
  return buffer.toString("ascii", offset, offset + 4);
}

function parsePcmWav(buffer: Buffer): PcmWaveData {
  if (buffer.length < 44 || readChunkId(buffer, 0) !== "RIFF" || readChunkId(buffer, 8) !== "WAVE") {
    throw new Error("captured audio was not a WAV file");
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = readChunkId(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const nextOffset = payloadStart + size + (size % 2);
    if (payloadStart + size > buffer.length) break;

    if (id === "fmt ") {
      if (size < 16) throw new Error("captured WAV fmt chunk was invalid");
      audioFormat = buffer.readUInt16LE(payloadStart);
      channels = buffer.readUInt16LE(payloadStart + 2);
      sampleRate = buffer.readUInt32LE(payloadStart + 4);
      bitsPerSample = buffer.readUInt16LE(payloadStart + 14);
    } else if (id === "data") {
      dataStart = payloadStart;
      dataSize = size;
    }

    offset = nextOffset;
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels <= 0 || sampleRate <= 0 || dataStart < 0 || dataSize <= 0) {
    throw new Error("captured WAV must be 16-bit PCM audio");
  }

  const bytesPerFrame = channels * 2;
  const frameCount = Math.floor(dataSize / bytesPerFrame);
  if (frameCount <= 0) throw new Error("captured audio file was empty");

  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    const frameOffset = dataStart + frame * bytesPerFrame;
    for (let channel = 0; channel < channels; channel++) {
      sum += buffer.readInt16LE(frameOffset + channel * 2) / 32768;
    }
    samples[frame] = sum / channels;
  }

  return { samples, sampleRate, durationSecs: frameCount / sampleRate };
}

export function buildDiscordVoiceWaveformFromSamples(samples: Float32Array, binCount = 256): string {
  if (samples.length === 0) return Buffer.alloc(binCount).toString("base64");
  const bins = Math.max(1, Math.min(binCount, samples.length));
  const rms = new Float32Array(bins);
  let max = 0;

  for (let i = 0; i < bins; i++) {
    const start = Math.floor(i * samples.length / bins);
    const end = Math.max(start + 1, Math.floor((i + 1) * samples.length / bins));
    let sumSquares = 0;
    for (let j = start; j < end; j++) {
      const sample = samples[j] ?? 0;
      sumSquares += sample * sample;
    }
    const value = Math.sqrt(sumSquares / (end - start));
    rms[i] = value;
    if (value > max) max = value;
  }

  const waveform = Buffer.alloc(binCount);
  if (max <= 0) return waveform.toString("base64");
  for (let i = 0; i < binCount; i++) {
    const sourceIndex = Math.min(bins - 1, Math.floor(i * bins / binCount));
    waveform[i] = Math.max(0, Math.min(255, Math.round(((rms[sourceIndex] ?? 0) / max) * 255)));
  }
  return waveform.toString("base64");
}

export function analyzePcmWavForDiscordVoiceMessage(buffer: Buffer): { durationSecs: number; waveform: string } {
  const pcm = parsePcmWav(buffer);
  return {
    durationSecs: pcm.durationSecs,
    waveform: buildDiscordVoiceWaveformFromSamples(pcm.samples),
  };
}

function encodeOggOpus(inputPath: string, outputPath: string): void {
  if (!commandExists("ffmpeg")) {
    throw new Error("Voice messages require ffmpeg to encode Discord-compatible Ogg Opus audio.");
  }
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-map_metadata",
    "-1",
    "-ac",
    "1",
    "-ar",
    String(CAPTURE_SAMPLE_RATE),
    "-c:a",
    "libopus",
    "-application",
    "voip",
    "-b:a",
    "64k",
    outputPath,
  ], { timeout: ENCODE_TIMEOUT_MS, encoding: "utf8" });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(stderr || "ffmpeg failed to encode the voice message");
  }
}

export class VoiceMessageRecorder {
  private readonly child: ChildProcess;
  private readonly wavPath: string;
  private readonly oggPath: string;
  private readonly tmpDir: string;
  private readonly exitPromise: Promise<void>;
  private stderr = "";
  private finished = false;

  private constructor(child: ChildProcess, wavPath: string, oggPath: string, tmpDir: string) {
    this.child = child;
    this.wavPath = wavPath;
    this.oggPath = oggPath;
    this.tmpDir = tmpDir;
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderr = (this.stderr + text).slice(-4000);
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.once("error", () => resolve());
    });
  }

  static start(): VoiceMessageRecorder {
    if (process.platform !== "linux") {
      throw new Error(`Voice messages are currently only implemented for Linux (got ${process.platform}).`);
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "record-voice-message-"));
    const wavPath = join(tmpDir, "input.wav");
    const oggPath = join(tmpDir, VOICE_MESSAGE_FILENAME);
    const recorder = chooseLinuxVoiceMessageRecorderCommand(commandExists, wavPath);
    if (!recorder) {
      cleanupPath(tmpDir);
      throw new Error("Voice messages require pw-record, arecord, or ffmpeg to capture audio.");
    }
    const child = spawn(recorder.command, recorder.args, { stdio: ["ignore", "ignore", "pipe"] });
    return new VoiceMessageRecorder(child, wavPath, oggPath, tmpDir);
  }

  async stop(): Promise<VoiceMessageClip> {
    if (!this.finished) {
      this.finished = true;
      this.child.kill("SIGINT");
      let timeout: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        this.exitPromise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            this.child.kill("SIGTERM");
            resolve();
          }, 2000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await Promise.race([
          this.exitPromise,
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              this.child.kill("SIGKILL");
              resolve();
            }, 1000);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
      }
      await this.exitPromise;
    }

    try {
      if (!existsSync(this.wavPath)) {
        throw new Error(this.stderr.trim() || "no audio file was captured");
      }
      const wavBytes = readFileSync(this.wavPath);
      if (wavBytes.length === 0) {
        throw new Error(this.stderr.trim() || "captured audio file was empty");
      }
      const analysis = analyzePcmWavForDiscordVoiceMessage(wavBytes);
      encodeOggOpus(this.wavPath, this.oggPath);
      const stats = statSync(this.oggPath);
      if (!stats.isFile() || stats.size <= 0) throw new Error("encoded voice message was empty");
      const oggBytes = readFileSync(this.oggPath);
      return {
        filename: VOICE_MESSAGE_FILENAME,
        mediaType: VOICE_MESSAGE_MEDIA_TYPE,
        base64: oggBytes.toString("base64"),
        sizeBytes: oggBytes.length,
        durationSecs: analysis.durationSecs,
        waveform: analysis.waveform,
      };
    } finally {
      cleanupPath(this.tmpDir);
    }
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.child.kill("SIGKILL");
    cleanupPath(this.tmpDir);
  }
}
