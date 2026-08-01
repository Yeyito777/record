/**
 * Slash command registry.
 *
 * Structured after the Exocortex TUI command system, but scoped to record.
 */

import { saveConfig } from "./config";
import { DISCORD_CUSTOM_STATUS_MAX_LENGTH, DISCORD_PRESENCE_STATUSES, type DiscordPresenceStatus } from "./discord";
import { clearPrompt } from "./promptstate";
import type { AppState } from "./state";
import { setNotice } from "./state";
import { THEME_NAMES, setTheme, theme, type ThemeName } from "./theme";
import { pushTimelineSystemMessage } from "./timeline";
import { DEFAULT_LOCAL_GAIN_DB, formatGainDbWithUnit, parseGainDb, parseNoiseSuppressionMode, type NoiseSuppressionMode } from "./volume";

export interface CompletionItem {
  name: string;
  desc: string;
  color?: string;
}

export type CommandResult =
  | { type: "handled" }
  | { type: "quit" }
  | { type: "login"; credential: string }
  | { type: "login_whatsapp" }
  | { type: "logout" }
  | { type: "logout_whatsapp" }
  | { type: "refresh" }
  | { type: "create_thread"; name: string }
  | { type: "upload"; path: string }
  | { type: "call" }
  | { type: "stream" }
  | { type: "watch"; target: string | null }
  | { type: "hangup" }
  | { type: "mute"; muted: boolean | null }
  | { type: "deafen"; deafened: boolean | null }
  | { type: "mic_volume"; volume: number }
  | { type: "speaker_volume"; volume: number }
  | { type: "noise_suppression"; mode: NoiseSuppressionMode }
  | { type: "status"; status: DiscordPresenceStatus }
  | { type: "status_quote"; text: string | null }
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
  { name: "volume", desc: "Set/show local gain" },
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
  { name: "quote", desc: "Set/show your custom status quote" },
];

const LOGIN_PROVIDER_ARGS: CompletionItem[] = [
  { name: "whatsapp", desc: "Link WhatsApp with a QR code" },
  { name: "discord", desc: "Log in to Discord explicitly" },
];

const LOGOUT_PROVIDER_ARGS: CompletionItem[] = [
  { name: "whatsapp", desc: "Disconnect the saved WhatsApp account" },
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
  if ((parts.length !== 2 && parts.length !== 3) || parts[1] !== "volume") {
    return usage(state, `Usage: /${kind} volume [gain]`);
  }

  if (parts.length === 2) {
    const current = kind === "mic" ? state.audio.micVolume : state.audio.speakerVolume;
    const label = kind === "mic" ? "Microphone record gain" : "Speaker playback gain";
    setNotice(state, `${label}: ${formatGainDbWithUnit(current)}`, "muted", { statusLine: true, chat: false });
    clearPrompt(state);
    return { type: "handled" };
  }

  const volume = parts[2]?.toLowerCase() === "reset" ? DEFAULT_LOCAL_GAIN_DB : parseGainDb(parts[2]);
  if (volume === null) return usage(state, `Usage: /${kind} volume [gain]`);
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
    description: "Log in to Discord or link WhatsApp",
    handler: (text, state) => {
      const match = text.match(/^\/login\s+(.+)$/);
      if (!match) return usage(state, "Usage: /login <token|username> | /login whatsapp");
      const credential = match[1].trim();
      if (!credential) return usage(state, "Usage: /login <token|username> | /login whatsapp");
      clearPrompt(state);
      if (credential.toLowerCase() === "whatsapp") return { type: "login_whatsapp" };
      const explicitDiscord = credential.match(/^discord\s+(.+)$/i)?.[1]?.trim();
      if (/^discord(?:\s|$)/i.test(credential)) {
        if (!explicitDiscord) return usage(state, "Usage: /login discord <token|username>");
        return { type: "login", credential: explicitDiscord };
      }
      return { type: "login", credential };
    },
  },
  {
    name: "/logout",
    description: "Log out of Discord or WhatsApp",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 2 && parts[1]?.toLowerCase() === "whatsapp") {
        clearPrompt(state);
        return { type: "logout_whatsapp" };
      }
      if (parts.length !== 1) return usage(state, "Usage: /logout [whatsapp]");
      clearPrompt(state);
      return { type: "logout" };
    },
    args: LOGOUT_PROVIDER_ARGS,
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
    name: "/thread",
    description: "Create a thread, anchored to the active reply when present",
    handler: (text, state) => {
      const match = text.match(/^\/thread(?:\s+([\s\S]+))?$/);
      const name = match?.[1]?.trim() ?? "";
      const length = Array.from(name).length;
      if (length < 1 || length > 100) {
        setNotice(state, "Usage: /thread <name> (1-100 characters)", "warning", { statusLine: false });
        clearPrompt(state);
        return { type: "handled" };
      }
      clearPrompt(state);
      return { type: "create_thread", name };
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
    name: "/stream",
    description: "Toggle first-monitor screen sharing in the current call",
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return usage(state, "Usage: /stream");
      clearPrompt(state);
      return { type: "stream" };
    },
  },
  {
    name: "/watch",
    description: "Watch another user's stream in the current call",
    handler: (text, state) => {
      const match = text.match(/^\/watch(?:\s+(\S+))?\s*$/);
      if (!match) return usage(state, "Usage: /watch [user_id|@mention|stream_key]");
      const rawTarget = match[1]?.trim() ?? null;
      const mention = rawTarget?.match(/^<@!?(\d+)>$/);
      clearPrompt(state);
      return { type: "watch", target: mention?.[1] ?? rawTarget };
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
    description: "Set/show local microphone gain",
    args: VOLUME_SUBCOMMAND_ARGS,
    getArgs: () => ({
      "/mic": VOLUME_SUBCOMMAND_ARGS,
    }),
    handler: (text, state) => handleLocalVolumeCommand(text, state, "mic"),
  },
  {
    name: "/speaker",
    description: "Set/show local speaker/app gain",
    args: VOLUME_SUBCOMMAND_ARGS,
    getArgs: () => ({
      "/speaker": VOLUME_SUBCOMMAND_ARGS,
    }),
    handler: (text, state) => handleLocalVolumeCommand(text, state, "speaker"),
  },
  {
    name: "/noise-suppression",
    description: "Set/show local microphone noise suppression",
    args: NOISE_SUPPRESSION_ARGS,
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        setNotice(state, `Noise suppression: ${state.noiseSuppression}`, "muted", { statusLine: true, chat: false });
        clearPrompt(state);
        return { type: "handled" };
      }
      if (parts.length !== 2) return usage(state, "Usage: /noise-suppression [off|simple]");
      const mode = parseNoiseSuppressionMode(parts[1]);
      if (!mode) return usage(state, "Usage: /noise-suppression [off|simple]");
      clearPrompt(state);
      return { type: "noise_suppression", mode };
    },
  },
  {
    name: "/status",
    description: "Set/show your Discord status",
    args: STATUS_ARGS,
    handler: (text, state) => {
      const trimmed = text.trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        setNotice(state, `Presence: ${state.auth.presenceStatus ?? "unknown"}`, "muted", { statusLine: false });
        clearPrompt(state);
        return { type: "handled" };
      }

      const quoteMatch = trimmed.match(/^\/status\s+quote(?:\s+([\s\S]+))?$/i);
      if (quoteMatch) {
        const quote = quoteMatch[1]?.trim();
        if (!quote) {
          pushTimelineSystemMessage(state.timeline, `Status quote: ${state.auth.customStatus?.text || "none"}`);
          clearPrompt(state);
          return { type: "handled" };
        }
        const normalizedQuote = quote.toLowerCase();
        if (normalizedQuote === "clear") {
          clearPrompt(state);
          return { type: "status_quote", text: null };
        }
        if (Array.from(quote).length > DISCORD_CUSTOM_STATUS_MAX_LENGTH) {
          setNotice(state, `Status quotes can be at most ${DISCORD_CUSTOM_STATUS_MAX_LENGTH} characters.`, "warning", { statusLine: false });
          clearPrompt(state);
          return { type: "handled" };
        }
        clearPrompt(state);
        return { type: "status_quote", text: quote };
      }

      const statusUsage = `Usage: /status [${DISCORD_PRESENCE_STATUSES.join("|")}] | /status quote <text|clear>`;
      if (parts.length !== 2) return usage(state, statusUsage);
      const status = parsePresenceStatus(parts[1]?.toLowerCase());
      if (!status) return usage(state, statusUsage);
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
    description: "Set/show the active theme",
    args: THEME_NAMES.map((name) => ({ name, desc: `${name} theme` })),
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        setNotice(state, `Theme: ${theme.name}`, "muted", { statusLine: true, chat: false });
        clearPrompt(state);
        return { type: "handled" };
      }
      if (parts.length !== 2) return usage(state, `Usage: /theme [${THEME_NAMES.join("|")}]`);
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

  const savedLoginArgs = Object.keys(state.auth.savedLogins)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, desc: "saved login" }));
  registry["/login"] = [
    ...LOGIN_PROVIDER_ARGS,
    ...savedLoginArgs.filter((item) => !LOGIN_PROVIDER_ARGS.some((provider) => provider.name === item.name.toLowerCase())),
  ];

  return registry;
}
