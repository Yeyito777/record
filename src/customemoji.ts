/** Inline Discord custom emoji backed by Kitty terminal graphics. */

import { moveTo } from "./terminal";
import { termWidth } from "./textwidth";
import { theme } from "./theme";
import type { DiscordCustomEmoji } from "./discord";
import type { ClipboardImageAttachment } from "./imageclipboard";
import {
  kittyGraphicsDeleteImageRange,
  kittyGraphicsDeleteZ,
  kittyGraphicsPlace,
  kittyGraphicsTransmitPng,
  type KittyGraphicsFrame,
} from "./terminalgraphics";

type RenderableCustomEmoji = Pick<DiscordCustomEmoji, "id" | "name" | "animated">;

const CUSTOM_EMOJI_RE = /<(a?):([A-Za-z0-9_]{1,64}):(\d+)>/g;
const MARKER_FIRST = 0xe000;
const MARKER_LAST = 0xf8ff;
const IMAGE_ID_FIRST = 0x72000000;
const IMAGE_ID_LAST = IMAGE_ID_FIRST + (MARKER_LAST - MARKER_FIRST);
const EMOJI_Z_INDEX = 1478;
const EMOJI_COLUMNS = 2;
const EMOJI_ROWS = 1;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const LOADING_GLYPH = "◇";
const IMAGE_PLACEHOLDER = "　";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SGR_RE = /\x1b\[([0-9;]*)m/g;

function selectionStateAfter(text: string, initiallySelected: boolean): boolean {
  let selected = initiallySelected;
  for (const match of text.matchAll(SGR_RE)) {
    const escape = match[0];
    if (escape === theme.selectionBg) {
      selected = true;
      continue;
    }

    const params = (match[1] || "0").split(";").map(Number);
    if (params.some((param) => param === 0 || param === 49
      || (param >= 40 && param <= 48)
      || (param >= 100 && param <= 107))) {
      selected = false;
    }
  }
  return selected;
}

interface RegisteredCustomEmoji extends RenderableCustomEmoji {
  key: string;
  marker: string;
  imageId: number;
  status: "idle" | "loading" | "ready" | "failed";
  pngBase64: string | null;
}

export interface CustomEmojiRenderBatch {
  placements: Array<{ emoji: RegisteredCustomEmoji; row: number; col: number; selected: boolean }>;
}

export interface CustomEmojiRenderLineOptions {
  /** Preserve this background beneath ready image placeholders. */
  imageBackground?: string;
  /** Restore this background immediately after each placeholder. */
  restoreBackground?: string;
}

export interface CustomEmojiImageRendererOptions {
  fetch?: typeof globalThis.fetch;
  onUpdate?: () => void;
}

export function discordCustomEmojiCdnUrl(emoji: Pick<DiscordCustomEmoji, "id">): string {
  return `https://cdn.discordapp.com/emojis/${emoji.id}.png?size=32&quality=lossless`;
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * Registry, downloader, and frame builder for custom emoji. Message layout uses
 * one BMP private-use marker per distinct emoji, so Vim history navigation sees
 * every image as one atomic character while terminal wrapping reserves its
 * square, two-column display footprint.
 */
export class CustomEmojiImageRenderer {
  private readonly byKey = new Map<string, RegisteredCustomEmoji>();
  private readonly byMarker = new Map<string, RegisteredCustomEmoji>();
  private enabled = false;
  private fetchImpl: typeof globalThis.fetch;
  private onUpdate: () => void;
  private lastVisibleImageIds = new Set<number>();

  constructor(options: CustomEmojiImageRendererOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.onUpdate = options.onUpdate ?? (() => {});
  }

  configure(options: CustomEmojiImageRendererOptions): void {
    if (options.fetch) this.fetchImpl = options.fetch;
    if (options.onUpdate) this.onUpdate = options.onUpdate;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.lastVisibleImageIds.clear();
    this.onUpdate();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  replaceTokens(text: string): string {
    return text.replace(CUSTOM_EMOJI_RE, (_raw, animated: string, name: string, id: string) => (
      this.markerFor({ id, name, animated: animated === "a" })
    ));
  }

  markerFor(emoji: RenderableCustomEmoji): string {
    // Keep the raw name/animation spelling per occurrence identity. Emoji can be
    // renamed, and yanking an older message should reproduce its original token.
    const key = `${emoji.animated ? "a" : "s"}:${emoji.name}:${emoji.id}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.marker;

    const offset = this.byKey.size;
    if (MARKER_FIRST + offset > MARKER_LAST) return LOADING_GLYPH;
    const registered: RegisteredCustomEmoji = {
      ...emoji,
      key,
      marker: String.fromCharCode(MARKER_FIRST + offset),
      imageId: IMAGE_ID_FIRST + offset,
      status: "idle",
      pngBase64: null,
    };
    this.byKey.set(key, registered);
    this.byMarker.set(registered.marker, registered);
    return registered.marker;
  }

  decodeMarkers(text: string): string {
    let result = "";
    for (const char of text) {
      const emoji = this.byMarker.get(char);
      result += emoji ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : char;
    }
    return result;
  }

  clipboardImageForMarker(marker: string): ClipboardImageAttachment | null {
    const emoji = this.byMarker.get(marker);
    if (emoji?.status !== "ready" || !emoji.pngBase64) return null;
    return {
      mediaType: "image/png",
      base64: emoji.pngBase64,
      sizeBytes: Buffer.from(emoji.pngBase64, "base64").length,
      filename: `${emoji.name}.png`,
    };
  }

  beginFrame(): CustomEmojiRenderBatch {
    return { placements: [] };
  }

  /** Replace markers in one rendered row and collect absolute cell placements. */
  renderLine(
    text: string,
    row: number,
    startCol: number,
    batch: CustomEmojiRenderBatch,
    options: CustomEmojiRenderLineOptions = {},
  ): string {
    let result = "";
    let chunkStart = 0;
    let col = startCol;
    let selected = false;

    for (let index = 0; index < text.length; index++) {
      const emoji = this.byMarker.get(text[index]!);
      if (!emoji) continue;

      const chunk = text.slice(chunkStart, index);
      result += chunk;
      col += termWidth(chunk);
      selected = selectionStateAfter(chunk, selected);

      if (this.enabled) this.ensureLoaded(emoji);
      if (this.enabled && emoji.status === "ready") {
        result += `${options.imageBackground ?? ""}${IMAGE_PLACEHOLDER}${options.restoreBackground ?? ""}`;
        batch.placements.push({ emoji, row, col, selected });
      } else {
        result += `${LOADING_GLYPH} `;
      }
      col += EMOJI_COLUMNS;
      chunkStart = index + 1;
    }

    return chunkStart === 0 ? text : result + text.slice(chunkStart);
  }

  finishFrame(batch: CustomEmojiRenderBatch): KittyGraphicsFrame {
    const placements = this.enabled ? batch.placements : [];
    const visibleImageIds = new Set(placements.map((placement) => placement.emoji.imageId));
    const enteringImageIds = new Set(
      [...visibleImageIds].filter((imageId) => !this.lastVisibleImageIds.has(imageId)),
    );
    const key = placements
      .map((placement) => `${placement.emoji.imageId}@${placement.row},${placement.col}:${placement.selected ? 1 : 0}`)
      .join(";");

    let payload = "";
    for (const imageId of enteringImageIds) {
      const emoji = placements.find((placement) => placement.emoji.imageId === imageId)?.emoji;
      if (emoji?.pngBase64) payload += kittyGraphicsTransmitPng(imageId, emoji.pngBase64);
    }
    payload += kittyGraphicsDeleteZ(EMOJI_Z_INDEX);
    for (const placement of placements) {
      payload += moveTo(placement.row, placement.col);
      payload += kittyGraphicsPlace(placement.emoji.imageId, {
        columns: EMOJI_COLUMNS,
        rows: EMOJI_ROWS,
        z: EMOJI_Z_INDEX,
        selected: placement.selected,
      });
    }

    this.lastVisibleImageIds = visibleImageIds;
    return { key, payload };
  }

  cleanupSequence(): string {
    this.lastVisibleImageIds.clear();
    return kittyGraphicsDeleteImageRange(IMAGE_ID_FIRST, IMAGE_ID_LAST);
  }

  private ensureLoaded(emoji: RegisteredCustomEmoji): void {
    if (emoji.status !== "idle") return;
    emoji.status = "loading";

    void this.fetchImpl(discordCustomEmojiCdnUrl(emoji), {
      headers: { Accept: "image/png" },
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Discord CDN returned ${response.status}`);
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > MAX_PNG_BYTES) throw new Error("Custom emoji PNG is too large");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_PNG_BYTES || !isPng(bytes)) {
        throw new Error("Discord CDN did not return a bounded PNG");
      }
      emoji.pngBase64 = bytes.toString("base64");
      emoji.status = "ready";
      this.onUpdate();
    }).catch(() => {
      emoji.status = "failed";
      emoji.pngBase64 = null;
    });
  }
}

export const customEmojiImages = new CustomEmojiImageRenderer();

export function replaceCustomEmojiTokens(text: string): string {
  return customEmojiImages.replaceTokens(text);
}

export function customEmojiMarker(emoji: RenderableCustomEmoji): string {
  return customEmojiImages.markerFor(emoji);
}

export function decodeCustomEmojiMarkers(text: string): string {
  return customEmojiImages.decodeMarkers(text);
}
