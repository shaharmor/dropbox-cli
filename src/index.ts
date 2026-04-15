#!/usr/bin/env bun
import { Command } from "commander";
import { setVerbose } from "./lib/logger";
import { setHumanMode } from "./lib/output";
import { registerAuthCommands } from "./commands/auth";
import { registerBulkMvCommand } from "./commands/bulk-mv";
import { registerCpCommand } from "./commands/cp";
import { registerDownloadCommand } from "./commands/download";
import { registerInfoCommand } from "./commands/info";
import { registerLsCommand } from "./commands/ls";
import { registerMkdirCommand } from "./commands/mkdir";
import { registerMvCommand } from "./commands/mv";
import { registerSearchCommand } from "./commands/search";
import { registerShareCommand } from "./commands/share";
import { registerUploadCommand } from "./commands/upload";

const program = new Command();

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

// Register all commands (alphabetical order)
registerAuthCommands(program);
registerBulkMvCommand(program);
registerCpCommand(program);
registerDownloadCommand(program);
registerInfoCommand(program);
registerLsCommand(program);
registerMkdirCommand(program);
registerMvCommand(program);
registerSearchCommand(program);
registerShareCommand(program);
registerUploadCommand(program);

program.parse();
