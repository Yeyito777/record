import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstagramClient, shortcodeToPk } from "./client";
import { bundleUrls, INSTAGRAM_DOCS, InstagramDocIdStore, scrapeDocIds } from "./docids";
import { instagramReadOnlyFromEnv, InstagramApiError, InstagramTransport, parseInstagramJson, parseWebTokens } from "./transport";
import { graphResponse, TOKEN_PAGE } from "./testkit";

const session = { cookies: { sessionid: "test-session", csrftoken: "test-csrf", ds_user_id: "1" } };

interface Call { url: string; init: RequestInit; body: URLSearchParams | null }

/** A fake www.instagram.com: the token page, then GraphQL answers by operation name. */
function fakeInstagram(answers: Record<string, (call: Call) => Response | Promise<Response>>, page = () => new Response(TOKEN_PAGE)) {
  const calls: Call[] = [];
  const fetcher = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body instanceof URLSearchParams ? init.body : null;
    const call = { url, init, body };
    calls.push(call);
    if (url === "https://www.instagram.com/") return page();
    const name = body?.get("fb_api_req_friendly_name") ?? url;
    const answer = answers[name];
    if (!answer) return new Response("not found", { status: 404 });
    return answer(call);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const noDocIds = () => new InstagramDocIdStore(null);
const options = (fetcher: typeof fetch, extra: Record<string, unknown> = {}) =>
  ({ fetcher, docIds: noDocIds(), minimumGapMs: 0, readOnly: false, ...extra });

describe("Instagram transport", () => {
  test("bootstraps fb_dtsg/lsd once for concurrent callers and posts IGD GraphQL to /api/graphql", async () => {
    let pages = 0;
    const ig = fakeInstagram({
      PolarisDirectInboxQuery: () => graphResponse({ get_slide_mailbox_for_iris_subscription: { id: "m", threads_by_folder: { edges: [] } } }),
    }, () => { pages++; return new Response(TOKEN_PAGE); });
    const client = new InstagramClient(session, options(ig.fetcher));
    await Promise.all([client.inbox(), client.inbox(), client.inbox(), client.inbox()]);
    expect(pages).toBe(1);
    expect(client.transport.bootstrapFetches).toBe(1);
    const post = ig.calls.find(call => call.body)!;
    expect(post.url).toBe("https://www.instagram.com/api/graphql");
    expect(post.init.redirect).toBe("manual");
    expect(post.body!.get("doc_id")).toBe(INSTAGRAM_DOCS.inbox.docId);
    expect(post.body!.get("fb_dtsg")).toBe("dtsg-test-token");
    expect(post.body!.get("lsd")).toBe("lsd-test");
    expect(JSON.parse(post.body!.get("variables")!).__relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider).toBe(5);
    const headers = post.init.headers as Record<string, string>;
    expect(headers["X-CSRFToken"]).toBe("test-csrf");
    expect(headers["X-FB-LSD"]).toBe("lsd-test");
    expect(headers["User-Agent"]).toContain("iPhone");
    expect(headers.Cookie).toContain("sessionid=test-session");
    // Later calls reuse the cached tokens.
    await client.inbox();
    expect(pages).toBe(1);
  });

  test("read-only mode refuses every mutation before the network", async () => {
    const ig = fakeInstagram({});
    const client = new InstagramClient(session, options(ig.fetcher, { readOnly: true }));
    for (const attempt of [
      () => client.sendText("hi", { threadId: "100" }), () => client.react("100", "mid.$1", "❤️", false),
      () => client.markRead("100", "3402823668417103000001", "mid.$1"), () => client.acceptRequest("100"),
    ]) {
      const error = await attempt().catch(error => error);
      expect(error).toBeInstanceOf(InstagramApiError);
      expect((error as InstagramApiError).kind).toBe("read_only");
    }
    expect(ig.calls).toHaveLength(0);
    expect(instagramReadOnlyFromEnv({ RECORD_INSTAGRAM_READONLY: "1" })).toBe(true);
    expect(instagramReadOnlyFromEnv({})).toBe(false);
  });

  test("sends text with a client id, replies, exactly once; an ack without message_id is uncertain", async () => {
    let sends = 0;
    const ig = fakeInstagram({
      IGDirectTextSendMutation: () => {
        sends++;
        return graphResponse({ xig_direct_text_send_with_slide_messaging_response: sends === 1 ? { message_id: "mid.$sent", timestamp_ms: "2000" } : {} });
      },
    });
    const client = new InstagramClient(session, options(ig.fetcher));
    const receipt = await client.sendText("test & hello", { threadId: "100" }, { replyTo: "mid.$10", otid: "7000" });
    expect(receipt).toEqual({ messageId: "mid.$sent", timestampMs: 2000 });
    const variables = JSON.parse(ig.calls.at(-1)!.body!.get("variables")!);
    expect(variables).toMatchObject({ ig_thread_igid: "100", recipient_igids: null, text: { sensitive_string_value: "test & hello" },
      reply_to_message_id: "mid.$10", offline_threading_id: "7000" });
    const error = await client.sendText("again", { recipientIds: ["2"] }).catch(error => error);
    expect((error as InstagramApiError).kind).toBe("uncertain");
    expect(sends).toBe(2);
    expect(JSON.parse(ig.calls.at(-1)!.body!.get("variables")!)).toMatchObject({ ig_thread_igid: null, recipient_igids: ["2"] });
    await expect(client.thread("../elsewhere", "1")).rejects.toThrow("Invalid");
  });

  test("a dropped connection on a write is uncertain and never replayed", async () => {
    let sends = 0;
    const ig = fakeInstagram({ IGDirectTextSendMutation: () => { sends++; throw new TypeError("socket closed"); } });
    const error = await new InstagramClient(session, options(ig.fetcher)).sendText("hi", { threadId: "100" }).catch(error => error);
    expect((error as InstagramApiError).kind).toBe("uncertain");
    expect(sends).toBe(1);
  });

  test("redacts bodies; login redirects, challenges and rate limits are fatal; 5xx is transient", async () => {
    const cases: Array<[Response, InstagramApiError["kind"], boolean]> = [
      [new Response("secret-session", { status: 302, headers: { location: "https://www.instagram.com/accounts/login/" } }), "auth", true],
      [new Response("secret-session", { status: 302, headers: { location: "/challenge/123/" } }), "challenge", true],
      [new Response("secret-session", { status: 429 }), "rate_limit", true],
      [Response.json({ message: "checkpoint_required", checkpoint_url: "/challenge/x" }, { status: 400 }), "challenge", true],
      [new Response("<html>secret-session</html>", { status: 503 }), "transient", false],
    ];
    for (const [response, kind, fatal] of cases) {
      const ig = fakeInstagram({ PolarisDirectInboxQuery: () => response.clone() });
      const error = await new InstagramClient(session, options(ig.fetcher)).inbox().catch(error => error);
      expect(error).toBeInstanceOf(InstagramApiError);
      expect((error as InstagramApiError).kind).toBe(kind);
      expect((error as InstagramApiError).fatal).toBe(fatal);
      expect(String(error)).not.toContain("secret-session");
    }
    // A signed-out token page is an expired session, not a crash.
    const signedOut = fakeInstagram({}, () => new Response("<html>login</html>"));
    expect(((await new InstagramClient(session, options(signedOut.fetcher)).inbox().catch(e => e)) as InstagramApiError).kind).toBe("auth");
    // A revoked session: Instagram deletes sessionid and redirects to its own home page.
    const revoked = fakeInstagram({}, () => new Response(null, {
      status: 302,
      headers: [["location", "https://www.instagram.com/"], ["set-cookie", 'sessionid=""; Domain=.instagram.com; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/']],
    }));
    const revokedError = (await new InstagramClient(session, options(revoked.fetcher)).inbox().catch(e => e)) as InstagramApiError;
    expect([revokedError.kind, revokedError.fatal]).toEqual(["auth", true]);
    expect(revokedError.message).toContain("session expired");
  });

  test("a stale fb_dtsg (1357004) re-bootstraps and retries a read once", async () => {
    let pages = 0, posts = 0;
    const ig = fakeInstagram({
      PolarisDirectInboxQuery: () => ++posts === 1
        ? new Response(`for (;;);{"__ar":1,"error":1357004,"errorSummary":"x","payload":null}`)
        : graphResponse({ get_slide_mailbox_for_iris_subscription: { id: "m", threads_by_folder: { edges: [] } } }),
    }, () => { pages++; return new Response(TOKEN_PAGE); });
    await new InstagramClient(session, options(ig.fetcher)).inbox();
    expect(posts).toBe(2);
    expect(pages).toBe(2);
  });

  test("an unknown doc_id refreshes ids from the public bundles (without cookies) and retries a read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "record-ig-docids-"));
    try {
      const store = new InstagramDocIdStore(join(directory, "doc-ids.json"));
      let pageNumber = 0;
      const calls: Call[] = [];
      const fetcher = (async (input: any, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init, body: init.body instanceof URLSearchParams ? init.body : null });
        if (url === "https://www.instagram.com/") {
          pageNumber++;
          return new Response(`${TOKEN_PAGE}<script src="https:\\/\\/static.cdninstagram.com\\/rsrc.php\\/v4\\/a\\/b.js"></script>`);
        }
        if (url.startsWith("https://static.cdninstagram.com/")) {
          return new Response(`__d("PolarisDirectInboxQuery_instagramRelayOperation",[],(function(t,n,r,o,a,i){a.exports="111"}),null);`);
        }
        const docId = (init.body as URLSearchParams).get("doc_id");
        return docId === "111"
          ? graphResponse({ get_slide_mailbox_for_iris_subscription: { id: "m", threads_by_folder: { edges: [] } } })
          : new Response(JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] }));
      }) as unknown as typeof fetch;
      await new InstagramClient(session, { fetcher, docIds: store, minimumGapMs: 0 }).inbox();
      const bundle = calls.find(call => call.url.startsWith("https://static.cdninstagram.com/"))!;
      expect((bundle.init.headers as Record<string, string>).Cookie).toBeUndefined();
      expect(store.docId(INSTAGRAM_DOCS.inbox)).toBe("111");
      expect(new InstagramDocIdStore(join(directory, "doc-ids.json")).docId(INSTAGRAM_DOCS.inbox)).toBe("111");
      expect(pageNumber).toBeGreaterThanOrEqual(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("applies cookie rotations from successful responses, never deletions", async () => {
    const rotated: Array<Record<string, string>> = [];
    const ig = fakeInstagram({
      PolarisDirectInboxQuery: () => {
        const response = graphResponse({ get_slide_mailbox_for_iris_subscription: { id: "m", threads_by_folder: { edges: [] } } });
        response.headers.append("set-cookie", "csrftoken=rotated; Path=/; Secure");
        response.headers.append("set-cookie", "sessionid=\"\"; expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0");
        return response;
      },
    });
    const transport = new InstagramTransport({ cookies: { ...session.cookies } }, {
      ...options(ig.fetcher), onSessionRotated: value => rotated.push(value.cookies),
    });
    await transport.graphql(INSTAGRAM_DOCS.inbox, {});
    expect(rotated.at(-1)?.csrftoken).toBe("rotated");
    expect(rotated.at(-1)?.sessionid).toBe("test-session");
  });

  test("parses tokens, XSSI prefixes, bundle URLs, doc ids and shortcodes", () => {
    expect(parseWebTokens(TOKEN_PAGE)).toEqual({ dtsg: "dtsg-test-token", lsd: "lsd-test" });
    expect(parseWebTokens("<html></html>")).toBeNull();
    expect(parseInstagramJson(`for (;;);{"a":1}`)).toEqual({ a: 1 });
    expect(parseInstagramJson(`{"a":1}\n{"b":2}`)).toEqual({ a: 1 });
    expect(bundleUrls(`src="https://static.cdninstagram.com/rsrc.php/v4/x/y.js?_nc=1" "https:\\/\\/evil.example\\/rsrc.php\\/a.js"`))
      .toEqual(["https://static.cdninstagram.com/rsrc.php/v4/x/y.js?_nc=1"]);
    expect(scrapeDocIds(`__d("IGDThreadDetailQuery_instagramRelayOperation",[],(function(t,n,r,o,a,i){a.exports="42"}),null);`))
      .toEqual({ IGDThreadDetailQuery: "42" });
    expect(shortcodeToPk("CPostDemo01")).toBe("2587514596081962293");
    expect(shortcodeToPk("../x")).toBeNull();
  });
});
