import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { killTrackedChildProcesses, trackChildProcess, trackedChildProcessCount } from "./childprocesses";

function exited(child: { once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown }, timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("child did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

describe("tracked child processes", () => {
  test("exit teardown signals running children and forgets exited ones", async () => {
    const child = trackChildProcess(spawn("sleep", ["30"], { stdio: "ignore" }));
    const done = exited(child);
    expect(trackedChildProcessCount()).toBeGreaterThanOrEqual(1);
    expect(killTrackedChildProcesses("SIGTERM")).toBeGreaterThanOrEqual(1);
    expect((await done).signal).toBe("SIGTERM");
    expect(killTrackedChildProcesses("SIGTERM")).toBe(0);
  });

  test("detached helpers are signalled as a whole process group", async () => {
    // A shell that starts a grandchild, like the voice engine's helpers.
    const child = trackChildProcess(spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore", detached: true }), { group: true });
    const done = exited(child);
    await Bun.sleep(100);
    killTrackedChildProcesses("SIGTERM");
    await done;
    await Bun.sleep(100);
    let groupAlive = true;
    try { process.kill(-child.pid!, 0); } catch { groupAlive = false; }
    expect(groupAlive).toBe(false);
  });

  test("Bun.spawn children are tracked too", async () => {
    const proc = trackChildProcess(Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
    killTrackedChildProcesses("SIGTERM");
    await proc.exited;
    expect(proc.signalCode).toBe("SIGTERM");
  });
});

describe("WhatsApp worker lifetime", () => {
  test("the worker exits by itself when Record's end of its stdin closes", async () => {
    const root = resolve(import.meta.dir, "..");
    const authDirectory = mkdtempSync(join(tmpdir(), "record-wa-worker-"));
    // No request is ever sent, so the worker never opens a WhatsApp connection;
    // a preloaded interval keeps it alive the way a live session's socket does.
    const keepAlive = join(authDirectory, "keepalive.cjs");
    writeFileSync(keepAlive, "setInterval(() => {}, 1000);\n");
    const worker = spawn(resolve(root, "node_modules/.bin/tsx"), [resolve(root, "src/whatsapp/worker.ts")], {
      cwd: root,
      env: { ...process.env, RECORD_WHATSAPP_AUTH_DIR: authDirectory, NODE_OPTIONS: `--require ${keepAlive}` },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const done = exited(worker, 15_000);
    try {
      await Bun.sleep(1_500);
      expect(worker.exitCode).toBeNull();
      worker.stdin.end();
      expect((await done).code).toBe(0);
    } finally {
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
  }, 20_000);
});
