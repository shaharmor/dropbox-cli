import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockLogin = mock();
const mockLogout = mock();
const mockGetStatus = mock();

mock.module("../../src/lib/auth", () => ({
  login: mockLogin,
  logout: mockLogout,
  getStatus: mockGetStatus,
}));

let captured: { success?: unknown } = {};

mock.module("../../src/lib/output", () => ({
  printSuccess: (data: unknown) => {
    captured.success = data;
  },
  isHuman: () => false,
}));



import { Command } from "commander";
import { registerAuthCommands } from "../../src/commands/auth";
import { CommandError, CredentialError } from "../../src/types";

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

    test.each([new Error("Connection refused"), "something went wrong"])("outputs a generic error when login rejects with %p", async (failure) => {
      mockLogin.mockRejectedValueOnce(failure);

      const program = new Command();
      registerAuthCommands(program);
      const error = await program.parseAsync(["node", "test", "auth", "login"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CommandError);
      expect(error).toMatchObject({ code: "auth_failed", message: "Authentication failed", exitCode: 1 });
    });

    test("preserves typed connection errors and supports noninteractive bounded login", async () => {
      mockLogin.mockRejectedValueOnce(new CredentialError("auth_cancelled", "Authentication cancelled."));
      const program = new Command();
      registerAuthCommands(program);
      const error = await program.parseAsync(["bun", "test", "auth", "login", "--non-interactive", "--timeout", "10"]).catch((e: unknown) => e);
      expect(mockLogin).toHaveBeenCalledWith(expect.objectContaining({ interactive: false, timeoutMs: 10000, signal: expect.any(AbortSignal) }));
      expect(error).toBeInstanceOf(CommandError);
      expect(error).toMatchObject({ code: "auth_cancelled", message: "Authentication cancelled.", exitCode: 2 });
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
