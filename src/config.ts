/**
 * Config persistence for record.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

export interface RecordConfig {
  token?: string;
}

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

export function loadConfig(): RecordConfig {
  const raw = readFileSync(configPath(), "utf8");
  return JSON.parse(raw) as RecordConfig;
}

export function saveConfig(config: RecordConfig): void {
  const dir = configDir();
  const path = configPath();

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  try {
    chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
  } catch {
    // Best effort only.
  }
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true });
}
