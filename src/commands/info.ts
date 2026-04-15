import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman, formatBytes, formatDate } from "../lib/output";
import { logError } from "../lib/logger";
import type { DropboxEntry } from "../types";

export function registerInfoCommand(program: Command): void {
  program
    .command("info <path>")
    .description("Get metadata for a file or folder")
    .addHelpText("after", `
Examples:
  $ dropbox-cli info /Documents/report.pdf    Get file metadata (size, modified date, hash)
  $ dropbox-cli info /Photos                  Get folder metadata`)
    .action(async (path: string) => {
      const result = await rpc<DropboxEntry>("files/get_metadata", {
        path,
        include_media_info: true,
        include_has_explicit_shared_members: true,
      });

      if (isHuman()) {
        logError(`Path: ${result.path_display}`);
        logError(`Type: ${result[".tag"]}`);
        logError(`Name: ${result.name}`);
        if (result[".tag"] === "file") {
          logError(`Size: ${formatBytes(result.size)}`);
          logError(`Modified: ${formatDate(result.server_modified)}`);
          logError(`Rev: ${result.rev}`);
          logError(`Content hash: ${result.content_hash}`);
        }
      }

      printSuccess(result);
    });
}
