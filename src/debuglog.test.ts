import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { debugLog, flushDebugLog, resetDebugLogForTest } from "./debuglog";

function tempLog(): string {
  return join(mkdtempSync(join(tmpdir(), "record-debuglog-")), "nested", "debug.log");
}

function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

afterEach(() => {
  resetDebugLogForTest();
});

describe("debugLog", () => {
  test("buffers events and writes them in one batch on flush", () => {
    const path = tempLog();
    resetDebugLogForTest({ enabled: true, verbose: false, path });
    debugLog("a.one", { n: 1 });
    debugLog("a.two", { token: "secret", nested: { password: "x" } });
    expect(existsSync(path)).toBe(false);
    flushDebugLog();
    const written = lines(path);
    expect(written.map((line) => line.event)).toEqual(["a.one", "a.two"]);
    expect(written[1]!.token).toBe("[redacted]");
    expect((written[1]!.nested as Record<string, unknown>).password).toBe("[redacted]");
  });

  test("flushes by itself shortly after an event", async () => {
    const path = tempLog();
    resetDebugLogForTest({ enabled: true, verbose: false, path });
    debugLog("a.timer");
    await Bun.sleep(400);
    expect(lines(path).map((line) => line.event)).toEqual(["a.timer"]);
  });

  test("high-frequency call and voice events are only kept in verbose mode", () => {
    const path = tempLog();
    resetDebugLogForTest({ enabled: true, verbose: false, path });
    debugLog("call.widget.update", { participants: 2 });
    debugLog("voice.playback.stats", {});
    debugLog("call.started");
    flushDebugLog();
    expect(lines(path).map((line) => line.event)).toEqual(["call.started"]);

    resetDebugLogForTest({ enabled: true, verbose: true, path });
    debugLog("call.widget.update", { participants: 2 });
    flushDebugLog();
    expect(lines(path).map((line) => line.event)).toEqual(["call.started", "call.widget.update"]);
  });

  test("RECORD_DEBUG=0 disables and RECORD_DEBUG=verbose keeps everything", () => {
    const path = tempLog();
    resetDebugLogForTest({ path }, { RECORD_DEBUG: "0" });
    debugLog("off.event");
    flushDebugLog();
    expect(existsSync(path)).toBe(false);

    resetDebugLogForTest({ path }, { RECORD_DEBUG: "verbose" });
    debugLog("call.widget.speaking");
    flushDebugLog();
    expect(lines(path).map((line) => line.event)).toEqual(["call.widget.speaking"]);
  });

  test("rotates to .1 once the file would exceed the size cap", () => {
    const path = tempLog();
    resetDebugLogForTest({ enabled: true, verbose: false, path, maxBytes: 4096 });
    debugLog("seed");
    flushDebugLog();
    writeFileSync(path, "x".repeat(5000), { flag: "a" });
    resetDebugLogForTest({ enabled: true, verbose: false, path, maxBytes: 4096 });
    debugLog("after.rotate");
    flushDebugLog();
    expect(statSync(`${path}.1`).size).toBeGreaterThan(5000);
    expect(lines(path).map((line) => line.event)).toEqual(["after.rotate"]);

    for (let i = 0; i < 200; i++) {
      debugLog("fill", { i });
      flushDebugLog();
    }
    expect(statSync(path).size).toBeLessThanOrEqual(4096);
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(4096);
  });
});
