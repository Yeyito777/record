/** Demux the first animated WebP frame for FFmpeg's static WebP decoder. */
export function firstAnimatedWebpFrame(data: Buffer): {
  data: Buffer;
  width: number;
  height: number;
  x: number;
  y: number;
} | null {
  if (data.length < 12 || data.toString("ascii", 0, 4) !== "RIFF"
    || data.toString("ascii", 8, 12) !== "WEBP") return null;
  const end = data.readUInt32LE(4) + 8;
  if (end > data.length) throw new Error("Truncated WebP image.");
  let canvas: { width: number; height: number } | undefined;
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) throw new Error("Truncated WebP chunk.");
    const type = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size % 2);
    if (next > end) throw new Error("Truncated WebP chunk.");
    if (type === "VP8X") {
      if (size !== 10) throw new Error("Invalid WebP extended header.");
      if (!(data[start]! & 2)) return null;
      canvas = {
        width: data.readUIntLE(start + 4, 3) + 1,
        height: data.readUIntLE(start + 7, 3) + 1,
      };
      if (canvas.width > 8192 || canvas.height > 8192 || canvas.width * canvas.height > 16 * 1024 * 1024) {
        throw new Error("WebP canvas exceeds the inline-image limit.");
      }
    }
    if (type === "ANMF" && canvas) {
      if (size < 16) throw new Error("Invalid WebP animation frame.");
      const x = data.readUIntLE(start, 3) * 2;
      const y = data.readUIntLE(start + 3, 3) * 2;
      const width = data.readUIntLE(start + 6, 3) + 1;
      const height = data.readUIntLE(start + 9, 3) + 1;
      if (x + width > canvas.width || y + height > canvas.height) throw new Error("WebP frame exceeds its canvas.");
      const chunks: Buffer[] = [];
      let alpha = false;
      let image = false;
      for (let at = start + 16; at < start + size;) {
        if (at + 8 > start + size) throw new Error("Truncated WebP frame chunk.");
        const tag = data.toString("ascii", at, at + 4);
        const length = data.readUInt32LE(at + 4);
        const after = at + 8 + length + (length % 2);
        if (after > start + size) throw new Error("Truncated WebP frame chunk.");
        if (tag === "ALPH" || tag === "VP8 " || tag === "VP8L") {
          chunks.push(data.subarray(at, after));
          alpha ||= tag === "ALPH";
          image ||= tag !== "ALPH";
        }
        at = after;
      }
      if (!image) throw new Error("WebP animation frame has no image.");
      // ALPH + VP8 requires an extended header; VP8L carries its own alpha.
      const extended = Buffer.alloc(alpha ? 18 : 0);
      if (alpha) {
        extended.write("VP8X");
        extended.writeUInt32LE(10, 4);
        extended[8] = 0x10;
        extended.writeUIntLE(width - 1, 12, 3);
        extended.writeUIntLE(height - 1, 15, 3);
      }
      const payload = Buffer.concat([extended, ...chunks]);
      const header = Buffer.alloc(12);
      header.write("RIFF");
      header.writeUInt32LE(payload.length + 4, 4);
      header.write("WEBP", 8);
      return { data: Buffer.concat([header, payload]), ...canvas, x, y };
    }
    offset = next;
  }
  if (canvas) throw new Error("WebP animation has no frame.");
  return null;
}
