import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman, formatBytes } from "../lib/output";
import { logError } from "../lib/logger";
import type { SearchResult, DropboxEntry } from "../types";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search for files and folders by name")
    .option("--path <path>", "Limit search to a specific folder path")
    .option("--limit <count>", "Maximum number of results", "100")
    .action(async (query: string, options: { path?: string; limit?: string }) => {
      const searchOptions: Record<string, unknown> = {
        query,
        options: {
          max_results: parseInt(options.limit || "100", 10),
          file_status: { ".tag": "active" },
          filename_only: false,
        },
      };

      if (options.path) {
        (searchOptions.options as Record<string, unknown>).path = options.path;
      }

      const result = await rpc<SearchResult>("files/search_v2", searchOptions);

      const entries: DropboxEntry[] = result.matches.map(
        (m) => m.metadata.metadata
      );

      if (isHuman()) {
        if (entries.length === 0) {
          logError("No results found.\n");
        } else {
          logError(`Found ${entries.length} result(s):\n`);
          for (const entry of entries) {
            const type = entry[".tag"] === "folder" ? "folder" : "file";
            const size =
              entry[".tag"] === "file" ? ` (${formatBytes(entry.size)})` : "";
            logError(`  [${type}] ${entry.path_display}${size}`);
          }
        }
      }

      printSuccess(entries);
    });
}
