// tests/lib/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readConfig, writeConfig, readAuth, writeAuth, clearAuth } from "../../src/lib/config";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Use a temp dir for tests
const TEST_DIR = join(import.meta.dir, ".test-config");

describe("config", () => {
  beforeEach(() => {
    // Override CONFIG_DIR for tests
    process.env.DROPBOX_CLI_CONFIG_DIR = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    delete process.env.DROPBOX_CLI_CONFIG_DIR;
  });

  test("readConfig returns null when no config exists", () => {
    expect(readConfig()).toBeNull();
  });

  test("writeConfig creates config dir and file", () => {
    writeConfig({ client_id: "test_id", client_secret: "test_secret" });
    const config = readConfig();
    expect(config).toEqual({ client_id: "test_id", client_secret: "test_secret" });
  });

  test("readAuth returns null when no auth exists", () => {
    expect(readAuth()).toBeNull();
  });

  test("writeAuth and readAuth round-trip", () => {
    const auth = {
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 1234567890,
      account_id: "acc",
      account_email: "user@test.com",
    };
    writeAuth(auth);
    expect(readAuth()).toEqual(auth);
  });

  test("clearAuth removes auth file", () => {
    writeAuth({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 0,
      account_id: "acc",
      account_email: "a@b.com",
    });
    expect(readAuth()).not.toBeNull();
    clearAuth();
    expect(readAuth()).toBeNull();
  });
});
