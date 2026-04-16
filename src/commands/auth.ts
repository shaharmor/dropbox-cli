import type { Command } from "commander";
import { login, logout, getStatus } from "../lib/auth";
import { printSuccess, printError } from "../lib/output";
import { logHuman } from "../lib/logger";

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage Dropbox authentication")
    .addHelpText("after", `
Examples:
  $ dropbox-cli auth login          Log in via OAuth2
  $ dropbox-cli auth status         Check if you're authenticated
  $ dropbox-cli auth logout         Clear stored tokens`);

  auth
    .command("login")
    .description("Authenticate with Dropbox via OAuth2")
    .action(async () => {
      try {
        const result = await login();
        logHuman(`\nAuthenticated as ${result.account_email}\n`);
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
      logHuman("Logged out successfully.\n");
      printSuccess({ message: "Logged out" });
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .action(() => {
      const status = getStatus();
      if (status.logged_in) {
        logHuman(`Logged in as: ${status.account_email}`);
        logHuman(
          `Token expires: ${new Date((status.token_expires_at || 0) * 1000).toLocaleString()}`
        );
        logHuman(`App client ID: ${status.client_id}\n`);
      } else {
        logHuman("Not logged in. Run `dropbox-cli auth login` to authenticate.\n");
      }
      printSuccess(status);
    });
}
