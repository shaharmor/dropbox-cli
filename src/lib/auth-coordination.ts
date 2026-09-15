import { Database } from "bun:sqlite";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CredentialError } from "../types";

const LOCK_WAIT_MS = 2000;

export function configDirectory(): string {
  return process.env.DROPBOX_CLI_CONFIG_DIR || join(homedir(), ".dropbox-cli");
}

// No symlink following, permissive fallback, or raw filesystem diagnostics containing secrets.
export function protectedOpen(path: string, directory = false): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const required = directory ? 0o700 : 0o600;
    if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        (process.getuid && stat.uid !== process.getuid()) || (stat.mode & required) !== required) {
      throw new Error("Unsafe credential permissions");
    }
    fchmodSync(fd, required);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function ensureProtectedDirectory(): string {
  const dir = configDirectory();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    closeSync(protectedOpen(dir, true));
    return dir;
  } catch {
    throw new CredentialError("credential_store_error", "Cannot securely access the credential directory.");
  }
}

function openCoordination(): Database {
  const dir = ensureProtectedDirectory();
  const path = join(dir, "auth-coordination.sqlite");
  try {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    closeSync(protectedOpen(path));
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { lstatSync(path + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      closeSync(protectedOpen(path + suffix));
    }
    const db = new Database(path, { create: false, strict: true });
    try { db.exec("PRAGMA busy_timeout = 0"); }
    catch (error) { db.close(); throw error; }
    return db;
  } catch {
    throw new CredentialError("coordination_error", "Cannot securely open credential coordination.");
  }
}

function begin(db: Database): boolean {
  try { db.exec("BEGIN IMMEDIATE"); return true; }
  catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") return false;
    throw new CredentialError("coordination_error", "Cannot acquire credential coordination.");
  }
}

function timeout(): never {
  throw new CredentialError("coordination_timeout", "Credential coordination is busy. Retry later.");
}

export function coordinate<T>(operation: (dir: string) => T): T {
  const db = openCoordination();
  try {
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (!begin(db)) {
      if (performance.now() >= deadline) timeout();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    // SQLite is only the OS-backed mutex. Generations live in atomically replaced JSON,
    // not in this transaction, so a crash/rollback cannot undo a published fence.
    return operation(configDirectory());
  } finally { db.close(); }
}

export async function coordinateAsync<T>(operation: (dir: string) => Promise<T>): Promise<T> {
  const db = openCoordination();
  try {
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (!begin(db)) {
      if (performance.now() >= deadline) timeout();
      await Bun.sleep(10);
    }
    return await operation(configDirectory());
  } finally { db.close(); }
}

export function authDeadline(timeoutMs: number, signal?: AbortSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CredentialError("auth_timeout", "Authentication deadline must be positive.");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new CredentialError("auth_cancelled", "Authentication cancelled."));
  const timer = setTimeout(() => controller.abort(new CredentialError("auth_timeout", "Authentication timed out.")), timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return {
    signal: controller.signal,
    async wait<T>(work: Promise<T>): Promise<T> {
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      try { return await Promise.race([work, cancelled]); }
      finally { controller.signal.removeEventListener("abort", abort); }
    },
    close() { clearTimeout(timer); signal?.removeEventListener("abort", cancel); },
  };
}
