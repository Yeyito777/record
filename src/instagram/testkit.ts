/** Synthetic Instagram data for tests (no real people, ids or text). */
import type { IgInboxPage, IgMessage, IgThread } from "./model";

export const VIEWER_ID = "1";
export const VIEWER_FBID = "900";
export const FRIEND_FBID = "800";

export function igMessage(id: string, overrides: Partial<IgMessage> = {}): IgMessage {
  return {
    id, senderFbid: FRIEND_FBID, senderName: "Friend", timestampMs: 1_000_000,
    content: { kind: "text", text: "hello" }, reactions: [], ...overrides,
  };
}

/** A read 1:1 thread with one message from the friend. */
export function igThread(id = "100", overrides: Partial<IgThread> = {}): IgThread {
  return {
    id, legacyId: `3402823668417103${id.padStart(23, "0")}`, rawTitle: "",
    users: [{ id: "2", fbid: FRIEND_FBID, username: "friend", name: "Friend" }],
    viewerFbid: VIEWER_FBID, isGroup: false, lastActivityMs: 1_000_000,
    messages: [igMessage("10")], receipts: { [VIEWER_FBID]: 1_000_000, [FRIEND_FBID]: 1_000_000 },
    markedUnread: false, muted: false, folder: "inbox", canSend: true, nicknames: {},
    hasOlder: true, cursor: "first", detailLoaded: false, ...overrides,
  };
}

export function igPage(threads: IgThread[] = [igThread()], next: string | null = null): IgInboxPage {
  return {
    threads, cursor: next, hasNextPage: Boolean(next), mailboxId: "17850000000000001", sequenceId: "705483",
    viewer: { id: VIEWER_ID, fbid: VIEWER_FBID, username: "me", name: "Me" },
  };
}

/** A minimal GraphQL Relay response envelope. */
export function graphResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(`for (;;);${JSON.stringify({ data, extensions: { is_final: true } })}`, {
    status: 200, headers: { "content-type": "text/javascript" }, ...init,
  });
}

export const TOKEN_PAGE = `<html><script>["DTSGInitialData",[],{"token":"dtsg-test-token"},258] ["LSD",[],{"token":"lsd-test"},323]</script></html>`;
