/**
 * Demo-mode installation. Runs synchronously from src/demo/bootstrap.ts before
 * any other Record module is evaluated, so every config path Record computes
 * already points at the isolated demo directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { DEMO_TOKEN, demoServerFolderLayout } from "./data";
import { assertSafeDemoConfigDir, assertUsableDemoHome, DEMO_HOME_MARKER, parseAnchor, realRecordConfigDirs, type Env } from "./env";
import { DemoDiscordServer } from "./server";
import { buildDemoWhatsAppData, DEMO_WHATSAPP_PHOTOS_CHAT, DemoWhatsAppBackend, demoWhatsAppCacheSnapshot } from "./whatsapp";

export interface DemoInstall {
  server: DemoDiscordServer;
  /** Value of XDG_CONFIG_HOME for this run; Record's config is `${home}/record`. */
  home: string;
  configDir: string;
  temporary: boolean;
}

let installed: DemoInstall | null = null;

export function currentDemoInstall(): DemoInstall | null {
  return installed;
}

export function installDemoMode(env: Env = process.env): DemoInstall {
  if (installed) return installed;
  const realDirs = realRecordConfigDirs(env);

  const requestedHome = env.RECORD_DEMO_HOME?.trim();
  if (requestedHome && !isAbsolute(requestedHome)) throw new Error("RECORD_DEMO_HOME must be an absolute path.");
  const home = requestedHome ? resolve(requestedHome) : mkdtempSync(join(tmpdir(), "record-demo-"));
  const configDir = join(home, "record");
  assertUsableDemoHome(home, env);
  assertSafeDemoConfigDir(configDir, realDirs);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, DEMO_HOME_MARKER), "Record offline demo home; safe to delete.\n");

  // Every Record path (config, caches, WhatsApp/Instagram auth, debug log) now
  // resolves inside the demo home.
  env.XDG_CONFIG_HOME = home;
  env.XDG_CACHE_HOME = join(home, "cache");
  env.XDG_STATE_HOME = join(home, "state");
  env.XDG_DATA_HOME = join(home, "data");
  env.RECORD_DEBUG_LOG = join(configDir, "debug.log");
  delete env.RECORD_WHATSAPP_AUTH_DIR;
  delete env.RECORD_PLAYBACK_TRACE_DIR;
  env.RECORD_DEMO = "1";
  env.RECORD_DEMO_HOME = home;

  const server = new DemoDiscordServer({
    anchorMs: parseAnchor(env.RECORD_DEMO_NOW),
    olderPageDelayMs: numberEnv(env.RECORD_DEMO_OLDER_DELAY_MS, 450),
    latencyMs: numberEnv(env.RECORD_DEMO_LATENCY_MS, 20),
    logPath: join(configDir, "demo.log"),
  });

  const configFile = join(configDir, "config.json");
  if (!existsSync(configFile)) {
    writeFileSync(configFile, `${JSON.stringify({
      token: DEMO_TOKEN,
      // Never hand links or files to host programs from the demo.
      openers: { url: null, rules: [] },
      images: { mode: "show" },
    }, null, 2)}\n`, { mode: 0o600 });
  }
  writeStartingState(server, configDir, env.RECORD_DEMO_OPEN);
  writeServerFolders(server, configDir);
  writeFileSync(join(home, "record-demo.pid"), `${process.pid}\n`);

  globalThis.fetch = server.fetch;
  globalThis.WebSocket = server.WebSocket as unknown as typeof WebSocket;

  process.on("SIGUSR1", () => server.emitIncoming(1));
  process.on("SIGUSR2", () => server.emitIncoming(10));
  server.startIncomingTimer(numberEnv(env.RECORD_DEMO_INCOMING_SECONDS, 0) * 1000);
  server.warmImages();

  // Delete our own temporary home on exit (the nested launcher creates one and
  // asks for cleanup); never a directory that is not named like a demo home.
  const temporary = !requestedHome || (env.RECORD_DEMO_CLEANUP === "1" && basename(home).startsWith("record-demo-"));
  if (temporary && env.RECORD_DEMO_KEEP !== "1") {
    const cleanup = (): void => {
      if (existsSync(join(home, DEMO_HOME_MARKER))) rmSync(home, { recursive: true, force: true });
    };
    process.on("exit", cleanup);
    // Move to the end once main.ts has registered its exit handlers, so they
    // persist their state first and nothing recreates the directory.
    setTimeout(() => {
      process.removeListener("exit", cleanup);
      process.on("exit", cleanup);
    }, 0);
  }

  installDemoWhatsApp(server, home, numberEnv(env.RECORD_DEMO_OLDER_DELAY_MS, 450), env);
  installed = { server, home, configDir, temporary };
  return installed;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Start on the long #general channel (or RECORD_DEMO_OPEN=<channel name>,
 * "dm" for the long DM, "none" for no channel) with the sidebar open.
 */
function writeStartingState(server: DemoDiscordServer, configDir: string, open: string | undefined): void {
  const path = join(configDir, "storage", "tui-state.json");
  if (existsSync(path) || open === "none") return;
  const world = server.world;
  let target = world.defaultChannel;
  if (open === "wa-photos" || open === "whatsapp") {
    // Required here, not imported: Record modules must load only after the
    // demo has pointed every config path at its home.
    const require = createRequire(import.meta.url);
    const { WHATSAPP_GUILD_ID, whatsappChannelId } = require("../chatproviders") as typeof import("../chatproviders");
    target = { guildId: WHATSAPP_GUILD_ID, channelId: whatsappChannelId(DEMO_WHATSAPP_PHOTOS_CHAT) };
  } else if (open === "dm") {
    target = { guildId: "@me::dms", channelId: world.directMessages[0]!.id };
  } else if (open) {
    const name = open.replace(/^#/, "");
    for (const guild of world.guilds) {
      const channel = [...guild.channels, ...guild.threads].find((candidate) => candidate.name === name || candidate.id === name);
      if (channel) {
        target = { guildId: guild.id, channelId: channel.id };
        break;
      }
    }
  }
  mkdirSync(join(configDir, "storage"), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    accountId: world.self.id,
    focusedChannel: target,
    sidebar: {
      open: true,
      currentFolderId: null,
      focusedGuildId: target.guildId,
      expandedGuildId: target.guildId,
      collapsedCategoryIds: [],
      selectedItem: { type: "channel", id: target.channelId, guildId: target.guildId },
      scrollOffset: 0,
    },
  }, null, 2)}\n`);
}

/** Nested server folders for the tree view, unless this demo home already has its own. */
function writeServerFolders(server: DemoDiscordServer, configDir: string): void {
  const accountId = server.world.self.id;
  const dir = join(configDir, "accounts", encodeURIComponent(accountId));
  const path = join(dir, "server-folders.json");
  if (existsSync(path)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = { version: 1, accountId, layout: demoServerFolderLayout(server.world), savedAt: server.world.anchorMs };
  writeFileSync(path, `${JSON.stringify(file)}\n`);
}

/**
 * The real WhatsApp runs in a Node child process with its own sockets; the
 * demo replaces it with a fake backend (src/demo/whatsapp.ts). A marker
 * creds.json in the demo home's auth directory makes Record reconnect it at
 * startup as it would a saved session, and a seeded cache holds the recent
 * messages, as after an earlier run.
 */
function installDemoWhatsApp(server: DemoDiscordServer, home: string, olderPageDelayMs: number, env: Env): void {
  const require = createRequire(import.meta.url);
  const { setDefaultWhatsAppBackendFactory } = require("../whatsapp/controller") as typeof import("../whatsapp/controller");
  const { getRecordWhatsAppPaths } = require("../whatsapp/paths") as typeof import("../whatsapp/paths");
  const { authDirectory } = getRecordWhatsAppPaths();
  // Never anywhere but the demo home: the real auth directory holds a real login.
  if (!resolve(authDirectory).startsWith(`${resolve(home)}/`)) {
    throw new Error(`Refusing demo WhatsApp outside the demo home: ${authDirectory}`);
  }
  const data = buildDemoWhatsAppData(server.world.anchorMs);
  const pictures = [...server.world.users.values()].filter((user) => user.avatar);
  setDefaultWhatsAppBackendFactory(() => new DemoWhatsAppBackend({
    data,
    olderPageDelayMs,
    mediaDelayMinMs: numberEnv(env.RECORD_DEMO_WA_MEDIA_MIN_MS, 100),
    mediaDelayMaxMs: numberEnv(env.RECORD_DEMO_WA_MEDIA_MAX_MS, 800),
    pictureUrl: (jid) => {
      const index = [...jid].reduce((sum, char) => sum + char.charCodeAt(0), 0) % (pictures.length + 2);
      const user = pictures[index];
      return user ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
    },
    log: (line) => server.log(line),
  }));
  mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  const creds = join(authDirectory, "creds.json");
  if (!existsSync(creds)) writeFileSync(creds, `${JSON.stringify({ demo: "Record offline demo; not a WhatsApp login" })}\n`, { mode: 0o600 });
  const cacheFile = join(dirname(authDirectory), "cache.json");
  if (!existsSync(cacheFile)) {
    writeFileSync(cacheFile, JSON.stringify(demoWhatsAppCacheSnapshot(data, server.world.anchorMs)), { mode: 0o600 });
  }
}
