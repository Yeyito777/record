import { describe, expect, test } from "bun:test";

import { loadedMentionCandidates, mentionCandidateForToken } from "./mentions";
import { createInitialState } from "./state";
import { appendTimelineMessage, setTimelineMessages } from "./timeline";

const member = (id: string, name: string) => ({ id, username: name, displayName: name, bot: false });
const message = (id: string, author: ReturnType<typeof member>) => ({
  id, channelId: "c1", guildId: "g1", type: 0, content: "hi", mentionEveryone: false, mentionRoleIds: [], mentionUserIds: [], mentionUsers: [],
  timestamp: Number(id), editedTimestamp: null, author, reply: null, call: null, attachments: [], stickerNames: [], embedsCount: 0,
} as any);

describe("mention index", () => {
  test("reuses the candidate list until an input changes, then picks up new users", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.channelList.guildId = "g1";
    state.channelList.activeChannelId = "c1";
    state.channelList.activeChannel = { id: "c1", guildId: "g1", parentId: null, name: "general", topic: null, position: 0, type: 0, nsfw: false } as any;
    state.memberList.guildId = "g1";
    state.memberList.channelId = "c1";
    state.memberList.members = [member("1", "alice")];
    setTimelineMessages(state.timeline, "c1", [message("10", member("2", "bob"))]);

    const first = loadedMentionCandidates(state);
    expect(loadedMentionCandidates(state)).toBe(first);
    expect(mentionCandidateForToken(state, "bob")?.id).toBe("2");
    expect(mentionCandidateForToken(state, "carol")).toBeNull();

    appendTimelineMessage(state.timeline, message("11", member("3", "carol")));
    expect(mentionCandidateForToken(state, "carol")?.id).toBe("3");

    state.memberList.members = [member("1", "alice"), member("4", "dave")];
    expect(mentionCandidateForToken(state, "dave")?.id).toBe("4");

    state.messageCacheByChannelId.c9 = { channelId: "c9", messages: [{ ...message("12", member("5", "erin")), channelId: "c9" }], hasOlder: false, updatedAt: 0, latestFetchedAt: null };
    expect(mentionCandidateForToken(state, "erin")?.id).toBe("5");
  });
});
