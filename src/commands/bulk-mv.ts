import type { Command } from "commander";
import { rpc, rpcRaw, pollBatchJob } from "../lib/api";
import { isFolderConflict } from "../lib/machine-api";
import { printSuccess } from "../lib/output";
import { AUTH_REFUSED } from "../lib/transport";
import { log, logError, logHuman } from "../lib/logger";
import { positiveInteger } from "../lib/options";
import { CommandError, CredentialError, type ListFolderResult, type BatchResult } from "../types";
import { basename, posix } from "path";

const DEFAULT_batchSize = 500;
// Dropbox files/move_batch_v2 accepts at most 1000 entries per call.
const MAX_BATCH_SIZE = 1000;

interface MoveFailure {
  path: string;
  reason: string;
}

// Dropbox errors are nested tagged unions, e.g. relocation_error -> to -> conflict -> file.
// Join the tag chain into one readable reason like "relocation_error/to/conflict/file".
function describeFailure(failure: unknown): string {
  const tags: string[] = [];
  let node = failure as Record<string, unknown> | undefined;
  while (node && typeof node[".tag"] === "string") {
    const tag = node[".tag"];
    tags.push(tag);
    node = node[tag] as Record<string, unknown> | undefined;
  }
  return tags.length > 0 ? tags.join("/") : "unknown";
}

// Mirrors how the CLI entry point reports each error type, so the cause keeps its usual code and exit code.
function describeCause(error: unknown): { code: string; message: string; exitCode: number } {
  if (error instanceof CommandError) return { code: error.code, message: error.message, exitCode: error.exitCode };
  if (error instanceof CredentialError) {
    return { code: error.code, message: error.message, exitCode: error.code === "auth_error" ? 2 : 1 };
  }
  return { code: "command_failed", message: error instanceof Error ? error.message : String(error), exitCode: 1 };
}

async function moveBatch(
  paths: string[],
  dest: string,
  autorename: boolean,
  label: string
): Promise<{ moved: number; failures: MoveFailure[] }> {
  log(`[${label}] Moving ${paths.length} files...`);

  const entries = paths.map((src) => ({
    from_path: src,
    to_path: posix.join(dest, basename(src)),
  }));

  const result = await rpc<BatchResult>("files/move_batch_v2", {
    entries,
    autorename,
    allow_ownership_transfer: false,
  });

  let completed: BatchResult = result;
  if (result[".tag"] === "async_job_id") {
    completed = await pollBatchJob<BatchResult>(
      "files/move_batch/check_v2",
      result.async_job_id!,
      label
    );
  }

  let moved = 0;
  const failures: MoveFailure[] = [];
  if (completed.entries) {
    for (let i = 0; i < completed.entries.length; i++) {
      const entry = completed.entries[i];
      if (entry[".tag"] === "success") {
        moved++;
        logHuman(`  ✓ ${paths[i]}`);
      } else {
        const reason = describeFailure(entry.failure);
        failures.push({ path: paths[i], reason });
        logHuman(`  ✗ ${paths[i]} — ${reason}`);
      }
    }
  }

  log(`[${label}] Done. ${moved}/${paths.length} moved.`);
  if (failures.length > 0) {
    logError(`[${label}] ${failures.length} file(s) failed to move.`);
  }
  return { moved, failures };
}

export function registerBulkMvCommand(program: Command): void {
  program
    .command("bulk-mv <source> <dest>")
    .description(
      "Move files whose names start with --match (case-sensitive) from the source folder to the destination folder. " +
      "Lists the source folder, filters names on the client, and moves matches in batches."
    )
    .requiredOption("--match <pattern>", "Case-sensitive filename prefix to match (e.g. '2024-')")
    .option("--autorename", "Automatically rename on conflict")
    .option("--dry-run", "Show what would be moved without moving")
    .option("--parallel <n>", "Number of batches to move in parallel", positiveInteger(), 1)
    .option("--batch-size <n>", "Number of files per batch, 1–1000", positiveInteger(MAX_BATCH_SIZE), DEFAULT_batchSize)
    .addHelpText("after", `
Examples:
  $ dropbox-cli bulk-mv /Photos /Photos/2024 --match "2024-"               Move files starting with "2024-"
  $ dropbox-cli bulk-mv /Inbox /Archive --match "report" --dry-run         Preview what would be moved
  $ dropbox-cli bulk-mv /Downloads /Docs --match "draft" --autorename      Auto-rename on conflict
  $ dropbox-cli bulk-mv /Photos /Photos/2024 --match "2024-" --parallel 5  Move 5 batches at a time
  $ dropbox-cli bulk-mv /Logs /Logs/old --match "2023-" --batch-size 100   Use smaller batches

If a run stops early, re-run the same command to continue with the files still in the source.`)
    .action(async (source: string, dest: string, options: { match: string; autorename?: boolean; dryRun?: boolean; parallel: number; batchSize: number }) => {
      const autorename = options.autorename ?? false;
      const dryRun = options.dryRun ?? false;
      const { parallel, batchSize } = options;
      // Remove trailing * from match pattern if present (we use it as a prefix search)
      const matchPrefix = options.match.replace(/\*$/, "");

      // Only a structured folder conflict proves that creation can be skipped.
      if (!dryRun) {
        const mkdirResult = await rpcRaw("files/create_folder_v2", { path: dest, autorename: false });
        if (mkdirResult.ok) {
          log(`Created folder: ${dest}`);
        } else {
          const error = (mkdirResult.data as { error?: unknown } | null)?.error;
          const folderExists = mkdirResult.status === 409 && isFolderConflict(error);
          if (!folderExists) {
            if (mkdirResult.status === 401) throw new CommandError("auth_error", AUTH_REFUSED, 2);
            throw new CommandError("destination_create_failed", "Destination creation failed or is uncertain. No files were moved; verify the destination before retrying.");
          }
          log(`Destination folder ${dest} already exists`);
        }
      }

      // Pipeline: list_folder pages feed into move batches concurrently
      const pending: string[] = [];
      const inFlight = new Set<Promise<void>>();
      let totalFound = 0;
      let totalMoved = 0;
      const allFailures: MoveFailure[] = [];
      let totalListed = 0;
      let batchNum = 0;
      // Paths of thrown batches: Dropbox may or may not have moved them.
      const unconfirmed: string[] = [];
      // The first failure after a batch was sent stops the run: nothing new is sent after it.
      let stopped = false;
      let cause: unknown;

      const dbxSource = source === "/" ? "" : source;

      function stop(error: unknown): void {
        if (!stopped) cause = error;
        stopped = true;
      }

      async function dispatchBatch(batch: string[]): Promise<void> {
        batchNum++;
        const label = `batch ${batchNum}`;
        logHuman(`${label}: moving ${batch.length} files...`);
        try {
          const { moved, failures } = await moveBatch(batch, dest, autorename, label);
          totalMoved += moved;
          allFailures.push(...failures);
        } catch (error) {
          unconfirmed.push(...batch);
          stop(error);
        }
      }

      function track(batch: string[]): void {
        const promise = dispatchBatch(batch).finally(() => { inFlight.delete(promise); });
        inFlight.add(promise);
      }

      async function flushReady(): Promise<void> {
        while (!stopped && pending.length >= batchSize) {
          track(pending.splice(0, batchSize));
          if (inFlight.size >= parallel) await Promise.race(inFlight);
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
            if (dryRun) {
              logHuman(`  [dry-run] Would move: ${entry.path_display}`);
            }
            pending.push(entry.path_display);
            totalFound++;
          }
        }

        logHuman(`Listed ${totalListed} entries, ${totalFound} matching...`);

        // Dispatch full batches while listing continues
        if (!dryRun) {
          await flushReady();
        }

        if (!result.has_more) break;

        // If all parallel slots are full, wait for one before fetching the next page
        if (!dryRun && inFlight.size >= parallel) await Promise.race(inFlight);
        if (stopped) break;

        try {
          result = await rpc<ListFolderResult>("files/list_folder/continue", {
            cursor: result.cursor,
          });
        } catch (error) {
          // Before any batch is sent nothing has moved, so the original error stands.
          if (batchNum === 0) throw error;
          stop(error);
          break;
        }
      }

      // Dispatch any remaining files as a final batch
      if (!dryRun && !stopped && pending.length > 0) track(pending.splice(0));

      // Wait for all in-flight batches to complete
      await Promise.all(inFlight);

      if (stopped) {
        const { code, message, exitCode } = describeCause(cause);
        throw new CommandError(
          "bulk_move_incomplete",
          `Bulk move stopped early (${code}): moved ${totalMoved}, failed ${allFailures.length}, ` +
          `unconfirmed ${unconfirmed.length} of ${totalFound} matched. ` +
          "Re-run to continue with the files still in the source.",
          exitCode,
          {
            matched: totalFound,
            moved: totalMoved,
            failed: allFailures.length,
            failures: allFailures,
            unconfirmed,
            cause: { code, message },
          },
        );
      }

      if (dryRun) {
        logHuman(`\n${totalFound} files would be moved.`);
      } else {
        logHuman(`\nDone. Moved ${totalMoved} files to ${dest}.`);
      }

      printSuccess({
        matched: totalFound,
        moved: dryRun ? 0 : totalMoved,
        failed: dryRun ? 0 : totalFound - totalMoved,
        failures: allFailures,
        dry_run: dryRun,
        source,
        dest,
        pattern: options.match,
      });
    });
}
