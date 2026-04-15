import type { Command } from "commander";
import { login, logout, getStatus } from "../lib/auth";
import { printSuccess, printError, isHuman } from "../lib/output";
import { logError } from "../lib/logger";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage Dropbox authentication");

  auth
    .command("login")
    .description("Authenticate with Dropbox via OAuth2")
    .action(async () => {
      try {
        const result = await login();
        if (isHuman()) {
          logError(`\nAuthenticated as ${result.account_email}\n`);
        }
        printSuccess({
          message: "Authentication successful",
          account_email: result.account_email,
          account_id: result.account_id,
        });
      } catch (err) {
        printError(
          "auth_failed",
          err instanceof Error ? err.message : "Authentication failed"
        );
      }
    });

  auth
    .command("logout")
    .description("Clear stored authentication tokens")
    .action(() => {
      logout();
      if (isHuman()) {
        logError("Logged out successfully.\n");
      }
      printSuccess({ message: "Logged out" });
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .action(() => {
      const status = getStatus();
      if (isHuman()) {
        if (status.logged_in) {
          logError(`Logged in as: ${status.account_email}`);
          logError(
            `Token expires: ${new Date((status.token_expires_at || 0) * 1000).toLocaleString()}`
          );
          logError(`App client ID: ${status.client_id}\n`);
        } else {
          logError("Not logged in. Run `dropbox-cli auth login` to authenticate.\n");
        }
      }
      printSuccess(status);
    });
}
