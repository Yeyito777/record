import { describe, expect, test } from "bun:test";
import { tmpdir, userInfo } from "os";
import { join } from "path";

import { configDir } from "./config";
import { debugLog, debugLogPath, flushDebugLog } from "./debuglog";

describe("test environment", () => {
  const realHome = userInfo().homedir;
  const root = process.env.RECORD_TEST_ROOT ?? "";

  test("the bunfig preload points every config path at a temporary directory", () => {
    expect(root.length).toBeGreaterThan(0);
    for (const path of [configDir(), debugLogPath(), process.env.HOME ?? ""]) {
      expect(path.startsWith(root)).toBe(true);
      expect(path.startsWith(join(realHome, ".config"))).toBe(false);
    }
  });

  test("temporary directories made by tests live under the throwaway root", () => {
    expect(tmpdir().startsWith(root)).toBe(true);
  });

  test("debug events from tests never reach the real debug log", () => {
    debugLog("testenv.guard", {});
    flushDebugLog();
    expect(debugLogPath()).not.toBe(join(realHome, ".config", "record", "debug.log"));
  });
});
