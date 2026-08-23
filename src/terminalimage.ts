/** Kitty graphics-protocol transport for expanded chat attachments. */

import type { InlineChatImageReady } from "./inlineimage";
import { moveTo } from "./terminal";

const APC = "\x1b_G";
const ST = "\x1b\\";
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const BASE64_CHUNK_CHARS = 4096;

export interface InlineTerminalImagePlacement {
  image: InlineChatImageReady;
  placementId: number;
  row: number;
  col: number;
  columns: number;
  rows: number;
  sourceY?: number;
  sourceHeight?: number;
}

interface TerminalImageSyncState {
  images: Map<number, string>;
  placements: Map<string, string>;
}

export interface InlineTerminalImageSyncOptions {
  /** Keep established placements but defer creating or moving them. */
  allowPlacementUpdates?: boolean;
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
  ].join(":");
}

function placeImage(placement: InlineTerminalImagePlacement): string {
  const sourceY = Math.max(0, Math.floor(placement.sourceY ?? 0));
  const sourceHeight = Math.max(1, Math.floor(placement.sourceHeight ?? placement.image.pixelHeight));
  const crop = sourceY > 0 || sourceHeight < placement.image.pixelHeight
    ? `,y=${sourceY},h=${sourceHeight}`
    : "";
  return moveTo(placement.row, placement.col)
    + graphicsCommand(
      // q=1 suppresses successful replies but lets the terminal report an
      // evicted image ID. handleInlineTerminalImageResponse then retries it.
      `a=p,i=${placement.image.imageId},p=${placement.placementId},c=${placement.columns},r=${placement.rows}${crop},C=1,z=1,q=1`,
    );
}

function imageFingerprint(image: InlineChatImageReady): string {
  return image.pngBase64;
}

/**
 * Reconcile terminal-owned image data and placements with the current chat
 * viewport. Image bytes are sent only once; scrolling normally emits only a
 * small placement command.
 */
export function syncInlineTerminalImages(
  owner: object,
  images: readonly InlineChatImageReady[],
  placements: readonly InlineTerminalImagePlacement[],
  write: (payload: string) => void = (payload) => { process.stdout.write(payload); },
  options: InlineTerminalImageSyncOptions = {},
): void {
  let state = syncStates.get(owner);
  if (!state) {
    state = { images: new Map(), placements: new Map() };
    syncStates.set(owner, state);
  }

  const out: string[] = [];
  const currentImages = new Map(images.map((image) => [image.imageId, image]));
  const desiredPlacements = new Map(placements.map((placement) => [placementKey(placement), placement]));
  const desiredImageIds = new Set(placements.map((placement) => placement.image.imageId));

  for (const imageId of state.images.keys()) {
    if (currentImages.has(imageId)) continue;
    out.push(hardDeleteImage(imageId));
    state.images.delete(imageId);
    for (const key of [...state.placements.keys()]) {
      if (key.startsWith(`${imageId}:`)) state.placements.delete(key);
    }
  }

  const retransmitted = new Set<number>();
  for (const image of images) {
    const fingerprint = imageFingerprint(image);
    if (state.images.get(image.imageId) === fingerprint) continue;
    if (!desiredImageIds.has(image.imageId)) continue;
    out.push(transmitInlinePng(image));
    state.images.set(image.imageId, fingerprint);
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

  for (const placement of placements) {
    const key = placementKey(placement);
    const fingerprint = placementFingerprint(placement);
    if (!retransmitted.has(placement.image.imageId) && state.placements.get(key) === fingerprint) continue;
    if (options.allowPlacementUpdates === false) continue;
    out.push(placeImage(placement));
    state.placements.set(key, fingerprint);
  }

  if (out.length > 0) write(`${SAVE_CURSOR}${out.join("")}${RESTORE_CURSOR}`);
}

/**
 * Consume a Kitty placement failure. st retains explicitly addressed image
 * data after a soft placement deletion, so viewport re-entry normally needs
 * only a placement command. If memory pressure really did evict the image,
 * forget its residency here; the next render retransmits it exactly once.
 */
export function handleInlineTerminalImageResponse(owner: object, sequence: string): boolean {
  const match = /^\x1b_Gi=(\d+)(?:,p=\d+)?;(ENOENT:image not found)\x1b\\$/.exec(sequence);
  if (!match) return false;
  const imageId = Number(match[1]);
  if (!Number.isSafeInteger(imageId) || imageId <= 0) return false;

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
