/** Session-only LRU of converted previews, independent of the active timeline. */
import type { DiscordMessageAttachment } from "./discord";
import type { InlineImagePrepareOptions, PreparedInlineImage } from "./inlineimage";

export function inlineImageCacheKey(
  attachment: Pick<DiscordMessageAttachment, "id" | "cacheKey" | "url">,
  options: InlineImagePrepareOptions,
): string {
  // Keep the exact source URL: replacing an attachment must not reuse old pixels.
  // Geometry is part of the key so a terminal cell-size change gets a fresh preview.
  return JSON.stringify([
    attachment.cacheKey ?? attachment.id,
    attachment.url,
    options.maxPixelWidth,
    options.maxPixelHeight,
    options.preserveSourceResolution ?? false,
  ]);
}

export class InlineImageCache {
  private readonly entries = new Map<string, PreparedInlineImage>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 64,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  get(key: string): PreparedInlineImage | undefined {
    const image = this.entries.get(key);
    if (image) {
      this.entries.delete(key);
      this.entries.set(key, image);
    }
    return image;
  }

  set(key: string, image: PreparedInlineImage): void {
    this.delete(key);
    // Conservatively charge two bytes per JS string character, including keys.
    const bytes = this.sizeOf(key, image);
    if (this.maxEntries <= 0 || bytes > this.maxBytes) return;
    this.entries.set(key, image);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!);
    }
  }

  private sizeOf(key: string, image: PreparedInlineImage): number {
    return (key.length + image.pngBase64.length) * 2;
  }

  private delete(key: string): void {
    const image = this.entries.get(key);
    if (!image) return;
    this.bytes -= this.sizeOf(key, image);
    this.entries.delete(key);
  }
}
