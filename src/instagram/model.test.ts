import { describe, expect, test } from "bun:test";
import {
  callTitle, classifyShareTarget, effectiveCallOutcome, isThreadUnread, mergeThreadDetail, mergeThreadPreview, offlineThreadingId,
  parseCall, parseContent, parseInboxPage, parseMessage, parseRequestsPage, parseSearchUsers, parseThread, prependOlder,
  foldReactionNotices, reactionNotice, seenByOthers, threadTitle, unreadMessages, type IgShare,
} from "./model";
import { FRIEND_FBID, igMessage, igThread, VIEWER_FBID } from "./testkit";

const cdn = (name: string) => `https://scontent.cdninstagram.com/v/${name}`;
const node = (content: Record<string, unknown>, contentType = "TEXT", extra: Record<string, unknown> = {}) => ({
  message_id: "mid.$1", sender_fbid: FRIEND_FBID, timestamp_ms: "1792360000000", content_type: contentType, text_body: "", content, ...extra,
});
const share = (xma: Record<string, unknown>, contentType = "MESSAGE_INLINE_SHARE", note = "", text = ""): IgShare => {
  const content = parseContent(node({ __typename: "SlideMessageXMAContent", xma_text_body: note, xma }, contentType, { text_body: text }));
  if (content.kind !== "share") throw new Error(`expected a share, got ${content.kind}`);
  return content.share;
};

describe("Instagram users", () => {
  test("keep their CDN profile picture URL for sidebar avatars", () => {
    const thread = parseThread({
      thread_fbid: "340282366841710300", viewer: { id: "1" },
      users: [
        { id: "2", username: "ana", full_name: "Ana", profile_pic_url: cdn("ana.jpg") },
        { id: "3", username: "bo", full_name: "Bo", profile_pic_url: "https://evil.example/bo.jpg" },
        { id: "4", username: "cy", full_name: "Cy" },
      ],
    })!;
    expect(thread.users.map(user => user.picUrl)).toEqual([cdn("ana.jpg"), undefined, undefined]);
  });
});

describe("Instagram item parsing", () => {
  test("text, heart, system and unsent", () => {
    expect(parseContent(node({ __typename: "SlideMessageText", text_body: "hey" }))).toEqual({ kind: "text", text: "hey" });
    expect(parseContent(node({ __typename: "SlideMessageText" }, "LIKE_HEART"))).toEqual({ kind: "heart" });
    expect(parseContent(node({ __typename: "SlideMessageAdminText", text_fragments: [{ plaintext: "Kai added " }, { plaintext: "Ines" }] }, "ADD_PARTICIPANT_XMAT")))
      .toEqual({ kind: "system", text: "Kai added Ines" });
    expect(parseMessage(node({ __typename: "SlideMessageText", text_body: "x" }, "TEXT", { tombstone_reason: "UNSENT" }))!.content).toEqual({ kind: "unavailable" });
    expect(parseMessage(node({ __typename: "SlideMessageText", text_body: "x" }, "TEXT", { expiration_timestamp_ms: "1000" }))!.content).toEqual({ kind: "unavailable" });
    expect(parseMessage({ content: {} })).toBeNull();
  });

  test("photos, videos and albums keep only CDN URLs", () => {
    const photo = { attachment_fbid: "1", preview_cdn_url: cdn("p.jpg"), attachment_cdn_url: cdn("full.jpg"), preview_width: 960, preview_height: 720 };
    const photos = parseContent(node({ __typename: "SlideMessageImageContent", attachments: [photo] }, "IMAGES"));
    expect(photos).toEqual({ kind: "media", items: [{ id: "1", video: false, preview: cdn("p.jpg"), url: cdn("full.jpg"), width: 960, height: 720 }] });
    const video = { attachment_fbid: "2", preview_cdn_url: cdn("t.jpg"), attachment_cdn_url: "https://video.xx.fbcdn.net/v.mp4", preview_width: 720, preview_height: 1280 };
    const videos = parseContent(node({ __typename: "SlideMessageVideosContent", videos: [video] }));
    expect(videos.kind === "media" && videos.items[0]!.video && videos.items[0]!.url).toBe("https://video.xx.fbcdn.net/v.mp4");
    const album = parseContent(node({ __typename: "SlideMessageMultiMediaContent", ordered_photo_video_attachments: [photo, { ...video, __typename: "XFBSlideVideoAttachment" }] }));
    expect(album.kind === "media" && album.items.map(item => item.video)).toEqual([false, true]);
    expect(parseContent(node({ __typename: "SlideMessageImageContent", attachments: [{ attachment_cdn_url: "http://localhost/private" }] })))
      .toEqual({ kind: "unsupported", text: "Sent a photo" });
  });

  test("voice, GIFs, stickers, music and view-once media", () => {
    expect(parseContent(node({ __typename: "SlideMessageAudiosContent", audio_attachments: [{ attachment_cdn_url: cdn("a.mp4"), playable_duration_ms: 8500 }] })))
      .toEqual({ kind: "voice", url: cdn("a.mp4"), durationSecs: 8.5 });
    const gif = parseContent(node({ __typename: "SlideMessageAnimatedMediaContent", animated_media: [{ attachment_mp4_url: cdn("g.mp4"), preview_cdn_url: cdn("g.jpg"), preview_width: 480, preview_height: 270 }] }));
    expect(gif).toMatchObject({ kind: "animated", mp4: cdn("g.mp4"), still: cdn("g.jpg"), sticker: false });
    expect(parseContent(node({ __typename: "SlideMessageAnimatedMediaContent", animated_media: { attachment_mp4_url: cdn("g.mp4") } })).kind).toBe("animated");
    expect(parseContent(node({ __typename: "SlideMessageCutoutStickerXMAContent", preview_url: cdn("s.webp"), alt_text: "cat" })))
      .toEqual({ kind: "sticker", url: cdn("s.webp"), alt: "cat" });
    expect(parseContent(node({ __typename: "SlideMessageMusicStickerXMAContent", title: "Song", display_artist: "Band", web_30s_preview_download_url: cdn("m.m4a") })))
      .toMatchObject({ kind: "music", title: "Song", artist: "Band", audio: cdn("m.m4a") });
    expect(parseContent(node({ __typename: "SlideMessageRavenImageContent", view_mode: 1 }))).toEqual({ kind: "disappearing", video: false });
    expect(parseContent(node({ __typename: "SlideMessageRavenVideoContent", view_mode: 1 }))).toEqual({ kind: "disappearing", video: true });
    expect(parseContent(node({ __typename: "SlideMessageSomethingNew" })).kind).toBe("unsupported");
  });

  test("shares: posts, reels, stories with context, profiles, links and placeholders", () => {
    const post = share({ __typename: "SlideMessageStandardXMA", target_url: "https://www.instagram.com/p/ABC123/", header_title_text: "ana", xmaPreviewImage: { url: cdn("i.jpg") } });
    expect(post).toMatchObject({ kind: "post", code: "ABC123", author: "ana", preview: cdn("i.jpg") });
    expect(share({ __typename: "SlideMessagePortraitXMA", target_url: "https://www.instagram.com/reel/R1/" }).kind).toBe("reel");
    expect(share({ __typename: "SlideMessagePortraitXMA", target_url: "https://www.instagram.com/someone/reel/R2/" }).code).toBe("R2");
    const reply = share({ __typename: "SlideMessagePortraitXMA", target_url: "https://www.instagram.com/stories/maya/123/" }, "STORY_REPLY_XMA", "so cute");
    expect(reply).toMatchObject({ kind: "story", username: "maya", storyId: "123", storyContext: "reply", text: "so cute" });
    expect(share({ __typename: "SlideMessagePortraitXMA", target_url: "https://www.instagram.com/stories/maya/1/" }, "STORY_MENTION_XMA").storyContext).toBe("mention");
    expect(share({ __typename: "SlideMessagePortraitXMA", target_url: "https://www.instagram.com/stories/maya/1/" }).storyContext).toBe("share");
    expect(share({ __typename: "SlideMessageExpiredPlaceholderXMA" }, "MESSAGE_INLINE_SHARE", "lol")).toMatchObject({ kind: "story", expired: true, storyContext: "reply" });
    expect(share({ __typename: "SlideMessagePlaceholderXMA", title_text: "Post unavailable" }).expired).toBe(true);
    expect(share({ __typename: "SlideMessageStandardXMA", target_url: "https://www.instagram.com/someone/" })).toMatchObject({ kind: "profile", username: "someone" });
    const link = share({ __typename: "SlideMessageStandardXMA", target_url: "https://l.instagram.com/?u=https%3A%2F%2Fexample.org%2Fa&e=x", title_text: "A" }, "MESSAGE_INLINE_SHARE", "look https://example.org/a");
    expect(link).toMatchObject({ kind: "link", url: "https://example.org/a", text: "look https://example.org/a" });
    expect(classifyShareTarget("javascript:alert(1)").kind).toBe("unavailable");
  });

  test("calls: audio/video and missed/ended/started from Instagram's localized sentence", () => {
    const cases: Array<[string, boolean, string]> = [
      ["Missed video call", true, "missed"], ["Missed audio call", false, "missed"], ["Audio call ended · 4:12", false, "ended"],
      ["Kai started a video chat", true, "started"],
      // Seen live (Spanish account wording) — audio calls also use IG_VIDEO_CALL_XMAT.
      ["Tienes una llamada de audio perdida", false, "missed"], ["Kai inició una llamada de audio", false, "started"],
      ["Videochiamata persa", true, "missed"], ["Chiamata vocale terminata", false, "ended"], ["Appel vidéo manqué", true, "missed"],
    ];
    for (const [line, video, outcome] of cases) {
      expect(parseCall(line, "IG_VIDEO_CALL_XMAT")).toMatchObject({ video, outcome });
    }
    expect(parseCall("Audio call ended · 4:12", "IG_VIDEO_CALL_XMAT").duration).toBe("4:12");
    expect(parseCall("📞", "IG_VIDEO_CALL_XMAT")).toMatchObject({ video: true, outcome: "unknown" });
    const unknown = parseCall("📞", "IG_VIDEO_CALL_XMAT");
    expect(callTitle(unknown, true, false)).toBe("Missed video call");
    expect(effectiveCallOutcome(parseCall("Kai started a video chat", ""), true, true)).toBe("started");
    expect(effectiveCallOutcome(parseCall("Maya started a video chat", ""), true, false)).toBe("missed");
    // Inbox previews keep only __typename: the sentence comes from igd_snippet.
    expect(parseContent(node({ __typename: "SlideMessageAdminText" }, "IG_VIDEO_CALL_XMAT", { igd_snippet: "Missed audio call" })))
      .toMatchObject({ kind: "call", call: { video: false, outcome: "missed" } });
  });

  test("replies, reactions, forwards and snippets", () => {
    const message = parseMessage(node({ __typename: "SlideMessageText", text_body: "yes" }, "TEXT", {
      reactions: [{ reaction: "🔥", sender_fbid: VIEWER_FBID }], igd_is_forwarded: true, igd_snippet: "yes",
      replied_to_message: { message_id: "mid.$0", sender_fbid: VIEWER_FBID, sender: { name: "Me" }, content: { __typename: "SlideMessageImageContent" }, content_type: "IMAGES" },
    }))!;
    expect(message.reactions).toEqual([{ emoji: "🔥", senderFbid: VIEWER_FBID }]);
    expect(message.replyTo).toEqual({ id: "mid.$0", senderFbid: VIEWER_FBID, senderName: "Me", summary: "Sent a photo" });
    expect(message.forwarded).toBe(true);
    expect(message.snippet).toBe("yes");
  });
});

describe("Instagram pages and threads", () => {
  const rawThread = (id: string, extra: Record<string, unknown> = {}) => ({
    thread_fbid: id, thread_id: "340282366841710300244259255133000000001", thread_title: "", is_group: false,
    users: [{ id: "2", interop_messaging_user_fbid: FRIEND_FBID, username: "friend", full_name: "Friend" }, { id: "1", username: "me" }],
    viewer: { id: "1", interop_messaging_user_fbid: VIEWER_FBID, username: "me", full_name: "Me" },
    last_activity_timestamp_ms: "2000", slide_read_receipts: [{ participant_fbid: VIEWER_FBID, watermark_timestamp_ms: "1000" }],
    messaging_folder_tag: "INBOX", input_mode: 0,
    slide_messages: { edges: [{ node: node({ __typename: "SlideMessageText", text_body: "b" }, "TEXT", { message_id: "mid.$b", timestamp_ms: "2000" }) },
      { node: node({ __typename: "SlideMessageText", text_body: "a" }, "TEXT", { message_id: "mid.$a", timestamp_ms: "1500" }) }],
      page_info: { end_cursor: "c1", has_next_page: true } },
    ...extra,
  });

  test("inbox page: mailbox ids, viewer, threads oldest→newest, the viewer is not a participant", () => {
    const page = parseInboxPage({ get_slide_mailbox_for_iris_subscription: {
      id: "mb", iris_inactive_subscription_uq_seq_id: "705", threads_by_folder: {
        edges: [{ node: { as_ig_direct_thread: rawThread("100") } }], page_info: { end_cursor: "next", has_next_page: true } },
    } })!;
    expect(page).toMatchObject({ mailboxId: "mb", sequenceId: "705", cursor: "next", hasNextPage: true,
      viewer: { id: "1", fbid: VIEWER_FBID } });
    const thread = page.threads[0]!;
    expect(thread.users.map(u => u.id)).toEqual(["2"]);
    expect(thread.messages.map(m => m.id)).toEqual(["mid.$a", "mid.$b"]);
    expect(thread.legacyId).toHaveLength(39);
    expect(thread.viewerUsername).toBe("me");
    expect(isThreadUnread(thread)).toBe(true);
    expect(unreadMessages(thread)).toHaveLength(2);
    expect(parseInboxPage({})).toBeNull();
    expect(parseInboxPage({ fetch__SlideMailbox: { id: "mb", threads_by_folder: { edges: [] } } })!.threads).toEqual([]);
  });

  test("requests and search", () => {
    const requests = parseRequestsPage({ pendingMailbox: { threads_by_folder: { edges: [{ node: { as_ig_direct_thread: rawThread("300") } }] } },
      spamMailbox: { threads_by_folder: { edges: [{ node: { as_ig_direct_thread: rawThread("301") } }] } } })!;
    expect(requests.pending.map(t => [t.id, t.folder])).toEqual([["300", "pending"]]);
    expect(requests.spamCount).toBe(1);
    expect(isThreadUnread(requests.pending[0]!)).toBe(false);
    expect(parseSearchUsers({ xdt_api__v1__fbsearch__topsearch_connection: { users: [{ user: { pk: "42", username: "maya" } }, { user: { pk: "x" } }] } }))
      .toEqual([{ id: "42", fbid: "", username: "maya", name: "" }]);
  });

  test("unread and seen follow read watermarks; titles use nicknames and group names", () => {
    const thread = igThread("1", { receipts: { [VIEWER_FBID]: 500, [FRIEND_FBID]: 2_000_000 } });
    expect(isThreadUnread(thread)).toBe(true);
    expect(isThreadUnread({ ...thread, receipts: {} })).toBe(false);
    expect(isThreadUnread({ ...thread, messages: [...thread.messages, igMessage("11", { senderFbid: VIEWER_FBID, timestampMs: 1_100_000 })] })).toBe(false);
    expect(seenByOthers(thread, 1_500_000)).toBe(true);
    expect(threadTitle({ ...thread, nicknames: { "2": "Bestie" } })).toBe("Bestie");
    expect(threadTitle({ ...thread, isGroup: true, users: [...thread.users, { id: "3", fbid: "3", username: "c", name: "Cara Lee" }] })).toBe("Friend, Cara");
  });

  test("merging: previews never replace full messages; detail owns its range; older pages prepend", () => {
    const full = { ...igThread("1", { detailLoaded: true, messages: [igMessage("1", { timestampMs: 1 }), igMessage("2", { timestampMs: 2 }), igMessage("3", { timestampMs: 3 })] }) };
    const preview = igThread("1", { messages: [igMessage("3", { timestampMs: 3, content: { kind: "unsupported", text: "Sent a photo" } }), igMessage("4", { timestampMs: 4 })], cursor: "x" });
    const merged = mergeThreadPreview(full, preview);
    expect(merged.messages.map(m => m.id)).toEqual(["1", "2", "3", "4"]);
    expect(merged.messages[2]!.content.kind).toBe("text");
    expect(merged.cursor).toBe("first");
    // Detail: message 3 was unsent; 5 is new; older history (1) is kept.
    const detail = mergeThreadDetail(merged, igThread("1", { messages: [igMessage("2", { timestampMs: 2 }), igMessage("5", { timestampMs: 5 })], cursor: "c2" }));
    expect(detail.messages.map(m => m.id)).toEqual(["1", "2", "5"]);
    expect(detail.detailLoaded).toBe(true);
    const paged = prependOlder(detail, [igMessage("0", { timestampMs: 0 }), igMessage("1", { timestampMs: 1 })], null, false);
    expect(paged.messages.map(m => m.id)).toEqual(["0", "1", "2", "5"]);
    expect(paged.hasOlder).toBe(false);
    // A request stays a request until accepted, even if the detail omits the folder.
    expect(mergeThreadDetail({ ...full, folder: "pending" }, igThread("1")).folder).toBe("pending");
  });

  test("inbox-list copies are only placeholders: a detail page that doesn't cover them pages them in again", () => {
    // Inbox lists carry `__typename` + `text_body` only: a photo is "unsupported" with Instagram's snippet.
    const page = parseInboxPage({ get_slide_mailbox_for_iris_subscription: { id: "mb", threads_by_folder: { edges: [{ node: { as_ig_direct_thread: {
      thread_fbid: "100", viewer: { id: "1", interop_messaging_user_fbid: VIEWER_FBID },
      slide_messages: { edges: [
        { node: node({ __typename: "SlideMessageImageContent" }, "IMAGES", { message_id: "mid.$p", timestamp_ms: "3000", igd_snippet: "Maya sent a photo" }) },
        { node: node({ __typename: "SlideMessageText", text_body: "hi" }, "TEXT", { message_id: "mid.$t", timestamp_ms: "2000" }) },
      ] },
    } } }] } } })!;
    const [photo, text] = [page.threads[0]!.messages.find(m => m.id === "mid.$p")!, page.threads[0]!.messages.find(m => m.id === "mid.$t")!];
    expect(photo.listPreview).toBe(true);
    expect(text.listPreview).toBeUndefined();

    const opened = igThread("1", { detailLoaded: true, cursor: "old", hasOlder: true, messages: [igMessage("1", { timestampMs: 1 })] });
    const polled = mergeThreadPreview(opened, igThread("1", { messages: [{ ...photo, timestampMs: 5 }] }));
    // 20+ messages later the chat opens: its newest page starts after the list copy.
    const detail = mergeThreadDetail(polled, igThread("1", { messages: [igMessage("30", { timestampMs: 30 })], cursor: "c30", hasOlder: true }));
    expect(detail.messages.map(m => m.id)).toEqual(["30"]);
    expect(detail).toMatchObject({ cursor: "c30", hasOlder: true });
    // An older page's real copy replaces a placeholder it meets.
    const withPlaceholder = { ...detail, messages: [{ ...photo, timestampMs: 5 }, ...detail.messages] };
    const realPhoto = igMessage("mid.$p", { timestampMs: 5, content: { kind: "media", items: [] } });
    expect(prependOlder(withPlaceholder, [realPhoto], null, false).messages.map(m => [m.id, m.content.kind]))
      .toEqual([["mid.$p", "media"], ["30", "text"]]);
  });

  test("offline threading ids follow the web's format", () => {
    expect(offlineThreadingId(1_792_360_800_000, 5)).toBe(String((1_792_360_800_000n << 22n) | 5n));
    expect(offlineThreadingId()).not.toBe(offlineThreadingId());
    expect(parseThread({ thread_fbid: "nope" })).toBeNull();
  });
});

describe("Instagram picture sizes and shapes", () => {
  test("stickers keep the size the payload carries; portrait cards are marked 9:16", () => {
    expect(parseContent(node({ __typename: "SlideMessageCutoutStickerXMAContent", preview_url: cdn("s.webp"), preview_width: 512, preview_height: 480, alt_text: "cat" })))
      .toEqual({ kind: "sticker", url: cdn("s.webp"), alt: "cat", width: 512, height: 480 });
    expect(share({ __typename: "SlideMessagePortraitXMA", target_url: "https://www.instagram.com/reel/R1/", preview_image: { url: cdn("r.jpg") } }).portrait).toBe(true);
    expect(share({ __typename: "SlideMessageStandardXMA", target_url: "https://www.instagram.com/p/P1/", preview_image: { url: cdn("p.jpg") } }).portrait).toBeUndefined();
  });
});

describe("Instagram reaction notices", () => {
  const system = (id: string, text: string, overrides: Partial<ReturnType<typeof igMessage>> = {}) =>
    igMessage(id, { content: { kind: "system", text }, ...overrides });

  test("are recognised from the flag, Instagram's sentences and reduced inbox snippets; other lines are not", () => {
    const flagged = parseMessage(node({ __typename: "SlideMessageAdminText", is_reaction_action_log: true, text_fragments: [{ plaintext: "Maya reacted 😂 to your message" }] }, "TEXT"))!;
    expect(reactionNotice(flagged)).toEqual({ emoji: "😂", targetId: null });
    expect(reactionNotice(system("a", "Maya liked a message"))).toEqual({ emoji: "❤️", targetId: null });
    expect(reactionNotice(system("b", "You reacted 🔥 to their message"))?.emoji).toBe("🔥");
    expect(reactionNotice(system("c", "Reacted 💗 to your message"))?.emoji).toBe("💗");
    expect(reactionNotice(igMessage("d", { content: { kind: "unsupported", text: "Message" }, snippet: "Reacted ❤️ to your message" }))?.emoji).toBe("❤️");
    for (const line of ["Maya named the group Weekend crew", "Reacted to your story", "Missed video call"]) {
      expect(reactionNotice(system("e", line))).toBeNull();
    }
    // Something a person typed is never hidden.
    expect(reactionNotice(igMessage("f", { content: { kind: "text", text: "liked a message" } }))).toBeNull();
  });

  test("are dropped from threads; their reaction lands on the target when the payload names it", () => {
    const target = igMessage("m1", { senderFbid: VIEWER_FBID, timestampMs: 1_000 });
    const named = system("n1", "Friend reacted 😂 to your message", {
      timestampMs: 2_000, replyTo: { id: "m1", senderFbid: VIEWER_FBID, senderName: "Me", summary: "hello" },
    });
    const unnamed = system("n2", "Friend liked a message", { timestampMs: 3_000 });
    const folded = foldReactionNotices(igThread("100", { messages: [target, named, unnamed], lastActivityMs: 3_000 }), igThread("100", { lastActivityMs: 900 }));
    expect(folded.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(folded.messages[0]!.reactions).toEqual([{ emoji: "😂", senderFbid: FRIEND_FBID }]);
    // A reaction is not activity: the chat keeps its place in the list.
    expect(folded.lastActivityMs).toBe(1_000);
    // Never counted as unread.
    expect(unreadMessages({ ...folded, receipts: { [VIEWER_FBID]: 500 } })).toEqual([]);
    // Already there (Instagram also lists it on the message): not doubled.
    const again = foldReactionNotices({ ...folded, messages: [...folded.messages, named] });
    expect(again.messages[0]!.reactions.length).toBe(1);
  });
});
