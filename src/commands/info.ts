import type { Command } from "commander";
import { rpc, machineMetadata } from "../lib/api";
import { printSuccess, formatBytes, formatDate, runMachine } from "../lib/output";
import { logHuman } from "../lib/logger";
import type { DropboxEntry, MachineOptions } from "../types";

export function registerInfoCommand(program: Command): void {
  program
    .command("info <path>")
    .description("Get metadata for a file or folder")
    .option("--machine", "Return validated account-bound metadata")
    .option("--expected-account <id>", "Required account identity for machine mode")
    .option("--timeout <seconds>", "Machine request deadline (1–600 seconds)")
    .addHelpText("after", `
Examples:
  $ dropbox-cli info /Documents/report.pdf    Get file metadata (size, modified date, hash)
  $ dropbox-cli info /Photos                  Get folder metadata`)
    .action(async (path: string, options: MachineOptions & { machine?: boolean }) => {
      if (options.machine || options.expectedAccount !== undefined || options.timeout !== undefined) {
        return runMachine(options, request => machineMetadata(path, request));
      }
      const result = await rpc<DropboxEntry>("files/get_metadata", {
        path,
        include_media_info: true,
        include_has_explicit_shared_members: true,
      });

      logHuman(`Path: ${result.path_display}`);
      logHuman(`Type: ${result[".tag"]}`);
      logHuman(`Name: ${result.name}`);
      if (result[".tag"] === "file") {
        logHuman(`Size: ${formatBytes(result.size)}`);
        logHuman(`Modified: ${formatDate(result.server_modified)}`);
        logHuman(`Rev: ${result.rev}`);
        logHuman(`Content hash: ${result.content_hash}`);
      }

      printSuccess(result);
    });
}
