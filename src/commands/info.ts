import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, formatBytes, formatDate } from "../lib/output";
import { logHuman } from "../lib/logger";
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
