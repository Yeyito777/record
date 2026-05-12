/**
 * Local file loading for Discord message uploads.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { gzipSync } from "zlib";
import { Worker } from "worker_threads";
import { basename, extname, join, resolve } from "path";
import { homedir, tmpdir } from "os";

export interface LocalFileUpload {
  path: string;
  filename: string;
  mediaType: string;
  base64: string;
  sizeBytes: number;
  compressed?: boolean;
  originalSizeBytes?: number;
  originalFilename?: string;
}

interface LocalFileUploadBytes {
  path: string;
  filename: string;
  mediaType: string;
  buffer: Buffer;
  compressed?: boolean;
  originalSizeBytes?: number;
  originalFilename?: string;
}

export interface OversizedFileCompressionInput {
  path: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  maxBytes: number;
}

export type OversizedFileCompressor = (input: OversizedFileCompressionInput) => LocalFileUploadBytes | null;

export interface ReadLocalFileUploadOptions {
  maxBytes?: number;
  compressor?: OversizedFileCompressor;
}

interface UploadWorkerSuccess {
  ok: true;
  upload: LocalFileUpload;
}

interface UploadWorkerFailure {
  ok: false;
  error: string;
}

type UploadWorkerResult = UploadWorkerSuccess | UploadWorkerFailure;

export const DISCORD_UPLOAD_LIMIT_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ics": "text/calendar",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".md": "text/markdown",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

const STATIC_COMPRESSIBLE_IMAGE_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

const IMAGE_QUALITIES = [85, 75, 65, 55, 45, 35, 25, 15, 8];
const IMAGE_SCALES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2];
const VIDEO_CRFS = [28, 32, 36, 40, 44, 48];
const VIDEO_SCALES = [1, 0.85, 0.7, 0.55, 0.4, 0.3];
const AUDIO_BITRATES = ["128k", "96k", "64k", "48k", "32k", "24k"];
const COMPRESSION_TIMEOUT_MS = 60_000;

export function normalizeUploadPath(input: string): string {
  let path = input.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1);
  }
  path = path.replace(/\\([\\ ])/g, "$1");
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function mediaTypeForFilename(filename: string): string {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export function formatUploadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadFromBytes(upload: LocalFileUploadBytes): LocalFileUpload {
  return {
    path: upload.path,
    filename: upload.filename,
    mediaType: upload.mediaType,
    base64: upload.buffer.toString("base64"),
    sizeBytes: upload.buffer.length,
    compressed: upload.compressed,
    originalSizeBytes: upload.originalSizeBytes,
    originalFilename: upload.originalFilename,
  };
}

function stem(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function commandExists(command: string): boolean {
  const result = spawnSync("command", ["-v", command], { timeout: 2_000, stdio: "ignore", shell: true });
  return !result.error && result.status === 0;
}

function magickCommand(): string | null {
  if (commandExists("magick")) return "magick";
  if (commandExists("convert")) return "convert";
  return null;
}

function readCompressedCandidate(
  outputPath: string,
  input: OversizedFileCompressionInput,
  filename: string,
  mediaType: string,
): LocalFileUploadBytes | null {
  let stats;
  try {
    stats = statSync(outputPath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size <= 0 || stats.size > input.maxBytes) return null;
  return {
    path: input.path,
    filename,
    mediaType,
    buffer: readFileSync(outputPath),
    compressed: true,
    originalSizeBytes: input.sizeBytes,
    originalFilename: input.filename,
  };
}

function compressImageToLimit(input: OversizedFileCompressionInput): LocalFileUploadBytes | null {
  if (!STATIC_COMPRESSIBLE_IMAGE_TYPES.has(input.mediaType)) return null;

  const command = magickCommand();
  if (!command) throw new Error(`File is larger than ${formatUploadSize(input.maxBytes)}, and automatic image compression requires ImageMagick.`);

  const workDir = mkdtempSync(join(tmpdir(), "record-upload-compress-"));
  try {
    const outputFilename = `${stem(input.filename)}-compressed.webp`;
    for (const scale of IMAGE_SCALES) {
      for (const quality of IMAGE_QUALITIES) {
        const outputPath = join(workDir, `image-${Math.round(scale * 100)}-${quality}.webp`);
        const args = [
          input.path,
          "-auto-orient",
          "-strip",
          ...(scale < 1 ? ["-resize", `${Math.round(scale * 100)}%`] : []),
          "-define",
          "webp:method=6",
          "-quality",
          String(quality),
          outputPath,
        ];
        spawnSync(command, args, { timeout: COMPRESSION_TIMEOUT_MS, stdio: "ignore" });
        const candidate = readCompressedCandidate(outputPath, input, outputFilename, "image/webp");
        if (candidate) return candidate;
      }
    }
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function compressVideoToLimit(input: OversizedFileCompressionInput): LocalFileUploadBytes | null {
  if (!input.mediaType.startsWith("video/")) return null;
  if (!commandExists("ffmpeg")) throw new Error(`File is larger than ${formatUploadSize(input.maxBytes)}, and automatic video compression requires ffmpeg.`);

  const workDir = mkdtempSync(join(tmpdir(), "record-upload-compress-"));
  try {
    const outputFilename = `${stem(input.filename)}-compressed.mp4`;
    for (const scale of VIDEO_SCALES) {
      for (const crf of VIDEO_CRFS) {
        const outputPath = join(workDir, `video-${Math.round(scale * 100)}-${crf}.mp4`);
        const scaleFilter = scale < 1
          ? [`-vf`, `scale=trunc(iw*${scale}/2)*2:trunc(ih*${scale}/2)*2`]
          : [];
        const args = [
          "-y",
          "-i",
          input.path,
          "-map_metadata",
          "-1",
          ...scaleFilter,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          String(crf),
          "-movflags",
          "+faststart",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          outputPath,
        ];
        spawnSync("ffmpeg", args, { timeout: COMPRESSION_TIMEOUT_MS, stdio: "ignore" });
        const candidate = readCompressedCandidate(outputPath, input, outputFilename, "video/mp4");
        if (candidate) return candidate;
      }
    }
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function compressAudioToLimit(input: OversizedFileCompressionInput): LocalFileUploadBytes | null {
  if (!input.mediaType.startsWith("audio/")) return null;
  if (!commandExists("ffmpeg")) throw new Error(`File is larger than ${formatUploadSize(input.maxBytes)}, and automatic audio compression requires ffmpeg.`);

  const workDir = mkdtempSync(join(tmpdir(), "record-upload-compress-"));
  try {
    const outputFilename = `${stem(input.filename)}-compressed.ogg`;
    for (const bitrate of AUDIO_BITRATES) {
      const outputPath = join(workDir, `audio-${bitrate}.ogg`);
      const args = [
        "-y",
        "-i",
        input.path,
        "-vn",
        "-map_metadata",
        "-1",
        "-c:a",
        "libopus",
        "-b:a",
        bitrate,
        outputPath,
      ];
      spawnSync("ffmpeg", args, { timeout: COMPRESSION_TIMEOUT_MS, stdio: "ignore" });
      const candidate = readCompressedCandidate(outputPath, input, outputFilename, "audio/ogg");
      if (candidate) return candidate;
    }
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function gzipFileToLimit(input: OversizedFileCompressionInput): LocalFileUploadBytes | null {
  const buffer = gzipSync(readFileSync(input.path), { level: 9 });
  if (buffer.length <= 0 || buffer.length > input.maxBytes) return null;
  return {
    path: input.path,
    filename: `${input.filename}.gz`,
    mediaType: "application/gzip",
    buffer,
    compressed: true,
    originalSizeBytes: input.sizeBytes,
    originalFilename: input.filename,
  };
}

export function compressOversizedFile(input: OversizedFileCompressionInput): LocalFileUploadBytes | null {
  return compressImageToLimit(input) ?? compressVideoToLimit(input) ?? compressAudioToLimit(input) ?? gzipFileToLimit(input);
}

export function readLocalFileUpload(inputPath: string, options: ReadLocalFileUploadOptions = {}): LocalFileUpload {
  const path = normalizeUploadPath(inputPath);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error("Not a file.");

  const filename = basename(path);
  const mediaType = mediaTypeForFilename(path);
  const maxBytes = options.maxBytes ?? DISCORD_UPLOAD_LIMIT_BYTES;
  if (stats.size > maxBytes) {
    const compressor = options.compressor ?? compressOversizedFile;
    const compressed = compressor({ path, filename, mediaType, sizeBytes: stats.size, maxBytes });
    if (compressed && compressed.buffer.length <= maxBytes) return uploadFromBytes(compressed);

    throw new Error(`Could not compress ${filename} below ${formatUploadSize(maxBytes)}.`);
  }

  return uploadFromBytes({
    path,
    filename,
    mediaType,
    buffer: readFileSync(path),
  });
}

export function readLocalFileUploadInWorker(inputPath: string): Promise<LocalFileUpload> {
  return new Promise((resolveUpload, rejectUpload) => {
    const worker = new Worker(new URL("./fileupload-worker.ts", import.meta.url), {
      workerData: { path: inputPath },
    });

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    worker.once("message", (message: UploadWorkerResult) => {
      settle(() => {
        if (message.ok) resolveUpload(message.upload);
        else rejectUpload(new Error(message.error));
      });
    });

    worker.once("error", (error) => {
      settle(() => rejectUpload(error));
    });

    worker.once("exit", (code) => {
      if (code === 0) return;
      settle(() => rejectUpload(new Error(`Upload worker exited with code ${code}.`)));
    });
  });
}
