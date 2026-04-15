#!/usr/bin/env bun
import { Command } from "commander";
import { setVerbose } from "./lib/logger";
import { setHumanMode } from "./lib/output";
import { registerAuthCommands } from "./commands/auth";
import { registerLsCommand } from "./commands/ls";
import { registerInfoCommand } from "./commands/info";
import { registerMkdirCommand } from "./commands/mkdir";
import { registerUploadCommand } from "./commands/upload";
import { registerDownloadCommand } from "./commands/download";
import { registerMvCommand } from "./commands/mv";
import { registerCpCommand } from "./commands/cp";
import { registerSearchCommand } from "./commands/search";
import { registerShareCommand } from "./commands/share";
import { registerBulkMvCommand } from "./commands/bulk-mv";

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

// Register all commands
registerAuthCommands(program);
registerLsCommand(program);
registerInfoCommand(program);
registerMkdirCommand(program);
registerUploadCommand(program);
registerDownloadCommand(program);
registerMvCommand(program);
registerCpCommand(program);
registerSearchCommand(program);
registerShareCommand(program);
registerBulkMvCommand(program);

program.parse();
