import type { Command } from "commander";
import { rpc, rpcRaw, pollBatchJob } from "../lib/api";
import { printSuccess, isHuman } from "../lib/output";
import { log, logError } from "../lib/logger";
import type { ListFolderResult, BatchResult } from "../types";
import { basename } from "path";

const DEFAULT_batchSize = 500;

async function moveBatch(
  paths: string[],
  dest: string,
  autorename: boolean,
  label: string
): Promise<number> {
  log(`[${label}] Moving ${paths.length} files...`);

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
      result.async_job_id!,
      label
    );
  }

  log(`[${label}] Done.`);
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
    .option("--parallel <n>", "Number of batches to move in parallel (default: 1)")
    .option("--batch-size <n>", "Number of files per batch (default: 500)")
    .addHelpText("after", `
Examples:
  $ dropbox-cli bulk-mv /Photos /Photos/2024 --match "2024-"               Move files starting with "2024-"
  $ dropbox-cli bulk-mv /Inbox /Archive --match "report" --dry-run         Preview what would be moved
  $ dropbox-cli bulk-mv /Downloads /Docs --match "draft" --autorename      Auto-rename on conflict
  $ dropbox-cli bulk-mv /Photos /Photos/2024 --match "2024-" --parallel 5  Move 5 batches at a time
  $ dropbox-cli bulk-mv /Logs /Logs/old --match "2023-" --batch-size 100   Use smaller batches`)
    .action(async (source: string, dest: string, options: { match: string; autorename?: boolean; dryRun?: boolean; parallel?: string; batchSize?: string }) => {
      const autorename = options.autorename ?? false;
      const dryRun = options.dryRun ?? false;
      const parallel = options.parallel ? parseInt(options.parallel, 10) : 1;
      const batchSize = options.batchSize ? parseInt(options.batchSize, 10) : DEFAULT_batchSize;
      // Remove trailing * from match pattern if present (we use it as a prefix search)
      const matchPrefix = options.match.replace(/\*$/, "");

      // Create destination folder up front (ignore error if it already exists)
      if (!dryRun) {
        const mkdirResult = await rpcRaw("files/create_folder_v2", { path: dest, autorename: false });
        if (mkdirResult.ok) {
          log(`Created folder: ${dest}`);
        } else {
          log(`Destination folder ${dest} already exists`);
        }
      }

      // Pipeline: list_folder pages feed into move batches concurrently
      const pending: string[] = [];
      const inFlight = new Set<Promise<void>>();
      let totalFound = 0;
      let totalMoved = 0;
      let totalListed = 0;
      let batchNum = 0;

      const dbxSource = source === "/" ? "" : source;

      async function dispatchBatch(batch: string[]): Promise<void> {
        batchNum++;
        const label = `batch ${batchNum}`;
        if (isHuman()) {
          logError(`${label}: moving ${batch.length} files (${totalMoved + 1}-${totalMoved + batch.length})...`);
        }
        totalMoved += batch.length;
        await moveBatch(batch, dest, autorename, label);
      }

      async function flushReady(): Promise<void> {
        while (pending.length >= batchSize) {
          const batch = pending.splice(0, batchSize);
          const promise = dispatchBatch(batch).then(() => { inFlight.delete(promise); });
          inFlight.add(promise);

          if (inFlight.size >= parallel) {
            await Promise.race(inFlight);
          }
        }
      }

      // First page
      let result = await rpc<ListFolderResult>("files/list_folder", {
        path: dbxSource,
        limit: 2000,
      });

      while (true) {
        for (const entry of result.entries) {
          totalListed++;
          if (entry[".tag"] === "file" && entry.name.startsWith(matchPrefix)) {
            if (dryRun && isHuman()) {
              logError(`  [dry-run] Would move: ${entry.path_display}`);
            }
            pending.push(entry.path_display);
            totalFound++;
          }
        }

        if (isHuman()) {
          logError(`Listed ${totalListed} entries, ${totalFound} matching...`);
        }

        // Dispatch full batches while listing continues
        if (!dryRun) {
          await flushReady();
        }

        if (!result.has_more) break;

        // If all parallel slots are full, wait for one before fetching the next page
        if (!dryRun && inFlight.size >= parallel) {
          await Promise.race(inFlight);
        }

        result = await rpc<ListFolderResult>("files/list_folder/continue", {
          cursor: result.cursor,
        });
      }

      // Dispatch any remaining files as a final batch
      if (!dryRun && pending.length > 0) {
        const promise = dispatchBatch(pending.splice(0)).then(() => { inFlight.delete(promise); });
        inFlight.add(promise);
      }

      // Wait for all in-flight batches to complete
      if (inFlight.size > 0) {
        await Promise.all(inFlight);
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
