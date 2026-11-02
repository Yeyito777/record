/**
 * What the bridge reads from the user's settings protobuf (READY's
 * `user_settings_proto`, record's USER_SETTINGS_PROTO capability): the
 * status they set, which the identify carries, and the server rail's order
 * and folders. PreloadedUserSettings field 11 is the status, field 14 the
 * guild folders. Only reads: nothing here encodes.
 */

import type { PresenceStatus } from "./gateway";

interface Field {
  no: number;
  wire: number;
  value: bigint | Uint8Array;
}

function varint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
  }
  throw new Error("truncated varint");
}

function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = varint(bytes, offset);
    offset = key.next;
    const no = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = varint(bytes, offset);
      offset = value.next;
      out.push({ no, wire, value: value.value });
    } else if (wire === 1) {
      out.push({ no, wire, value: bytes.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const length = varint(bytes, offset);
      offset = length.next;
      const end = offset + Number(length.value);
      if (end > bytes.length) throw new Error("truncated field");
      out.push({ no, wire, value: bytes.subarray(offset, end) });
      offset = end;
    } else if (wire === 5) {
      out.push({ no, wire, value: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`wire type ${wire}`);
    }
  }
  return out;
}

function fixed64(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = Math.min(bytes.length, 8) - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index] ?? 0);
  return value;
}

/** A wrapper message's `value` (google.protobuf.StringValue / Int64Value / UInt64Value). */
function wrapped(bytes: Uint8Array): Field | null {
  return fields(bytes).find((field) => field.no === 1) ?? null;
}

function packedFixed64(field: Field): string[] {
  if (!(field.value instanceof Uint8Array)) return [];
  const ids: string[] = [];
  if (field.wire === 1) return [fixed64(field.value).toString()];
  for (let offset = 0; offset + 8 <= field.value.length; offset += 8) ids.push(fixed64(field.value.subarray(offset, offset + 8)).toString());
  return ids;
}

export interface GuildFolder {
  /** Null for a lone server (Discord keeps every server in a "folder"). */
  id: string | null;
  name: string | null;
  color: number | null;
  guildIds: string[];
}

export interface UserProto {
  status: PresenceStatus | null;
  folders: GuildFolder[];
}

function presence(value: string | null): PresenceStatus | null {
  if (value === "online" || value === "idle" || value === "dnd" || value === "invisible") return value;
  return value === "offline" ? "invisible" : null;
}

export function decodeUserProto(base64: string | null | undefined): UserProto {
  const out: UserProto = { status: null, folders: [] };
  if (!base64) return out;
  try {
    for (const field of fields(Buffer.from(base64, "base64"))) {
      if (!(field.value instanceof Uint8Array) || field.wire !== 2) continue;
      if (field.no === 11) {
        for (const status of fields(field.value)) {
          if (status.no === 1 && status.value instanceof Uint8Array) {
            const value = wrapped(status.value);
            if (value?.value instanceof Uint8Array) out.status = presence(new TextDecoder().decode(value.value));
          }
        }
      } else if (field.no === 14) {
        for (const folderField of fields(field.value)) {
          if (folderField.no !== 1 || !(folderField.value instanceof Uint8Array)) continue;
          const folder: GuildFolder = { id: null, name: null, color: null, guildIds: [] };
          for (const part of fields(folderField.value)) {
            if (part.no === 1) folder.guildIds.push(...packedFixed64(part));
            else if (part.value instanceof Uint8Array) {
              const value = wrapped(part.value);
              if (!value) continue;
              if (part.no === 2 && typeof value.value === "bigint") folder.id = value.value.toString();
              else if (part.no === 3 && value.value instanceof Uint8Array) folder.name = new TextDecoder().decode(value.value) || null;
              else if (part.no === 4 && typeof value.value === "bigint") folder.color = Number(value.value & 0xffffffn);
            }
          }
          if (folder.guildIds.length > 0) out.folders.push(folder);
        }
      }
    }
  } catch {
    // A settings blob we cannot read: no status, no folders (READY's order).
  }
  return out;
}
