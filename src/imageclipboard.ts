/**
 * Clipboard image reading for message uploads.
 *
 * Mirrors the Exocortex TUI behavior: Ctrl+V reads an image from the system
 * clipboard using native macOS tools, xclip/wl-paste, or PowerShell and stores
 * it as a pending attachment for the next send.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ClipboardImageAttachment {
  mediaType: ImageMediaType;
  base64: string;
  sizeBytes: number;
  filename?: string;
}

type ImageClipboardBackend = "macos" | "xclip" | "wl" | "powershell" | null;

let backend: ImageClipboardBackend | undefined;

function detectBackend(): ImageClipboardBackend {
  if (backend !== undefined) return backend;

  if (process.platform === "win32") {
    backend = "powershell";
    return backend;
  }

  if (process.platform === "darwin") {
    try {
      const osascript = spawnSync("which", ["osascript"], { timeout: 1000 });
      const sips = spawnSync("which", ["sips"], { timeout: 1000 });
      if (osascript.status === 0 && sips.status === 0) {
        backend = "macos";
        return backend;
      }
    } catch {
      // Native macOS clipboard tools not available.
    }
  }

  if (process.env.WAYLAND_DISPLAY) {
    try {
      const result = spawnSync("which", ["wl-paste"], { timeout: 1000 });
      if (result.status === 0) {
        backend = "wl";
        return backend;
      }
    } catch {
      // wl-paste not available.
    }
  }

  try {
    const result = spawnSync("which", ["xclip"], { timeout: 1000 });
    if (result.status === 0) {
      backend = "xclip";
      return backend;
    }
  } catch {
    // xclip not available.
  }

  backend = null;
  return backend;
}

const IMAGE_FORMATS: Array<{ mime: ImageMediaType; target: string }> = [
  { mime: "image/png", target: "image/png" },
  { mime: "image/jpeg", target: "image/jpeg" },
  { mime: "image/gif", target: "image/gif" },
  { mime: "image/webp", target: "image/webp" },
];

const MACOS_READ_IMAGE_SCRIPT = `
on run argv
  set outputPath to item 1 of argv
  try
    set imageData to the clipboard as «class PNGf»
    set imageFormat to "png"
  on error
    try
      set imageData to the clipboard as TIFF picture
      set imageFormat to "tiff"
    on error
      return "none"
    end try
  end try

  set outputFile to open for access POSIX file outputPath with write permission
  try
    set eof outputFile to 0
    write imageData to outputFile
    close access outputFile
  on error errorMessage
    try
      close access outputFile
    end try
    error errorMessage
  end try
  return imageFormat
end run
`;

function readImageMacOS(): ClipboardImageAttachment | null {
  const tempDir = mkdtempSync(join(tmpdir(), "record-clipboard-"));
  const rawPath = join(tempDir, "clipboard-image");
  const pngPath = join(tempDir, "clipboard-image.png");

  try {
    const result = spawnSync("osascript", ["-", rawPath], {
      input: MACOS_READ_IMAGE_SCRIPT,
      timeout: 5000,
    });
    if (result.status !== 0) return null;

    const imageFormat = result.stdout?.toString().trim();
    if (imageFormat === "none" || !imageFormat) return null;

    let imagePath = rawPath;
    if (imageFormat === "tiff") {
      const conversion = spawnSync("sips", ["-s", "format", "png", rawPath, "--out", pngPath], {
        timeout: 5000,
      });
      if (conversion.status !== 0) return null;
      imagePath = pngPath;
    }

    const buffer = readFileSync(imagePath);
    if (buffer.length === 0) return null;
    return {
      mediaType: "image/png",
      base64: buffer.toString("base64"),
      sizeBytes: buffer.length,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readImageXclip(): ClipboardImageAttachment | null {
  const targets = spawnSync("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], { timeout: 1000 });
  if (targets.status !== 0 || !targets.stdout) return null;
  const available = targets.stdout.toString();

  for (const format of IMAGE_FORMATS) {
    if (!available.includes(format.target)) continue;
    const result = spawnSync("xclip", ["-selection", "clipboard", "-t", format.target, "-o"], {
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) continue;
    return {
      mediaType: format.mime,
      base64: Buffer.from(result.stdout).toString("base64"),
      sizeBytes: result.stdout.length,
    };
  }
  return null;
}

function readImageWayland(): ClipboardImageAttachment | null {
  const targets = spawnSync("wl-paste", ["--list-types"], { timeout: 1000 });
  if (targets.status !== 0 || !targets.stdout) return null;
  const available = targets.stdout.toString();

  for (const format of IMAGE_FORMATS) {
    if (!available.includes(format.target)) continue;
    const result = spawnSync("wl-paste", ["--type", format.target], {
      timeout: 5000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) continue;
    return {
      mediaType: format.mime,
      base64: Buffer.from(result.stdout).toString("base64"),
      sizeBytes: result.stdout.length,
    };
  }
  return null;
}

function readImagePowerShell(): ClipboardImageAttachment | null {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img) {",
    "  try {",
    "    $path = [System.IO.Path]::GetTempFileName()",
    "    $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "    Write-Output $path",
    "  } finally {",
    "    $img.Dispose()",
    "  }",
    "}",
  ].join("\n");

  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { timeout: 5000 });
  if (result.status !== 0 || !result.stdout) return null;

  const tmpPath = result.stdout.toString().trim();
  if (!tmpPath) return null;

  try {
    const buffer = readFileSync(tmpPath);
    if (buffer.length === 0) return null;
    return {
      mediaType: "image/png",
      base64: buffer.toString("base64"),
      sizeBytes: buffer.length,
    };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

export function readClipboardImage(): ClipboardImageAttachment | null {
  try {
    const selectedBackend = detectBackend();
    if (!selectedBackend) return null;
    if (selectedBackend === "macos") return readImageMacOS();
    if (selectedBackend === "powershell") return readImagePowerShell();
    return selectedBackend === "wl" ? readImageWayland() : readImageXclip();
  } catch {
    return null;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function imageLabel(mediaType: string): string {
  const ext = mediaType.split("/")[1]?.toUpperCase() ?? "IMG";
  return ext === "JPEG" ? "JPG" : ext;
}

export function imageExtension(mediaType: string): string {
  const ext = imageLabel(mediaType).toLowerCase();
  return ext === "jpg" ? "jpg" : ext;
}
