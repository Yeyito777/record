import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWhatsAppOutgoingSends, saveWhatsAppOutgoingSend, sameWhatsAppAccount, type WhatsAppOutgoingSend } from "./outbox";

function send(): WhatsAppOutgoingSend {
  return {
    accountId: "self:4@s.whatsapp.net", messageIds: ["wire-id"], confirmedIds: new Set(),
    confirmedMessages: [], receivedAtMs: 100,
    attachmentImages: { attachment: { mediaType: "image/png", base64: "b25l" } },
    message: {
      id: "local:wa:test", channelId: "whatsapp:person", type: 0, content: "hello", timestamp: 100,
      editedTimestamp: null, author: { id: "self", username: "Me", displayName: "Me", bot: false },
      mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], mentionUsers: [],
      reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0, localStatus: "pending",
    },
  };
}

test("outbox atomically round-trips exact send IDs and image bytes with private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "record-wa-outbox-"));
  const directory = join(root, "outbox");
  try {
    saveWhatsAppOutgoingSend(directory, send());
    expect(loadWhatsAppOutgoingSends(directory)).toEqual([send()]);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(lstatSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
    const completed = send();
    completed.confirmedIds.add("wire-id");
    completed.confirmedMessages.push({
      id: "wire-id", chatId: "person@s.whatsapp.net", key: { id: "wire-id", chatId: "person@s.whatsapp.net" },
      fromMe: true, timestampMs: 100, content: { kind: "text", text: "hello" },
    });
    saveWhatsAppOutgoingSend(directory, completed);
    expect(loadWhatsAppOutgoingSends(directory)).toEqual([completed]);
    expect(readdirSync(directory)).toEqual(files);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbox rejects malformed records and symlinks without following them", () => {
  const root = mkdtempSync(join(tmpdir(), "record-wa-outbox-unsafe-"));
  const directory = join(root, "outbox");
  try {
    saveWhatsAppOutgoingSend(directory, send());
    const path = join(directory, readdirSync(directory)[0]!);
    writeFileSync(path, JSON.stringify({ version: 1, ...send(), confirmedIds: ["unknown-id"] }));
    expect(() => loadWhatsAppOutgoingSends(directory)).toThrow("Invalid");
    rmSync(path);
    const target = join(root, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, path);
    expect(() => loadWhatsAppOutgoingSends(directory)).toThrow("Unsafe");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("account isolation ignores linked-device suffixes, not account identities", () => {
  expect(sameWhatsAppAccount("self:4@s.whatsapp.net", "self:5@s.whatsapp.net")).toBe(true);
  expect(sameWhatsAppAccount("other@s.whatsapp.net", "self:4@s.whatsapp.net")).toBe(false);
});
