import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { coordinate, coordinateAsync, protectedOpen } from "./auth-coordination";
import { CredentialError, type AppConfig, type AuthData, type CredentialSnapshot } from "../types";

function storeError(): CredentialError {
  return new CredentialError("credential_store_error", "Cannot securely read or persist credentials.");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readJSON(dir: string, name: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = protectedOpen(join(dir, name));
  } catch (error) {
    if (isMissing(error)) return null;
    throw storeError();
  }
  try {
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw storeError();
    return value;
  } catch {
    throw storeError();
  } finally {
    closeSync(fd);
  }
}

/** Owner-only, durable replace: write a temporary file, fsync it, rename, fsync the directory. */
function atomicJSON(dir: string, name: string, value: unknown): void {
  const destination = join(dir, name);
  const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    // Refuse to replace an existing file that fails the ownership/permission/link checks.
    try {
      closeSync(protectedOpen(destination));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    const parent = protectedOpen(dir, true);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } catch {
    throw storeError();
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!isMissing(error)) throw storeError();
    }
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateAuth(value: Record<string, unknown>): AuthData {
  const valid = [value.access_token, value.refresh_token, value.account_id, value.account_email].every(text) &&
    typeof value.expires_at === "number" && Number.isFinite(value.expires_at) && value.expires_at >= 0;
  if (!valid) throw storeError();
  return {
    access_token: value.access_token as string,
    refresh_token: value.refresh_token as string,
    account_id: value.account_id as string,
    account_email: value.account_email as string,
    expires_at: value.expires_at as number,
  };
}

interface AuthRecord {
  generation: string;
  auth: AuthData | null;
}

/**
 * Credential store bound to one config directory. It must only be used inside a coordination
 * transaction (see `withCredentialStore`). Every write to auth.json, including logout and
 * failed/cancelled login, publishes a fresh opaque generation in the JSON itself so that a
 * writer holding an older generation cannot overwrite newer state.
 */
function openStore(dir: string) {
  const readRecord = (): AuthRecord => {
    const value = readJSON(dir, "auth.json");
    if (!value) return { generation: "absent", auth: null };
    if (value.generation !== undefined && !text(value.generation)) throw storeError();
    if (value.logged_out === true) {
      const extraKeys = Object.keys(value).some(key => key !== "generation" && key !== "logged_out");
      if (!text(value.generation) || extraKeys) throw storeError();
      return { generation: value.generation, auth: null };
    }
    // Files written before generations existed are accepted as the "legacy" generation.
    return { generation: (value.generation as string | undefined) ?? "legacy", auth: validateAuth(value) };
  };

  const publish = (auth: AuthData | null): string => {
    const generation = randomUUID();
    atomicJSON(dir, "auth.json", auth ? { ...auth, generation } : { logged_out: true, generation });
    return generation;
  };

  // Always reads the record so a corrupt or unsafe auth.json fails closed before any write.
  const requireGeneration = (expected?: string): void => {
    const { generation } = readRecord();
    if (expected !== undefined && expected !== generation) {
      throw new CredentialError("auth_superseded", "Authentication was superseded by another credential change.");
    }
  };

  return {
    readConfig(): AppConfig | null {
      const value = readJSON(dir, "config.json");
      if (!value) return null;
      if (!text(value.client_id) || !text(value.client_secret)) throw storeError();
      return { client_id: value.client_id, client_secret: value.client_secret };
    },

    snapshot(): CredentialSnapshot | null {
      const record = readRecord();
      return record.auth ? Object.freeze({ ...record.auth, generation: record.generation }) : null;
    },

    writeAuth(auth: AuthData, expected?: string): void {
      requireGeneration(expected);
      publish(validateAuth(auth as unknown as Record<string, unknown>));
    },

    clearAuth(): void {
      requireGeneration();
      publish(null);
    },

    /** Publishes a new generation so any older login or refresh still in flight is superseded. */
    beginAuthAttempt(): string {
      return publish(readRecord().auth);
    },

    cancelAuthAttempt(expected: string): void {
      const record = readRecord();
      if (record.generation === expected) publish(record.auth);
    },

    writeConfig(config: AppConfig, expected?: string): string {
      requireGeneration(expected);
      if (!text(config.client_id) || !text(config.client_secret)) throw storeError();
      // Fence old browser/refresh completions before changing app credentials. A crash
      // between the two replacements leaves a logged-out store, never mismatched tokens.
      const generation = publish(null);
      atomicJSON(dir, "config.json", { client_id: config.client_id, client_secret: config.client_secret });
      return generation;
    },
  };
}

export type CredentialStore = ReturnType<typeof openStore>;

export function withCredentialStore<T>(operation: (store: CredentialStore) => T): T {
  return coordinate(dir => operation(openStore(dir)));
}

export function withCredentialStoreAsync<T>(
  operation: (store: CredentialStore) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return coordinateAsync(dir => operation(openStore(dir)), signal);
}

export function readConfig(): AppConfig | null {
  return withCredentialStore(store => store.readConfig());
}

export function writeConfig(config: AppConfig, expectedGeneration?: string): string {
  return withCredentialStore(store => store.writeConfig(config, expectedGeneration));
}

export function readAuth(): AuthData | null {
  return withCredentialStore(store => {
    const snapshot = store.snapshot();
    if (!snapshot) return null;
    const { generation, ...auth } = snapshot;
    return auth;
  });
}

export function writeAuth(auth: AuthData, expectedGeneration?: string): void {
  withCredentialStore(store => store.writeAuth(auth, expectedGeneration));
}

export function clearAuth(): void {
  withCredentialStore(store => store.clearAuth());
}

export function beginAuthAttempt(): string {
  return withCredentialStore(store => store.beginAuthAttempt());
}

export function cancelAuthAttempt(generation: string): void {
  withCredentialStore(store => store.cancelAuthAttempt(generation));
}
