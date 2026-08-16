/**
 * Discord application (server/bot) command discovery, completion, and parsing.
 *
 * The plain-text syntax follows endcord's unambiguous app-qualified form:
 *   /@app_name command [subcommand | group subcommand] --option=value
 * The @ marker keeps app namespaces distinct from Record's local commands.
 * Values containing whitespace can be quoted. Discord itself identifies a command
 * by both command id and application id, so retaining the app namespace avoids
 * silently invoking the wrong command when multiple apps register the same name.
 */

import type { CompletionItem } from "./commands";
import { DIRECT_MESSAGES_GUILD_ID, type DiscordChannel, type DiscordGuildMember, type DiscordRole } from "./discord";
import type { ClipboardImageAttachment } from "./imageclipboard";
import { loadedMentionCandidates } from "./mentions";
import type { AppState } from "./state";

export const APPLICATION_COMMAND_CHAT_INPUT = 1;
export const APPLICATION_COMMAND_INTERACTION = 2;
export const APPLICATION_COMMAND_AUTOCOMPLETE = 4;

export type ServerCommandOptionType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
export type ServerCommandChoiceValue = string | number;

export interface ServerCommandChoice {
  name: string;
  value: ServerCommandChoiceValue;
  name_localized?: string | null;
}

export interface ServerCommandOption {
  type: ServerCommandOptionType;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  options?: ServerCommandOption[];
  choices?: ServerCommandChoice[];
  channel_types?: number[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  file_types?: string[];
}

export interface ServerCommandIndexPermissions {
  /** The application-command index resolves this boolean for the current user. */
  user?: boolean;
  /** Older command-index responses expose per-user entries instead. */
  users?: Record<string, boolean>;
  roles?: Record<string, boolean>;
  channels?: Record<string, boolean>;
}

export interface ServerCommandApplication {
  id: string;
  name: string;
  permissions?: ServerCommandIndexPermissions;
}

export interface ServerCommand {
  id: string;
  applicationId: string;
  applicationName: string;
  name: string;
  description: string;
  version: string;
  guildId?: string;
  options: ServerCommandOption[];
  nsfw: boolean;
  defaultMemberPermissions?: string | null;
  permissions?: ServerCommandIndexPermissions;
  /** Original index fields retained for the sanitized interaction command object. */
  raw: Record<string, unknown>;
}

export interface ServerCommandGuildState {
  loading: boolean;
  loaded: boolean;
  requestId: number;
  error: string | null;
  applications: ServerCommandApplication[];
  commands: ServerCommand[];
}

export interface ServerCommandAutocompleteState {
  key: string;
  nonce: string | null;
  status: "waiting" | "pending" | "ready" | "error";
  choices: ServerCommandChoice[];
}

export interface ServerCommandsState {
  guilds: Record<string, ServerCommandGuildState>;
  autocomplete: ServerCommandAutocompleteState | null;
}

export interface ServerCommandInteractionOption {
  type: ServerCommandOptionType;
  name: string;
  value?: string | number | boolean;
  options?: ServerCommandInteractionOption[];
  focused?: boolean;
}

export interface ServerCommandInteractionData {
  application_command: Record<string, unknown>;
  attachments: Array<{ id: string; filename: string }>;
  id: string;
  name: string;
  options: ServerCommandInteractionOption[];
  type: 1;
  version: string;
  guild_id: string;
}

export interface ServerCommandInteractionRequest {
  type: 2 | 4;
  applicationId: string;
  guildId: string;
  channelId: string;
  data: ServerCommandInteractionData;
  uploads: ClipboardImageAttachment[];
  key?: string;
}

export type ServerCommandParseResult =
  | { type: "server_command"; request: ServerCommandInteractionRequest; sourceText: string }
  | { type: "error"; message: string };

export function createServerCommandsState(): ServerCommandsState {
  return { guilds: {}, autocomplete: null };
}

export function createServerCommandGuildState(): ServerCommandGuildState {
  return {
    loading: false,
    loaded: false,
    requestId: 0,
    error: null,
    applications: [],
    commands: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePermissions(value: unknown): ServerCommandIndexPermissions | undefined {
  if (!isRecord(value)) return undefined;
  const result: ServerCommandIndexPermissions = {};
  if (typeof value.user === "boolean") result.user = value.user;
  for (const key of ["users", "roles", "channels"] as const) {
    if (!isRecord(value[key])) continue;
    const entries = Object.entries(value[key])
      .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean");
    if (entries.length > 0) result[key] = Object.fromEntries(entries);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeChoice(value: unknown): ServerCommandChoice | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  if (typeof value.value !== "string" && typeof value.value !== "number") return null;
  const name = stringField(value, "name_default") ?? value.name;
  const localized = typeof value.name_localized === "string"
    ? value.name_localized
    : typeof value.name_default === "string"
      ? value.name
      : undefined;
  return {
    name,
    value: value.value,
    ...(localized ? { name_localized: localized } : {}),
  };
}

function normalizeOption(value: unknown): ServerCommandOption | null {
  if (!isRecord(value)) return null;
  if (!Number.isInteger(value.type) || (value.type as number) < 1 || (value.type as number) > 11) return null;
  if (typeof value.name !== "string" || typeof value.description !== "string") return null;
  const name = stringField(value, "name_default") ?? value.name;
  const description = typeof value.description_default === "string" ? value.description_default : value.description;

  const nested = Array.isArray(value.options)
    ? value.options.map(normalizeOption).filter((option): option is ServerCommandOption => option !== null)
    : undefined;
  const choices = Array.isArray(value.choices)
    ? value.choices.map(normalizeChoice).filter((choice): choice is ServerCommandChoice => choice !== null)
    : undefined;
  const channelTypes = Array.isArray(value.channel_types)
    ? value.channel_types.filter((type): type is number => Number.isInteger(type))
    : undefined;
  const fileTypes = Array.isArray(value.file_types)
    ? value.file_types.filter((type): type is string => typeof type === "string" && type.length > 0)
    : undefined;

  return {
    type: value.type as ServerCommandOptionType,
    name,
    description,
    ...(value.required === true ? { required: true } : {}),
    ...(value.autocomplete === true ? { autocomplete: true } : {}),
    ...(nested && nested.length > 0 ? { options: nested } : {}),
    ...(choices && choices.length > 0 ? { choices } : {}),
    ...(channelTypes && channelTypes.length > 0 ? { channel_types: channelTypes } : {}),
    ...(fileTypes && fileTypes.length > 0 ? { file_types: fileTypes } : {}),
    ...(numberField(value, "min_value") !== undefined ? { min_value: numberField(value, "min_value") } : {}),
    ...(numberField(value, "max_value") !== undefined ? { max_value: numberField(value, "max_value") } : {}),
    ...(numberField(value, "min_length") !== undefined ? { min_length: numberField(value, "min_length") } : {}),
    ...(numberField(value, "max_length") !== undefined ? { max_length: numberField(value, "max_length") } : {}),
  };
}

/** Validate and normalize Discord's undocumented client command-index response. */
export function normalizeServerCommandIndex(value: unknown): {
  applications: ServerCommandApplication[];
  commands: ServerCommand[];
} {
  if (!isRecord(value)) return { applications: [], commands: [] };
  const rawApplications = Array.isArray(value.applications) ? value.applications : [];
  const applications = rawApplications.flatMap((raw): ServerCommandApplication[] => {
    if (!isRecord(raw)) return [];
    const id = stringField(raw, "id");
    const name = stringField(raw, "name");
    if (!id || !name) return [];
    const permissions = normalizePermissions(raw.permissions);
    return [{ id, name, ...(permissions ? { permissions } : {}) }];
  });
  const appById = new Map(applications.map((application) => [application.id, application]));
  const rawCommands = Array.isArray(value.application_commands) ? value.application_commands : [];
  const commands = rawCommands.flatMap((raw): ServerCommand[] => {
    if (!isRecord(raw) || raw.type !== APPLICATION_COMMAND_CHAT_INPUT) return [];
    const id = stringField(raw, "id");
    const applicationId = stringField(raw, "application_id");
    const name = stringField(raw, "name_default") ?? stringField(raw, "name");
    const version = stringField(raw, "version");
    if (!id || !applicationId || !name || !version) return [];
    let application = appById.get(applicationId);
    if (!application) {
      // `applications` is optional in current command-index responses. Keep the
      // command usable through a deterministic ID-qualified fallback namespace.
      application = { id: applicationId, name: `App ${applicationId}` };
      applications.push(application);
      appById.set(applicationId, application);
    }
    const options = Array.isArray(raw.options)
      ? raw.options.map(normalizeOption).filter((option): option is ServerCommandOption => option !== null)
      : [];
    const permissions = normalizePermissions(raw.permissions);
    const guildId = stringField(raw, "guild_id");
    const defaultMemberPermissions = raw.default_member_permissions === null
      ? null
      : typeof raw.default_member_permissions === "string"
        ? raw.default_member_permissions
        : undefined;
    return [{
      id,
      applicationId,
      applicationName: application.name,
      name,
      description: typeof raw.description_default === "string"
        ? raw.description_default
        : typeof raw.description === "string"
          ? raw.description
          : "",
      version,
      ...(guildId ? { guildId } : {}),
      options,
      nsfw: raw.nsfw === true,
      ...(defaultMemberPermissions !== undefined ? { defaultMemberPermissions } : {}),
      ...(permissions ? { permissions } : {}),
      raw: { ...raw },
    }];
  });
  return { applications, commands };
}

export function serverCommandAppToken(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, "_");
}

function activeGuildAndChannel(state: AppState): { guildId: string; channel: DiscordChannel } | null {
  const channel = state.channelList.activeChannel;
  const guildId = channel?.guildId ?? state.channelList.guildId;
  if (!channel || !guildId || guildId === DIRECT_MESSAGES_GUILD_ID) return null;
  return { guildId, channel };
}

function permissionBits(value: string | number | null | undefined): bigint {
  try {
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string" && value.trim()) return BigInt(value);
  } catch {
    // Malformed permission values fail closed when a command requires them.
  }
  return 0n;
}

const ADMINISTRATOR_PERMISSION = 1n << 3n;

function currentUserChannelPermissions(state: AppState, guildId: string, channel: DiscordChannel): bigint | null {
  const roles = state.guildRolesByGuildId[guildId];
  const userRoleIds = state.roleIdsByGuildId[guildId] ?? [];
  let permissions: bigint | null = null;
  if (roles && roles.length > 0 && roles.every((role) => typeof role.permissions === "string")) {
    const byId = new Map(roles.map((role) => [role.id, role]));
    permissions = permissionBits(byId.get(guildId)?.permissions);
    for (const roleId of userRoleIds) permissions |= permissionBits(byId.get(roleId)?.permissions);
  } else {
    const guild = state.sidebar.guilds.find((candidate) => candidate.id === guildId);
    if (typeof guild?.permissions === "string") permissions = permissionBits(guild.permissions);
  }
  if (permissions === null || (permissions & ADMINISTRATOR_PERMISSION) !== 0n) return permissions;

  const overwrites = channel.permissionOverwrites ?? [];
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyone) permissions = (permissions & ~permissionBits(everyone.deny)) | permissionBits(everyone.allow);

  const roleIds = new Set(userRoleIds);
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !roleIds.has(overwrite.id)) continue;
    roleAllow |= permissionBits(overwrite.allow);
    roleDeny |= permissionBits(overwrite.deny);
  }
  permissions = (permissions & ~roleDeny) | roleAllow;
  const member = state.auth.user
    ? overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === state.auth.user?.id)
    : undefined;
  return member ? (permissions & ~permissionBits(member.deny)) | permissionBits(member.allow) : permissions;
}

function specialAllChannelsIds(guildId: string): string[] {
  const ids = [guildId];
  try {
    ids.push((BigInt(guildId) - 1n).toString());
  } catch {
    // Tests and provider stubs may use non-snowflake guild IDs.
  }
  return ids;
}

function matchingChannelPermission(
  permissions: ServerCommandIndexPermissions | undefined,
  guildId: string,
  channelId: string,
): boolean | undefined {
  const channels = permissions?.channels;
  if (!channels) return undefined;
  if (typeof channels[channelId] === "boolean") return channels[channelId];
  for (const id of specialAllChannelsIds(guildId)) {
    if (typeof channels[id] === "boolean") return channels[id];
  }
  return undefined;
}

function matchingUserPermission(
  permissions: ServerCommandIndexPermissions | undefined,
  userId: string | null | undefined,
): boolean | undefined {
  if (permissions?.user !== undefined) return permissions.user;
  return userId && permissions?.users && typeof permissions.users[userId] === "boolean"
    ? permissions.users[userId]
    : undefined;
}

function matchingRolePermission(
  permissions: ServerCommandIndexPermissions | undefined,
  guildId: string,
  roleIds: readonly string[],
): boolean | undefined {
  const roles = permissions?.roles;
  if (!roles) return undefined;
  const values = [guildId, ...roleIds]
    .map((id) => roles[id])
    .filter((value): value is boolean => typeof value === "boolean");
  if (values.some(Boolean)) return true;
  return values.length > 0 ? false : undefined;
}

/** Apply command/app index overwrites and default member permissions for this channel. */
export function serverCommandAvailable(state: AppState, command: ServerCommand): boolean {
  const active = activeGuildAndChannel(state);
  if (!active) return false;
  const { guildId, channel } = active;
  if (command.nsfw && !channel.nsfw) return false;
  const permissions = currentUserChannelPermissions(state, guildId, channel);
  if (permissions !== null && (permissions & ADMINISTRATOR_PERMISSION) !== 0n) return true;

  const guildState = state.serverCommands.guilds[guildId];
  const application = guildState?.applications.find((candidate) => candidate.id === command.applicationId);
  const roleIds = state.roleIdsByGuildId[guildId] ?? [];

  const commandChannel = matchingChannelPermission(command.permissions, guildId, channel.id);
  const appChannel = matchingChannelPermission(application?.permissions, guildId, channel.id);
  if ((commandChannel ?? appChannel) === false) return false;

  // A command-specific user/role allow is authoritative and overrides app defaults.
  const commandUser = matchingUserPermission(command.permissions, state.auth.user?.id);
  if (commandUser !== undefined) return commandUser;
  const commandRole = matchingRolePermission(command.permissions, guildId, roleIds);
  if (commandRole !== undefined) return commandRole;

  if (matchingUserPermission(application?.permissions, state.auth.user?.id) === false) return false;
  const appRole = matchingRolePermission(application?.permissions, guildId, roleIds);
  if (appRole === false) return false;

  if (command.defaultMemberPermissions === undefined || command.defaultMemberPermissions === null) return true;
  if (permissions === null) return true;
  const required = permissionBits(command.defaultMemberPermissions);
  return required !== 0n && (permissions & required) === required;
}

function activeServerCommands(state: AppState): {
  guildId: string;
  channelId: string;
  applications: ServerCommandApplication[];
  commands: ServerCommand[];
} | null {
  const active = activeGuildAndChannel(state);
  if (!active) return null;
  const guildState = state.serverCommands.guilds[active.guildId];
  if (!guildState?.loaded) return null;
  return {
    guildId: active.guildId,
    channelId: active.channel.id,
    applications: guildState.applications,
    commands: guildState.commands.filter((command) => serverCommandAvailable(state, command)),
  };
}

interface TokenizeResult {
  tokens: string[];
  unterminatedQuote: boolean;
}

function tokenize(text: string, tolerateUnterminated = false): TokenizeResult | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;
  let started = false;

  for (const char of text) {
    if (escaping) {
      token += char;
      escaping = false;
      started = true;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += char;
    started = true;
  }

  if (escaping) token += "\\";
  if (quote && !tolerateUnterminated) return null;
  if (started) tokens.push(token);
  if (/\s$/.test(text)) tokens.push("");
  return { tokens, unterminatedQuote: quote !== null };
}

interface ResolvedCommandRoute {
  guildId: string;
  channelId: string;
  command: ServerCommand;
  application: ServerCommandApplication;
  branchTokens: string[];
  leafOptions: ServerCommandOption[];
  optionTokens: string[];
  wrappedPath: ServerCommandOption[];
}

function findApplication(
  active: NonNullable<ReturnType<typeof activeServerCommands>>,
  token: string,
): ServerCommandApplication | null {
  const appToken = token.replace(/^\/@?/, "").toLocaleLowerCase();
  return active.applications.find((application) => (
    serverCommandAppToken(application.name) === appToken
    && active.commands.some((command) => command.applicationId === application.id)
  )) ?? null;
}

/**
 * Count the leading tokens that form a recognized app command route.
 *
 * A valid app namespace counts even before a command is chosen, matching how
 * Record highlights its local slash commands. Command and nested branch tokens
 * are included only while they match the active guild's available schema.
 */
export function getServerCommandPathLength(state: AppState, tokens: readonly string[]): number {
  const firstToken = tokens[0];
  if (!firstToken?.startsWith("/") || firstToken.length <= 1) return 0;

  const active = activeServerCommands(state);
  if (!active) return 0;
  const application = findApplication(active, firstToken);
  if (!application) return 0;

  const commandName = tokens[1]?.toLocaleLowerCase();
  const command = commandName
    ? active.commands.find((candidate) => (
      candidate.applicationId === application.id && candidate.name.toLocaleLowerCase() === commandName
    ))
    : undefined;
  if (!command) return 1;

  const branches = command.options.filter((option) => option.type === 1 || option.type === 2);
  if (branches.length === 0) return 2;
  const firstBranchName = tokens[2]?.toLocaleLowerCase();
  const firstBranch = firstBranchName
    ? branches.find((option) => option.name.toLocaleLowerCase() === firstBranchName)
    : undefined;
  if (!firstBranch) return 2;
  if (firstBranch.type === 1) return 3;

  const secondBranchName = tokens[3]?.toLocaleLowerCase();
  const secondBranch = secondBranchName
    ? (firstBranch.options ?? []).find((option) => (
      option.type === 1 && option.name.toLocaleLowerCase() === secondBranchName
    ))
    : undefined;
  return secondBranch ? 4 : 3;
}

function resolveRoute(state: AppState, tokens: string[]): ResolvedCommandRoute | null {
  const active = activeServerCommands(state);
  if (!active || tokens.length < 2) return null;
  const application = findApplication(active, tokens[0] ?? "");
  if (!application) return null;
  const commandName = tokens[1]?.toLocaleLowerCase();
  const command = active.commands.find((candidate) => (
    candidate.applicationId === application.id && candidate.name.toLocaleLowerCase() === commandName
  ));
  if (!command) return null;

  const trailing = tokens.slice(2);
  const bare = trailing.filter((token) => token && !token.startsWith("--"));
  const optionTokens = trailing.filter((token) => token.startsWith("--"));
  let leafOptions = command.options;
  const wrappedPath: ServerCommandOption[] = [];
  const branchTokens: string[] = [];
  const firstBranches = command.options.filter((option) => option.type === 1 || option.type === 2);
  if (firstBranches.length > 0) {
    const firstName = bare[0]?.toLocaleLowerCase();
    const first = firstBranches.find((option) => option.name.toLocaleLowerCase() === firstName);
    if (!first) return null;
    wrappedPath.push(first);
    branchTokens.push(bare[0] ?? "");
    if (first.type === 2) {
      const secondName = bare[1]?.toLocaleLowerCase();
      const second = (first.options ?? []).find((option) => option.type === 1 && option.name.toLocaleLowerCase() === secondName);
      if (!second) return null;
      wrappedPath.push(second);
      branchTokens.push(bare[1] ?? "");
      leafOptions = second.options ?? [];
      if (bare.length > 2) return null;
    } else {
      leafOptions = first.options ?? [];
      if (bare.length > 1) return null;
    }
  } else if (bare.length > 0) {
    return null;
  }

  return { ...active, command, application, branchTokens, leafOptions, optionTokens, wrappedPath };
}

function optionTypeName(type: ServerCommandOptionType): string {
  switch (type) {
    case 1: return "subcommand";
    case 2: return "group";
    case 3: return "text";
    case 4: return "integer";
    case 5: return "true/false";
    case 6: return "user";
    case 7: return "channel";
    case 8: return "role";
    case 9: return "user/role";
    case 10: return "number";
    case 11: return "attachment";
  }
}

function optionDescription(option: ServerCommandOption): string {
  const required = option.required ? "required " : "";
  const detail = option.description ? ` — ${option.description}` : "";
  return `${required}${optionTypeName(option.type)}${detail}`;
}

function quoteValue(value: string): string {
  return value.length > 0 && !/[\s"'\\]/.test(value) ? value : JSON.stringify(value);
}

function optionToken(name: string, value: string | number | boolean): string {
  return `--${name}=${quoteValue(String(value))}`;
}

function optionTokenParts(token: string): { name: string; value: string | null } | null {
  if (!token.startsWith("--") || token.length <= 2) return null;
  const separator = token.indexOf("=");
  if (separator < 0) return { name: token.slice(2), value: null };
  return { name: token.slice(2, separator), value: token.slice(separator + 1) };
}

function optionValueCompletions(state: AppState, option: ServerCommandOption, query: string): CompletionItem[] {
  const lower = query.toLocaleLowerCase();
  if (option.choices && option.choices.length > 0) {
    return option.choices
      .filter((choice) => choice.name.toLocaleLowerCase().startsWith(lower) || String(choice.value).toLocaleLowerCase().startsWith(lower))
      .map((choice) => ({
        name: optionToken(option.name, choice.value),
        desc: choice.name_localized || choice.name,
      }));
  }
  if (option.type === 5) {
    return [true, false]
      .filter((value) => String(value).startsWith(lower))
      .map((value) => ({ name: optionToken(option.name, value), desc: "boolean" }));
  }
  if (option.type === 6 || option.type === 8 || option.type === 9) {
    return loadedMentionCandidates(state)
      .filter((candidate) => (
        (option.type === 6 && candidate.kind === "user")
        || (option.type === 8 && candidate.kind === "role")
        || (option.type === 9 && (candidate.kind === "user" || candidate.kind === "role"))
      ))
      .filter((candidate) => candidate.displayName.toLocaleLowerCase().includes(lower) || candidate.username.toLocaleLowerCase().includes(lower))
      .map((candidate) => ({
        name: optionToken(option.name, candidate.kind === "role" ? `<@&${candidate.id}>` : `<@${candidate.id}>`),
        desc: candidate.displayName,
        color: candidate.color,
      }));
  }
  if (option.type === 7) {
    return state.channelList.channels
      .filter((channel) => !option.channel_types || option.channel_types.includes(channel.type))
      .filter((channel) => channel.name.toLocaleLowerCase().includes(lower))
      .map((channel) => ({ name: optionToken(option.name, `<#${channel.id}>`), desc: `#${channel.name}` }));
  }
  return [];
}

function rootApplicationCompletions(state: AppState, raw: string): CompletionItem[] {
  const active = activeServerCommands(state);
  if (!active || /\s/.test(raw)) return [];
  const prefix = raw.replace(/^\/@?/, "").toLocaleLowerCase();
  const appIds = new Set(active.commands.map((command) => command.applicationId));
  return active.applications
    .filter((application) => appIds.has(application.id))
    .filter((application) => serverCommandAppToken(application.name).startsWith(prefix))
    .map((application) => ({
      name: `/@${serverCommandAppToken(application.name)}`,
      desc: `${application.name} app`,
    }));
}

/** App namespace candidates to show beside Record's local commands after `/`. */
export function getServerCommandRootCompletions(state: AppState, input: string): CompletionItem[] {
  const raw = input.trimStart();
  if (!raw.startsWith("/")) return [];
  return rootApplicationCompletions(state, raw);
}

/**
 * Return null when this is not an app-qualified command, otherwise contextual
 * command/subcommand/option completions (which may legitimately be empty).
 */
export function getServerCommandArgumentCompletions(state: AppState, input: string): CompletionItem[] | null {
  const raw = input.trimStart();
  const parsed = tokenize(raw, true);
  if (!parsed || parsed.tokens.length === 0) return null;
  const active = activeServerCommands(state);
  if (!active) return null;
  const application = findApplication(active, parsed.tokens[0] ?? "");
  if (!application) return null;
  if (parsed.tokens.length === 1) return [];

  const commands = active.commands.filter((command) => command.applicationId === application.id);
  const commandQuery = parsed.tokens[1]?.toLocaleLowerCase() ?? "";
  const command = commands.find((candidate) => candidate.name.toLocaleLowerCase() === commandQuery);
  if (!command || parsed.tokens.length === 2) {
    return commands
      .filter((candidate) => candidate.name.toLocaleLowerCase().startsWith(commandQuery))
      .map((candidate) => ({ name: candidate.name, desc: candidate.description || application.name }));
  }

  const afterCommand = parsed.tokens.slice(2);
  const current = afterCommand.at(-1) ?? "";
  const completed = afterCommand.slice(0, -1);
  const completedBare = completed.filter((token) => token && !token.startsWith("--"));
  const completedOptions = completed.filter((token) => token.startsWith("--"));
  const branches = command.options.filter((option) => option.type === 1 || option.type === 2);
  let leafOptions = command.options;

  if (branches.length > 0) {
    const first = branches.find((option) => option.name.toLocaleLowerCase() === completedBare[0]?.toLocaleLowerCase());
    if (!first) {
      if (completedBare.length > 0 || current.startsWith("--")) return [];
      return branches
        .filter((option) => option.name.toLocaleLowerCase().startsWith(current.toLocaleLowerCase()))
        .map((option) => ({ name: option.name, desc: optionDescription(option) }));
    }
    if (first.type === 2) {
      const children = (first.options ?? []).filter((option) => option.type === 1);
      const second = children.find((option) => option.name.toLocaleLowerCase() === completedBare[1]?.toLocaleLowerCase());
      if (!second) {
        if (completedBare.length > 1 || current.startsWith("--")) return [];
        return children
          .filter((option) => option.name.toLocaleLowerCase().startsWith(current.toLocaleLowerCase()))
          .map((option) => ({ name: option.name, desc: optionDescription(option) }));
      }
      leafOptions = second.options ?? [];
    } else {
      leafOptions = first.options ?? [];
    }
  }

  const used = new Set(completedOptions.map(optionTokenParts).filter(Boolean).map((part) => part!.name.toLocaleLowerCase()));
  const currentOption = optionTokenParts(current);
  if (currentOption && currentOption.value !== null) {
    const option = leafOptions.find((candidate) => candidate.name.toLocaleLowerCase() === currentOption.name.toLocaleLowerCase());
    if (!option) return [];
    const local = optionValueCompletions(state, option, currentOption.value);
    if (local.length > 0) return local;
    const remote = buildServerCommandAutocompleteRequest(state, raw);
    const remoteState = state.serverCommands.autocomplete;
    if (remote && remoteState && remoteState.key === remote.key) {
      return remoteState.choices.map((choice) => ({
        name: optionToken(option.name, choice.value),
        desc: choice.name_localized || choice.name,
      }));
    }
    return [];
  }

  const optionQuery = (currentOption?.name ?? "").toLocaleLowerCase();
  return leafOptions
    .filter((option) => option.type >= 3 && !used.has(option.name.toLocaleLowerCase()))
    .filter((option) => option.name.toLocaleLowerCase().startsWith(optionQuery))
    .map((option) => ({
      name: `--${option.name}${option.type === 11 ? "" : "="}`,
      desc: optionDescription(option),
    }));
}

function attachmentMatchesFileTypes(option: ServerCommandOption, upload: ClipboardImageAttachment): boolean {
  if (!option.file_types || option.file_types.length === 0) return true;
  const mediaType = upload.mediaType.toLocaleLowerCase();
  const filename = (upload.filename ?? "").toLocaleLowerCase();
  return option.file_types.some((fileType) => {
    const normalized = fileType.toLocaleLowerCase();
    if (normalized === "image" || normalized === "video" || normalized === "audio") {
      return mediaType.startsWith(`${normalized}/`);
    }
    return normalized.startsWith(".") && filename.endsWith(normalized);
  });
}

function parseEntityId(value: string, type: 6 | 7 | 8 | 9): string | null {
  const patterns: Record<6 | 7 | 8 | 9, RegExp> = {
    6: /^<@!?(\d+)>$/,
    7: /^<#(\d+)>$/,
    8: /^<@&(\d+)>$/,
    9: /^<@!?&?(\d+)>$/,
  };
  return value.match(patterns[type])?.[1] ?? (/^\d+$/.test(value) ? value : null);
}

function valueMatchesChoice(option: ServerCommandOption, value: string | number): boolean {
  return !option.choices || option.choices.some((choice) => String(choice.value) === String(value));
}

function parseOptionValue(option: ServerCommandOption, raw: string): { value: string | number | boolean } | { error: string } {
  switch (option.type) {
    case 3: {
      const length = Array.from(raw).length;
      if (option.min_length !== undefined && length < option.min_length) return { error: `--${option.name} must be at least ${option.min_length} characters.` };
      if (option.max_length !== undefined && length > option.max_length) return { error: `--${option.name} can be at most ${option.max_length} characters.` };
      if (!valueMatchesChoice(option, raw)) return { error: `--${option.name} must use one of its listed choices.` };
      return { value: raw };
    }
    case 4: {
      if (!/^-?\d+$/.test(raw)) return { error: `--${option.name} must be an integer.` };
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) return { error: `--${option.name} is outside Discord's integer range.` };
      if (option.min_value !== undefined && value < option.min_value) return { error: `--${option.name} must be at least ${option.min_value}.` };
      if (option.max_value !== undefined && value > option.max_value) return { error: `--${option.name} can be at most ${option.max_value}.` };
      if (!valueMatchesChoice(option, value)) return { error: `--${option.name} must use one of its listed choices.` };
      return { value };
    }
    case 5: {
      const normalized = raw.toLocaleLowerCase();
      if (["true", "on", "yes", "1"].includes(normalized)) return { value: true };
      if (["false", "off", "no", "0"].includes(normalized)) return { value: false };
      return { error: `--${option.name} must be true or false.` };
    }
    case 6:
    case 7:
    case 8:
    case 9: {
      const value = parseEntityId(raw, option.type);
      return value ? { value } : { error: `--${option.name} must be a valid ${optionTypeName(option.type)} mention or id.` };
    }
    case 10: {
      const value = Number(raw);
      if (!raw || !Number.isFinite(value)) return { error: `--${option.name} must be a number.` };
      if (option.min_value !== undefined && value < option.min_value) return { error: `--${option.name} must be at least ${option.min_value}.` };
      if (option.max_value !== undefined && value > option.max_value) return { error: `--${option.name} can be at most ${option.max_value}.` };
      if (!valueMatchesChoice(option, value)) return { error: `--${option.name} must use one of its listed choices.` };
      return { value };
    }
    default:
      return { error: `--${option.name} has an unsupported value type.` };
  }
}

function wrapOptions(options: ServerCommandInteractionOption[], path: readonly ServerCommandOption[]): ServerCommandInteractionOption[] {
  let wrapped = options;
  for (let index = path.length - 1; index >= 0; index--) {
    const branch = path[index]!;
    const item: ServerCommandInteractionOption = { type: branch.type, name: branch.name };
    if (wrapped.length > 0) item.options = wrapped;
    wrapped = [item];
  }
  return wrapped;
}

function applicationCommandPayload(command: ServerCommand): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: command.id,
    application_id: command.applicationId,
    version: command.version,
    type: APPLICATION_COMMAND_CHAT_INPUT,
    name: command.name,
    description: command.description,
  };
  if (typeof command.raw.name_default === "string" && typeof command.raw.name === "string") {
    payload.name_localized = command.raw.name;
  }
  if (typeof command.raw.description_default === "string" && typeof command.raw.description === "string") {
    payload.description_localized = command.raw.description;
  }
  for (const key of [
    "dm_permission",
    "nsfw",
    "name_localized",
    "name_localizations",
    "description_localized",
    "description_localizations",
    "default_member_permissions",
    "contexts",
    "integration_types",
    "guild_id",
    "options",
  ]) {
    if (command.raw[key] !== undefined) payload[key] = command.raw[key];
  }
  return payload;
}

function interactionData(
  route: ResolvedCommandRoute,
  options: ServerCommandInteractionOption[],
  uploads: ClipboardImageAttachment[],
): ServerCommandInteractionData {
  return {
    application_command: applicationCommandPayload(route.command),
    attachments: uploads.map((upload, index) => ({ id: String(index), filename: upload.filename ?? `attachment-${index + 1}` })),
    id: route.command.id,
    name: route.command.name,
    options: wrapOptions(options, route.wrappedPath),
    type: APPLICATION_COMMAND_CHAT_INPUT,
    version: route.command.version,
    guild_id: route.guildId,
  };
}

function appNamespaceKnown(state: AppState, token: string): boolean {
  const active = activeServerCommands(state);
  return Boolean(active && findApplication(active, token));
}

function appCommandNameKnown(state: AppState, appToken: string, commandToken: string | undefined): boolean {
  if (!commandToken) return false;
  const active = activeServerCommands(state);
  if (!active) return false;
  const application = findApplication(active, appToken);
  return Boolean(application && active.commands.some((command) => (
    command.applicationId === application.id
    && command.name.toLocaleLowerCase() === commandToken.toLocaleLowerCase()
  )));
}

/** Parse an app-qualified command only when its namespace belongs to the active guild. */
export function tryServerCommand(text: string, state: AppState): ServerCommandParseResult | null {
  const parsed = tokenize(text.trim());
  if (!parsed || parsed.tokens.length === 0) {
    const tolerant = tokenize(text.trim(), true);
    const namespace = tolerant?.tokens[0];
    const commandName = tolerant?.tokens[1];
    const recognized = namespace && (
      (tolerant?.tokens.length === 1 && appNamespaceKnown(state, namespace))
      || appCommandNameKnown(state, namespace, commandName)
    );
    return text.startsWith("/") && recognized
      ? { type: "error", message: "Server command contains an unterminated quote." }
      : null;
  }
  const namespace = parsed.tokens[0] ?? "";
  if (!appNamespaceKnown(state, namespace)) return null;
  if (parsed.tokens.length === 1) {
    return { type: "error", message: "Choose a command for this app with Tab." };
  }
  if (!appCommandNameKnown(state, namespace, parsed.tokens[1])) {
    return namespace.startsWith("/@")
      ? { type: "error", message: "Unknown command for this app. Use Tab to choose one." }
      : null;
  }
  const route = resolveRoute(state, parsed.tokens);
  if (!route) return { type: "error", message: "Invalid server command. Use Tab to complete its command and subcommand." };

  const options: ServerCommandInteractionOption[] = [];
  const uploads: ClipboardImageAttachment[] = [];
  const seen = new Set<string>();
  for (const rawToken of route.optionTokens) {
    const part = optionTokenParts(rawToken);
    if (!part) return { type: "error", message: `Invalid option: ${rawToken}` };
    const name = part.name.toLocaleLowerCase();
    if (seen.has(name)) return { type: "error", message: `Option --${part.name} was provided more than once.` };
    const option = route.leafOptions.find((candidate) => candidate.name.toLocaleLowerCase() === name && candidate.type >= 3);
    if (!option) return { type: "error", message: `Unknown option --${part.name}.` };
    seen.add(name);

    if (option.type === 11) {
      const upload = state.pendingImages[uploads.length];
      if (!upload) return { type: "error", message: `--${option.name} needs an attached image.` };
      if (!attachmentMatchesFileTypes(option, upload)) {
        return { type: "error", message: `The attached image is not an accepted file type for --${option.name}.` };
      }
      options.push({ type: option.type, name: option.name, value: uploads.length });
      uploads.push(upload);
      continue;
    }
    if (part.value === null) return { type: "error", message: `--${option.name} needs a value.` };
    const converted = parseOptionValue(option, part.value);
    if ("error" in converted) return { type: "error", message: converted.error };
    options.push({ type: option.type, name: option.name, value: converted.value });
  }

  const missing = route.leafOptions.find((option) => option.type >= 3 && option.required && !seen.has(option.name.toLocaleLowerCase()));
  if (missing) return { type: "error", message: `Missing required option --${missing.name}.` };
  if (state.pendingImages.length > uploads.length) {
    return { type: "error", message: "This server command has no option for one or more attached images." };
  }

  return {
    type: "server_command",
    sourceText: text,
    request: {
      type: APPLICATION_COMMAND_INTERACTION,
      applicationId: route.command.applicationId,
      guildId: route.guildId,
      channelId: route.channelId,
      data: interactionData(route, options, uploads),
      uploads,
    },
  };
}

/** Build a relaxed type-4 request for the currently focused dynamic option. */
export function buildServerCommandAutocompleteRequest(
  state: AppState,
  input: string,
): ServerCommandInteractionRequest | null {
  const parsed = tokenize(input.trimStart(), true);
  if (!parsed || parsed.tokens.length < 3) return null;
  const route = resolveRoute(state, parsed.tokens);
  if (!route) return null;
  const currentToken = parsed.tokens.at(-1) ?? "";
  const currentPart = optionTokenParts(currentToken);
  if (!currentPart || currentPart.value === null) return null;
  const focused = route.leafOptions.find((option) => (
    option.name.toLocaleLowerCase() === currentPart.name.toLocaleLowerCase() && option.autocomplete === true
  ));
  if (!focused) return null;

  const options: ServerCommandInteractionOption[] = [];
  for (const rawToken of route.optionTokens) {
    const part = optionTokenParts(rawToken);
    if (!part || part.value === null) continue;
    const option = route.leafOptions.find((candidate) => candidate.name.toLocaleLowerCase() === part.name.toLocaleLowerCase());
    if (!option || option.type === 11) continue;
    if (option === focused && rawToken === currentToken) {
      options.push({ type: option.type, name: option.name, value: part.value, focused: true });
      continue;
    }
    const converted = parseOptionValue(option, part.value);
    if (!("error" in converted)) options.push({ type: option.type, name: option.name, value: converted.value });
  }
  const focusedOption = options.find((option) => option.focused);
  if (!focusedOption) return null;
  const wrapped = wrapOptions(options, route.wrappedPath);
  const key = [route.guildId, route.channelId, route.command.id, JSON.stringify(wrapped)].join(":");
  return {
    type: APPLICATION_COMMAND_AUTOCOMPLETE,
    applicationId: route.command.applicationId,
    guildId: route.guildId,
    channelId: route.channelId,
    data: interactionData(route, options, []),
    uploads: [],
    key,
  };
}

/** Test/support helper for constructing loaded index state without REST. */
export function setLoadedServerCommandIndex(
  state: AppState,
  guildId: string,
  value: unknown,
): void {
  const normalized = normalizeServerCommandIndex(value);
  state.serverCommands.guilds[guildId] = {
    ...createServerCommandGuildState(),
    loaded: true,
    applications: normalized.applications,
    commands: normalized.commands,
  };
}

/** Entity lists used by tests and future richer option widgets. */
export interface ServerCommandEntityContext {
  members: DiscordGuildMember[];
  roles: DiscordRole[];
  channels: DiscordChannel[];
}
