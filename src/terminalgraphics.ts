/** Kitty terminal graphics protocol helpers and capability detection. */

const ESC = "\x1b";
const APC = `${ESC}_G`;
const ST = `${ESC}\\`;
const GRAPHICS_QUERY_IMAGE_ID = 0x6ffffffe;
const MAX_CHUNK_CHARS = 4096;
const DEFAULT_QUERY_TIMEOUT_MS = 1500;

// A valid, transparent 1x1 PNG. Query actions decode and validate the payload
// without retaining it in the terminal's image store.
const QUERY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";

export interface KittyGraphicsFrame {
  /** Stable identity used by the retained frame renderer. */
  key: string;
  /** Commands needed to transition to this set of placements. */
  payload: string;
  /** Placement-only redraw used to repair terminal cursor overlay damage. */
  repaintPayload?: string;
  /** Absolute terminal cells occupied by this frame's placements. */
  cells?: Array<{ row: number; startCol: number; endCol: number }>;
}

export interface TerminalGraphicsClientOptions {
  write: (sequence: string) => void;
  onSupportChanged: (supported: boolean) => void;
  queryTimeoutMs?: number;
}

function uint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a non-zero uint32`);
  }
  return value;
}

export function kittyGraphicsQuery(): string {
  return `${APC}a=q,t=d,f=100,i=${GRAPHICS_QUERY_IMAGE_ID};${QUERY_PNG_BASE64}${ST}`;
}

/** Encode a direct PNG transmission, chunking at Kitty's recommended limit. */
export function kittyGraphicsTransmitPng(imageId: number, pngBase64: string): string {
  const id = uint32(imageId, "imageId");
  if (!pngBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pngBase64)) {
    throw new Error("pngBase64 must contain canonical base64 image data");
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < pngBase64.length; offset += MAX_CHUNK_CHARS) {
    chunks.push(pngBase64.slice(offset, offset + MAX_CHUNK_CHARS));
  }

  return chunks.map((chunk, index) => {
    const more = index + 1 < chunks.length ? 1 : 0;
    const controls = index === 0
      ? `a=t,t=d,f=100,i=${id},q=2,m=${more}`
      : `q=2,m=${more}`;
    return `${APC}${controls};${chunk}${ST}`;
  }).join("");
}

export function kittyGraphicsPlace(
  imageId: number,
  options: { columns?: number; rows?: number; z?: number } = {},
): string {
  const id = uint32(imageId, "imageId");
  const columns = Math.max(1, Math.floor(options.columns ?? 1));
  const rows = Math.max(1, Math.floor(options.rows ?? 1));
  const z = Math.trunc(options.z ?? 0);
  // C=1 keeps placement from moving the terminal cursor. The caller reserves
  // the same number of terminal columns in the underlying text row.
  return `${APC}a=p,i=${id},c=${columns},r=${rows},C=1,z=${z},q=2${ST}`;
}

export function kittyGraphicsDeleteZ(z: number): string {
  return `${APC}a=d,d=z,z=${Math.trunc(z)},q=2${ST}`;
}

export function kittyGraphicsDeleteImageRange(firstImageId: number, lastImageId: number): string {
  const first = uint32(firstImageId, "firstImageId");
  const last = uint32(lastImageId, "lastImageId");
  if (last < first) throw new RangeError("lastImageId must not precede firstImageId");
  // Uppercase R is a hard delete: placements and their now-unused image data
  // are both reclaimed when Record exits.
  return `${APC}a=d,d=R,x=${first},y=${last},q=2${ST}`;
}

/**
 * Query terminal graphics support without trusting TERM. Kitty graphics replies
 * are APC control strings and are delivered by TerminalControlBuffer.
 */
export class TerminalGraphicsClient {
  private supported: boolean | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TerminalGraphicsClientOptions) {}

  isSupported(): boolean | null {
    return this.supported;
  }

  query(): void {
    this.clearTimeout();
    this.options.write(kittyGraphicsQuery());
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.updateSupport(false);
    }, this.options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    this.timeout.unref?.();
  }

  handleControlSequence(sequence: string): boolean {
    if (!sequence.startsWith(APC) || !sequence.endsWith(ST)) return false;

    const separator = sequence.indexOf(";", APC.length);
    const controls = sequence.slice(APC.length, separator === -1 ? -ST.length : separator);
    const response = separator === -1 ? "" : sequence.slice(separator + 1, -ST.length);
    const fields = new Map(controls.split(",").map((field) => {
      const equals = field.indexOf("=");
      return equals > 0 ? [field.slice(0, equals), field.slice(equals + 1)] : [field, ""];
    }));

    if (fields.get("i") === String(GRAPHICS_QUERY_IMAGE_ID)) {
      this.clearTimeout();
      this.updateSupport(response === "OK");
    }
    // Graphics replies must never leak into key parsing, including diagnostics
    // for quiet commands from a terminal with a slightly different subset.
    return true;
  }

  dispose(): void {
    this.clearTimeout();
  }

  private updateSupport(supported: boolean): void {
    if (this.supported === supported) return;
    this.supported = supported;
    this.options.onSupportChanged(supported);
  }

  private clearTimeout(): void {
    if (!this.timeout) return;
    clearTimeout(this.timeout);
    this.timeout = null;
  }
}
