/**
 * The bridge's settings (docs/social-protocol.md §4): writes start off and
 * stay off until the user turns them on in the app. `--read-only` pins them
 * off whatever the file says (sandboxes and tests against a real account).
 */

import { join } from "node:path";

import { readJson, writePrivateAtomic } from "./files";
import { BridgeError, DEFAULT_SETTINGS, type Settings } from "./protocol";

export class SettingsStore {
  private current: Settings;
  private readonly path: string;

  constructor(stateDir: string, private readonly options: { readOnly: boolean; fixtures: boolean }) {
    this.path = join(stateDir, "settings.json");
    const saved = readJson<Partial<Settings>>(this.path) ?? {};
    this.current = {
      writes: options.fixtures && saved.writes === undefined ? true : saved.writes === true,
      notifications: saved.notifications ?? DEFAULT_SETTINGS.notifications,
      previews: saved.previews ?? DEFAULT_SETTINGS.previews,
    };
    if (options.readOnly) this.current.writes = false;
  }

  get(): Settings {
    return { ...this.current };
  }

  get writes(): boolean {
    return this.current.writes && !this.options.readOnly;
  }

  /** Applies the fields given; returns the settings. */
  set(patch: Partial<Record<keyof Settings, unknown>>): Settings {
    const next = { ...this.current };
    for (const key of ["writes", "notifications", "previews"] as const) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== "boolean") throw new BridgeError("invalid_argument", `${key} must be a boolean`);
      next[key] = patch[key] as boolean;
    }
    if (next.writes && this.options.readOnly) {
      throw new BridgeError("read_only", "this bridge runs read-only (--read-only)");
    }
    this.current = next;
    writePrivateAtomic(this.path, `${JSON.stringify(this.current)}\n`);
    return this.get();
  }

  /** Throws `read_only` unless writes are on. Every write path calls it first. */
  guard(what: string): void {
    if (!this.writes) throw new BridgeError("read_only", `writes are off (${what})`);
  }
}
