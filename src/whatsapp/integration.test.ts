import { describe, expect, test } from "bun:test";

import { WHATSAPP_GUILD_ID, whatsappChannelId } from "../chatproviders";
import {
  createWhatsAppUiState,
  applyWhatsAppReactions,
  upsertWhatsAppChats,
  upsertWhatsAppContacts,
  upsertWhatsAppMessages,
  updateWhatsAppChats,
  registerWhatsAppLidMapping,
  whatsAppChannels,
  whatsAppDisplayName,
  whatsAppTimelineMessages,
} from "./integration";
import type { WhatsAppMessage } from "./types";

function message(id: string, chatId: string, timestampMs: number, text: string, senderId = chatId): WhatsAppMessage {
  return {
    key: { id, chatId },
    id,
    chatId,
    senderId,
    senderName: "Push name",
    fromMe: false,
    timestampMs,
    content: { kind: "text", text },
  };
}

describe("WhatsApp UI integration", () => {
  test("maps active direct and group chats into the separate WhatsApp root", () => {
    const state = createWhatsAppUiState();
    upsertWhatsAppContacts(state, [{ id: "15551234567@s.whatsapp.net", name: "Mom" }]);
    upsertWhatsAppChats(state, [
      { id: "15551234567@s.whatsapp.net", kind: "direct", lastMessageAtMs: 20 },
      { id: "group@g.us", kind: "group", name: "Family", lastMessageAtMs: 10 },
      { id: "old@g.us", kind: "group", name: "Old", archived: true, lastMessageAtMs: 30 },
    ]);

    expect(whatsAppChannels(state).map((channel) => [channel.guildId, channel.name, channel.type])).toEqual([
      [WHATSAPP_GUILD_ID, "Mom", 1],
      [WHATSAPP_GUILD_ID, "Family", 3],
    ]);
  });

  test("applies Baileys unread deltas instead of overwriting absolute counts", () => {
    const state = createWhatsAppUiState();
    const chatId = "15551234567@s.whatsapp.net";
    upsertWhatsAppChats(state, [{ id: chatId, kind: "direct", unreadCount: 5 }]);
    updateWhatsAppChats(state, [{ id: chatId, kind: "direct", unreadCount: 2 }]);
    expect(state.chatsById[chatId]?.unreadCount).toBe(7);
    updateWhatsAppChats(state, [{ id: chatId, kind: "direct", unreadCount: 0 }]);
    expect(state.chatsById[chatId]?.unreadCount).toBe(0);
    updateWhatsAppChats(state, [{ id: chatId, kind: "direct", unreadCount: -1 }]);
    expect(state.chatsById[chatId]?.unreadCount).toBe(1);
  });

  test("never regresses chat recency when stale metadata arrives", () => {
    const state = createWhatsAppUiState();
    const chatId = "15551234567@s.whatsapp.net";
    upsertWhatsAppChats(state, [{ id: chatId, kind: "direct", lastMessageAtMs: 200 }]);
    upsertWhatsAppChats(state, [{ id: chatId, kind: "direct", lastMessageAtMs: 50 }]);
    updateWhatsAppChats(state, [{ id: chatId, kind: "direct", lastMessageAtMs: 100 }]);
    expect(state.chatsById[chatId]?.lastMessageAtMs).toBe(200);

    upsertWhatsAppMessages(state, [message("cached-newest", chatId, 300, "newest")]);
    upsertWhatsAppChats(state, [{ id: chatId, kind: "direct", lastMessageAtMs: 75 }]);
    expect(state.chatsById[chatId]?.lastMessageAtMs).toBe(300);
  });

  test("deduplicates and sorts messages and builds reply previews", () => {
    const state = createWhatsAppUiState();
    const chatId = "group@g.us";
    const first = message("a", chatId, 10, "first", "alice@s.whatsapp.net");
    const second = {
      ...message("b", chatId, 20, "reply", "bob@s.whatsapp.net"),
      replyTo: { id: "a", chatId, participantId: "alice@s.whatsapp.net" },
    };
    upsertWhatsAppMessages(state, [second, first, { ...first, content: { kind: "text", text: "updated" } }]);

    const timeline = whatsAppTimelineMessages(state, whatsappChannelId(chatId));
    expect(timeline.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(timeline[0]?.content).toBe("updated");
    expect(timeline[1]?.reply?.summary).toBe("updated");
  });

  test("replaces edited content without losing the original timestamp", () => {
    const state = createWhatsAppUiState();
    const chatId = "15551234567@s.whatsapp.net";
    upsertWhatsAppMessages(state, [message("edited", chatId, 10, "before")]);
    upsertWhatsAppMessages(state, [{
      ...message("edited", chatId, 0, "after"),
      timestampMs: null,
      editedTimestampMs: 20,
      senderName: undefined,
    }]);

    expect(state.messagesByChatId[chatId]?.[0]).toMatchObject({
      content: { kind: "text", text: "after" },
      timestampMs: 10,
      editedTimestampMs: 20,
      senderName: "Push name",
    });
    expect(whatsAppTimelineMessages(state, whatsappChannelId(chatId))[0]).toMatchObject({
      content: "after",
      timestamp: 10,
      editedTimestamp: 20,
    });
  });

  test("drops protocol placeholders left by older caches", () => {
    const state = createWhatsAppUiState();
    const chatId = "15551234567@s.whatsapp.net";
    upsertWhatsAppMessages(state, [{
      ...message("control", chatId, 10, ""),
      content: { kind: "unsupported", sourceType: "protocolMessage" },
    }]);
    expect(state.messagesByChatId[chatId]).toBeUndefined();
  });

  test("applies, replaces, and removes WhatsApp reactions on their target message", () => {
    const state = createWhatsAppUiState();
    const chatId = "group@g.us";
    upsertWhatsAppMessages(state, [message("target", chatId, 10, "hello")]);
    applyWhatsAppReactions(state, [
      { target: { id: "target", chatId }, reaction: { senderId: "alice@s.whatsapp.net", fromMe: false, emoji: "❤️" } },
      { target: { id: "target", chatId }, reaction: { senderId: "self@s.whatsapp.net", fromMe: true, emoji: "❤️" } },
    ]);
    expect(whatsAppTimelineMessages(state, whatsappChannelId(chatId))[0]?.reactions).toEqual([{
      count: 2,
      me: true,
      emoji: { id: null, name: "❤️", animated: false },
    }]);

    applyWhatsAppReactions(state, [{
      target: { id: "target", chatId },
      reaction: { senderId: "alice@s.whatsapp.net", fromMe: false, emoji: "👍" },
    }]);
    applyWhatsAppReactions(state, [{
      target: { id: "target", chatId },
      reaction: { senderId: "self@s.whatsapp.net", fromMe: true, emoji: "" },
    }]);
    expect(whatsAppTimelineMessages(state, whatsappChannelId(chatId))[0]?.reactions).toEqual([{
      count: 1,
      me: false,
      emoji: { id: null, name: "👍", animated: false },
    }]);
  });

  test("maps media to ordinary timeline attachments", () => {
    const state = createWhatsAppUiState();
    const chatId = "15551234567@s.whatsapp.net";
    upsertWhatsAppMessages(state, [{
      ...message("image-1", chatId, 10, ""),
      content: { kind: "media", mediaKind: "image", caption: "photo", mimeType: "image/jpeg", sizeBytes: 42 },
    }]);

    const [mapped] = whatsAppTimelineMessages(state, whatsappChannelId(chatId));
    expect(mapped?.content).toBe("photo");
    expect(mapped?.attachments[0]).toMatchObject({ contentType: "image/jpeg", size: 42 });
  });

  test("never passes terminal controls from WhatsApp into sidebar or timeline output", () => {
    const state = createWhatsAppUiState();
    const chatId = "15551234567@s.whatsapp.net";
    upsertWhatsAppContacts(state, [{
      id: chatId,
      name: "Alice\x1b]52;c;Y2xpcGJvYXJk\x07\nAdmin\u202e",
    }]);
    upsertWhatsAppChats(state, [{ id: chatId, kind: "direct" }]);
    upsertWhatsAppMessages(state, [message("unsafe", chatId, 10, "hello\x1b[2J\nworld\x9b31m")]);

    expect(whatsAppChannels(state)[0]?.name).toBe("Alice Admin");
    const mapped = whatsAppTimelineMessages(state, whatsappChannelId(chatId))[0];
    expect(mapped?.content).toBe("hello\nworld");
    expect(JSON.stringify({ channel: whatsAppChannels(state)[0], mapped })).not.toContain("\x1b");
  });

  test("resolves display names across phone/LID mappings and recent push names", () => {
    const state = createWhatsAppUiState();
    const phoneId = "15551234567@s.whatsapp.net";
    const lid = "opaque-user@lid";
    upsertWhatsAppContacts(state, [{ id: lid, name: "Mapped person" }]);
    registerWhatsAppLidMapping(state, lid, phoneId);
    expect(whatsAppDisplayName(state, phoneId)).toBe("Mapped person");

    const other = "15557654321@s.whatsapp.net";
    upsertWhatsAppMessages(state, [{
      ...message("push-name", other, 10, "hello", other),
      senderName: "Recent push name",
    }]);
    expect(whatsAppDisplayName(state, other)).toBe("Recent push name");
  });

  test("merges phone and LID identities when a new message supplies the alternate JID", () => {
    const state = createWhatsAppUiState();
    const phoneId = "15551234567@s.whatsapp.net";
    const lid = "opaque-user@lid";
    upsertWhatsAppContacts(state, [
      { id: phoneId, name: "Mom" },
      { id: lid, pushName: "Mom" },
    ]);
    upsertWhatsAppChats(state, [
      { id: phoneId, kind: "direct", name: "Mom", lastMessageAtMs: 10 },
      { id: lid, kind: "direct", lastMessageAtMs: 20 },
    ]);
    upsertWhatsAppMessages(state, [message("old", phoneId, 10, "old")]);
    upsertWhatsAppMessages(state, [{
      ...message("new", lid, 20, "new", lid),
      key: {
        id: "new",
        chatId: lid,
        alternateChatId: phoneId,
      },
    }]);

    expect(Object.keys(state.chatsById).filter((id) => id === phoneId || id === lid)).toEqual([phoneId]);
    expect(state.messagesByChatId[lid]).toBeUndefined();
    expect(state.messagesByChatId[phoneId]?.map((entry) => [entry.id, entry.chatId])).toEqual([
      ["old", phoneId],
      ["new", phoneId],
    ]);
    expect(whatsAppChannels(state).filter((channel) => channel.name === "Mom")).toHaveLength(1);
    expect(whatsAppTimelineMessages(state, whatsappChannelId(lid)).map((entry) => entry.channelId))
      .toEqual([whatsappChannelId(phoneId), whatsappChannelId(phoneId)]);
  });

  test("does not erase known names when WhatsApp sends sparse empty patches", () => {
    const state = createWhatsAppUiState();
    const jid = "15551234567@s.whatsapp.net";
    upsertWhatsAppContacts(state, [{ id: jid, name: "Address book name", pushName: "Profile name" }]);
    upsertWhatsAppChats(state, [{ id: jid, kind: "direct", name: "Chat name" }]);
    upsertWhatsAppContacts(state, [{ id: jid, name: "", pushName: "" }]);
    upsertWhatsAppChats(state, [{ id: jid, kind: "direct", name: "" }]);

    expect(state.contactsById[jid]).toMatchObject({ name: "Address book name", pushName: "Profile name" });
    expect(state.chatsById[jid]?.name).toBe("Chat name");
    expect(whatsAppDisplayName(state, jid)).toBe("Address book name");
  });
});
