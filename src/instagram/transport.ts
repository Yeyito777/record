import type { InstagramSession } from "./auth";
import { bundleUrls, INSTAGRAM_DOCS, InstagramDocIdStore, isInstagramMutation, scrapeDocIds, type InstagramDocument } from "./docids";

export type InstagramErrorKind =
  | "auth" | "challenge" | "rate_limit" | "feedback" | "read_only" | "rejected" | "transient" | "invalid" | "uncertain" | "stale";

export class InstagramApiError extends Error {
  constructor(message: string, readonly fatal = false, readonly kind: InstagramErrorKind = fatal ? "rejected" : "transient") {
    super(message);
  }
}

/** `RECORD_INSTAGRAM_READONLY=1`: never send, react, accept, or mark anything read. */
export function instagramReadOnlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.RECORD_INSTAGRAM_READONLY ?? "");
}

export interface InstagramTransportOptions {
  fetcher?: typeof fetch;
  readOnly?: boolean;
  docIds?: InstagramDocIdStore;
  /** Instagram rotated cookies on a successful response: persist the session. */
  onSessionRotated?: (session: InstagramSession) => void;
  minimumGapMs?: number;
  now?: () => number;
}

interface WebTokens { dtsg: string; lsd: string }

const APP_ID = "936619743392459";
const ASBD_ID = "359341";
/**
 * iOS Safari (Quiet's verified identity). A desktop Chrome UA without the
 * matching sec-ch-* client hints gets IGD GraphQL error 1357054.
 */
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const TOKEN_TTL_MS = 30 * 60_000;
const ROTATABLE = /^(csrftoken|rur|wd|mid|ig_did|datr|ds_user_id|sessionid|shbid|shbts|ig_nrcb)$/;

/** Parse the CSRF form tokens from a signed-in page's named auth modules only. */
export function parseWebTokens(html: string): WebTokens | null {
  const token = (module: string) => {
    const match = html.match(new RegExp(`"${module}"\\s*,\\s*\\[\\s*\\]\\s*,\\s*\\{[^{}]{0,4096}?"token"\\s*:\\s*"([^"]{1,4096})"`));
    const value = match?.[1];
    return value && /^[\x21-\x7e]+$/.test(value) ? value : null;
  };
  const dtsg = token("DTSGInitialData"), lsd = token("LSD");
  return dtsg && lsd ? { dtsg, lsd } : null;
}

/** Strip Instagram's `for (;;);` XSSI prefix; streamed responses carry the primary payload first. */
export function parseInstagramJson(text: string): any {
  const clean = text.startsWith("for (;;);") ? text.slice(9) : text;
  try { return JSON.parse(clean); } catch {
    const first = clean.split("\n", 1)[0];
    return first && first !== clean ? JSON.parse(first) : (() => { throw new SyntaxError("Not JSON"); })();
  }
}

function looksStale(json: any): boolean {
  const parts = [String(json?.errorSummary ?? "")];
  for (const error of Array.isArray(json?.errors) ? json.errors : []) parts.push(String(error?.message ?? ""), String(error?.summary ?? ""));
  const text = parts.join(" ").toLowerCase();
  return text.includes("persistedquery") || text.includes("persisted_query") || text.includes("doc_id")
    || (text.includes("document") && text.includes("not found"));
}

/**
 * The one path to Instagram for this provider (a port of Quiet's LiveBackend):
 * cookie session, fb_dtsg/lsd bootstrap from a signed-in page (cached 30 min,
 * concurrent callers share one fetch), IGD GraphQL on /api/graphql with
 * doc_id refresh from the public bundles, cookie rotation, typed errors, a
 * small request gap, and the read-only guard for every mutation.
 * Never logs or echoes cookies, tokens or response bodies.
 */
export class InstagramTransport {
  readonly readOnly: boolean;
  private readonly fetcher: typeof fetch;
  private readonly docIds: InstagramDocIdStore;
  private tokens: (WebTokens & { sessionId: string; at: number }) | null = null;
  private tokenFetch: Promise<WebTokens> | null = null;
  private wwwClaim = "0";
  private lastRequestAt = 0;
  private refreshing: Promise<boolean> | null = null;
  /** Token page fetches actually sent (tests). */
  bootstrapFetches = 0;

  constructor(private session: InstagramSession, private readonly options: InstagramTransportOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.readOnly = options.readOnly ?? instagramReadOnlyFromEnv();
    this.docIds = options.docIds ?? new InstagramDocIdStore();
  }

  get viewerId(): string { return this.session.cookies.ds_user_id ?? ""; }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private cookieHeader(): string {
    return Object.entries(this.session.cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private async pace(): Promise<void> {
    const gap = this.options.minimumGapMs ?? 250;
    const wait = this.lastRequestAt + gap - Date.now();
    this.lastRequestAt = Math.max(Date.now(), this.lastRequestAt + gap);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    await this.pace();
    try {
      return await this.fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(25_000), ...init });
    } catch {
      throw new InstagramApiError("Instagram request failed or timed out. Try /refresh.", false, "transient");
    }
  }

  /** Apply Set-Cookie rotations from a successful response (never deletions of the login). */
  private rotate(response: Response): void {
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    let changed = false;
    for (const header of cookies) {
      const pair = header.split(";", 1)[0] ?? "";
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim(), value = pair.slice(equals + 1).trim();
      if (!ROTATABLE.test(name) || !value || value === "\"\"" || value === "deleted" || /[\r\n;\s]/.test(value)) continue;
      if (/max-age=0|expires=thu, 01[ -]jan[ -]1970/i.test(header)) continue;
      if (this.session.cookies[name] !== value) { this.session.cookies[name] = value; changed = true; }
    }
    const claim = response.headers.get("x-ig-set-www-claim");
    if (claim && /^[\w:.-]{1,200}$/.test(claim)) this.wwwClaim = claim;
    if (changed) this.options.onSessionRotated?.({ cookies: { ...this.session.cookies } });
  }

  private failFor(response: Response, json: any): never {
    const status = response.status;
    if (status === 429) throw new InstagramApiError("Instagram rate limit reached. Wait before /refresh.", true, "rate_limit");
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.get("location") ?? "";
      if (/\/accounts\/login/.test(location)) throw new InstagramApiError("Instagram session expired. Sign in in your browser, then /login instagram.", true, "auth");
      if (/challenge|checkpoint|suspended/.test(location)) throw new InstagramApiError("Instagram needs verification. Open it in your browser, then /login instagram.", true, "challenge");
      throw new InstagramApiError(`Instagram redirected the request (HTTP ${status}).`, false, "transient");
    }
    if (status >= 500 || status === 408) throw new InstagramApiError(`Instagram is temporarily unavailable (HTTP ${status}). Record will retry.`, false, "transient");
    const message = String(json?.message ?? "");
    if (json?.challenge || json?.checkpoint_url || /challenge_required|checkpoint/.test(message)) {
      throw new InstagramApiError("Instagram needs verification. Open it in your browser, then /login instagram.", true, "challenge");
    }
    if (status === 401 || message === "login_required" || json?.require_login) {
      throw new InstagramApiError("Instagram session expired. Sign in in your browser, then /login instagram.", true, "auth");
    }
    if (message.includes("feedback_required") || json?.feedback_title) {
      throw new InstagramApiError("Instagram blocked this action for now. Try again later in the app.", true, "feedback");
    }
    if (/please wait/i.test(message)) throw new InstagramApiError("Instagram asked to slow down. Wait before /refresh.", true, "rate_limit");
    // Never echo server payloads: they can contain credentials or terminal controls.
    throw new InstagramApiError(`Instagram request was rejected (HTTP ${status}).`, true, "rejected");
  }

  /** fb_dtsg + lsd from a signed-in page, cached per sessionid; one fetch for concurrent callers. */
  async webTokens(): Promise<WebTokens> {
    const sessionId = this.session.cookies.sessionid ?? "";
    if (this.tokens && this.tokens.sessionId === sessionId && this.now() - this.tokens.at < TOKEN_TTL_MS) return this.tokens;
    if (this.tokenFetch) return this.tokenFetch;
    const fetching = this.fetchTokens(sessionId);
    this.tokenFetch = fetching;
    try { return await fetching; } finally { if (this.tokenFetch === fetching) this.tokenFetch = null; }
  }

  private async fetchTokens(sessionId: string): Promise<WebTokens> {
    this.bootstrapFetches++;
    const response = await this.send("https://www.instagram.com/", {
      headers: { Cookie: this.cookieHeader(), Accept: "text/html,application/xhtml+xml", "User-Agent": USER_AGENT },
    });
    if (response.status !== 200) this.failFor(response, null);
    const tokens = parseWebTokens(await response.text());
    if (!tokens) {
      throw new InstagramApiError("Instagram session expired or needs verification. Sign in in your browser, then /login instagram.", true, "auth");
    }
    this.rotate(response);
    this.tokens = { ...tokens, sessionId, at: this.now() };
    return tokens;
  }

  /** Run a persisted GraphQL operation and return `data`. Reads retry once on stale tokens or doc_ids. */
  async graphql(document: InstagramDocument, variables: Record<string, unknown>, referer = "/direct/inbox/", retry = true): Promise<any> {
    const mutation = isInstagramMutation(document);
    if (mutation && this.readOnly) {
      throw new InstagramApiError("Read-only mode (RECORD_INSTAGRAM_READONLY): nothing was sent.", false, "read_only");
    }
    const tokens = await this.webTokens();
    const docId = this.docIds.docId(document);
    const body = new URLSearchParams({
      av: this.viewerId, __d: "www", __user: "0", __a: "1", __comet_req: "7",
      fb_dtsg: tokens.dtsg, lsd: tokens.lsd, fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: document.name, server_timestamps: "true",
      variables: JSON.stringify(variables), doc_id: docId,
    });
    let response: Response;
    try {
      response = await this.send(`https://www.instagram.com/${document.route === "api" ? "api/graphql" : "graphql/query"}`, {
        method: "POST",
        headers: {
          Cookie: this.cookieHeader(), "User-Agent": USER_AGENT, Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded", "X-CSRFToken": this.session.cookies.csrftoken ?? "",
          "X-IG-App-ID": APP_ID, "X-ASBD-ID": ASBD_ID, "X-FB-LSD": tokens.lsd,
          "X-FB-Friendly-Name": document.name, "X-Root-Field-Name": document.root,
          Origin: "https://www.instagram.com", Referer: `https://www.instagram.com${referer}`,
        },
        body,
      });
    } catch (error) {
      // A write whose connection dropped may have landed: never replay it.
      if (mutation && error instanceof InstagramApiError && error.kind === "transient") {
        throw new InstagramApiError("Instagram may not have received this. Refresh before trying again.", false, "uncertain");
      }
      throw error;
    }
    let json: any = null;
    try { json = parseInstagramJson(await response.text()); } catch { json = null; }
    if (response.status >= 300 || json === null) {
      if (response.status === 403 && !String(json?.message ?? "").includes("login_required")) {
        this.tokens = null;
        if (retry && !mutation) return this.graphql(document, variables, referer, false);
        throw new InstagramApiError("Instagram couldn't authorize this request. Try again.", false, "rejected");
      }
      if (json === null && response.status < 300) {
        throw new InstagramApiError(mutation ? "Instagram's reply was unreadable; it may have been sent. Refresh before retrying."
          : "Instagram returned an unreadable response.", false, mutation ? "uncertain" : "invalid");
      }
      this.failFor(response, json);
    }
    if (json?.error === 1357004) {
      this.tokens = null;
      if (retry && !mutation) return this.graphql(document, variables, referer, false);
      throw new InstagramApiError("Instagram couldn't authorize this request. Try again.", false, "rejected");
    }
    const message = String(json?.message ?? "");
    if (json?.status === "fail" || message) this.failFor(response, json);
    const data = json?.data;
    const rootOk = data && typeof data === "object" && data[document.root] !== undefined;
    if (!rootOk) {
      if (looksStale(json) && retry && await this.refreshDocIds() && this.docIds.docId(document) !== docId) {
        if (!mutation) return this.graphql(document, variables, referer, false);
        throw new InstagramApiError("Instagram updated. Try again.", false, "stale");
      }
      const codes = (Array.isArray(json?.errors) ? json.errors : []).map((error: any) => Number(error?.code));
      if (codes.includes(1675004)) throw new InstagramApiError("Instagram cancelled this send.", false, "rejected");
      if (codes.some((code: number) => code === 1404006 || code === 1404078)) {
        throw new InstagramApiError("Instagram blocked this action for now. Try again later in the app.", true, "feedback");
      }
      throw new InstagramApiError(mutation ? "Instagram did not accept this request." : "Instagram returned an unsupported response.",
        false, mutation ? "rejected" : "invalid");
    }
    this.rotate(response);
    return data;
  }

  /** A web REST read (`/api/v1/<path>`), e.g. one shared reel's media. */
  async rest(path: string, referer = "/"): Promise<any> {
    const response = await this.send(`https://www.instagram.com/api/v1/${path}`, {
      headers: {
        Cookie: this.cookieHeader(), "User-Agent": USER_AGENT, Accept: "*/*",
        "X-CSRFToken": this.session.cookies.csrftoken ?? "", "X-IG-App-ID": APP_ID, "X-ASBD-ID": ASBD_ID,
        "X-IG-WWW-Claim": this.wwwClaim, "X-Requested-With": "XMLHttpRequest",
        Origin: "https://www.instagram.com", Referer: `https://www.instagram.com${referer}`,
      },
    });
    let json: any = null;
    try { json = parseInstagramJson(await response.text()); } catch { json = null; }
    if (!response.ok || json?.status !== "ok") {
      if (json === null && response.ok) throw new InstagramApiError("Instagram returned an unreadable response.", false, "invalid");
      this.failFor(response, json);
    }
    this.rotate(response);
    return json;
  }

  /** Re-scrape doc_ids from the public bundles the home page references (≤ every 6 h). */
  async refreshDocIds(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    if (!this.docIds.canRefresh()) return false;
    this.docIds.markAttempt();
    const run = (async () => {
      try {
        const page = await this.send("https://www.instagram.com/", {
          headers: { Cookie: this.cookieHeader(), Accept: "text/html", "User-Agent": USER_AGENT },
        });
        if (page.status !== 200) return false;
        const wanted = new Set<string>(Object.values(INSTAGRAM_DOCS).map(document => document.name));
        const found: Record<string, string> = {};
        for (const url of bundleUrls(await page.text()).slice(0, 80)) {
          // Public static JS: never send cookies.
          const bundle = await this.send(url, { headers: { "User-Agent": USER_AGENT } }).catch(() => null);
          if (!bundle?.ok) continue;
          for (const [name, id] of Object.entries(scrapeDocIds(await bundle.text()))) if (wanted.has(name)) found[name] = id;
          if (Object.keys(found).length === wanted.size) break;
        }
        await this.docIds.update(found);
        return Object.keys(found).length > 0;
      } catch {
        return false;
      }
    })();
    this.refreshing = run;
    try { return await run; } finally { this.refreshing = null; }
  }
}
