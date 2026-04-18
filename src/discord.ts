/**
 * Tiny Discord REST client for token validation.
 */

const API_BASE = "https://discord.com/api/v9";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) record/0.1.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;

interface DiscordMeResponse {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar: string | null;
  bot?: boolean;
  email?: string | null;
  verified?: boolean;
}

interface DiscordErrorResponse {
  message?: string;
  code?: number;
}

export interface DiscordIdentity {
  id: string;
  username: string;
  globalName: string | null;
  discriminator: string;
  avatar: string | null;
  bot: boolean;
  email: string | null;
  verified: boolean | null;
}

export function formatDiscordDisplayName(user: DiscordIdentity): string {
  if (user.globalName) return `${user.globalName} (@${user.username})`;
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return `@${user.username}`;
}

export async function validateToken(token: string): Promise<DiscordIdentity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}/users/@me`, {
      headers: {
        "Accept": "application/json",
        "Authorization": token,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const body = bodyText ? tryParseJson(bodyText) : null;

    if (response.status === 200) {
      const me = body as DiscordMeResponse;
      return {
        id: me.id,
        username: me.username,
        globalName: me.global_name ?? null,
        discriminator: me.discriminator,
        avatar: me.avatar ?? null,
        bot: Boolean(me.bot),
        email: me.email ?? null,
        verified: typeof me.verified === "boolean" ? me.verified : null,
      };
    }

    if (response.status === 401) {
      throw new Error("Discord rejected the token.");
    }

    if (response.status === 429) {
      throw new Error("Discord rate-limited the request. Try again in a moment.");
    }

    const errorBody = body as DiscordErrorResponse | null;
    const detail = errorBody?.message ? ` ${errorBody.message}` : "";
    throw new Error(`Discord returned ${response.status}.${detail}`.trim());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Discord request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
