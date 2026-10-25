/**
 * bun test preload (bunfig.toml): isolate the suite from the real config.
 *
 * configDir(), the debug log, the WhatsApp auth dir, the Instagram cookie
 * store, the call widget cache and anything resolving `~` all derive from
 * these variables, so a test can never touch the owner's real files even
 * when it forgets to set up its own temporary directory.
 */

import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Roots of runs that were killed before their exit hook (older than an hour).
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith("record-test-")) continue;
  const path = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(path).mtimeMs > 60 * 60_000) rmSync(path, { recursive: true, force: true });
  } catch {
    // Another run removed it first.
  }
}

const root = mkdtempSync(join(tmpdir(), "record-test-"));
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.RECORD_TEST_ROOT = root;
// os.tmpdir() reads TMPDIR: every mkdtemp the tests make lands under root and
// is removed with it (tests left ~30,000 directories in /tmp otherwise).
process.env.TMPDIR = join(root, "tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
delete process.env.RECORD_DEBUG_LOG;
delete process.env.RECORD_WHATSAPP_AUTH_DIR;
delete process.env.RECORD_PLAYBACK_TRACE_DIR;

// bun test never fires process "exit" listeners from a preload; a global
// afterAll here runs once, after the last test file.
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
