/**
 * bun test preload (bunfig.toml): isolate the suite from the real config.
 *
 * configDir(), the debug log, the WhatsApp auth dir, the Instagram cookie
 * store, the call widget cache and anything resolving `~` all derive from
 * these variables, so a test can never touch the owner's real files even
 * when it forgets to set up its own temporary directory.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "record-test-"));
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.RECORD_TEST_ROOT = root;
delete process.env.RECORD_DEBUG_LOG;
delete process.env.RECORD_WHATSAPP_AUTH_DIR;
delete process.env.RECORD_PLAYBACK_TRACE_DIR;

process.once("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
