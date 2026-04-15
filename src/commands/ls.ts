import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman, formatBytes, formatDate } from "../lib/output";
import { logError } from "../lib/logger";
import type { ListFolderResult, DropboxEntry } from "../types";

export function registerLsCommand(program: Command): void {
  program
    .command("ls [path]")
    .description("List files and folders in a Dropbox directory")
    .action(async (path: string = "") => {
      // Dropbox uses "" for root, not "/"
      const dbxPath = path === "/" ? "" : path;

      // First page
      let result = await rpc<ListFolderResult>("files/list_folder", {
        path: dbxPath,
        include_mounted_folders: true,
        include_non_downloadable_files: true,
      });

      const allEntries: DropboxEntry[] = [...result.entries];

      // Auto-paginate
      while (result.has_more) {
        result = await rpc<ListFolderResult>("files/list_folder/continue", {
          cursor: result.cursor,
        });
        allEntries.push(...result.entries);
      }

      if (isHuman()) {
        if (allEntries.length === 0) {
          logError("(empty folder)\n");
        } else {
          // Print header
          logError(
            `${"Type".padEnd(8)}${"Name".padEnd(40)}${"Size".padStart(12)}  Modified`
          );
          logError("-".repeat(80));
          for (const entry of allEntries) {
            const type = entry[".tag"] === "folder" ? "folder" : "file";
            const size =
              entry[".tag"] === "file" ? formatBytes(entry.size) : "-";
            const modified =
              entry[".tag"] === "file"
                ? formatDate(entry.server_modified)
                : "-";
            logError(
              `${type.padEnd(8)}${entry.name.padEnd(40)}${size.padStart(12)}  ${modified}`
            );
          }
          logError(`\n${allEntries.length} items`);
        }
      }

      printSuccess(allEntries);
    });
}
