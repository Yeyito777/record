/**
 * Moving pictures for the demo's GIFs: a Tenor-style mp4, a .gif, an APNG
 * sticker, a WhatsApp GIF (an mp4). Made by ffmpeg from its test pattern,
 * two seconds at 12 fps, tinted per seed; without ffmpeg, a still PNG.
 */

import { spawn } from "node:child_process";

import { renderPicture } from "./png";

/** mp4a: a six-second clip with a tone (a video with sound, for the viewer). */
export type DemoAnimationKind = "mp4" | "gif" | "apng" | "mp4a";

const made = new Map<string, Promise<Buffer>>();

const CONTENT_TYPES: Record<DemoAnimationKind, string> = { mp4: "video/mp4", gif: "image/gif", apng: "image/png", mp4a: "video/mp4" };

export function demoAnimationContentType(kind: DemoAnimationKind): string {
  return CONTENT_TYPES[kind];
}

export function demoAnimation(kind: DemoAnimationKind, width: number, height: number, seed: number): Promise<Buffer> {
  const w = Math.max(2, Math.min(1920, Math.round(width / 2) * 2));
  const h = Math.max(2, Math.min(1920, Math.round(height / 2) * 2));
  const key = `${kind}:${w}x${h}:${seed}`;
  let bytes = made.get(key);
  if (!bytes) {
    bytes = encode(kind, w, h, seed);
    made.set(key, bytes);
  }
  return bytes;
}

function encode(kind: DemoAnimationKind, width: number, height: number, seed: number): Promise<Buffer> {
  // The source ends by itself: a palette (GIF) waits for its input's end.
  const source = kind === "mp4a"
    ? `testsrc2=size=${width}x${height}:rate=25:duration=6`
    : `testsrc2=size=${width}x${height}:rate=12:duration=2,hue=h=${(seed * 47) % 360}`;
  const output: Record<DemoAnimationKind, string[]> = {
    mp4: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "30", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4"],
    mp4a: [
      "-f", "lavfi", "-i", `sine=frequency=${220 + (seed % 5) * 110}:sample_rate=48000:duration=6`,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "28", "-g", "50",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4",
    ],
    gif: ["-vf", "split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse", "-f", "gif"],
    apng: ["-plays", "0", "-f", "apng"],
  };
  const fallback = renderPicture(width, height, [40, 40, 60], [120, 80, 160], seed);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffmpeg", ["-hide_banner", "-v", "error", "-nostdin", "-f", "lavfi", "-i", source, ...output[kind], "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
      // Never left running: a demo picture that takes this long is a still.
      setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
    } catch {
      resolve(fallback);
      return;
    }
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => resolve(fallback));
    child.once("close", (code) => resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : fallback));
  });
}
