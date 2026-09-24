import { expect, test } from "bun:test";
import type { WASocket } from "@whiskeysockets/baileys";
import { sendWhatsAppReaction } from "./sending";

test("reaction transport preserves the original key for adds and removals", async () => {
  const calls: unknown[][] = [];
  const socket = {
    user: { id: "self:2@s.whatsapp.net" },
    sendMessage: async (...args: unknown[]) => { calls.push(args); },
  } as unknown as Pick<WASocket, "sendMessage" | "user">;
  const key = { id: "original", chatId: "group@g.us", fromMe: false, participantId: "sender@lid" };
  for (const emoji of ["👍", "❤️", ""]) {
    expect(await sendWhatsAppReaction(socket, key, emoji)).toEqual({
      target: key, reaction: { senderId: socket.user!.id, fromMe: true, emoji },
    });
    expect(calls.at(-1)).toEqual(["group@g.us", { react: {
      text: emoji, key: { id: "original", remoteJid: "group@g.us", fromMe: false, participant: "sender@lid" },
    } }]);
  }
  await expect(sendWhatsAppReaction(socket, { ...key, participantId: undefined }, "👍")).rejects.toThrow();
  expect(calls).toHaveLength(3);
  await sendWhatsAppReaction(socket, { ...key, fromMe: true, participantId: undefined }, "👍");
  expect(calls.at(-1)).toEqual(["group@g.us", { react: {
    text: "👍", key: { id: "original", remoteJid: "group@g.us", fromMe: true, participant: "self@s.whatsapp.net" },
  } }]);
});

test("reaction transport propagates failure without a success event", async () => {
  const socket = {
    user: { id: "self@s.whatsapp.net" },
    sendMessage: async () => { throw new Error("offline"); },
  } as unknown as Pick<WASocket, "sendMessage" | "user">;
  await expect(sendWhatsAppReaction(socket, { id: "id", chatId: "person@s.whatsapp.net" }, "")).rejects.toThrow("offline");
});
