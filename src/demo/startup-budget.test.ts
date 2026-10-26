import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "../..");
const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Everything Record asks Discord for in its first seconds, against the demo's
 * fake Discord. A start that fans out per server (roles, members, a second
 * session) is the kind of burst that gets user clients rate-limited or flagged.
 */
describe("startup request budget", () => {
  test.skipIf(!hasScript || process.platform !== "linux")("a start stays within the web client's footprint", async () => {
    const root = mkdtempSync(join(tmpdir(), "record-startup-budget-"));
    const demoHome = join(root, "demo-home");
    const proc = Bun.spawn(["script", "-qec", `${process.execPath} run ${join(REPO, "src/main.ts")} --demo`, "/dev/null"], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), TERM: "xterm-256color", RECORD_DEMO_HOME: demoHome, RECORD_DEMO_KEEP: "1", RECORD_DEBUG: "0" },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await Bun.sleep(8_000);
    } finally {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(3_000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    const logPath = join(demoHome, "record", "demo.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((line) => line.slice(line.indexOf(" ") + 1));
    const api = lines.filter((line) => /^\w+ discord\.com\/api\//.test(line));
    const gateway = lines.filter((line) => line.startsWith("GATEWAY "));
    const count = (pattern: RegExp, from: string[]) => from.filter((line) => pattern.test(line)).length;

    expect(api.length).toBeGreaterThan(3);
    // No per-server REST fan-out: roles come from READY, members from op 37.
    expect(count(/\/guilds\/\d+\/roles/, api)).toBe(0);
    expect(count(/\/guilds\/\d+\/members/, api)).toBe(0);
    expect(count(/\/guilds\/\d+\/emojis|\/application-command-index/, api)).toBe(0);
    expect(api.length).toBeLessThanOrEqual(12);
    // Nothing a user client may not call (single-message GET, OAuth member route).
    expect(lines.filter((line) => line.startsWith("BOT-ONLY "))).toEqual([]);
    expect(count(/\/users\/@me\/guilds\/\d+\/member/, api)).toBe(0);
    // One Discord session (one IDENTIFY), and member lookups only for what is on screen.
    expect(count(/^GATEWAY op 2\b/, gateway)).toBe(1);
    expect(count(/^GATEWAY op 8\b/, gateway)).toBeLessThanOrEqual(2);
    expect(gateway.length).toBeLessThanOrEqual(10);
  }, 20_000);
});
