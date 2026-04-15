import type { Command } from "commander";
import { rpc, pollBatchJob } from "../lib/api";
import { printSuccess, isHuman } from "../lib/output";
import { log, logError } from "../lib/logger";
import type { SearchResult, BatchResult } from "../types";
import { basename } from "path";

const BATCH_SIZE = 500;

async function moveBatch(
  paths: string[],
  dest: string,
  autorename: boolean
): Promise<number> {
  const entries = paths.map((src) => ({
    from_path: src,
    to_path: `${dest}/${basename(src)}`,
  }));

  const result = await rpc<BatchResult>("files/move_batch_v2", {
    entries,
    autorename,
    allow_ownership_transfer: false,
  });

  if (result[".tag"] === "async_job_id") {
    await pollBatchJob<BatchResult>(
      "files/move_batch/check_v2",
      result.async_job_id!
    );
  }

  return paths.length;
}

export function registerBulkMvCommand(program: Command): void {
  program
    .command("bulk-mv <source> <dest>")
    .description(
      "Move files matching a pattern from source folder to destination folder. " +
      "Searches server-side and moves in batches — handles thousands of files efficiently."
    )
    .requiredOption("--match <pattern>", "Filename prefix to match (e.g. '2024-')")
    .option("--autorename", "Automatically rename on conflict")
    .option("--dry-run", "Show what would be moved without moving")
    .action(async (source: string, dest: string, options: { match: string; autorename?: boolean; dryRun?: boolean }) => {
      const autorename = options.autorename ?? false;
      const dryRun = options.dryRun ?? false;
      // Remove trailing * from match pattern if present (we use it as a prefix search)
      const matchPrefix = options.match.replace(/\*$/, "");

      let totalFound = 0;
      let totalMoved = 0;
      let cursor: string | undefined;
      let hasMore = true;

      // Create destination folder (ignore error if it already exists)
      if (!dryRun) {
        try {
          await rpc("files/create_folder_v2", { path: dest, autorename: false });
          log(`Created folder: ${dest}`);
        } catch {
          // Folder likely already exists
          log(`Destination folder ${dest} already exists or could not be created`);
        }
      }

      while (hasMore) {
        // Search for matching files
        let result: SearchResult;
        if (cursor) {
          result = await rpc<SearchResult>("files/search/continue_v2", { cursor });
        } else {
          result = await rpc<SearchResult>("files/search_v2", {
            query: matchPrefix,
            options: {
              max_results: 1000,
              file_status: { ".tag": "active" },
              filename_only: true,
              path: source,
            },
          });
        }

        // Filter to exact prefix matches (search is fuzzy, we want exact prefix)
        const matchingPaths: string[] = [];
        for (const match of result.matches) {
          const entry = match.metadata.metadata;
          if (entry[".tag"] === "file" && entry.name.startsWith(matchPrefix)) {
            // Only include files directly in the source folder, not subdirectories
            const parentPath = entry.path_display.substring(0, entry.path_display.lastIndexOf("/"));
            if (parentPath.toLowerCase() === source.toLowerCase()) {
              matchingPaths.push(entry.path_display);
            }
          }
        }

        totalFound += matchingPaths.length;

        if (matchingPaths.length > 0) {
          if (dryRun) {
            for (const p of matchingPaths) {
              if (isHuman()) {
                logError(`  [dry-run] Would move: ${p}`);
              }
            }
          } else {
            // Move in sub-batches of BATCH_SIZE
            for (let i = 0; i < matchingPaths.length; i += BATCH_SIZE) {
              const batch = matchingPaths.slice(i, i + BATCH_SIZE);
              if (isHuman()) {
                logError(`Moving ${batch.length} files (${totalMoved + 1}-${totalMoved + batch.length})...`);
              }
              await moveBatch(batch, dest, autorename);
              totalMoved += batch.length;
            }
          }
        }

        hasMore = result.has_more && !!result.cursor;
        cursor = result.cursor;
      }

      if (isHuman()) {
        if (dryRun) {
          logError(`\n${totalFound} files would be moved.`);
        } else {
          logError(`\nDone. Moved ${totalMoved} files to ${dest}.`);
        }
      }

      printSuccess({
        matched: totalFound,
        moved: dryRun ? 0 : totalMoved,
        dry_run: dryRun,
        source,
        dest,
        pattern: options.match,
      });
    });
}
