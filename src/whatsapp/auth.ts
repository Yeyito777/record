import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "@whiskeysockets/baileys";

import { getRecordWhatsAppPaths } from "./paths";

export interface WhatsAppAuthStateBundle {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export type WhatsAppAuthStateLoader = (authDirectory: string) => Promise<WhatsAppAuthStateBundle>;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_PREFIX = ".record-auth-";
const fileLocks = new Map<string, Promise<void>>();

/**
 * Enforce a private, flat auth directory without following links. Baileys auth
 * state contains long-lived identity and Signal keys, so unexpected filesystem
 * objects fail closed rather than being traversed.
 */
export async function hardenWhatsAppAuthDirectory(authDirectory: string): Promise<void> {
  await mkdir(authDirectory, { recursive: true, mode: DIRECTORY_MODE });
  await hardenEntry(authDirectory, true);
}

async function hardenEntry(entryPath: string, rootDirectory = false): Promise<void> {
  let info;
  try {
    info = await lstat(entryPath);
  } catch (error) {
    // An atomic writer may have renamed a temporary file between readdir and
    // lstat. The root itself, however, must never disappear silently.
    if (!rootDirectory && isMissing(error)) return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to use a symlink in WhatsApp auth state: ${entryPath}`);
  }

  if (info.isDirectory()) {
    if (!rootDirectory) throw new Error(`Unexpected directory in WhatsApp auth state: ${entryPath}`);
    await chmod(entryPath, DIRECTORY_MODE);
    const children = await readdir(entryPath);
    await Promise.all(children.map((child) => hardenEntry(join(entryPath, child))));
    return;
  }

  if (rootDirectory || !info.isFile()) {
    throw new Error(`Unexpected entry in WhatsApp auth state: ${entryPath}`);
  }
  await chmod(entryPath, FILE_MODE);
}

function fixedFileName(file: string): string {
  return file.replace(/\//g, "__").replace(/:/g, "-");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileLocks.get(path) === current) fileLocks.delete(path);
  }
}

async function assertRegularDestination(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing unsafe WhatsApp auth state entry: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Some non-Linux filesystems reject fsync on directories. File fsync and
    // atomic rename still protect against partial JSON there.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteJson(authDirectory: string, file: string, data: unknown): Promise<void> {
  const destination = join(authDirectory, fixedFileName(file));
  await withFileLock(destination, async () => {
    await assertRegularDestination(destination);
    const temporary = join(authDirectory, `${TEMP_PREFIX}${randomUUID()}.tmp`);
    let handle;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        FILE_MODE,
      );
      await handle.writeFile(JSON.stringify(data, BufferJSON.replacer), { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await chmod(destination, FILE_MODE);
      await syncDirectory(authDirectory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  });
}

async function readJson(authDirectory: string, file: string): Promise<unknown | null> {
  const path = join(authDirectory, fixedFileName(file));
  return await withFileLock(path, async () => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Refusing unsafe WhatsApp auth state entry: ${path}`);
      }
      const serialized = await readFile(path, "utf8");
      return JSON.parse(serialized, BufferJSON.reviver);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  });
}

async function removeFile(authDirectory: string, file: string): Promise<void> {
  const path = join(authDirectory, fixedFileName(file));
  await withFileLock(path, async () => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Refusing unsafe WhatsApp auth state entry: ${path}`);
      }
      await unlink(path);
      await syncDirectory(authDirectory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  });
}

async function removeStaleTemporaryFiles(authDirectory: string): Promise<void> {
  for (const entry of await readdir(authDirectory)) {
    if (!entry.startsWith(TEMP_PREFIX) || !entry.endsWith(".tmp")) continue;
    const path = join(authDirectory, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Refusing unsafe WhatsApp auth temporary entry: ${path}`);
    }
    await unlink(path);
  }
}

/**
 * Record-owned atomic multi-file Baileys auth state.
 *
 * Every write is created as 0600, fsynced, and atomically renamed over the old
 * value. The 0700 directory is fsynced where supported. Invalid/truncated JSON
 * is an error instead of silently creating a new identity beside stale keys.
 */
export async function loadSecureWhatsAppAuthState(
  authDirectory = getRecordWhatsAppPaths().authDirectory,
): Promise<WhatsAppAuthStateBundle> {
  await hardenWhatsAppAuthDirectory(authDirectory);
  await removeStaleTemporaryFiles(authDirectory);

  const storedCreds = await readJson(authDirectory, "creds.json");
  const creds = (storedCreds ?? initAuthCreds()) as AuthenticationState["creds"];

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      await Promise.all(ids.map(async (id) => {
        let value = await readJson(authDirectory, `${type}-${id}.json`) as SignalDataTypeMap[T] | null;
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(
            value as unknown as Record<string, unknown>,
          ) as unknown as SignalDataTypeMap[T];
        }
        if (value != null) result[id] = value;
      }));
      return result;
    },
    set: async (data: SignalDataSet) => {
      const writes: Promise<void>[] = [];
      for (const rawCategory of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
        const category = data[rawCategory];
        if (!category) continue;
        for (const [id, value] of Object.entries(category)) {
          const file = `${rawCategory}-${id}.json`;
          writes.push(value == null
            ? removeFile(authDirectory, file)
            : atomicWriteJson(authDirectory, file, value));
        }
      }
      await Promise.all(writes);
      await hardenWhatsAppAuthDirectory(authDirectory);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await atomicWriteJson(authDirectory, "creds.json", creds);
      await hardenWhatsAppAuthDirectory(authDirectory);
    },
  };
}
