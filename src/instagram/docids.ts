import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { instagramAuthPath } from "./auth";

/** Which URL a GraphQL operation is posted to. IGD (DM) operations only work on /api/graphql. */
export type InstagramGraphQLRoute = "api" | "query";

export interface InstagramDocument {
  /** Relay operation name, as shipped in Instagram's web bundles. */
  name: string;
  /** Snapshot doc_id (Oct 2026); a runtime override from the bundles wins. */
  docId: string;
  /** Field under `data` that must be present for success. */
  root: string;
  route: InstagramGraphQLRoute;
}

const doc = (name: string, docId: string, root: string, route: InstagramGraphQLRoute = "api"): InstagramDocument =>
  ({ name, docId, root, route });

/**
 * Every operation Record uses, from Quiet's verified map (Quiet docs/API.md §7).
 * Mutations are recognised by name (`…Mutation`) and blocked in read-only mode.
 */
export const INSTAGRAM_DOCS = {
  inbox: doc("PolarisDirectInboxQuery", "27909866362025854", "get_slide_mailbox_for_iris_subscription"),
  inboxPage: doc("IGDThreadListOffMsysPaginationQuery", "28774058922187457", "fetch__SlideMailbox"),
  thread: doc("IGDThreadDetailQuery", "39768212509458705", "get_slide_thread_nullable"),
  olderMessages: doc("IGDMessageListOffMsysQuery", "28309970012037685", "fetch__SlideThread"),
  requests: doc("IGDMessageRequestLeftRailStandaloneQuery", "28140752162262138", "pendingMailbox"),
  search: doc("PolarisSearchBoxRefetchableQuery", "27706427925724183", "xdt_api__v1__fbsearch__topsearch_connection", "query"),
  sendText: doc("IGDirectTextSendMutation", "26911679871773184", "xig_direct_text_send_with_slide_messaging_response"),
  react: doc("IGDirectReactionSendMutation", "24374451552236906", "xig_direct_reaction_send_with_slide_messaging_response"),
  markRead: doc("useIGDMarkThreadAsReadMutation", "27399783383056109", "xig_direct_item_seen_mutation_with_slide_messaging_response"),
  acceptRequest: doc("useIGDirectAcceptMessageRequestMutation", "36571001125823973", "ig_direct_accept_message_request"),
} as const satisfies Record<string, InstagramDocument>;

export function isInstagramMutation(document: InstagramDocument): boolean {
  return /mutation/i.test(document.name);
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Runtime doc_id overrides scraped from Instagram's public JS bundles,
 * persisted next to the session (`record/instagram/doc-ids.json`). Refreshed
 * only when an operation looks stale, and at most every 6 hours.
 */
export class InstagramDocIdStore {
  private overrides: Record<string, string> = {};
  private refreshedAt = 0;

  constructor(private readonly path: string | null = defaultDocIdPath()) {
    if (!path) return;
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data?.version === 1 && data.ids && typeof data.ids === "object") {
        for (const [name, id] of Object.entries(data.ids)) {
          if (/^[A-Za-z0-9_]+$/.test(name) && typeof id === "string" && /^\d+$/.test(id)) this.overrides[name] = id;
        }
        this.refreshedAt = Number(data.refreshedAt) || 0;
      }
    } catch {
      // No overrides yet: the snapshot ids are used.
    }
  }

  docId(document: InstagramDocument): string {
    return this.overrides[document.name] ?? document.docId;
  }

  canRefresh(now = Date.now()): boolean {
    return now - this.refreshedAt > REFRESH_INTERVAL_MS;
  }

  markAttempt(now = Date.now()): void {
    this.refreshedAt = now;
  }

  async update(scraped: Record<string, string>, now = Date.now()): Promise<void> {
    this.refreshedAt = now;
    if (!Object.keys(scraped).length) return;
    Object.assign(this.overrides, scraped);
    if (!this.path) return;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, refreshedAt: now, ids: this.overrides }), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
    } catch {
      // Overrides still apply for this session.
    }
  }
}

function defaultDocIdPath(): string | null {
  try { return join(dirname(instagramAuthPath()), "doc-ids.json"); } catch { return null; }
}

/** `__d("<Op>_instagramRelayOperation",[],(function(t,n,r,o,a,i){a.exports="<doc_id>"})` */
export function scrapeDocIds(bundle: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /__d\("([A-Za-z0-9_]+)_instagramRelayOperation",\[\],\(function\([^)]*\)\{[A-Za-z_$]+\.exports="(\d+)"\}/g;
  for (const match of bundle.matchAll(pattern)) result[match[1]!] = match[2]!;
  return result;
}

/** Public bundle URLs (`static.cdninstagram.com/rsrc.php/…js`) referenced by a page's HTML. */
export function bundleUrls(html: string): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(/https:(?:\\\/|\/){2}static\.cdninstagram\.com(?:\\\/|\/)rsrc\.php(?:\\\/|\/)[^"'\s]+?\.js[^"'\s]*/g)) {
    const url = match[0].replace(/\\\//g, "/").replace(/&amp;/g, "&");
    try { if (new URL(url).hostname === "static.cdninstagram.com") seen.add(url); } catch { /* skip */ }
  }
  return [...seen];
}
