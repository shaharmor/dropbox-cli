import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeAuth, readAuth, writeConfig } from "../../src/lib/config";
import { logout, getStatus } from "../../src/lib/auth";
import { existsSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-auth");

describe("auth", () => {
  beforeEach(() => {
    process.env.DROPBOX_CLI_CONFIG_DIR = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    delete process.env.DROPBOX_CLI_CONFIG_DIR;
  });

  describe("logout", () => {
    test("clears stored auth data", () => {
      writeAuth({
        access_token: "tok",
        refresh_token: "ref",
        expires_at: 0,
        account_id: "acc",
        account_email: "user@test.com",
      });
      expect(readAuth()).not.toBeNull();

      logout();
      expect(readAuth()).toBeNull();
    });

    test("does not throw when no auth exists", () => {
      expect(() => logout()).not.toThrow();
    });
  });

  describe("getStatus", () => {
    test("returns logged_in: false when no auth exists", () => {
      const status = getStatus();
      expect(status).toEqual({ logged_in: false });
    });

    test("returns account info when logged in", () => {
      writeAuth({
        access_token: "tok",
        refresh_token: "ref",
        expires_at: 1700000000,
        account_id: "dbid:test",
        account_email: "user@test.com",
      });
      writeConfig({ client_id: "app-key", client_secret: "secret" });

      const status = getStatus();
      expect(status).toEqual({
        logged_in: true,
        account_email: "user@test.com",
        account_id: "dbid:test",
        token_expires_at: 1700000000,
        client_id: "app-key",
      });
    });

    test("returns status without client_id when no config exists", () => {
      writeAuth({
        access_token: "tok",
        refresh_token: "ref",
        expires_at: 1700000000,
        account_id: "dbid:test",
        account_email: "user@test.com",
      });

      const status = getStatus();
      expect(status.logged_in).toBe(true);
      expect(status.client_id).toBeUndefined();
    });
  });
});
