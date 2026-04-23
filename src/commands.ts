/**
 * Slash command registry.
 *
 * Structured after the Exocortex TUI command system, but scoped to record.
 */

import { clearPrompt } from "./promptstate";
import type { AppState } from "./state";
import { setNotice } from "./state";
import { THEME_NAMES, setTheme, type ThemeName } from "./theme";

export interface CompletionItem {
  name: string;
  desc: string;
}

export type CommandResult =
  | { type: "handled" }
  | { type: "quit" }
  | { type: "login"; credential: string }
  | { type: "logout" }
  | { type: "refresh" }
  | { type: "theme_changed" };

export interface SlashCommand {
  name: string;
  description: string;
  args?: CompletionItem[];
  handler: (text: string, state: AppState) => CommandResult;
}

function usage(state: AppState, text: string): CommandResult {
  setNotice(state, text, "warning");
  clearPrompt(state);
  return { type: "handled" };
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

const STATIC_COMMAND_ARGS: Record<string, CompletionItem[]> = Object.fromEntries(
  commands
    .filter((command) => command.name !== "/login" && command.args && command.args.length > 0)
    .map((command) => [command.name, command.args!]),
);

export function getCommandArgs(state: AppState): Record<string, CompletionItem[]> {
  const loginArgs = Object.keys(state.auth.savedLogins)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, desc: "saved login" }));

  return {
    ...STATIC_COMMAND_ARGS,
    ...(loginArgs.length > 0 ? { "/login": loginArgs } : {}),
  };
}
