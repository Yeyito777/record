import { describe, expect, test } from "bun:test";

import { fetchWhatsAppProfilePictureUrl, isWhatsAppPictureJid } from "./profilepicture";

function boom(code: number): Error {
  return Object.assign(new Error(code === 404 ? "item-not-found" : "error"), { data: code });
}

describe("WhatsApp profile pictures", () => {
  test("asks for the preview size of people and groups only", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const socket = {
      profilePictureUrl: async (jid: string, type?: string) => {
        asked.push([jid, type]);
        return "https://pps.whatsapp.net/v/t61/abc.jpg?oh=1";
      },
    };
    expect(await fetchWhatsAppProfilePictureUrl(socket, "15551234567@s.whatsapp.net")).toBe("https://pps.whatsapp.net/v/t61/abc.jpg?oh=1");
    expect(await fetchWhatsAppProfilePictureUrl(socket, "120363000000000000@g.us")).not.toBeNull();
    expect(await fetchWhatsAppProfilePictureUrl(socket, "987654321@lid")).not.toBeNull();
    expect(asked.map(([, type]) => type)).toEqual(["preview", "preview", "preview"]);
    for (const jid of ["status@broadcast", "123@newsletter", "x@s.whatsapp.net", ""]) {
      expect(isWhatsAppPictureJid(jid)).toBe(false);
      await expect(fetchWhatsAppProfilePictureUrl(socket, jid)).rejects.toThrow("Invalid");
    }
    expect(asked).toHaveLength(3);
  });

  test("no picture or a hidden one is null; anything else is an error to back off from", async () => {
    const answer = (error: Error | null, url?: string) => ({
      profilePictureUrl: async () => { if (error) throw error; return url; },
    });
    const jid = "15551234567@s.whatsapp.net";
    expect(await fetchWhatsAppProfilePictureUrl(answer(boom(404)), jid)).toBeNull();
    expect(await fetchWhatsAppProfilePictureUrl(answer(boom(401)), jid)).toBeNull();
    expect(await fetchWhatsAppProfilePictureUrl(answer(null, undefined), jid)).toBeNull();
    expect(await fetchWhatsAppProfilePictureUrl(answer(null, "http://insecure/x.jpg"), jid)).toBeNull();
    await expect(fetchWhatsAppProfilePictureUrl(answer(boom(429)), jid)).rejects.toThrow();
    await expect(fetchWhatsAppProfilePictureUrl(answer(new Error("Timed Out")), jid)).rejects.toThrow("Timed Out");
  });
});
