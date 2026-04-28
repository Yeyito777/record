import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { configDir, defaultOpenersConfig, loadConfig } from "./config";
import type { DiscordMessageAttachment } from "./discord";

export interface OpenableTargetMatch {
  target: string;
  start: number;
  end: number;
}

export interface OpenCommand {
  command: string;
  args: string[];
}

export interface AttachmentOpenResult {
  ok: boolean;
  path?: string;
  error?: string;
  cached?: boolean;
}

export interface AttachmentDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export interface AttachmentDownloadOptions {
  onProgress?: (progress: AttachmentDownloadProgress) => void;
}

interface NormalizedOpenCommandConfig {
  command: string;
  args: string[];
}

interface ExtensionOpenRule extends NormalizedOpenCommandConfig {
  extensions: readonly string[];
}

interface NormalizedOpenersConfig {
  url: NormalizedOpenCommandConfig | null;
  rules: readonly ExtensionOpenRule[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeCommandConfig(value: unknown): NormalizedOpenCommandConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value.command !== "string" || value.command.trim() === "") return null;
  const args = Array.isArray(value.args)
    ? value.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return { command: value.command, args };
}

function normalizeExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const extensions = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase().replace(/^\.+/, "");
    if (normalized) extensions.add(normalized);
  }
  return [...extensions];
}

function normalizeOpenFileRule(value: unknown): ExtensionOpenRule | null {
  const command = normalizeCommandConfig(value);
  if (!command || !isRecord(value)) return null;
  const extensions = normalizeExtensions(value.extensions);
  if (extensions.length === 0) return null;
  return { ...command, extensions };
}

function defaultNormalizedOpenersConfig(): NormalizedOpenersConfig {
  const defaults = defaultOpenersConfig();
  return {
    url: normalizeCommandConfig(defaults.url) ?? { command: "xdg-open", args: ["{target}"] },
    rules: (defaults.rules ?? [])
      .map(normalizeOpenFileRule)
      .filter((rule): rule is ExtensionOpenRule => rule !== null),
  };
}

function configuredOpeners(): unknown {
  try {
    return loadConfig().openers;
  } catch {
    return undefined;
  }
}

function readOpenersConfig(): NormalizedOpenersConfig {
  const defaults = defaultNormalizedOpenersConfig();
  const configured = configuredOpeners();
  if (!isRecord(configured)) return defaults;

  const url = hasOwn(configured, "url")
    ? (configured.url === null ? null : normalizeCommandConfig(configured.url))
    : defaults.url;

  const rules = hasOwn(configured, "rules")
    ? (Array.isArray(configured.rules)
      ? configured.rules
        .map(normalizeOpenFileRule)
        .filter((rule): rule is ExtensionOpenRule => rule !== null)
      : [])
    : defaults.rules;

  return { url, rules };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openableFilePathRegExp(rules: readonly ExtensionOpenRule[]): RegExp | null {
  const pattern = [...new Set(rules.flatMap((rule) => rule.extensions))]
    .map(escapeRegExp)
    .join("|");
  if (!pattern) return null;
  return new RegExp(String.raw`(?:~/|\.{1,2}/|/)\S*?\.(?:${pattern})\b`, "gi");
}

function trimTrailingTargetPunctuation(target: string): string {
  return target.replace(/[),.;:!?\]}]+$/g, "");
}

function extensionOf(filePath: string): string | null {
  const match = filePath.match(/\.([^.\/]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function ruleForPath(filePath: string, rules: readonly ExtensionOpenRule[]): ExtensionOpenRule | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  return rules.find((rule) => rule.extensions.includes(ext)) ?? null;
}

function expandUserPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function replaceLiteral(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement);
}

function renderCommandTemplate(template: string, target: string, path: string): string {
  let rendered = template;
  rendered = replaceLiteral(rendered, "{target:sh}", shellQuote(target));
  rendered = replaceLiteral(rendered, "{path:sh}", shellQuote(path));
  rendered = replaceLiteral(rendered, "{target}", target);
  rendered = replaceLiteral(rendered, "{path}", path);
  return rendered;
}

function commandFromConfig(config: NormalizedOpenCommandConfig, target: string, path = target): OpenCommand {
  return {
    command: renderCommandTemplate(config.command, target, path),
    args: config.args.map((arg) => renderCommandTemplate(arg, target, path)),
  };
}

function safeFilename(filename: string): string {
  const cleaned = filename.replace(/[\\/\0]/g, "_").trim();
  return cleaned || "attachment";
}

function attachmentCacheDir(): string {
  return join(configDir(), "attachments");
}

function extensionFromFilename(filename: string): string {
  const match = safeFilename(filename).match(/\.[^.]+$/);
  return match ? match[0] : "";
}

function attachmentCachePath(attachment: DiscordMessageAttachment): string {
  const hash = createHash("sha256").update(`${attachment.id}\n${attachment.url}\n${attachment.filename}`).digest("hex").slice(0, 16);
  const ext = extensionFromFilename(attachment.filename);
  return join(attachmentCacheDir(), `${hash}-${safeFilename(attachment.filename).replace(/\.[^.]+$/, "")}${ext}`);
}

function cachedAttachmentIsComplete(path: string, expectedSize: number): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (expectedSize <= 0 || stat.size === expectedSize);
  } catch {
    return false;
  }
}

export function cachedAttachmentPath(attachment: DiscordMessageAttachment): string {
  return attachmentCachePath(attachment);
}

function overlapsAny(match: OpenableTargetMatch, matches: readonly OpenableTargetMatch[]): boolean {
  return matches.some((existing) => match.start < existing.end && match.end > existing.start);
}

function collectUrlMatches(text: string): OpenableTargetMatch[] {
  const matches: OpenableTargetMatch[] = [];
  URL_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const target = trimTrailingTargetPunctuation(raw);
    if (!target) continue;
    matches.push({ target, start, end: start + target.length });
  }
  return matches;
}

function collectFilePathMatches(
  text: string,
  occupied: readonly OpenableTargetMatch[],
  rules: readonly ExtensionOpenRule[],
): OpenableTargetMatch[] {
  const matches: OpenableTargetMatch[] = [];
  const localFilePathRe = openableFilePathRegExp(rules);
  if (!localFilePathRe) return matches;

  for (const match of text.matchAll(localFilePathRe)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const target = trimTrailingTargetPunctuation(raw);
    if (!target || !ruleForPath(target, rules)) continue;

    const candidate = { target, start, end: start + target.length };
    if (overlapsAny(candidate, occupied)) continue;
    matches.push(candidate);
  }
  return matches;
}

/**
 * Find openable targets in rendered text.
 *
 * Targets are configured by ~/.config/record/config.json under openers:
 * - openers.url controls http/https link opening
 * - openers.rules controls local file extensions and commands
 */
export function findOpenableTargetMatches(text: string): OpenableTargetMatch[] {
  const openers = readOpenersConfig();
  const urlMatches = openers.url ? collectUrlMatches(text) : [];
  const fileMatches = collectFilePathMatches(text, urlMatches, openers.rules);
  return [...urlMatches, ...fileMatches].sort((a, b) => a.start - b.start);
}

export function resolveOpenCommand(target: string): OpenCommand | null {
  const openers = readOpenersConfig();

  if (/^https?:\/\//i.test(target)) {
    return openers.url ? commandFromConfig(openers.url, target) : null;
  }

  const rule = ruleForPath(target, openers.rules);
  if (!rule) return null;
  const expandedPath = expandUserPath(target);
  return commandFromConfig(rule, target, expandedPath);
}

export function spawnOpenTargetDetached(target: string): ChildProcess | null {
  const openCommand = resolveOpenCommand(target);
  if (!openCommand) return null;

  try {
    const child = spawn(openCommand.command, openCommand.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // Best effort: opening a target should never disrupt the TUI.
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

export function openTargetDetached(target: string): boolean {
  return spawnOpenTargetDetached(target) !== null;
}

function responseContentLength(response: Response, fallbackSize: number): number | null {
  const header = response.headers.get("content-length");
  const parsed = header ? Number.parseInt(header, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackSize > 0 ? fallbackSize : null;
}

function notifyDownloadProgress(options: AttachmentDownloadOptions | undefined, receivedBytes: number, totalBytes: number | null): void {
  options?.onProgress?.({ receivedBytes, totalBytes });
}

function writeStreamChunk(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function finishWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("finish", onFinish);
    };
    stream.once("error", onError);
    stream.once("finish", onFinish);
    stream.end();
  });
}

async function writeResponseBodyToFile(
  response: Response,
  path: string,
  totalBytes: number | null,
  options?: AttachmentDownloadOptions,
): Promise<void> {
  const tmpPath = `${path}.part-${process.pid}-${Date.now()}`;
  const body = response.body;

  try {
    if (!body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      notifyDownloadProgress(options, bytes.byteLength, totalBytes);
      writeFileSync(tmpPath, bytes, { mode: 0o600 });
      renameSync(tmpPath, path);
      return;
    }

    const stream = createWriteStream(tmpPath, { mode: 0o600 });
    let receivedBytes = 0;
    try {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        receivedBytes += value.byteLength;
        await writeStreamChunk(stream, value);
        notifyDownloadProgress(options, receivedBytes, totalBytes);
      }
      await finishWriteStream(stream);
    } catch (error) {
      stream.destroy();
      throw error;
    }

    renameSync(tmpPath, path);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export async function downloadAttachment(
  attachment: DiscordMessageAttachment,
  options: AttachmentDownloadOptions = {},
): Promise<AttachmentOpenResult> {
  if (!attachment.url) return { ok: false, error: "Attachment has no URL." };

  const path = attachmentCachePath(attachment);
  if (existsSync(path) && cachedAttachmentIsComplete(path, attachment.size)) {
    return { ok: true, path, cached: true };
  }

  try {
    mkdirSync(attachmentCacheDir(), { recursive: true, mode: 0o700 });
    const response = await fetch(attachment.url);
    if (!response.ok) {
      return { ok: false, error: `Download failed: HTTP ${response.status}` };
    }

    const totalBytes = responseContentLength(response, attachment.size);
    notifyDownloadProgress(options, 0, totalBytes);
    await writeResponseBodyToFile(response, path, totalBytes, options);
    return { ok: true, path, cached: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function openAttachmentDetached(
  attachment: DiscordMessageAttachment,
  options: AttachmentDownloadOptions = {},
): Promise<AttachmentOpenResult> {
  const downloaded = await downloadAttachment(attachment, options);
  if (!downloaded.ok || !downloaded.path) return downloaded;
  if (!spawnOpenTargetDetached(downloaded.path)) {
    return { ok: false, path: downloaded.path, error: `No opener configured for ${downloaded.path}.`, cached: downloaded.cached };
  }
  return downloaded;
}
