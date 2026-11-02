/**
 * record's headless mode: a bridge between one service and Moon's apps
 * (a26-system docs/social-protocol.md).
 *
 *   bun src/service/main.ts --provider whatsapp
 *   bun src/service/main.ts --provider whatsapp --fixtures --socket /tmp/wa.sock --state /tmp/wa --cache /tmp/wa-cache
 *   bun src/service/main.ts --provider instagram --provider-module /opt/moon-social/instagram/provider.ts
 *
 * --read-only    writes stay off whatever the settings say (sandboxes, tests)
 * --fixtures     the provider's made-up data: no account, no network
 * --moon / --no-moon   post notifications and badges to Moon (default: on,
 *                except with --fixtures)
 */

import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createLogger, errorText } from "./log";
import { createMoonLink, createNullMoonLink } from "./moon";
import { SERVICE_NAMES, type ServiceName } from "./protocol";
import type { ProviderFactory } from "./provider";
import { Bridge } from "./server";

export interface CliOptions {
  service: ServiceName;
  providerModule: string | null;
  socketPath: string;
  stateDir: string;
  cacheDir: string;
  fixtures: boolean;
  readOnly: boolean;
  moon: boolean;
  moonSocket: string | null;
  notifySocket: string | null;
}

const USAGE = "usage: service --provider discord|instagram|whatsapp [--provider-module PATH] [--socket PATH] [--state DIR] [--cache DIR] [--fixtures] [--read-only] [--moon|--no-moon] [--moon-socket PATH] [--notify-socket PATH]";

export function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (["--fixtures", "--read-only", "--moon", "--no-moon"].includes(arg)) { flags.add(arg); continue; }
    if (!arg.startsWith("--") || i + 1 >= argv.length) throw new Error(USAGE);
    values.set(arg, argv[++i]!);
  }
  const service = values.get("--provider") as ServiceName | undefined;
  if (!service || !SERVICE_NAMES.includes(service)) throw new Error(USAGE);
  const path = (key: string, fallback: string) => {
    const value = values.get(key) ?? fallback;
    if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
    return value;
  };
  const fixtures = flags.has("--fixtures");
  return {
    service,
    providerModule: values.has("--provider-module") ? path("--provider-module", "") : null,
    socketPath: path("--socket", process.env.MOON_SOCIAL_SOCKET ?? `/run/moon-social/${service}.sock`),
    stateDir: path("--state", `/var/lib/moon-social/${service}`),
    cacheDir: path("--cache", `/var/cache/moon-social/${service}`),
    fixtures,
    readOnly: flags.has("--read-only"),
    moon: flags.has("--moon") || (!fixtures && !flags.has("--no-moon")),
    moonSocket: values.get("--moon-socket") ?? null,
    notifySocket: values.get("--notify-socket") ?? null,
  };
}

/** The provider for a service: record's own (providers/SERVICE.ts), else the sample's with --fixtures. */
export async function loadProvider(options: CliOptions): Promise<ProviderFactory> {
  const candidates = options.providerModule
    ? [options.providerModule]
    : [join(import.meta.dir, "providers", `${options.service}.ts`)];
  if (!options.providerModule && options.fixtures) candidates.push(join(import.meta.dir, "providers", "sample.ts"));
  for (const candidate of candidates) {
    try {
      const module = await import(pathToFileURL(resolve(candidate)).href);
      if (typeof module.createProvider === "function") return module.createProvider as ProviderFactory;
    } catch (error) {
      if (candidate === candidates.at(-1)) throw error;
    }
  }
  throw new Error(`no provider for ${options.service}`);
}

async function main(): Promise<void> {
  // Sessions, caches and media are root-only from the moment they exist.
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  const log = createLogger(options.service);
  const moon = options.moon
    ? createMoonLink({ moonSocket: options.moonSocket ?? undefined, notifySocket: options.notifySocket ?? undefined })
    : createNullMoonLink();
  const bridge = new Bridge({ ...options, moon, log });
  const factory = await loadProvider(options);
  let exiting = false;
  const exit = (code: number) => {
    if (exiting) return;
    exiting = true;
    void bridge.stop().finally(() => process.exit(code));
    setTimeout(() => process.exit(code), 5_000).unref();
  };
  process.on("SIGTERM", () => exit(0));
  process.on("SIGINT", () => exit(0));
  process.on("unhandledRejection", (error) => log.error("unhandled_rejection", { error: errorText(error) }));
  await bridge.start(factory);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`service: ${errorText(error)}\n`);
    process.exit(1);
  });
}
