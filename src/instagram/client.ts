import type { InstagramSession } from "./auth";

export interface InstagramUser {
  pk: string | number;
  username?: string;
  full_name?: string;
}

export interface InstagramItem {
  item_id: string;
  user_id: string | number;
  timestamp: string | number;
  item_type: string;
  text?: string;
  [key: string]: any;
}

export interface InstagramThread {
  thread_id: string;
  thread_title?: string;
  users: InstagramUser[];
  items: InstagramItem[];
  is_group?: boolean;
  muted?: boolean;
  last_activity_at?: string | number;
  marked_as_unread?: boolean;
  last_seen_at?: Record<string, { timestamp?: string | number; item_id?: string }>;
  has_older?: boolean;
  oldest_cursor?: string;
  [key: string]: any;
}

export interface InstagramInbox {
  viewer: InstagramUser;
  inbox: { threads: InstagramThread[]; has_older: boolean; oldest_cursor?: string };
}

export class InstagramApiError extends Error {
  constructor(message: string, readonly fatal = false) { super(message); }
}

/** Uses Instagram's web Direct API, not the browser DOM. No credential-bearing redirects. */
export class InstagramClient {
  constructor(private session: InstagramSession, private fetcher: typeof fetch = fetch) {}

  private async request(path: string, fields?: Record<string, string>): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(`https://www.instagram.com/api/v1/${path}`, {
        method: fields ? "POST" : "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Cookie: Object.entries(this.session.cookies).map(([name, value]) => `${name}=${value}`).join("; "),
          "X-CSRFToken": this.session.cookies.csrftoken!,
          "X-IG-App-ID": "936619743392459",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://www.instagram.com",
          Referer: "https://www.instagram.com/direct/inbox/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
          ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(fields ? { body: new URLSearchParams(fields) } : {}),
      });
    } catch {
      throw new InstagramApiError("Instagram request failed or timed out. Try /refresh.");
    }
    if (response.status === 429) throw new InstagramApiError("Instagram rate limit reached. Wait before /refresh.", true);
    if (response.status >= 500 || response.status === 408) {
      throw new InstagramApiError("Instagram is temporarily unavailable. Record will retry.");
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      throw new InstagramApiError("Instagram session expired or needs verification. Open Instagram in vimbrowser, then /login instagram.", true);
    }
    let data: any;
    try { data = await response.json(); } catch {
      throw new InstagramApiError("Instagram returned an unreadable response. Check your session in vimbrowser.", true);
    }
    if (!response.ok || data.status === "fail") {
      const fatal = Boolean(data.challenge || data.checkpoint_url || data.message === "login_required" || data.message === "challenge_required");
      // Never echo server payloads: they may contain credentials or arbitrary terminal controls.
      throw new InstagramApiError(fatal
        ? "Instagram needs verification. Open it in vimbrowser, then /login instagram."
        : `Instagram request was rejected (HTTP ${response.status}).`, fatal);
    }
    return data;
  }

  async inbox(cursor?: string): Promise<InstagramInbox> {
    const query = new URLSearchParams({ limit: "50", thread_message_limit: "20" });
    if (cursor) query.set("cursor", cursor);
    const data = await this.request(`direct_v2/inbox/?${query}`);
    if (!Array.isArray(data.inbox?.threads) || !data.viewer?.pk) throw new InstagramApiError("Instagram inbox format is unsupported.", true);
    return data;
  }

  async thread(id: string, cursor?: string): Promise<InstagramThread> {
    if (!/^\d+$/.test(id)) throw new Error("Invalid Instagram thread ID.");
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) { query.set("cursor", cursor); query.set("direction", "older"); }
    const data = await this.request(`direct_v2/threads/${id}/?${query}`);
    if (!data.thread || !Array.isArray(data.thread.items)) throw new InstagramApiError("Instagram thread format is unsupported.", true);
    return data.thread;
  }

  async sendText(id: string, text: string, reply?: string): Promise<InstagramItem> {
    if (!/^\d+$/.test(id)) throw new Error("Invalid Instagram thread ID.");
    const context = crypto.randomUUID();
    const fields: Record<string, string> = {
      action: "send_item", thread_ids: JSON.stringify([id]), text,
      client_context: context, mutation_token: context, device_id: this.session.cookies.ig_did || context,
    };
    if (reply) fields.replied_to_item_id = reply;
    const data = await this.request("direct_v2/threads/broadcast/text/", fields);
    if (!data.payload?.item_id) throw new InstagramApiError("Instagram did not confirm sending. Refresh before retrying to avoid duplicates.");
    return {
      item_id: String(data.payload.item_id), user_id: this.session.cookies.ds_user_id!,
      timestamp: data.payload.timestamp ?? Date.now() * 1000, item_type: "text", text,
    };
  }

  async markSeen(id: string, itemId: string): Promise<void> {
    if (!/^\d+$/.test(id) || !/^\d+$/.test(itemId)) return;
    await this.request(`direct_v2/threads/${id}/items/${itemId}/seen/`, {
      action: "mark_seen", thread_id: id, item_id: itemId,
    });
  }
}
