/**
 * Config persistence for record.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { normalizeToken } from "./token";

export interface OpenCommandConfig {
  /** Executable to spawn when opening a matching target. */
  command: string;
  /** Arguments passed to command. Supports {target}, {path}, {target:sh}, and {path:sh}. */
  args?: string[];
}

export interface OpenFileRuleConfig extends OpenCommandConfig {
  /** File extensions handled by this opener, without a leading dot. */
  extensions: string[];
}

export interface OpenersConfig {
  /** Opener used for http/https links. Set to null to disable link opening. */
  url?: OpenCommandConfig | null;
  /** File openers matched by extension, checked in order. */
  rules?: OpenFileRuleConfig[];
}

export interface ChannelsConfig {
  /** Show channels the current user cannot view in the sidebar. */
  showHidden?: boolean;
}

export interface AudioConfig {
  /** Local microphone noise suppression mode. */
  noiseSuppression?: "off" | "simple";
  /** Local microphone capture gain in dB. 0 dB is neutral/default. */
  micGainDb?: number;
}

export interface RecordConfig {
  token?: string;
  /** Open-on-enter commands for links and file/attachment targets. */
  openers?: OpenersConfig;
  /** Sidebar/channel display preferences. */
  channels?: ChannelsConfig;
  /** Local audio capture/playback preferences. */
  audio?: AudioConfig;
  /** Preserve unknown future/user keys. */
  [key: string]: unknown;
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

export function defaultOpenersConfig(): OpenersConfig {
  return {
    url: { command: "xdg-open", args: ["{target}"] },
    rules: [
      {
        extensions: ["gif"],
        command: "video-play",
        args: ["{path}"],
      },
      {
        extensions: [
          "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff",
          "avif", "heic", "heif", "svg", "ico", "jxl", "jp2", "ppm", "pgm",
          "pbm", "pnm", "pdf",
        ],
        command: "show",
        args: ["{path}"],
      },
      {
        extensions: ["html"],
        command: "xdg-open",
        args: ["{path}"],
      },
      {
        extensions: [
          "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma",
          "aif", "aiff", "alac", "mid", "midi", "mov", "mp4", "m4v", "mkv",
          "webm", "avi",
        ],
        command: "st",
        args: ["-e", "zsh", "-ic", "exec audio-play {path:sh}"],
      },
      {
        extensions: ["md", "py", "txt"],
        command: "st",
        args: ["-e", "zsh", "-ic", "exec nvim {path:sh}"],
      },
    ],
  };
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

function loadConfigIfPresent(): RecordConfig {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

export function saveConfig(config: RecordConfig): void {
  const existing = loadConfigIfPresent();
  writeSecureJson(configPath(), {
    ...existing,
    ...config,
    ...(existing.openers || config.openers ? { openers: { ...existing.openers, ...config.openers } } : {}),
    ...(existing.channels || config.channels ? { channels: { ...existing.channels, ...config.channels } } : {}),
    ...(existing.audio || config.audio ? { audio: { ...existing.audio, ...config.audio } } : {}),
  });
}

export function saveSavedLogins(savedLogins: SavedLogins): void {
  const sortedEntries = Object.entries(savedLogins).sort((a, b) => a[0].localeCompare(b[0]));
  writeSecureJson(savedLoginsPath(), Object.fromEntries(sortedEntries));
}

export function clearConfig(): void {
  const config = loadConfigIfPresent();
  delete config.token;

  if (Object.keys(config).length > 0) {
    writeSecureJson(configPath(), config);
  } else {
    rmSync(configPath(), { force: true });
  }
}
