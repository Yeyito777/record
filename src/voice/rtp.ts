import { createCipheriv, createDecipheriv } from "crypto";
import { createSocket, type Socket as UdpSocket } from "dgram";

import { RTP_HEADER_LENGTH, UDP_DISCOVERY_TIMEOUT_MS } from "./constants";

export function selectEncryptionMode(modes: string[]): string {
  if (modes.includes("aead_aes256_gcm_rtpsize")) return "aead_aes256_gcm_rtpsize";
  if (modes.includes("aead_xchacha20_poly1305_rtpsize")) return "aead_xchacha20_poly1305_rtpsize";
  return modes[0] ?? "aead_aes256_gcm_rtpsize";
}

export function connectUdp(socket: UdpSocket, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, host, () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

export function bindUdp(socket: UdpSocket, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, host, () => {
      socket.off("error", reject);
      const address = socket.address();
      resolve(typeof address === "string" ? port : address.port);
    });
  });
}

export async function reserveUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  const port = await bindUdp(socket, "127.0.0.1", 0);
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

export function discoverUdpAddress(socket: UdpSocket, ssrc: number): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out during Discord voice UDP discovery."));
    }, UDP_DISCOVERY_TIMEOUT_MS);
    timer.unref?.();

    const onMessage = (packet: Buffer): void => {
      if (packet.length < 74) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      const type = packet.readUInt16BE(0);
      const length = packet.readUInt16BE(2);
      if (type !== 2 || length !== 70) {
        reject(new Error("Discord voice UDP discovery returned an invalid packet."));
        return;
      }
      const nul = packet.indexOf(0, 8);
      const addressEnd = nul >= 8 ? nul : 72;
      resolve({
        address: packet.subarray(8, addressEnd).toString("ascii"),
        port: packet.readUInt16BE(72),
      });
    };

    socket.on("message", onMessage);
    const packet = Buffer.alloc(74);
    packet.writeUInt16BE(1, 0);
    packet.writeUInt16BE(70, 2);
    packet.writeUInt32BE(ssrc, 4);
    socket.send(packet);
  });
}

export interface ParsedRtpPacket {
  sequence: number;
  timestamp: number;
  ssrc: number;
  payloadType: number;
  headerLength: number;
  hasExtension: boolean;
}

export function parseDiscordRtpPacket(packet: Buffer): ParsedRtpPacket | null {
  const parsed = parseRtpHeader(packet, { encryptedDiscordPacket: true });
  if (!parsed || packet.length <= parsed.headerLength + 4) return null;
  return parsed;
}

export function parsePlainRtpPacket(packet: Buffer): (ParsedRtpPacket & { payload: Buffer }) | null {
  const parsed = parseRtpHeader(packet, { encryptedDiscordPacket: false });
  if (!parsed || packet.length <= parsed.headerLength) return null;
  return { ...parsed, payload: packet.subarray(parsed.headerLength) };
}

function parseRtpHeader(packet: Buffer, options: { encryptedDiscordPacket: boolean }): ParsedRtpPacket | null {
  if (packet.length < RTP_HEADER_LENGTH || (packet[0] >> 6) !== 2) return null;
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = (packet[0] & 0x10) !== 0;
  let headerLength = RTP_HEADER_LENGTH + csrcCount * 4;
  if (hasExtension) {
    if (packet.length < headerLength + 4) return null;
    if (options.encryptedDiscordPacket) {
      // Discord's rtpsize AEAD modes authenticate only the RTP header and the
      // 4-byte extension prelude; the extension body is inside the encrypted payload.
      headerLength += 4;
    } else {
      const extensionLength = packet.readUInt16BE(headerLength + 2) * 4;
      headerLength += 4 + extensionLength;
    }
  }
  if (packet.length < headerLength) return null;
  return {
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payloadType: packet[1] & 0x7f,
    headerLength,
    hasExtension,
  };
}

export function encryptAes256GcmRtp(header: Buffer, payload: Buffer, key: Buffer, counter: Buffer): Buffer {
  const nonce = Buffer.alloc(12);
  counter.copy(nonce, 0);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, ciphertext, tag, counter]);
}

export function decryptAes256GcmRtp(packet: Buffer, headerLength: number, key: Buffer): Buffer | null {
  if (packet.length <= headerLength + 4 + 16) return null;
  const header = packet.subarray(0, headerLength);
  const encrypted = packet.subarray(headerLength, packet.length - 4);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const counter = packet.subarray(packet.length - 4);
  const nonce = Buffer.alloc(12);
  counter.copy(nonce, 0);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}
