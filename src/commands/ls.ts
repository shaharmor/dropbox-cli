import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman, formatBytes, formatDate } from "../lib/output";
import { logError } from "../lib/logger";
import type { ListFolderResult, DropboxEntry } from "../types";

export function registerLsCommand(program: Command): void {
  program
    .command("ls [path]")
    .description("List files and folders in a Dropbox directory")
    .option("--limit <count>", "Maximum number of entries to return")
    .action(async (path: string = "", options: { limit?: string }) => {
      // Dropbox uses "" for root, not "/"
      const dbxPath = path === "/" ? "" : path;
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;

      // First page
      const listArgs: Record<string, unknown> = {
        path: dbxPath,
        include_mounted_folders: true,
        include_non_downloadable_files: true,
      };
      if (limit !== undefined) {
        listArgs.limit = Math.min(limit, 2000); // Dropbox max per page is 2000
      }

      let result = await rpc<ListFolderResult>("files/list_folder", listArgs);

      const allEntries: DropboxEntry[] = [...result.entries];

      // Auto-paginate (respect limit)
      while (result.has_more && (limit === undefined || allEntries.length < limit)) {
        result = await rpc<ListFolderResult>("files/list_folder/continue", {
          cursor: result.cursor,
        });
        allEntries.push(...result.entries);
      }

      // Trim to exact limit if we overshot
      const entries = limit !== undefined ? allEntries.slice(0, limit) : allEntries;

      if (isHuman()) {
        if (entries.length === 0) {
          logError("(empty folder)\n");
        } else {
          // Print header
          logError(
            `${"Type".padEnd(8)}${"Name".padEnd(40)}${"Size".padStart(12)}  Modified`
          );
          logError("-".repeat(80));
          for (const entry of entries) {
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
          logError(`\n${entries.length} items`);
        }
      }

      printSuccess(entries);
    });
}
