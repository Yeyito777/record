/** Kitty graphics-protocol transport for expanded chat attachments. */

import type { InlineChatImageReady } from "./inlineimage";
import { moveTo } from "./terminal";

const APC = "\x1b_G";
const ST = "\x1b\\";
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const BASE64_CHUNK_CHARS = 4096;
const MAX_IDLE_IMAGES = 64;
const MAX_IDLE_IMAGE_BYTES = 32 * 1024 * 1024;

export interface InlineTerminalImagePlacement {
  image: InlineChatImageReady;
  placementId: number;
  row: number;
  col: number;
  columns: number;
  rows: number;
  sourceY?: number;
  sourceHeight?: number;
  /** Higher values composite above ordinary chat previews (z=1). */
  z?: number;
  /** Ask supporting terminals to tint this placement as one selected object. */
  selected?: boolean;
}

interface TerminalImageSyncState {
  /** In LRU order; bytes charge both retained base64 and terminal RGBA pixels. */
  images: Map<number, { fingerprint: string; bytes: number }>;
  placements: Map<string, string>;
}

export interface InlineTerminalImageSyncOptions {
  /** Keep established placements but defer creating or moving them. */
  allowPlacementUpdates?: boolean;
  /**
   * Send every placement again even if it looks unchanged: the screen was
   * repainted from scratch (resize, alternate-screen re-entry), which can
   * drop or move placements behind our back. Image data stays resident.
   */
  replacePlacements?: boolean;
  /**
   * Rows (1-based, inclusive) a region scroll moved in this frame. Placements
   * anchored there moved (or left) with them, so they are placed again even
   * when this frame wants them where they were.
   */
  movedRows?: { start: number; end: number } | null;
  /**
   * Last row (1-based) existing placements may reach while placement updates
   * are deferred (allowPlacementUpdates false): one placed further down (an
   * image placed past the pane for a smooth-scroll glide) is deleted rather
   * than left drawing over the rows below. Desired placements may still
   * reach further (they are placed only when updates are allowed).
   */
  maxRow?: number;
  /** Bound on images kept in the terminal with no placement (default 64). */
  maxIdleImages?: number;
  /** Bound on their charged bytes, base64 plus RGBA pixels (default 32 MiB). */
  maxIdleBytes?: number;
}

const syncStates = new WeakMap<object, TerminalImageSyncState>();

function graphicsCommand(control: string, payload = ""): string {
  return `${APC}${control};${payload}${ST}`;
}

export function transmitInlinePng(image: InlineChatImageReady): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < image.pngBase64.length; offset += BASE64_CHUNK_CHARS) {
    chunks.push(image.pngBase64.slice(offset, offset + BASE64_CHUNK_CHARS));
  }
  if (chunks.length <= 1) {
    return graphicsCommand(`a=t,t=d,f=100,i=${image.imageId},q=2`, chunks[0] ?? "");
  }

  return chunks.map((chunk, index) => {
    if (index === 0) {
      return graphicsCommand(`a=t,t=d,f=100,i=${image.imageId},q=2,m=1`, chunk);
    }
    const final = index === chunks.length - 1;
    return graphicsCommand(`m=${final ? 0 : 1},q=2`, chunk);
  }).join("");
}

function hardDeleteImage(imageId: number): string {
  return graphicsCommand(`a=d,d=I,i=${imageId},q=2`);
}

function deletePlacement(imageId: number, placementId: number): string {
  return graphicsCommand(`a=d,d=i,i=${imageId},p=${placementId},q=2`);
}

function placementKey(placement: Pick<InlineTerminalImagePlacement, "image" | "placementId">): string {
  return `${placement.image.imageId}:${placement.placementId}`;
}

function placementFingerprint(placement: InlineTerminalImagePlacement): string {
  return [
    placement.row,
    placement.col,
    placement.columns,
    placement.rows,
    placement.sourceY ?? 0,
    placement.sourceHeight ?? placement.image.pixelHeight,
    placement.selected ? 1 : 0,
    placement.z ?? 1,
  ].join(":");
}

function placeImage(placement: InlineTerminalImagePlacement): string {
  const sourceY = Math.max(0, Math.floor(placement.sourceY ?? 0));
  const sourceHeight = Math.max(1, Math.floor(placement.sourceHeight ?? placement.image.pixelHeight));
  const crop = sourceY > 0 || sourceHeight < placement.image.pixelHeight
    ? `,y=${sourceY},h=${sourceHeight}`
    : "";
  const selected = placement.selected ? ",V=1" : "";
  return moveTo(placement.row, placement.col)
    + graphicsCommand(
      // q=1 suppresses successful replies but lets the terminal report an
      // evicted image ID. handleInlineTerminalImageResponse then retries it.
      `a=p,i=${placement.image.imageId},p=${placement.placementId},c=${placement.columns},r=${placement.rows}${crop},C=1,z=${Math.trunc(placement.z ?? 1)}${selected},q=1`,
    );
}

function imageFingerprint(image: InlineChatImageReady): string {
  return image.pngBase64;
}

/** Terminal commands for one reconciliation, split by visibility. */
export interface InlineTerminalImageUpdate {
  /**
   * Data for images with no current placement. Sending it changes nothing on
   * screen, so it may precede a synchronized frame instead of stretching it.
   */
  transmit: string;
  /** Placement changes, to present atomically with the frame's text. */
  update: string;
}

/**
 * Reconcile terminal-owned image data and placements with the current chat
 * viewport. Recently used data survives chat switches; only placements are
 * removed. A bounded idle LRU keeps this from retaining every visited image.
 * The returned commands are recorded as sent and must be written in order.
 */
export function planInlineTerminalImages(
  owner: object,
  images: readonly InlineChatImageReady[],
  placements: readonly InlineTerminalImagePlacement[],
  options: InlineTerminalImageSyncOptions = {},
): InlineTerminalImageUpdate {
  let state = syncStates.get(owner);
  if (!state) {
    state = { images: new Map(), placements: new Map() };
    syncStates.set(owner, state);
  }

  const transmit: string[] = [];
  const out: string[] = [];
  const desiredPlacements = new Map(placements.map((placement) => [placementKey(placement), placement]));
  const desiredImageIds = new Set(placements.map((placement) => placement.image.imageId));

  const retransmitted = new Set<number>();
  for (const image of images) {
    if (!desiredImageIds.has(image.imageId)) continue;
    const fingerprint = imageFingerprint(image);
    const resident = state.images.get(image.imageId);
    if (resident?.fingerprint === fingerprint) {
      state.images.delete(image.imageId);
      state.images.set(image.imageId, resident);
      continue;
    }
    const placed = [...state.placements.keys()].some((key) => key.startsWith(`${image.imageId}:`));
    // Replacing a placed image's data is visible, so it stays in the frame.
    (placed ? out : transmit).push(transmitInlinePng(image));
    state.images.delete(image.imageId);
    state.images.set(image.imageId, {
      fingerprint,
      bytes: image.pngBase64.length * 2 + image.pixelWidth * image.pixelHeight * 4,
    });
    retransmitted.add(image.imageId);
    for (const key of [...state.placements.keys()]) {
      if (key.startsWith(`${image.imageId}:`)) state.placements.delete(key);
    }
  }

  for (const [key] of state.placements) {
    if (desiredPlacements.has(key)) continue;
    const [imageIdText, placementIdText] = key.split(":");
    out.push(deletePlacement(Number(imageIdText), Number(placementIdText)));
    state.placements.delete(key);
  }

  const moved = options.movedRows;
  for (const placement of placements) {
    const key = placementKey(placement);
    const fingerprint = placementFingerprint(placement);
    const placedRow = Number(state.placements.get(key)?.split(":", 1)[0]);
    const scrolled = !!moved && placedRow >= moved.start && placedRow <= moved.end;
    if (!options.replacePlacements && !retransmitted.has(placement.image.imageId)
      && state.placements.get(key) === fingerprint && !scrolled) continue;
    if (options.allowPlacementUpdates === false) {
      const placed = state.placements.get(key)?.split(":").map(Number);
      if (placed && options.maxRow !== undefined && placed[0]! + placed[3]! - 1 > options.maxRow) {
        out.push(deletePlacement(placement.image.imageId, placement.placementId));
        state.placements.delete(key);
      }
      continue;
    }
    out.push(placeImage(placement));
    state.placements.set(key, fingerprint);
  }

  // Visible images are pinned; the *additional* idle working set is bounded.
  // Prune only after removing old placements so hard deletes cannot erase a
  // current placement. Large modal images are reclaimed as soon as they close.
  const maxIdleImages = options.maxIdleImages ?? MAX_IDLE_IMAGES;
  const maxIdleBytes = options.maxIdleBytes ?? MAX_IDLE_IMAGE_BYTES;
  const idle = [...state.images].filter(([imageId]) => !desiredImageIds.has(imageId));
  let idleBytes = idle.reduce((sum, [, image]) => sum + image.bytes, 0);
  let idleCount = idle.length;
  const evict = (imageId: number, bytes: number) => {
    out.push(hardDeleteImage(imageId));
    state.images.delete(imageId);
    idleBytes -= bytes;
    idleCount--;
  };
  // An oversized modal must not flush all the smaller cached chat previews.
  for (const [imageId, image] of idle) {
    if (image.bytes > maxIdleBytes) evict(imageId, image.bytes);
  }
  for (const [imageId, image] of idle) {
    if (idleCount <= maxIdleImages && idleBytes <= maxIdleBytes) break;
    if (state.images.has(imageId)) evict(imageId, image.bytes);
  }

  const wrap = (commands: string[]) => commands.length > 0 ? `${SAVE_CURSOR}${commands.join("")}${RESTORE_CURSOR}` : "";
  return { transmit: wrap(transmit), update: wrap(out) };
}

export function syncInlineTerminalImages(
  owner: object,
  images: readonly InlineChatImageReady[],
  placements: readonly InlineTerminalImagePlacement[],
  write: (payload: string) => void = (payload) => { process.stdout.write(payload); },
  options: InlineTerminalImageSyncOptions = {},
): void {
  const { transmit, update } = planInlineTerminalImages(owner, images, placements, options);
  if (transmit || update) write(transmit + update);
}

/** Image id of a Kitty "image not found" placement reply, else null. */
export function terminalImageNotFoundId(sequence: string): number | null {
  const match = /^\x1b_Gi=(\d+)(?:,p=\d+)?;(ENOENT:image not found)\x1b\\$/.exec(sequence);
  if (!match) return null;
  const imageId = Number(match[1]);
  return Number.isSafeInteger(imageId) && imageId > 0 ? imageId : null;
}

/**
 * Consume a Kitty placement failure. st retains explicitly addressed image
 * data after a soft placement deletion, so viewport re-entry normally needs
 * only a placement command. If memory pressure really did evict the image,
 * forget its residency here; the next render retransmits it exactly once.
 */
export function handleInlineTerminalImageResponse(owner: object, sequence: string): boolean {
  const imageId = terminalImageNotFoundId(sequence);
  if (imageId === null) return false;

  const state = syncStates.get(owner);
  if (!state) return true;
  state.images.delete(imageId);
  for (const key of [...state.placements.keys()]) {
    if (key.startsWith(`${imageId}:`)) state.placements.delete(key);
  }
  return true;
}

export function disposeInlineTerminalImages(
  owner: object,
  write: (payload: string) => void = (payload) => { process.stdout.write(payload); },
): void {
  const state = syncStates.get(owner);
  if (!state) return;
  const payload = [...state.images.keys()].map(hardDeleteImage).join("");
  syncStates.delete(owner);
  if (payload) write(`${SAVE_CURSOR}${payload}${RESTORE_CURSOR}`);
}

export function queryTerminalCellSize(): string {
  return "\x1b[16t";
}

export function parseTerminalCellSize(sequence: string): { width: number; height: number } | null {
  const match = /^\x1b\[6;(\d+);(\d+)t$/.exec(sequence);
  if (!match) return null;
  const height = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}
