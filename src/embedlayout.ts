/**
 * Message-pane layout of one Discord embed: a left bar in the embed's colour,
 * provider/author/title rows, the description and fields, the footer, and its
 * pictures through the inline-image pipeline (a thumbnail at the right when
 * there is room, large images and video posters below).
 */

import type { DiscordMessageEmbed, DiscordMessageEmbedField } from "./discord";
import { embedHasText, embedHost, formatVideoDuration, isBareMediaEmbed, isVideoEmbed, type EmbedGroup, type EmbedMediaSource } from "./embeds";
import type { InlineChatImageReady, InlineChatImageState } from "./inlineimage";
import { fitPictureCells, inlineImageHasShape, inlineImagePlacementId, inlineImageShape, isPendingInlineImage } from "./inlineimage";
import { loadingLabel } from "./loading";
import { markdownWordWrap } from "./markdown";
import { sliceByWidth, termWidth, truncate } from "./textwidth";
import { ansiTrueColor, theme } from "./theme";

export interface EmbedImagePlacement {
  image: InlineChatImageReady;
  placementId: number;
  lineIndex: number;
  /** Cells from the start of the row (after the pane's one-column margin). */
  columnOffset: number;
  columns: number;
  rows: number;
}

export interface EmbedLayout {
  lines: string[];
  lineAnchors: string[];
  wrapContinuation: boolean[];
  inlineImages: EmbedImagePlacement[];
}

export interface EmbedLayoutOptions {
  messageId: string;
  /** Embed owner: the message id, or its forwarded copy's (embeds.ts). */
  occurrence: string;
  width: number;
  /** Row of the message this embed's first row lands on. */
  lineOffset: number;
  states: Readonly<Record<string, InlineChatImageState>>;
  /** Ctrl+O: provider rows, timestamps and uncapped descriptions/field values. */
  showDetails: boolean;
  /** GIFs play in their boxes (st video): a gifv poster has no "▶ GIF" row. */
  gifsPlay?: boolean;
  loadingFrameIndex: number;
  cellWidthPixels: number;
  cellHeightPixels: number;
  /** Style that restores the message's text colour and background. */
  restore: string;
  /** Mentions, custom emoji and link colours, as message text gets them. */
  formatText: (text: string, restore: string) => string;
  /** The embed's own URL is already visible on the line above it. */
  urlShown: boolean;
}

/** Widest an embed gets (bar included), like Discord's fixed-width card. */
const EMBED_MAX_WIDTH = 80;
const BAR = "▎";
const BAR_WIDTH = 2;
const DESCRIPTION_MAX_LINES = 6;
const FIELD_VALUE_MAX_LINES = 4;
const TITLE_MAX_LINES = 2;
const INLINE_FIELD_MIN_WIDTH = 16;
const INLINE_FIELD_GAP = 2;
const MAX_INLINE_FIELDS_PER_ROW = 3;
const IMAGE_MAX_COLUMNS = 60;
const IMAGE_MAX_ROWS = 10;
const THUMBNAIL_MAX_COLUMNS = 16;
const THUMBNAIL_MAX_ROWS = 5;
const THUMBNAIL_GAP = 2;
/** Narrowest text column worth keeping beside a thumbnail; narrower puts it below. */
const THUMBNAIL_MIN_TEXT_WIDTH = 28;
const GALLERY_GAP = 1;

interface Row {
  text: string;
  anchor: string;
  cont: boolean;
}

function sanitize(text: string | null | undefined): string {
  return (text ?? "").replace(/\t/g, "  ").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

function oneLine(text: string | null | undefined): string {
  return sanitize(text).replace(/\s+/g, " ").trim();
}

const MASKED_LINK_RE = /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\)/g;

/** `[label](url)` reads as its label in the link colour (the URL is not drawn; historyopenable.ts opens it). */
function maskedLinks(text: string, restore: string): string {
  return text.replace(MASKED_LINK_RE, (_match, label: string) => `${theme.accent}${label}${restore}`);
}

/** The masked links of embed text, in order: what each drawn label opens. */
export function embedMaskedLinks(text: string | null | undefined): Array<{ label: string; url: string }> {
  return [...sanitize(text).matchAll(MASKED_LINK_RE)].map((match) => ({ label: match[1]!, url: match[2]! }));
}

/**
 * Fit a picture into at most `maxColumns` x `maxRows` cells, keeping its
 * pixel aspect ratio (inlineImageCellLayout with embed-sized bounds).
 */
export function fitImageCells(
  image: Pick<InlineChatImageReady, "pixelWidth" | "pixelHeight" | "sourcePixelWidth" | "sourcePixelHeight">,
  maxColumns: number,
  maxRows: number,
  cellWidthPixels: number,
  cellHeightPixels: number,
): { columns: number; rows: number } {
  return fitPictureCells(image.pixelWidth, image.pixelHeight, maxColumns, maxRows, cellWidthPixels, cellHeightPixels, 1);
}

function wrapMarkdown(text: string, width: number, restore: string): { lines: string[]; cont: boolean[] } {
  if (width <= 0) return { lines: [], cont: [] };
  const wrapped = markdownWordWrap(text, width, restore);
  return { lines: wrapped.lines, cont: wrapped.cont };
}

/** Keep the first `max` rows; the last one kept ends in an ellipsis. */
function capRows(lines: string[], cont: boolean[], max: number, width: number): { lines: string[]; cont: boolean[] } {
  if (lines.length <= max) return { lines, cont };
  const kept = lines.slice(0, max);
  const last = kept[max - 1] ?? "";
  kept[max - 1] = termWidth(last) + 1 <= width ? `${last}…` : `${truncate(last, Math.max(1, width - 1))}…`;
  return { lines: kept, cont: cont.slice(0, max) };
}

function padTo(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - termWidth(text)))}`;
}

/** Cut a styled row to `width` cells, closing any style it was cut inside. */
function clip(text: string, width: number, restore: string): string {
  if (termWidth(text) <= width) return text;
  return `${sliceByWidth(text, width)[0]}${theme.reset}${restore}`;
}

export function formatEmbedTimestamp(timestamp: number, nowMs = Date.now()): string {
  const date = new Date(timestamp);
  const now = new Date(nowMs);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `Today at ${time}`;
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${month} ${date.getDate()}${year}, ${time}`;
}

function statusLabel(state: InlineChatImageState | undefined, source: EmbedMediaSource, embed: DiscordMessageEmbed, loadingFrameIndex: number): { text: string; color: string } {
  const host = embedHost(embed.url) || embedHost(source.media.url);
  const what = source.role === "poster" ? (embed.type === "gifv" ? "GIF" : "video") : source.role === "thumbnail" ? "thumbnail" : "image";
  if (state?.phase === "loading") return { text: loadingLabel(`Loading ${what}…`, isPendingInlineImage(state) ? 0 : loadingFrameIndex), color: theme.muted };
  if (state?.phase === "waiting") return { text: `Waiting for connection to load ${what}…`, color: theme.muted };
  if (state?.phase === "error" && source.role !== "poster") {
    const reason = oneLine(state.error).slice(0, 120) || "unknown error";
    return { text: `✗ Could not display ${what}: ${reason}`, color: theme.error };
  }
  // Hidden (/images hide), not loaded yet, or a poster that could not be made.
  const duration = source.role === "poster" ? formatVideoDuration(embed.video?.durationSecs) : "";
  const icon = source.role === "poster" ? "▶" : "🖼";
  return { text: [`${icon} ${what}`, host, duration].filter(Boolean).join(" · "), color: theme.muted };
}

function fieldRows(
  fields: readonly DiscordMessageEmbedField[],
  width: number,
  options: EmbedLayoutOptions,
  anchor: (part: string, index: number) => string,
): Row[] {
  const rows: Row[] = [];
  const valueRestore = options.restore;
  const renderField = (field: DiscordMessageEmbedField, columnWidth: number): string[] => {
    const name = oneLine(field.name);
    const nameLines = name ? [`${theme.bold}${truncate(options.formatText(name, `${theme.bold}${valueRestore}`), columnWidth)}${theme.boldOff}${theme.reset}${valueRestore}`] : [];
    const value = sanitize(field.value).trim();
    const wrapped = value ? wrapMarkdown(options.formatText(maskedLinks(value, valueRestore), valueRestore), columnWidth, valueRestore) : { lines: [], cont: [] };
    const capped = options.showDetails ? wrapped : capRows(wrapped.lines, wrapped.cont, FIELD_VALUE_MAX_LINES, columnWidth);
    return [...nameLines, ...capped.lines.map((line) => clip(line, columnWidth, valueRestore))];
  };

  let fieldIndex = 0;
  let rowIndex = 0;
  while (fieldIndex < fields.length) {
    const field = fields[fieldIndex]!;
    let group = [field];
    if (field.inline) {
      group = [];
      while (fieldIndex + group.length < fields.length && fields[fieldIndex + group.length]!.inline && group.length < MAX_INLINE_FIELDS_PER_ROW) {
        group.push(fields[fieldIndex + group.length]!);
      }
    }
    // Inline fields take a third of the width each, as in Discord; fewer
    // columns when a third is too narrow to read (the rest start a new row).
    let perRow = MAX_INLINE_FIELDS_PER_ROW;
    while (perRow > 1 && Math.floor((width - INLINE_FIELD_GAP * (perRow - 1)) / perRow) < INLINE_FIELD_MIN_WIDTH) perRow--;
    group = group.slice(0, perRow);
    fieldIndex += group.length;
    const columnWidth = field.inline ? Math.floor((width - INLINE_FIELD_GAP * (perRow - 1)) / perRow) : width;
    const columns = group.map((entry) => renderField(entry, columnWidth));
    const height = Math.max(0, ...columns.map((column) => column.length));
    for (let line = 0; line < height; line++) {
      const text = columns
        .map((column, index) => (index === columns.length - 1 ? column[line] ?? "" : padTo(column[line] ?? "", columnWidth)))
        .join(" ".repeat(INLINE_FIELD_GAP));
      rows.push({ text, anchor: anchor(`field${rowIndex}`, line), cont: false });
    }
    rowIndex++;
  }
  return rows;
}

/** Rows and image placements for one embed group, `width` cells wide. */
export function layoutEmbed(group: EmbedGroup, options: EmbedLayoutOptions): EmbedLayout {
  const { embed } = group;
  const anchorBase = `msg:${options.messageId}:embed:${encodeURIComponent(options.occurrence)}:${group.index}`;
  const anchor = (part: string, index: number): string => `${anchorBase}:${part}:${index}`;
  const bare = isBareMediaEmbed(embed);
  const indent = bare ? 0 : BAR_WIDTH;
  const contentWidth = Math.max(1, Math.min(options.width, EMBED_MAX_WIDTH) - indent);
  const restore = options.restore;
  const barColor = typeof embed.color === "number" ? ansiTrueColor(embed.color) : theme.muted;
  const bar = bare ? "" : `${barColor}${BAR}${theme.reset}${restore} `;

  const out: EmbedLayout = { lines: [], lineAnchors: [], wrapContinuation: [], inlineImages: [] };
  const push = (row: Row): void => {
    out.lines.push(`${bar}${row.text}`);
    out.lineAnchors.push(row.anchor);
    out.wrapContinuation.push(row.cont);
  };
  const place = (image: InlineChatImageReady, sourceId: string, lineIndex: number, columnOffset: number, cells: { columns: number; rows: number }): void => {
    out.inlineImages.push({
      image,
      // Distinct per occurrence and role: the same picture can be both a thumbnail and opened.
      placementId: inlineImagePlacementId(image.imageId, `${options.messageId}:${sourceId}`),
      lineIndex: options.lineOffset + lineIndex,
      columnOffset,
      columns: cells.columns,
      rows: cells.rows,
    });
  };

  const stateOf = (source: EmbedMediaSource | undefined): InlineChatImageState | null => {
    const state = source ? options.states[source.attachment.id] : undefined;
    return state && state.sourceUrl === source!.attachment.url ? state : null;
  };
  const readyState = (source: EmbedMediaSource | undefined): InlineChatImageReady | null => {
    const state = stateOf(source);
    return state?.phase === "ready" ? state : null;
  };
  /** Loading, waiting or about to load, with a size known before it arrives: it holds its final box. */
  const holdsBox = (source: EmbedMediaSource | undefined): boolean => {
    const state = stateOf(source);
    return (state?.phase === "loading" || state?.phase === "waiting") && inlineImageShape(source!.attachment) !== null;
  };
  /**
   * The cells a picture takes within these bounds: its final box while it
   * loads, the same box once drawn when it has the shape it was expected to
   * (otherwise its own), or null while it holds none.
   */
  const cellsOf = (source: EmbedMediaSource | undefined, maxColumns: number, maxRows: number): { columns: number; rows: number } | null => {
    const ready = readyState(source);
    const shape = source ? inlineImageShape(source.attachment) : null;
    const box = shape ? { pixelWidth: shape.width, pixelHeight: shape.height } : null;
    const fit = ready ? (box && inlineImageHasShape(shape!, ready) ? box : ready) : holdsBox(source) ? box : null;
    return fit ? fitImageCells(fit, maxColumns, maxRows, options.cellWidthPixels, options.cellHeightPixels) : null;
  };

  const thumbnail = group.media.find((source) => source.role === "thumbnail");
  const largeMedia = group.media.filter((source) => source.role !== "thumbnail");
  const thumbnailReady = readyState(thumbnail);
  const thumbnailCells = cellsOf(thumbnail, THUMBNAIL_MAX_COLUMNS, THUMBNAIL_MAX_ROWS);
  const thumbnailBeside = Boolean(thumbnailCells && contentWidth - thumbnailCells.columns - THUMBNAIL_GAP >= THUMBNAIL_MIN_TEXT_WIDTH);
  const textWidth = thumbnailBeside ? contentWidth - thumbnailCells!.columns - THUMBNAIL_GAP : contentWidth;

  // Text rows.
  const text: Row[] = [];
  const provider = oneLine(embed.providerName);
  const author = oneLine(embed.authorName);
  const title = oneLine(embed.title);
  // The provider names the source only when nothing else does (a bare gif needs none).
  if (provider && (options.showDetails || (!author && !title && !bare))) {
    text.push({ text: `${theme.muted}${truncate(provider, textWidth)}${theme.reset}${restore}`, anchor: anchor("provider", 0), cont: false });
  }
  if (author) {
    const authorRestore = `${theme.bold}${restore}`;
    text.push({ text: `${theme.bold}${truncate(options.formatText(author, authorRestore), textWidth)}${theme.boldOff}${theme.reset}${restore}`, anchor: anchor("author", 0), cont: false });
  }
  if (title) {
    const titleColor = embed.url ? theme.accent : theme.text;
    const titleRestore = `${theme.bold}${titleColor}`;
    const titleLines = wrapMarkdown(options.formatText(title, titleRestore), textWidth, titleRestore);
    const wrapped = capRows(titleLines.lines, titleLines.cont, TITLE_MAX_LINES, textWidth);
    wrapped.lines.forEach((line, index) => text.push({
      text: `${theme.bold}${titleColor}${clip(line, textWidth, titleRestore)}${theme.boldOff}${theme.reset}${restore}`,
      anchor: anchor("title", index),
      cont: wrapped.cont[index] ?? false,
    }));
  }
  const description = sanitize(embed.description).trim();
  if (description) {
    const wrapped = wrapMarkdown(options.formatText(maskedLinks(description, restore), restore), textWidth, restore);
    const capped = options.showDetails ? wrapped : capRows(wrapped.lines, wrapped.cont, DESCRIPTION_MAX_LINES, textWidth);
    capped.lines.forEach((line, index) => text.push({
      text: `${clip(line, textWidth, restore)}${theme.reset}${restore}`,
      anchor: anchor("description", index),
      cont: capped.cont[index] ?? false,
    }));
  }
  if (embed.fields?.length) text.push(...fieldRows(embed.fields, textWidth, options, anchor));
  const footerText = oneLine(embed.footer?.text);
  const timestamp = options.showDetails && typeof embed.timestamp === "number" ? formatEmbedTimestamp(embed.timestamp) : "";
  const footer = [footerText, timestamp].filter(Boolean).join(" • ");

  // Nothing of its own but its link: name the host, unless the link is right above.
  if (text.length === 0 && !footer && group.media.length === 0 && !isVideoEmbed(embed)) {
    const host = embedHost(embed.url);
    if (!host || options.urlShown) return out;
    text.push({ text: `${theme.muted}${truncate(host, textWidth)}${theme.reset}${restore}`, anchor: anchor("host", 0), cont: false });
  }

  if (thumbnailBeside && thumbnailCells && thumbnail) {
    const columnOffset = indent + textWidth + THUMBNAIL_GAP;
    const sourceId = encodeURIComponent(thumbnail.attachment.id);
    // Rows below the text keep the picture's own anchor: Enter there opens it.
    while (text.length < thumbnailCells.rows) {
      text.push({ text: "", anchor: `msg:${options.messageId}:image:${sourceId}:${text.length}`, cont: false });
    }
    // Held blank while it loads: the text beside it is the same either way.
    if (thumbnailReady) place(thumbnailReady, thumbnail.attachment.id, out.lines.length, columnOffset, thumbnailCells);
    // The rows beside it end exactly where it starts (render.ts restores the cells under it).
    for (let index = 0; index < thumbnailCells.rows; index++) text[index] = { ...text[index]!, text: padTo(text[index]!.text, textWidth + THUMBNAIL_GAP) };
  }
  for (const row of text) push(row);

  // Pictures below: a thumbnail without room beside, the large image or poster, a gallery.
  const below = [...largeMedia, ...(thumbnail && !thumbnailBeside ? [thumbnail] : [])];
  const entries = below.map((source) => ({ source, state: readyState(source) }));
  const status = (source: EmbedMediaSource) => statusLabel(options.states[source.attachment.id], source, embed, options.loadingFrameIndex);
  // Drawn, or holding its box: two or more images make a gallery.
  const gallery = entries.filter((entry) => entry.source.role === "image" && (entry.state || holdsBox(entry.source)));
  if (gallery.length > 1) {
    // Side by side, up to two per row, like Discord's mosaic.
    for (let start = 0; start < gallery.length; start += 2) {
      const pair = gallery.slice(start, start + 2);
      const columnWidth = Math.floor((Math.min(contentWidth, IMAGE_MAX_COLUMNS) - GALLERY_GAP * (pair.length - 1)) / pair.length);
      const cells = pair.map((entry) => cellsOf(entry.source, columnWidth, Math.floor(IMAGE_MAX_ROWS / 2))!);
      const height = Math.max(...cells.map((cell) => cell.rows));
      const first = out.lines.length;
      let offset = indent;
      // The status of each picture still loading, at the top of its cells.
      const statuses: string[] = [];
      pair.forEach((entry, index) => {
        const cell = cells[index]!;
        if (entry.state) place(entry.state, entry.source.attachment.id, first, offset, cell);
        const label = entry.state ? null : status(entry.source);
        statuses.push(label ? `${label.color}${padTo(truncate(label.text, cell.columns), cell.columns)}${theme.reset}${restore}` : " ".repeat(cell.columns));
        offset += cell.columns + GALLERY_GAP;
      });
      const statusRow = pair.every((entry) => entry.state) ? "" : statuses.join(" ".repeat(GALLERY_GAP));
      const sourceId = encodeURIComponent(pair[0]!.source.attachment.id);
      for (let row = 0; row < height; row++) push({ text: row === 0 ? statusRow : "", anchor: `msg:${options.messageId}:image:${sourceId}:${row}`, cont: false });
    }
  }
  for (const { source, state } of entries) {
    if (gallery.length > 1 && gallery.some((entry) => entry.source === source)) continue;
    const sourceId = encodeURIComponent(source.attachment.id);
    const thumbnailRole = source.role === "thumbnail";
    const cells = cellsOf(
      source,
      Math.min(contentWidth, thumbnailRole ? THUMBNAIL_MAX_COLUMNS * 2 : IMAGE_MAX_COLUMNS),
      thumbnailRole ? THUMBNAIL_MAX_ROWS * 2 : IMAGE_MAX_ROWS,
    );
    if (!cells) {
      // A thumbnail shows only once drawn: no placeholder rows to come and go.
      if (thumbnailRole && (embedHasText(embed) || below.length > 1)) continue;
      const label = status(source);
      push({ text: `${label.color}${truncate(label.text, contentWidth)}${theme.reset}${restore}`, anchor: `msg:${options.messageId}:image-status:${sourceId}:0`, cont: false });
      continue;
    }
    if (state) place(state, source.attachment.id, out.lines.length, indent, cells);
    // Held while it loads, its status on the first row: nothing moves when it lands.
    const label = state ? null : status(source);
    for (let row = 0; row < cells.rows; row++) {
      const text = row === 0 && label ? `${label.color}${truncate(label.text, contentWidth)}${theme.reset}${restore}` : "";
      push({ text, anchor: `msg:${options.messageId}:image:${sourceId}:${row}`, cont: false });
    }
    if (source.role === "poster" && !(options.gifsPlay && embed.type === "gifv")) {
      const duration = formatVideoDuration(embed.video?.durationSecs);
      const play = embed.type === "gifv" ? "▶ GIF" : "▶ Play";
      const playLabel = `${theme.accent}${play}${theme.reset}${restore}${duration ? `${theme.muted} · ${duration}${theme.reset}${restore}` : ""}`;
      push({ text: playLabel, anchor: anchor("video", 0), cont: false });
    }
  }
  // A video with no picture to show still gets its play row.
  if (isVideoEmbed(embed) && !group.media.some((source) => source.role === "poster")) {
    const duration = formatVideoDuration(embed.video?.durationSecs);
    const host = embedHost(embed.url) || embedHost(embed.video?.url);
    const details = [host, duration].filter(Boolean).join(" · ");
    const label = `${theme.accent}▶ Play video${theme.reset}${restore}${details ? `${theme.muted} · ${details}${theme.reset}${restore}` : ""}`;
    push({ text: label, anchor: anchor("video", 0), cont: false });
  }
  // Last, under the pictures, as in Discord.
  if (footer) push({ text: `${theme.muted}${truncate(footer, contentWidth)}${theme.reset}${restore}`, anchor: anchor("footer", 0), cont: false });
  return out;
}
