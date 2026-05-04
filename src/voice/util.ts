import { DAVE_ENCRYPTED_MARKER } from "./constants";

export async function messageDataToBinaryBuffer(data: unknown): Promise<Buffer | null> {
  if (typeof data === "string") return null;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  return null;
}

export function isDaveVoiceGatewayBinaryMessage(packet: Buffer): boolean {
  if (packet.length < 3) return false;
  const opcode = packet.readUInt8(2);
  return opcode === 25 || opcode === 27 || opcode === 29 || opcode === 30;
}

export function messageDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

export function snowflakeToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isDaveEncryptedPayload(payload: Buffer | null | undefined): boolean {
  if (!payload || payload.length < DAVE_ENCRYPTED_MARKER.length) return false;
  const marker = payload.lastIndexOf(DAVE_ENCRYPTED_MARKER);
  if (marker < 0) return false;
  const suffix = payload.subarray(marker + DAVE_ENCRYPTED_MARKER.length);
  // DAVE-encrypted media usually ends in FAFA, but Discord/davey can leave
  // padding bytes after the marker. Do not feed those encrypted bytes to Opus.
  if (suffix.length === 0) return true;
  if (marker < payload.length - 256) return false;
  return suffix.every((byte) => byte === suffix[0]);
}

export function stripDavePadding(payload: Buffer): Buffer {
  const marker = payload.lastIndexOf(DAVE_ENCRYPTED_MARKER);
  if (marker < 0) return payload;
  const suffix = payload.subarray(marker + DAVE_ENCRYPTED_MARKER.length);
  if (suffix.length === 0) return payload;
  if (marker < payload.length - 256) return payload;
  if (!suffix.every((byte) => byte === suffix[0])) return payload;
  return payload.subarray(0, marker + DAVE_ENCRYPTED_MARKER.length);
}

export function isUnencryptedDavePassthroughError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UnencryptedWhenPassthroughDisabled");
}

export function asError(error: unknown, prefix: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix} ${message}`.trim());
}
