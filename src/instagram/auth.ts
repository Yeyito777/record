import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface InstagramSession {
  cookies: Record<string, string>;
}

export type InstagramLogin =
  | { source: "cookies"; credential: string }
  | { source: "browser"; tabId?: string };

export const INSTAGRAM_LOGIN_HELP = [
  "Paste your Instagram cookies in Record:",
  "/login instagram sessionid=…; csrftoken=…; ds_user_id=…",
  "Or paste the full Cookie request header after /login instagram.",
  "Sign in to instagram.com in any browser. Open DevTools → Network,",
  "reload, select an instagram.com request, and copy its Cookie header.",
  "Keep these cookies private, like a password.",
  "Optional browser import: /login instagram browser [tab ID]",
].join("\n");

/** Parse a pasted Cookie request header without decoding opaque cookie values. */
export function parseInstagramCookies(credential: string): InstagramSession {
  const invalid = () => new Error("Invalid Instagram cookies. Include sessionid, csrftoken and ds_user_id from the same signed-in browser session. Run /login instagram for help.");
  if (/[\x00-\x1f\x7f]/.test(credential)) throw invalid();
  let text = credential.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/^cookie:\s*/i, "");
  const cookies: Record<string, string> = Object.create(null);
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const match = part.trim().match(/^([a-zA-Z0-9_]+)=([^\s;]+)$/);
    if (!match || Object.hasOwn(cookies, match[1]!)) throw invalid();
    cookies[match[1]!] = match[2]!;
  }
  try { return validateSession({ cookies }); }
  catch { throw invalid(); }
}

export function instagramAuthPath(): string {
  const home = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config");
  if (!isAbsolute(home)) throw new Error("Instagram requires an absolute config directory.");
  return join(home, "record", "instagram", "session.json");
}

export function validateSession(value: unknown): InstagramSession {
  const cookies = (value as InstagramSession)?.cookies;
  if (!cookies || !["sessionid", "csrftoken", "ds_user_id"].every((key) =>
    typeof cookies[key] === "string" && cookies[key].length > 0 && !/[\r\n;]/.test(cookies[key]!))) {
    throw new Error("No valid Instagram session found. Run /login instagram for cookie login instructions.");
  }
  return { cookies: Object.fromEntries(Object.entries(cookies).filter(([name, value]) =>
    /^[a-zA-Z0-9_]+$/.test(name) && typeof value === "string" && !/[\r\n;]/.test(value))) };
}

/** Capture only Instagram cookies; never write CLI output or credentials to logs. */
export async function importInstagramSession(tabId?: string): Promise<InstagramSession> {
  if (tabId && !/^\d+$/.test(tabId)) throw new Error("Instagram tab ID must be numeric.");
  const run = promisify(execFile);
  try {
    if (tabId) {
      const { stdout } = await run("vimbrowser-cli", ["tabs", "--json"], { timeout: 15_000 });
      const tabs = JSON.parse(stdout).tabs as Array<{ id: number; url: string }>;
      const tab = tabs.find((entry) => String(entry.id) === tabId);
      if (!tab || new URL(tab.url).hostname !== "www.instagram.com") {
        throw new Error("Choose an Instagram tab.");
      }
    }
    const { stdout } = await run("vimbrowser-cli", tabId
      ? ["cookies", tabId, "https://www.instagram.com/"]
      : ["cookies", "--url", "https://www.instagram.com/"], { timeout: 15_000 });
    const result = JSON.parse(stdout);
    const cookies: Record<string, string> = {};
    for (const cookie of result.cookies ?? []) {
      if ([".instagram.com", "instagram.com", "www.instagram.com", ".www.instagram.com"].includes(cookie.domain)) {
        cookies[cookie.name] = cookie.value;
      }
    }
    return validateSession({ cookies });
  } catch {
    throw new Error("Could not import Instagram auth. Sign in in vimbrowser, then /login instagram browser [tab ID], or paste cookies with /login instagram <cookies>.");
  }
}

export async function saveInstagramSession(session: InstagramSession, path = instagramAuthPath()): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(validateSession(session)), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadInstagramSession(path = instagramAuthPath()): Promise<InstagramSession | null> {
  try {
    return validateSession(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Saved Instagram auth is invalid. Run /login instagram to log in again.");
  }
}

export async function removeInstagramSession(path = instagramAuthPath()): Promise<void> {
  await rm(path, { force: true });
}
