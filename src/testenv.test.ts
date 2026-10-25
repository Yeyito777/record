import { describe, expect, test } from "bun:test";
import { tmpdir, userInfo } from "os";
import { join } from "path";

import { configDir } from "./config";
import { debugLog, debugLogPath, flushDebugLog } from "./debuglog";

describe("test environment", () => {
  const realHome = userInfo().homedir;
  const root = process.env.RECORD_TEST_ROOT ?? "";

  test("the bunfig preload points every config path at a temporary directory", () => {
    expect(root.startsWith(tmpdir())).toBe(true);
    for (const path of [configDir(), debugLogPath(), process.env.HOME ?? ""]) {
      expect(path.startsWith(root)).toBe(true);
      expect(path.startsWith(join(realHome, ".config"))).toBe(false);
    }
  });

  test("debug events from tests never reach the real debug log", () => {
    debugLog("testenv.guard", {});
    flushDebugLog();
    expect(debugLogPath()).not.toBe(join(realHome, ".config", "record", "debug.log"));
  });
});
