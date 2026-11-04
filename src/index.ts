#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { setVerbose } from "./lib/logger";
import { setHumanMode, printSuccess, printError, printMachineError } from "./lib/output";
import { CredentialError, MachineError } from "./types";
import { registerAuthCommands } from "./commands/auth";
import { registerBulkMvCommand } from "./commands/bulk-mv";
import { registerCpCommand } from "./commands/cp";
import { registerDownloadCommand } from "./commands/download";
import { registerInfoCommand } from "./commands/info";
import { registerLsCommand } from "./commands/ls";
import { registerMkdirCommand } from "./commands/mkdir";
import { registerMvCommand } from "./commands/mv";
import { registerSafeBatchCommand } from "./commands/mv-batch";
import { registerSearchCommand } from "./commands/search";
import { registerShareCommand } from "./commands/share";
import { registerStreamLinkCommand } from "./commands/stream-link";
import { registerThumbnailsCommand } from "./commands/thumbnails";
import { registerUploadCommand } from "./commands/upload";

const program = new Command();
program.exitOverride();
// Error messages can echo argv, so drop them; help requested by a bare command still reaches stderr.
program.configureOutput({ outputError: () => {} });

program
  .name("dropbox-cli")
  .description("CLI for the Dropbox API. Outputs JSON by default.")
  .version("1.0.0")
  .option("--human", "Human-readable output instead of JSON")
  .option("--verbose", "Debug logging to stderr");

// Apply global options before any command runs
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  setVerbose(opts.verbose ?? false);
  setHumanMode(opts.human ?? false);
});

program.command("capabilities")
  .description("Describe the versioned viewer machine contract without authentication")
  .action(() => printSuccess({
    protocol_version: 1,
    capabilities: [
      "account-status", "login-pkce", "list-page", "metadata", "download-original",
      "download-progress", "ensure-directory", "move-single", "move-batch", "thumbnail-batch",
      "stream-link",
    ],
  }));

// Register all commands (alphabetical order)
registerAuthCommands(program);
registerBulkMvCommand(program);
registerCpCommand(program);
registerDownloadCommand(program);
registerInfoCommand(program);
registerLsCommand(program);
registerMkdirCommand(program);
registerMvCommand(program);
registerSafeBatchCommand(program);
registerSearchCommand(program);
registerShareCommand(program);
registerStreamLinkCommand(program);
registerThumbnailsCommand(program);
registerUploadCommand(program);

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander throws with exit code 0 for --help/--version; anything else becomes a JSON error.
    if (error.exitCode !== 0) printMachineError(new MachineError("invalid_args", "Invalid command arguments. Use --help for usage."));
  } else if (error instanceof Error && !(error instanceof MachineError) && !(error instanceof CredentialError)) {
    // Machine commands report their own errors, so only human-command failures reach here.
    printError("command_failed", error.message);
  } else {
    printMachineError(error);
  }
}
