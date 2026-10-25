/**
 * First import of src/main.ts. With `--demo` or RECORD_DEMO=1 it installs the
 * offline demo (isolated config dir, fake Discord behind fetch/WebSocket)
 * before any other module computes a config path. Otherwise it does nothing.
 */

import { createRequire } from "node:module";

import { isDemoRequested } from "./env";

if (isDemoRequested(process.argv, process.env)) {
  const require = createRequire(import.meta.url);
  try {
    (require("./install") as typeof import("./install")).installDemoMode();
  } catch (error) {
    console.error(`record demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
