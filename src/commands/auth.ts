import type { Command } from "commander";
import { login, logout, getStatus } from "../lib/auth";
import { printSuccess, printError } from "../lib/output";
import { logHuman } from "../lib/logger";
import { CredentialError } from "../types";

function authFailure(error: unknown): never {
  if (error instanceof CredentialError) printError(error.code, error.message, 2);
  printError("auth_failed", "Authentication failed");
}

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
    .option("--non-interactive", "Do not prompt for missing app credentials")
    .option("--timeout <seconds>", "Authorization deadline (1–600 seconds)", "180")
    .action(async (options: { nonInteractive?: boolean; timeout: string }) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const seconds = Number(options.timeout);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
          throw new CredentialError("auth_timeout", "Authorization timeout must be between 1 and 600 seconds.");
        }
        const result = await login({ interactive: options.nonInteractive ? false : undefined,
          timeoutMs: seconds * 1000, signal: controller.signal });
        logHuman(`\nAuthenticated as ${result.account_email}\n`);
        printSuccess({
          message: "Authentication successful",
          account_email: result.account_email,
          account_id: result.account_id,
        });
      } catch (err) {
        authFailure(err);
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    });

  auth
    .command("logout")
    .description("Clear stored authentication tokens")
    .action(() => {
      try {
        logout();
        logHuman("Logged out successfully.\n");
        printSuccess({ message: "Logged out" });
      } catch (error) { authFailure(error); }
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .action(() => {
      let status: ReturnType<typeof getStatus>;
      try { status = getStatus(); } catch (error) { authFailure(error); }
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
