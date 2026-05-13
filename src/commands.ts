/**
 * Slash command registry.
 *
 * Structured after the Exocortex TUI command system, but scoped to record.
 */

import { saveConfig } from "./config";
import { DISCORD_PRESENCE_STATUSES, type DiscordPresenceStatus } from "./discord";
import { clearPrompt } from "./promptstate";
import type { AppState } from "./state";
import { setNotice } from "./state";
import { THEME_NAMES, setTheme, type ThemeName } from "./theme";
import { parseNoiseSuppressionMode, parseVolumePercent, type NoiseSuppressionMode } from "./volume";

export interface CompletionItem {
  name: string;
  desc: string;
  color?: string;
}

export type CommandResult =
  | { type: "handled" }
  | { type: "quit" }
  | { type: "login"; credential: string }
  | { type: "logout" }
  | { type: "refresh" }
  | { type: "upload"; path: string }
  | { type: "call" }
  | { type: "hangup" }
  | { type: "mute"; muted: boolean | null }
  | { type: "deafen"; deafened: boolean | null }
  | { type: "mic_volume"; volume: number }
  | { type: "speaker_volume"; volume: number }
  | { type: "noise_suppression"; mode: NoiseSuppressionMode }
  | { type: "status"; status: DiscordPresenceStatus }
  | { type: "theme_changed" };

export interface SlashCommand {
  name: string;
  description: string;
  args?: CompletionItem[];
  /** Optional dynamic/nested argument completions keyed by command prefix. */
  getArgs?: (state: AppState) => Record<string, CompletionItem[]>;
  handler: (text: string, state: AppState) => CommandResult;
}

function usage(state: AppState, text: string): CommandResult {
  setNotice(state, text, "warning");
  clearPrompt(state);
  return { type: "handled" };
}

const CHANNELS_ARGS: CompletionItem[] = [
  { name: "show-hidden", desc: "toggle inaccessible channel rows" },
];

const SHOW_HIDDEN_ARGS: CompletionItem[] = [
  { name: "on", desc: "Show inaccessible channel rows" },
  { name: "off", desc: "Hide inaccessible channel rows" },
];

const VOICE_TOGGLE_ARGS: CompletionItem[] = [
  { name: "on", desc: "Turn this voice setting on" },
  { name: "off", desc: "Turn this voice setting off" },
];

const VOLUME_SUBCOMMAND_ARGS: CompletionItem[] = [
  { name: "volume", desc: "Set local volume" },
];

const VOLUME_VALUE_ARGS: CompletionItem[] = [
  { name: "100%", desc: "Full volume" },
  { name: "75%", desc: "Three-quarter volume" },
  { name: "50%", desc: "Half volume" },
  { name: "25%", desc: "Quarter volume" },
  { name: "0%", desc: "Silent" },
];

const NOISE_SUPPRESSION_ARGS: CompletionItem[] = [
  { name: "off", desc: "Disable local microphone noise suppression" },
  { name: "simple", desc: "Use low-latency RNNoise suppression" },
];

const STATUS_ARGS: CompletionItem[] = [
  { name: "online", desc: "Show as online" },
  { name: "idle", desc: "Show as idle" },
  { name: "dnd", desc: "Show as Do Not Disturb" },
  { name: "invisible", desc: "Show as offline" },
];

function parseOnOff(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return null;
}

function parsePresenceStatus(value: string | undefined): DiscordPresenceStatus | null {
  switch (value) {
    case "1":
    case "online":
      return "online";
    case "2":
    case "idle":
      return "idle";
    case "3":
    case "dnd":
    case "disturb":
      return "dnd";
    case "4":
    case "invisible":
    case "offline":
      return "invisible";
    default:
      return null;
  }
}

function handleChannelsCommand(text: string, state: AppState): CommandResult {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts[1] !== "show-hidden") {
    return usage(state, "Usage: /channels show-hidden [on|off]");
  }

  const parsed = parseOnOff(parts[2]);
  if (parts[2] !== undefined && parsed === null) return usage(state, "Usage: /channels show-hidden [on|off]");

  const next = parsed ?? !state.showHiddenChannels;
  state.showHiddenChannels = next;
  clearPrompt(state);

  try {
    saveConfig({ channels: { showHidden: next } });
    setNotice(state, `Hidden channels ${next ? "shown" : "hidden"}.`, "muted", { statusLine: false });
  } catch (error) {
    setNotice(state, `Hidden channels ${next ? "shown" : "hidden"}, but saving failed: ${(error as Error).message}`, "warning", { statusLine: false });
  }

  return { type: "handled" };
}

function handleLocalVolumeCommand(text: string, state: AppState, kind: "mic" | "speaker"): CommandResult {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3 || parts[1] !== "volume") {
    return usage(state, `Usage: /${kind} volume <0-100>`);
  }

  const volume = parseVolumePercent(parts[2]);
  if (volume === null) return usage(state, `Usage: /${kind} volume <0-100>`);
  clearPrompt(state);
  return kind === "mic"
    ? { type: "mic_volume", volume }
    : { type: "speaker_volume", volume };
}

const commands: SlashCommand[] = [
  {
    name: "/help",
    description: "Show available commands",
    handler: (_text, state) => {
      const lines = commands
        .filter((command) => command.name !== "/exit")
        .map((command) => `${command.name}  ${command.description}`);
      setNotice(state, lines.join("\n"), "muted");
      clearPrompt(state);
      return { type: "handled" };
    },
  },
  {
    name: "/quit",
    description: "Exit record",
    handler: () => ({ type: "quit" }),
  },
  {
    name: "/exit",
    description: "Exit record",
    handler: () => ({ type: "quit" }),
  },
  {
    name: "/login",
    description: "Validate and save a Discord token, or reuse a saved login",
    handler: (text, state) => {
      const match = text.match(/^\/login\s+(.+)$/);
      if (!match) return usage(state, "Usage: /login <token|username>");
      const credential = match[1].trim();
      if (!credential) return usage(state, "Usage: /login <token|username>");
      clearPrompt(state);
      return { type: "login", credential };
    },
  },
  {
    name: "/logout",
    description: "Clear the saved Discord token",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return usage(state, "Usage: /logout");
      clearPrompt(state);
      return { type: "logout" };
    },
  },
  {
    name: "/refresh",
    description: "Reload servers, channels, and messages",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return usage(state, "Usage: /refresh");
      clearPrompt(state);
      return { type: "refresh" };
    },
  },
  {
    name: "/upload",
    description: "Upload a local file to the current channel",
    handler: (text, state) => {
      const match = text.match(/^\/upload(?:\s+([\s\S]+))?$/);
      const path = match?.[1]?.trim() ?? "";
      if (!path) {
        setNotice(state, "Usage: /upload <file-path>", "warning", { statusLine: false });
        clearPrompt(state);
        return { type: "handled" };
      }
      clearPrompt(state);
      return { type: "upload", path };
    },
  },
  {
    name: "/call",
    description: "Start a voice call in the current DM or selected voice channel",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return usage(state, "Usage: /call");
      clearPrompt(state);
      return { type: "call" };
    },
  },
  {
    name: "/hangup",
    description: "Leave the current voice call",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return usage(state, "Usage: /hangup");
      clearPrompt(state);
      return { type: "hangup" };
    },
  },
  {
    name: "/mute",
    description: "Toggle or set voice call microphone mute",
    args: VOICE_TOGGLE_ARGS,
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 2) return usage(state, "Usage: /mute [on|off]");
      const parsed = parseOnOff(parts[1]);
      if (parts[1] !== undefined && parsed === null) return usage(state, "Usage: /mute [on|off]");
      clearPrompt(state);
      return { type: "mute", muted: parsed };
    },
  },
  {
    name: "/deafen",
    description: "Toggle or set voice call speaker deafen",
    args: VOICE_TOGGLE_ARGS,
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 2) return usage(state, "Usage: /deafen [on|off]");
      const parsed = parseOnOff(parts[1]);
      if (parts[1] !== undefined && parsed === null) return usage(state, "Usage: /deafen [on|off]");
      clearPrompt(state);
      return { type: "deafen", deafened: parsed };
    },
  },
  {
    name: "/mic",
    description: "Set local microphone volume",
    args: VOLUME_SUBCOMMAND_ARGS,
    getArgs: () => ({
      "/mic": VOLUME_SUBCOMMAND_ARGS,
      "/mic volume": VOLUME_VALUE_ARGS,
    }),
    handler: (text, state) => handleLocalVolumeCommand(text, state, "mic"),
  },
  {
    name: "/speaker",
    description: "Set local speaker/app volume",
    args: VOLUME_SUBCOMMAND_ARGS,
    getArgs: () => ({
      "/speaker": VOLUME_SUBCOMMAND_ARGS,
      "/speaker volume": VOLUME_VALUE_ARGS,
    }),
    handler: (text, state) => handleLocalVolumeCommand(text, state, "speaker"),
  },
  {
    name: "/noise-suppression",
    description: "Set local microphone noise suppression",
    args: NOISE_SUPPRESSION_ARGS,
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 2) return usage(state, "Usage: /noise-suppression <off|simple>");
      const mode = parseNoiseSuppressionMode(parts[1]);
      if (!mode) return usage(state, "Usage: /noise-suppression <off|simple>");
      clearPrompt(state);
      return { type: "noise_suppression", mode };
    },
  },
  {
    name: "/status",
    description: "Set your Discord presence",
    args: STATUS_ARGS,
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 2) return usage(state, `Usage: /status <${DISCORD_PRESENCE_STATUSES.join("|")}>`);
      const status = parsePresenceStatus(parts[1]?.toLowerCase());
      if (!status) return usage(state, `Usage: /status <${DISCORD_PRESENCE_STATUSES.join("|")}>`);
      clearPrompt(state);
      return { type: "status", status };
    },
  },
  {
    name: "/channels",
    description: "Configure channel display options",
    args: CHANNELS_ARGS,
    getArgs: () => ({
      "/channels": CHANNELS_ARGS,
      "/channels show-hidden": SHOW_HIDDEN_ARGS,
    }),
    handler: handleChannelsCommand,
  },
  {
    name: "/theme",
    description: "Switch the active theme",
    args: THEME_NAMES.map((name) => ({ name, desc: `${name} theme` })),
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 2) return usage(state, `Usage: /theme <${THEME_NAMES.join("|")}>`);
      const name = parts[1] as ThemeName;
      if (!THEME_NAMES.includes(name)) {
        return usage(state, `Unknown theme: ${parts[1]}. Available: ${THEME_NAMES.join(", ")}`);
      }
      const persistError = setTheme(name);
      clearPrompt(state);
      if (persistError) {
        setNotice(state, `Theme set to ${name}, but saving failed: ${persistError}`, "warning");
      } else {
        setNotice(state, `Theme set to ${name}.`, "success");
      }
      return { type: "theme_changed" };
    },
  },
];

export function tryCommand(text: string, state: AppState): CommandResult | null {
  if (!text.startsWith("/")) return null;

  const name = text.split(/\s+/)[0];
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) return null;

  return command.handler(text, state);
}

export const COMMAND_LIST: CompletionItem[] = commands
  .filter((command) => command.name !== "/exit")
  .map((command) => ({ name: command.name, desc: command.description }));

export function getCommandArgs(state: AppState): Record<string, CompletionItem[]> {
  const registry: Record<string, CompletionItem[]> = {};
  for (const command of commands) {
    if (command.name !== "/login" && command.args && command.args.length > 0) {
      registry[command.name] = command.args;
    }
    if (command.getArgs) {
      Object.assign(registry, command.getArgs(state));
    }
  }

  const loginArgs = Object.keys(state.auth.savedLogins)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, desc: "saved login" }));
  if (loginArgs.length > 0) registry["/login"] = loginArgs;

  return registry;
}
