import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..");
const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Runs `probe` in a pty whose reader drains slowly (a few KiB every 5 ms), like st on macOS. */
const SLOW_PTY = `
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out = bytearray(); start = time.time()
while time.time() - start < 20:
    time.sleep(0.005)
    try:
        r, _, _ = select.select([fd], [], [], 0)
        if r: out += os.read(fd, 65536)
    except OSError: break
    if os.waitpid(pid, os.WNOHANG)[0]:
        try:
            while True:
                d = os.read(fd, 65536)
                if not d: break
                out += d
        except OSError: pass
        break
open(sys.argv[0] + ".out", "wb").write(out)
`;

describe("non-blocking terminal output", () => {
  test.skipIf(!hasPython || process.platform === "win32")("a big write returns at once, keeps the loop running, and reaches the terminal in order before exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-termout-"));
    const relay = join(dir, "relay.py");
    writeFileSync(relay, SLOW_PTY);
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, `
      import { appendFileSync } from "fs";
      import { installTerminalOutput, terminalOutputBacklog } from ${JSON.stringify(join(REPO, "src/terminaloutput.ts"))};
      const installed = installTerminalOutput();
      const big = "A".repeat(256 * 1024) + "B".repeat(256 * 1024);
      const t0 = performance.now();
      process.stdout.write(big);
      process.stdout.write("<END>");
      const writeMs = performance.now() - t0;
      const backlog = terminalOutputBacklog();
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      setTimeout(() => {
        clearInterval(timer);
        appendFileSync(${JSON.stringify(join(dir, "report.json"))}, JSON.stringify({ installed, writeMs, backlog, ticks }));
        process.exit(0);
      }, 500);
    `);
    const run = spawnSync("python3", [relay, process.execPath, probe], { timeout: 30_000 });
    expect(run.status).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    expect(report.installed).toBe(true);
    expect(report.writeMs).toBeLessThan(50);
    expect(report.backlog).toBeGreaterThan(0);
    // The event loop kept running while the terminal drained (~40 ticks in 500 ms).
    expect(report.ticks).toBeGreaterThan(30);
    const out = readFileSync(`${relay}.out`).toString("latin1").replace(/\r/g, "");
    const a = out.indexOf("A"), b = out.indexOf("B"), end = out.indexOf("<END>");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(a + 256 * 1024);
    expect(end).toBe(b + 256 * 1024);
  }, 40_000);

  test.skipIf(!hasPython || process.platform === "win32")("interactive output overtakes queued media, but never splits a message", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-termout-lanes-"));
    const relay = join(dir, "relay.py");
    writeFileSync(relay, SLOW_PTY);
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, `
      import { installTerminalOutput, writeTerminalBulk, terminalInteractiveBacklog } from ${JSON.stringify(join(REPO, "src/terminaloutput.ts"))};
      installTerminalOutput();
      writeTerminalBulk("[X" + "x".repeat(128 * 1024) + "X]");
      writeTerminalBulk("[Y" + "y".repeat(128 * 1024) + "Y]");
      setTimeout(() => {
        process.stdout.write("<FRAME>");
        setTimeout(() => process.exit(terminalInteractiveBacklog() === 0 ? 0 : 3), 3000);
      }, 20);
    `);
    const run = spawnSync("python3", [relay, process.execPath, probe], { timeout: 30_000 });
    expect(run.status).toBe(0);
    const out = readFileSync(`${relay}.out`).toString("latin1");
    const xEnd = out.indexOf("X]"), frame = out.indexOf("<FRAME>"), yStart = out.indexOf("[Y");
    expect(xEnd).toBeGreaterThan(0);
    expect(frame).toBeGreaterThan(xEnd);
    // The frame went before the second packet, which still arrived whole.
    expect(yStart).toBeGreaterThan(frame);
    expect(out.indexOf("Y]")).toBe(yStart + 2 + 128 * 1024);
  }, 40_000);
});
