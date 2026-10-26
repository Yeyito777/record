/**
 * Demo-mode switches and the config-directory safety checks. Pure helpers so
 * tests can exercise the refusal rules without touching any real directory.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** The only token demo mode accepts or writes; never a real Discord token. */
export const DEMO_TOKEN = "demo.record-offline.not-a-real-token";

export type Env = Record<string, string | undefined>;

/** The demo's WhatsApp "login": a marker, so Record reconnects the fake backend at startup. */
export const DEMO_WHATSAPP_CREDS = { demo: "Record offline demo; not a WhatsApp login" };

/** Only the demo's marker creds.json (or nothing) is in a WhatsApp auth directory. */
function isDemoWhatsAppAuth(dir: string): boolean {
  try {
    const names = readdirSync(dir);
    if (names.some((name) => name !== "creds.json")) return false;
    if (names.length === 0) return true;
    return JSON.stringify(JSON.parse(readFileSync(join(dir, "creds.json"), "utf8"))) === JSON.stringify(DEMO_WHATSAPP_CREDS);
  } catch {
    return false;
  }
}

export function isDemoRequested(argv: readonly string[], env: Env): boolean {
  if (argv.slice(2).includes("--demo")) return true;
  const flag = env.RECORD_DEMO?.trim().toLowerCase();
  return Boolean(flag && flag !== "0" && flag !== "false" && flag !== "no");
}

/** Record config directories that may hold the owner's real tokens. */
export function realRecordConfigDirs(env: Env): string[] {
  const dirs = new Set<string>();
  if (env.HOME) dirs.add(join(env.HOME, ".config", "record"));
  if (env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)) dirs.add(join(env.XDG_CONFIG_HOME, "record"));
  return [...dirs];
}

function canonical(path: string): string[] {
  const out = [resolve(path)];
  try {
    if (existsSync(path)) out.push(realpathSync(path));
  } catch {
    // Unresolvable paths are compared lexically only.
  }
  return out;
}

function overlaps(a: string, b: string): boolean {
  const down = relative(a, b);
  const up = relative(b, a);
  const inside = (rel: string): boolean => rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return inside(down) || inside(up);
}

/**
 * Throw unless `demoConfigDir` is clearly separate from every real Record
 * config directory and does not already hold a real login.
 */
export function assertSafeDemoConfigDir(demoConfigDir: string, realDirs: readonly string[]): void {
  if (!isAbsolute(demoConfigDir)) throw new Error(`Demo config dir must be absolute: ${demoConfigDir}`);
  for (const real of realDirs) {
    for (const demoPath of canonical(demoConfigDir)) {
      for (const realPath of canonical(real)) {
        if (overlaps(demoPath, realPath)) {
          throw new Error(`Refusing to run demo mode with config dir ${demoConfigDir}: it overlaps the real Record config ${real}.`);
        }
      }
    }
  }
  const configFile = join(demoConfigDir, "config.json");
  if (existsSync(configFile)) {
    let token: unknown;
    try {
      token = (JSON.parse(readFileSync(configFile, "utf8")) as { token?: unknown }).token;
    } catch {
      throw new Error(`Refusing to run demo mode: ${configFile} is not a demo config.`);
    }
    if (token !== undefined && token !== DEMO_TOKEN) {
      throw new Error(`Refusing to run demo mode: ${configFile} holds a non-demo token.`);
    }
  }
  for (const name of ["saved-logins.json", join("whatsapp", "auth"), join("instagram", "session.json")]) {
    const path = join(demoConfigDir, name);
    if (name === join("whatsapp", "auth") && existsSync(path) && isDemoWhatsAppAuth(path)) continue;
    if (existsSync(path)) {
      throw new Error(`Refusing to run demo mode: ${join(demoConfigDir, name)} looks like real login data.`);
    }
  }
}

/** Written into every demo home; only marked (or new/empty) homes are reused or deleted. */
export const DEMO_HOME_MARKER = ".record-demo-home";

/**
 * A demo home (XDG_CONFIG_HOME for the run) must be new, empty, or a previous
 * demo home. Anything else, such as $HOME, is refused before it is written to.
 */
export function assertUsableDemoHome(home: string, env: Env): void {
  if (!isAbsolute(home)) throw new Error(`Demo home must be an absolute path: ${home}`);
  for (const protectedDir of [env.HOME, env.HOME ? join(env.HOME, ".config") : undefined, env.XDG_CONFIG_HOME]) {
    if (!protectedDir) continue;
    for (const demoPath of canonical(home)) {
      for (const protectedPath of canonical(protectedDir)) {
        const rel = relative(demoPath, protectedPath);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
          throw new Error(`Refusing to use ${home} as the demo home: it contains ${protectedDir}.`);
        }
      }
    }
  }
  if (!existsSync(home)) return;
  if (!statSync(home).isDirectory()) throw new Error(`Demo home is not a directory: ${home}`);
  if (existsSync(join(home, DEMO_HOME_MARKER))) return;
  if (readdirSync(home).length > 0) {
    throw new Error(`Refusing to use ${home} as the demo home: it is not empty and was not created by demo mode.`);
  }
}

export function parseAnchor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
