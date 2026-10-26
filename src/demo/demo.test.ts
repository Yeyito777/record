import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fetchChannelMessages, fetchDirectMessages, fetchGuildChannels, fetchGuilds, validateToken } from "../discord";
import { buildDemoWorld, DEMO_TOKEN } from "./data";
import { assertSafeDemoConfigDir, assertUsableDemoHome, DEMO_HOME_MARKER, DEMO_WHATSAPP_CREDS, isDemoRequested, realRecordConfigDirs } from "./env";
import { DemoDiscordServer, DemoNetworkBlockedError } from "./server";

const REPO = resolve(import.meta.dir, "../..");
const temps: string[] = [];
const originalFetch = globalThis.fetch;

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-demo-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function server(): DemoDiscordServer {
  return new DemoDiscordServer({ latencyMs: 0, olderPageDelayMs: 0 });
}

describe("demo switches", () => {
  test("--demo or a truthy RECORD_DEMO enables demo mode", () => {
    expect(isDemoRequested(["bun", "src/main.ts", "--demo"], {})).toBe(true);
    expect(isDemoRequested(["bun", "src/main.ts"], { RECORD_DEMO: "1" })).toBe(true);
    expect(isDemoRequested(["bun", "src/main.ts"], { RECORD_DEMO: "0" })).toBe(false);
    expect(isDemoRequested(["bun", "src/main.ts"], {})).toBe(false);
    // Only Record's own arguments count, not the runtime's.
    expect(isDemoRequested(["--demo", "src/main.ts"], {})).toBe(false);
  });
});

describe("demo config safety", () => {
  test("refuses config dirs overlapping the real Record config", () => {
    const home = temp();
    const real = realRecordConfigDirs({ HOME: home });
    expect(real).toEqual([join(home, ".config", "record")]);
    expect(() => assertSafeDemoConfigDir(join(home, ".config", "record"), real)).toThrow(/overlaps the real Record config/);
    expect(() => assertSafeDemoConfigDir(join(home, ".config", "record", "nested"), real)).toThrow(/overlaps/);
    expect(() => assertSafeDemoConfigDir(join(home, ".config"), real)).toThrow(/overlaps/);
    expect(() => assertSafeDemoConfigDir(join(home, "demo", "record"), real)).not.toThrow();
  });

  test("refuses a directory holding a real token or login data", () => {
    const dir = join(temp(), "record");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "real-looking-token" }));
    expect(() => assertSafeDemoConfigDir(dir, [])).toThrow(/non-demo token/);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: DEMO_TOKEN }));
    expect(() => assertSafeDemoConfigDir(dir, [])).not.toThrow();
    writeFileSync(join(dir, "saved-logins.json"), "{}");
    expect(() => assertSafeDemoConfigDir(dir, [])).toThrow(/real login data/);
  });

  test("a demo home's WhatsApp marker is reusable; anything else in auth is refused", () => {
    const dir = join(temp(), "record");
    const auth = join(dir, "whatsapp", "auth");
    mkdirSync(auth, { recursive: true });
    expect(() => assertSafeDemoConfigDir(dir, [])).not.toThrow();
    writeFileSync(join(auth, "creds.json"), `${JSON.stringify(DEMO_WHATSAPP_CREDS)}\n`);
    expect(() => assertSafeDemoConfigDir(dir, [])).not.toThrow();
    writeFileSync(join(auth, "creds.json"), JSON.stringify({ noiseKey: { private: "x" }, me: { id: "1@s.whatsapp.net" } }));
    expect(() => assertSafeDemoConfigDir(dir, [])).toThrow(/real login data/);
    writeFileSync(join(auth, "creds.json"), `${JSON.stringify(DEMO_WHATSAPP_CREDS)}\n`);
    writeFileSync(join(auth, "pre-key-1.json"), "{}");
    expect(() => assertSafeDemoConfigDir(dir, [])).toThrow(/real login data/);
  });

  test("a demo home must be new, empty or marked, and never contain HOME", () => {
    const root = temp();
    const env = { HOME: join(root, "home") };
    mkdirSync(env.HOME, { recursive: true });
    expect(() => assertUsableDemoHome(env.HOME, env)).toThrow(/contains/);
    expect(() => assertUsableDemoHome(root, env)).toThrow(/contains/);
    expect(() => assertUsableDemoHome(join(root, "fresh"), env)).not.toThrow();
    const used = join(root, "used");
    mkdirSync(used);
    writeFileSync(join(used, "notes.txt"), "mine");
    expect(() => assertUsableDemoHome(used, env)).toThrow(/not empty/);
    writeFileSync(join(used, DEMO_HOME_MARKER), "");
    expect(() => assertUsableDemoHome(used, env)).not.toThrow();
  });
});

describe("fake Discord server", () => {
  test("refuses every host other than Discord's API and CDN", async () => {
    const demo = server();
    for (const url of ["https://example.com/", "https://www.instagram.com/api/graphql", "http://discord.com/api/v9/users/@me", "https://web.whatsapp.com/"]) {
      await expect(demo.fetch(url)).rejects.toBeInstanceOf(DemoNetworkBlockedError);
    }
    expect(demo.blocked.length).toBe(4);
  });

  test("the real Discord client functions run against it", async () => {
    const demo = server();
    globalThis.fetch = demo.fetch;
    const me = await validateToken(DEMO_TOKEN);
    expect(me.username).toBe("demo");
    await expect(validateToken("someone-elses-token")).rejects.toThrow(/rejected the token/);

    const guilds = await fetchGuilds(DEMO_TOKEN);
    expect(guilds.length).toBe(15);
    expect(guilds.filter((guild) => guild.icon).length).toBe(12);
    const dms = await fetchDirectMessages(DEMO_TOKEN);
    expect(dms.some((channel) => channel.type === 3)).toBe(true);

    const channels = await fetchGuildChannels(DEMO_TOKEN, guilds[0]!.id);
    const general = channels.find((channel) => channel.name === "general")!;
    const latest = await fetchChannelMessages(DEMO_TOKEN, general.id, 50);
    expect(latest.length).toBe(50);
    expect(latest.at(-1)!.id).toBe(general.lastMessageId!);
    const older = await fetchChannelMessages(DEMO_TOKEN, general.id, 50, latest[0]!.id);
    expect(older.length).toBe(50);
    expect(BigInt(older.at(-1)!.id) < BigInt(latest[0]!.id)).toBe(true);
    expect(demo.history(general.id)!.length).toBeGreaterThanOrEqual(2000);
    expect(demo.requests.every((line) => line.includes("discord.com/api/v9/"))).toBe(true);
  });

  test("serves generated PNGs for icons and image attachments", async () => {
    const demo = server();
    const guild = demo.world.guilds[0]!;
    const icon = await demo.fetch(`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=64`);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await icon.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const images = demo.world.guilds[0]!.channels.find((channel) => channel.name === "images")!;
    const attachment = demo.history(images.id!)!.flatMap((message) => message.attachments ?? []).find((item) => item.content_type === "image/png")!;
    const body = await demo.fetch(attachment.url);
    expect((await body.arrayBuffer()).byteLength).toBe(attachment.size);
  });

  test("the world is deterministic", () => {
    const a = buildDemoWorld();
    const b = buildDemoWorld();
    expect(a.guilds.map((guild) => [guild.id, guild.icon])).toEqual(b.guilds.map((guild) => [guild.id, guild.icon]));
    const left = server();
    const right = server();
    const channelId = left.world.defaultChannel.channelId;
    expect(left.history(channelId)!.slice(-20)).toEqual(right.history(channelId)!.slice(-20));
  });

  test("gateway: identify gets READY, sends echo as MESSAGE_CREATE, incoming appends", async () => {
    const demo = server();
    const events: Array<{ op: number; t?: string; d?: any }> = [];
    const socket = new demo.WebSocket("wss://gateway.discord.gg/?v=9&encoding=json");
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String((event as MessageEvent).data));
      events.push(payload);
      if (payload.op === 10) socket.send(JSON.stringify({ op: 2, d: { token: DEMO_TOKEN } }));
    });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !predicate(); i += 1) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    await waitFor(() => events.some((event) => event.t === "READY"));
    expect(events.find((event) => event.t === "READY")!.d.guilds.length).toBe(15);

    globalThis.fetch = demo.fetch;
    const channelId = demo.world.defaultChannel.channelId;
    const before = demo.history(channelId)!.length;
    const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: DEMO_TOKEN },
      body: JSON.stringify({ content: "hello", nonce: "123" }),
    });
    expect((await response.json()).content).toBe("hello");
    await waitFor(() => events.some((event) => event.t === "MESSAGE_CREATE" && event.d.nonce === "123"));

    demo.emitIncoming(3, channelId);
    expect(demo.history(channelId)!.length).toBe(before + 4);
    await waitFor(() => events.filter((event) => event.t === "MESSAGE_CREATE").length === 4);

    const voice = new demo.WebSocket("wss://us-east1234.discord.media/?v=8");
    let closed = false;
    voice.addEventListener("close", () => { closed = true; });
    await waitFor(() => closed);
    socket.close();
  });
});

describe("demo launch", () => {
  function launch(env: Record<string, string>): { code: number; stderr: string } {
    const proc = Bun.spawnSync(["bun", "run", join(REPO, "src/main.ts"), "--demo"], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    return { code: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
  }

  function fakeRealHome(): { home: string; configFile: string; original: string } {
    const home = temp();
    const configFile = join(home, ".config", "record", "config.json");
    mkdirSync(join(home, ".config", "record"), { recursive: true });
    const original = JSON.stringify({ token: "owner-real-token-sentinel" });
    writeFileSync(configFile, original);
    return { home, configFile, original };
  }

  test("refuses to start pointed at the real config and leaves it untouched", () => {
    const { home, configFile, original } = fakeRealHome();
    const result = launch({ HOME: home, RECORD_DEMO_HOME: join(home, ".config") });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing");
    expect(readFileSync(configFile, "utf8")).toBe(original);
    expect(existsSync(join(home, ".config", "record", "debug.log"))).toBe(false);
    expect(existsSync(join(home, ".config", DEMO_HOME_MARKER))).toBe(false);
  }, 30_000);

  test("the demo bootstrap is main.ts's first import (nothing reads a config path before it)", () => {
    const source = readFileSync(join(REPO, "src/main.ts"), "utf8");
    const firstImport = source.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe(`import "./demo/bootstrap";`);
  });

  test("bootstrap swaps fetch/WebSocket for the fake server and WhatsApp and Instagram for fake ones, inside the demo home", () => {
    const { home, configFile, original } = fakeRealHome();
    const script = join(temp(), "probe.ts");
    writeFileSync(script, `
      import ${JSON.stringify(join(REPO, "src/demo/bootstrap.ts"))};
      const { currentDemoInstall } = await import(${JSON.stringify(join(REPO, "src/demo/install.ts"))});
      const { WhatsAppController } = await import(${JSON.stringify(join(REPO, "src/whatsapp/controller.ts"))});
      const { DemoWhatsAppBackend } = await import(${JSON.stringify(join(REPO, "src/demo/whatsapp.ts"))});
      const { getRecordWhatsAppPaths } = await import(${JSON.stringify(join(REPO, "src/whatsapp/paths.ts"))});
      const { createInitialState } = await import(${JSON.stringify(join(REPO, "src/state.ts"))});
      const { debugLogPath } = await import(${JSON.stringify(join(REPO, "src/debuglog.ts"))});
      const { InstagramController } = await import(${JSON.stringify(join(REPO, "src/instagram/controller.ts"))});
      const { instagramAuthPath } = await import(${JSON.stringify(join(REPO, "src/instagram/auth.ts"))});
      const { instagramCachePath } = await import(${JSON.stringify(join(REPO, "src/instagram/cache.ts"))});
      const { instagramMutePath } = await import(${JSON.stringify(join(REPO, "src/instagram/mute.ts"))});
      const { cachedAttachmentPath } = await import(${JSON.stringify(join(REPO, "src/openable.ts"))});
      const { instagramTimelineMessages } = await import(${JSON.stringify(join(REPO, "src/instagram/integration.ts"))});
      const { instagramChannelId } = await import(${JSON.stringify(join(REPO, "src/chatproviders.ts"))});
      const { DEMO_INSTAGRAM_SHARES_THREAD } = await import(${JSON.stringify(join(REPO, "src/demo/instagram.ts"))});
      const controller = new WhatsAppController(createInitialState(null, "/tmp/x.json"), () => {});
      const igState = createInitialState(null, "/tmp/y.json");
      const instagram = new InstagramController(igState, () => {}, { pollIntervalMs: 60_000 });
      await instagram.autoConnect();
      const igAccount = igState.instagram.account?.id ?? "";
      const igChannel = instagramChannelId(DEMO_INSTAGRAM_SHARES_THREAD);
      instagram.openChannel(igChannel);
      for (let i = 0; i < 100 && !igState.instagram.threadsById[DEMO_INSTAGRAM_SHARES_THREAD]?.detailLoaded; i++) await Bun.sleep(10);
      const igImage = instagramTimelineMessages(igState.instagram, igChannel).flatMap((message) => message.attachments)
        .find((attachment) => attachment.contentType?.startsWith("image/"));
      const igImageResponse = igImage ? await fetch(igImage.url) : null;
      await instagram.shutdown();
      const demo = currentDemoInstall();
      let blocked = false;
      try { await fetch("https://example.com/"); } catch (error) { blocked = error.name === "DemoNetworkBlockedError"; }
      console.log(JSON.stringify({
        fakeFetch: globalThis.fetch === demo.server.fetch,
        fakeSocket: globalThis.WebSocket === demo.server.WebSocket,
        blocked,
        xdg: process.env.XDG_CONFIG_HOME === demo.home,
        fakeWhatsApp: controller.backend instanceof DemoWhatsAppBackend,
        whatsappAuthInDemoHome: getRecordWhatsAppPaths().authDirectory.startsWith(demo.home + "/"),
        debugLogInDemoHome: debugLogPath().startsWith(demo.home + "/"),
        instagramConnected: igState.instagram.connection.status === "connected",
        instagramPathsInDemoHome: [instagramAuthPath(), instagramCachePath(igAccount), instagramMutePath(igAccount), igImage ? cachedAttachmentPath(igImage) : ""]
          .every((path) => path.startsWith(demo.home + "/")),
        instagramCacheSaved: (await import("node:fs")).existsSync(instagramCachePath(igAccount)),
        instagramSessionNeverWritten: !(await import("node:fs")).existsSync(instagramAuthPath()),
        instagramImageServed: igImageResponse?.ok === true,
      }));
      await controller.shutdown();
    `);
    const proc = Bun.spawnSync(["bun", "run", script], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", HOME: home, RECORD_DEMO: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString().trim().split("\n").at(-1)!)).toEqual({
      fakeFetch: true, fakeSocket: true, blocked: true, xdg: true, fakeWhatsApp: true, whatsappAuthInDemoHome: true,
      debugLogInDemoHome: true, instagramConnected: true, instagramPathsInDemoHome: true, instagramCacheSaved: true,
      instagramSessionNeverWritten: true, instagramImageServed: true,
    });
    expect(readFileSync(configFile, "utf8")).toBe(original);
    expect(existsSync(join(home, ".config", "record", "whatsapp"))).toBe(false);
    expect(existsSync(join(home, ".config", "record", "instagram"))).toBe(false);
  }, 30_000);

  test("a demo run uses its own home and never writes the real config", () => {
    const { home, configFile, original } = fakeRealHome();
    const demoHome = join(temp(), "record-demo-launch");
    // Without a TTY Record exits right after start-up; demo setup has run by then.
    launch({ HOME: home, XDG_CONFIG_HOME: join(home, ".config"), RECORD_DEMO_HOME: demoHome });
    expect(readFileSync(configFile, "utf8")).toBe(original);
    expect(existsSync(join(home, ".config", "record", "debug.log"))).toBe(false);
    expect(existsSync(join(demoHome, DEMO_HOME_MARKER))).toBe(true);
    expect(JSON.parse(readFileSync(join(demoHome, "record", "config.json"), "utf8")).token).toBe(DEMO_TOKEN);
  }, 30_000);
});
