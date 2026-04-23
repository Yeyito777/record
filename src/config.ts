/**
 * Config persistence for record.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { normalizeToken } from "./token";

export interface RecordConfig {
  token?: string;
}

export type SavedLogins = Record<string, string>;

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "record");

  const home = process.env.HOME;
  if (home) return join(home, ".config", "record");

  throw new Error("Could not resolve a config directory for record.");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function savedLoginsPath(): string {
  return join(configDir(), "saved-logins.json");
}

export function loadConfig(): RecordConfig {
  const raw = readFileSync(configPath(), "utf8");
  return JSON.parse(raw) as RecordConfig;
}

export function loadSavedLogins(): SavedLogins {
  const raw = readFileSync(savedLoginsPath(), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Saved logins file must contain a JSON object.");
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([username, token]) => [username, normalizeToken(token)]),
  );
}

function writeSecureJson(path: string, value: unknown): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

  try {
    chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
  } catch {
    // Best effort only.
  }
}

export function saveConfig(config: RecordConfig): void {
  writeSecureJson(configPath(), config);
}

export function saveSavedLogins(savedLogins: SavedLogins): void {
  const sortedEntries = Object.entries(savedLogins).sort((a, b) => a[0].localeCompare(b[0]));
  writeSecureJson(savedLoginsPath(), Object.fromEntries(sortedEntries));
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}
