import { Database } from "bun:sqlite";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CredentialError } from "../types";

const LOCK_WAIT_MS = 2000;
export const MAX_REFRESH_MS = 15000;

export function configDirectory(): string {
  return process.env.DROPBOX_CLI_CONFIG_DIR || join(homedir(), ".dropbox-cli");
}

class UnlinkedFileError extends Error {}

// No symlink following, permissive fallback, or raw filesystem diagnostics containing secrets.
export function protectedOpen(path: string, directory = false): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const required = directory ? 0o700 : 0o600;
    if ((directory ? !stat.isDirectory() : !stat.isFile()) ||
        (process.getuid && stat.uid !== process.getuid()) || (stat.mode & required) !== required) {
      throw new Error("Unsafe credential permissions");
    }
    if (!directory && stat.nlink !== 1) {
      if (stat.nlink === 0) throw new UnlinkedFileError();
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

function openCoordination(): Database | null {
  const dir = ensureProtectedDirectory();
  const path = join(dir, "auth-coordination.sqlite");
  try {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    closeSync(protectedOpen(path));
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { closeSync(protectedOpen(path + suffix)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        // SQLite can unlink a sidecar after open, before fstat. Revalidate its name
        // on the next bounded acquisition attempt; never accept the detached inode.
        if (error instanceof UnlinkedFileError) return null;
        throw error;
      }
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
  let db: Database | null = null;
  try {
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (true) {
      if (performance.now() >= deadline) timeout();
      db ??= openCoordination();
      if (db && begin(db)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    // SQLite is only the OS-backed mutex. Generations live in atomically replaced JSON,
    // not in this transaction, so a crash/rollback cannot undo a published fence.
    return operation(configDirectory());
  } finally { db?.close(); }
}

export async function coordinateAsync<T>(operation: (dir: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const checkCancelled = () => {
    if (signal?.aborted) throw new CredentialError("auth_cancelled", "Authentication cancelled.");
  };
  checkCancelled();
  let db: Database | null = null;
  try {
    // A live refresh owns the transaction for up to MAX_REFRESH_MS. Never steal it.
    const deadline = performance.now() + MAX_REFRESH_MS + LOCK_WAIT_MS;
    while (true) {
      checkCancelled();
      if (performance.now() >= deadline) timeout();
      db ??= openCoordination();
      if (db && begin(db)) break;
      await Bun.sleep(10);
    }
    checkCancelled();
    return await operation(configDirectory());
  } finally { db?.close(); }
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
