import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockLogin = mock();
const mockLogout = mock();
const mockGetStatus = mock();

mock.module("../../src/lib/auth", () => ({
  login: mockLogin,
  logout: mockLogout,
  getStatus: mockGetStatus,
}));

let captured: { success?: unknown; error?: { code: string; message: string } } = {};

mock.module("../../src/lib/output", () => ({
  printSuccess: (data: unknown) => {
    captured.success = data;
  },
  printError: (code: string, message: string) => {
    captured.error = { code, message };
    throw new Error(`EXIT:${code}`);
  },
  isHuman: () => false,
}));



import { Command } from "commander";
import { registerAuthCommands } from "../../src/commands/auth";
import { CredentialError } from "../../src/types";

describe("auth commands", () => {
  beforeEach(() => {
    mockLogin.mockReset();
    mockLogout.mockReset();
    mockGetStatus.mockReset();
    captured = {};
  });

  describe("auth login", () => {
    test("outputs success on successful login", async () => {
      mockLogin.mockResolvedValueOnce({
        account_email: "user@example.com",
        account_id: "dbid:test123",
      });

      const program = new Command();
      registerAuthCommands(program);
      await program.parseAsync(["node", "test", "auth", "login"]);

      expect(mockLogin).toHaveBeenCalled();
      expect(captured.success).toEqual({
        message: "Authentication successful",
        account_email: "user@example.com",
        account_id: "dbid:test123",
      });
    });

    test("outputs error on failed login", async () => {
      mockLogin.mockRejectedValueOnce(new Error("Connection refused"));

      const program = new Command();
      registerAuthCommands(program);
      await expect(
        program.parseAsync(["node", "test", "auth", "login"])
      ).rejects.toThrow("EXIT:auth_failed");
      expect(captured.error).toEqual({
        code: "auth_failed",
        message: "Authentication failed",
      });
    });

    test("preserves typed connection errors and supports noninteractive bounded login", async () => {
      mockLogin.mockRejectedValueOnce(new CredentialError("auth_cancelled", "Authentication cancelled."));
      const program = new Command();
      registerAuthCommands(program);
      await expect(program.parseAsync(["bun", "test", "auth", "login", "--non-interactive", "--timeout", "10"])).rejects.toThrow("EXIT:auth_cancelled");
      expect(mockLogin).toHaveBeenCalledWith(expect.objectContaining({ interactive: false, timeoutMs: 10000, signal: expect.any(AbortSignal) }));
      expect(captured.error).toEqual({ code: "auth_cancelled", message: "Authentication cancelled." });
    });

    test("uses generic message for non-Error rejections", async () => {
      mockLogin.mockRejectedValueOnce("something went wrong");

      const program = new Command();
      registerAuthCommands(program);
      await expect(
        program.parseAsync(["node", "test", "auth", "login"])
      ).rejects.toThrow("EXIT:auth_failed");
      expect(captured.error?.message).toBe("Authentication failed");
    });
  });

  describe("auth logout", () => {
    test("calls logout and outputs success", async () => {
      const program = new Command();
      registerAuthCommands(program);
      await program.parseAsync(["node", "test", "auth", "logout"]);

      expect(mockLogout).toHaveBeenCalled();
      expect(captured.success).toEqual({ message: "Logged out" });
    });
  });

  describe("auth status", () => {
    test("outputs logged-in status", async () => {
      mockGetStatus.mockReturnValueOnce({
        logged_in: true,
        account_email: "user@example.com",
        account_id: "dbid:test123",
        token_expires_at: 1700000000,
        client_id: "app-key",
      });

      const program = new Command();
      registerAuthCommands(program);
      await program.parseAsync(["node", "test", "auth", "status"]);

      expect(captured.success).toEqual({
        logged_in: true,
        account_email: "user@example.com",
        account_id: "dbid:test123",
        token_expires_at: 1700000000,
        client_id: "app-key",
      });
    });

    test("outputs logged-out status", async () => {
      mockGetStatus.mockReturnValueOnce({ logged_in: false });

      const program = new Command();
      registerAuthCommands(program);
      await program.parseAsync(["node", "test", "auth", "status"]);

      expect(captured.success).toEqual({ logged_in: false });
    });
  });
});
