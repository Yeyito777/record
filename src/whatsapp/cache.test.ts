import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWhatsAppUiState } from "./integration";
import {
  hydrateWhatsAppUiState,
  loadWhatsAppCache,
  saveWhatsAppCache,
  snapshotWhatsAppUiState,
} from "./cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WhatsApp UI cache", () => {
  test("round-trips chats, contacts, messages, and account with private atomic storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "record-wa-cache-"));
    temporaryDirectories.push(root);
    const cacheFile = join(root, "whatsapp", "cache.json");
    const source = createWhatsAppUiState();
    source.account = { id: "self@s.whatsapp.net", name: "Me" };
    source.chatsById["person@s.whatsapp.net"] = { id: "person@s.whatsapp.net", kind: "direct", name: "Person" };
    source.contactsById["person@s.whatsapp.net"] = { id: "person@s.whatsapp.net", name: "Person" };
    source.messagesByChatId["person@s.whatsapp.net"] = [{
      key: { id: "m1", chatId: "person@s.whatsapp.net" },
      id: "m1",
      chatId: "person@s.whatsapp.net",
      fromMe: false,
      timestampMs: 10,
      content: { kind: "text", text: "hello" },
    }];

    await saveWhatsAppCache(cacheFile, snapshotWhatsAppUiState(source));
    expect((await lstat(join(root, "whatsapp"))).mode & 0o777).toBe(0o700);
    expect((await lstat(cacheFile)).mode & 0o777).toBe(0o600);
    expect((await readFile(cacheFile, "utf8")).toString()).not.toContain("connection");

    const loaded = await loadWhatsAppCache(cacheFile);
    const restored = createWhatsAppUiState();
    hydrateWhatsAppUiState(restored, loaded!);
    expect(restored.account?.id).toBe("self@s.whatsapp.net");
    expect(restored.chatsById["person@s.whatsapp.net"]?.name).toBe("Person");
    expect(restored.messagesByChatId["person@s.whatsapp.net"]?.[0]?.content).toEqual({ kind: "text", text: "hello" });
  });

  test("repairs cached duplicate phone/LID chats using message alternate IDs", () => {
    const phoneId = "15551234567@s.whatsapp.net";
    const lid = "opaque-person@lid";
    const restored = createWhatsAppUiState();
    hydrateWhatsAppUiState(restored, {
      version: 1,
      savedAtMs: 1,
      account: null,
      chats: [
        { id: phoneId, kind: "direct", name: "Mom", lastMessageAtMs: 10 },
        { id: lid, kind: "direct", lastMessageAtMs: 20 },
      ],
      contacts: [
        { id: phoneId, name: "Mom" },
        { id: lid, pushName: "Mom" },
      ],
      messagesByChatId: {
        [phoneId]: [{
          key: { id: "old", chatId: phoneId },
          id: "old",
          chatId: phoneId,
          fromMe: false,
          timestampMs: 10,
          content: { kind: "text", text: "old" },
        }],
        [lid]: [{
          key: { id: "new", chatId: lid, alternateChatId: phoneId },
          id: "new",
          chatId: lid,
          fromMe: false,
          timestampMs: 20,
          content: { kind: "text", text: "new" },
        }],
      },
    });

    expect(restored.chatsById[lid]).toBeUndefined();
    expect(restored.messagesByChatId[lid]).toBeUndefined();
    expect(restored.messagesByChatId[phoneId]?.map((message) => message.id)).toEqual(["old", "new"]);
  });

  test("fails closed for malformed data and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "record-wa-cache-unsafe-"));
    temporaryDirectories.push(root);
    const malformed = join(root, "malformed.json");
    await writeFile(malformed, "{broken", { mode: 0o600 });
    await expect(loadWhatsAppCache(malformed)).rejects.toThrow();

    const linked = join(root, "linked.json");
    await symlink(malformed, linked);
    await expect(loadWhatsAppCache(linked)).rejects.toThrow("unsafe WhatsApp cache file");
  });
});
