import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, formatBytes } from "../lib/output";
import { logHuman } from "../lib/logger";
import { positiveInteger } from "../lib/options";
import type { SearchResult, DropboxEntry } from "../types";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search for files and folders by name and, where the account supports it, file contents")
    .option("--path <path>", "Limit search to a specific folder path")
    .option("--limit <count>", "Maximum number of results", positiveInteger(), 100)
    .addHelpText("after", `
Examples:
  $ dropbox-cli search "quarterly report"                Search all of Dropbox
  $ dropbox-cli search "*.pdf" --path /Documents         Search within a folder
  $ dropbox-cli search "budget" --limit 5                Limit number of results`)
    .action(async (query: string, options: { path?: string; limit: number }) => {
      const limit = options.limit;

      const searchArgs: Record<string, unknown> = {
        query,
        options: {
          max_results: Math.min(limit, 1000),
          file_status: { ".tag": "active" },
          filename_only: false,
        },
      };

      if (options.path) {
        (searchArgs.options as Record<string, unknown>).path = options.path;
      }

      // First page
      let result = await rpc<SearchResult>("files/search_v2", searchArgs);
      const allMatches = [...result.matches];

      // Auto-paginate until we have enough or no more results
      while (result.has_more && result.cursor && allMatches.length < limit) {
        result = await rpc<SearchResult>("files/search/continue_v2", {
          cursor: result.cursor,
        });
        allMatches.push(...result.matches);
      }

      const entries: DropboxEntry[] = allMatches
        .slice(0, limit)
        .map((m) => m.metadata.metadata);

      if (entries.length === 0) {
        logHuman("No results found.\n");
      } else {
        logHuman(`Found ${entries.length} result(s):\n`);
        for (const entry of entries) {
          const type = entry[".tag"] === "folder" ? "folder" : "file";
          const size =
            entry[".tag"] === "file" ? ` (${formatBytes(entry.size)})` : "";
          logHuman(`  [${type}] ${entry.path_display}${size}`);
        }
      }

      printSuccess(entries);
    });
}
