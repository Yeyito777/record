/**
 * Demo-mode installation. Runs synchronously from src/demo/bootstrap.ts before
 * any other Record module is evaluated, so every config path Record computes
 * already points at the isolated demo directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { DEMO_TOKEN } from "./data";
import { assertSafeDemoConfigDir, assertUsableDemoHome, DEMO_HOME_MARKER, parseAnchor, realRecordConfigDirs, type Env } from "./env";
import { DemoDiscordServer } from "./server";

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

  disableWhatsAppLogin();
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
  if (open === "dm") {
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

/** WhatsApp runs in a Node child process with its own sockets; keep it off. */
function disableWhatsAppLogin(): void {
  const require = createRequire(import.meta.url);
  const { WhatsAppController } = require("../whatsapp/controller") as typeof import("../whatsapp/controller");
  const { setNotice } = require("../state") as typeof import("../state");
  const prototype = WhatsAppController.prototype as unknown as Record<string, unknown>;
  prototype.login = function (this: { state: Parameters<typeof setNotice>[0]; scheduleRender: () => void }) {
    setNotice(this.state, "WhatsApp is not available in demo mode.", "warning");
    this.scheduleRender();
  };
  prototype.restoreSavedSession = function () {};
}
