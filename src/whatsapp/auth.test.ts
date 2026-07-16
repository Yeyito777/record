import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hardenWhatsAppAuthDirectory, loadSecureWhatsAppAuthState } from "./auth";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

function permissionBits(mode: number): number {
  return mode & 0o777;
}

describe("secure Baileys auth state", () => {
  test("enforces 0700 directories and 0600 after credential and key writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "record-whatsapp-auth-"));
    temporaryDirectories.push(root);
    const authDirectory = join(root, "record", "whatsapp", "auth");
    await mkdir(authDirectory, { recursive: true, mode: 0o777 });
    await chmod(authDirectory, 0o777);

    const auth = await loadSecureWhatsAppAuthState(authDirectory);
    expect(permissionBits((await lstat(authDirectory)).mode)).toBe(0o700);

    await auth.saveCreds();
    const credsPath = join(authDirectory, "creds.json");
    expect(permissionBits((await lstat(credsPath)).mode)).toBe(0o600);

    // Demonstrate that every write re-hardens existing state, not only the new file.
    await chmod(credsPath, 0o666);
    await auth.state.keys.set({
      "sender-key": { "group--device": new Uint8Array([1, 2, 3]) },
    });

    const entries = await readdir(authDirectory, { withFileTypes: true });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      const mode = permissionBits((await lstat(join(authDirectory, entry.name))).mode);
      expect(mode).toBe(entry.isDirectory() ? 0o700 : 0o600);
    }
  });

  test("refuses symlinks in credential state", async () => {
    const root = await mkdtemp(join(tmpdir(), "record-whatsapp-auth-link-"));
    temporaryDirectories.push(root);
    const authDirectory = join(root, "auth");
    await mkdir(authDirectory);
    await symlink("/tmp", join(authDirectory, "unsafe"));

    await expect(hardenWhatsAppAuthDirectory(authDirectory)).rejects.toThrow("Refusing to use a symlink");
  });

  test("creates private files even under a permissive process umask", async () => {
    const root = await mkdtemp(join(tmpdir(), "record-whatsapp-auth-umask-"));
    temporaryDirectories.push(root);
    const authDirectory = join(root, "auth");
    const previousUmask = process.umask(0);
    try {
      const auth = await loadSecureWhatsAppAuthState(authDirectory);
      await auth.saveCreds();
      await auth.state.keys.set({
        "sender-key": { device: new Uint8Array([4, 5, 6]) },
      });
    } finally {
      process.umask(previousUmask);
    }

    for (const entry of await readdir(authDirectory, { withFileTypes: true })) {
      expect(entry.isFile()).toBe(true);
      expect(permissionBits((await lstat(join(authDirectory, entry.name))).mode)).toBe(0o600);
    }
  });

  test("fails closed on truncated credentials instead of silently replacing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "record-whatsapp-auth-truncated-"));
    temporaryDirectories.push(root);
    const authDirectory = join(root, "auth");
    await mkdir(authDirectory, { mode: 0o700 });
    await writeFile(join(authDirectory, "creds.json"), "{truncated", { mode: 0o600 });

    await expect(loadSecureWhatsAppAuthState(authDirectory)).rejects.toThrow();
  });
});
